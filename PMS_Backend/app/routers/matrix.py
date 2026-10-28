"""Configurable matrices API: types, versions, CHRO approval, Excel templates."""
import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import AuditActorDep, CurrentPrincipal, get_current_user
from app.auth.permissions import Permission, Principal
from app.dependencies import get_db, transaction
from app.models import Department, Matrix, MatrixVersion, MatrixVersionStatus, Plant, User
from app.schemas.jd import ReasonRequest, UserRef
from app.schemas.matrix import (
    MAX_DEFINITION_BYTES,
    ApproveRequest,
    DefinitionCheckRequest,
    DraftSave,
    LocatedProblem,
    MatrixCreate,
    MatrixDetail,
    MatrixSummary,
    MatrixUpdate,
    PolicyLink,
    PreviewRequest,
    PreviewResult,
    RuleSummary,
    ScopeIn,
    ScopeRead,
    UploadConfirmed,
    UploadPreviewRead,
    VersionActions,
    VersionRead,
    VersionSummary,
)
from app.schemas.organization import DepartmentRef, PlantRef
from app.services import clock
from app.services import matrix_rules as rules
from app.services import matrix_service as service
from app.services import matrix_templates as templates
from app.services import matrix_uploads as uploads
from app.services.errors import ConflictError, Issue, PermissionDeniedError, ValidationFailedError
from app.services.applicability import ApplicabilityInput
from app.services.matrix_types import MatrixTypeSpec, type_metadata
from app.services.scope import department_visible, plant_visible

router = APIRouter(prefix="/api", tags=["matrices"], dependencies=[Depends(get_current_user)])
DbSession = Annotated[Session, Depends(get_db)]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# --- builders ------------------------------------------------------------------------------

def _users(db: Session, versions: list[MatrixVersion]) -> dict[int, UserRef]:
    ids = {uid for v in versions for uid in (v.created_by_user_id, v.submitted_by_user_id,
                                             v.approved_by_user_id, v.rejected_by_user_id,
                                             v.published_by_user_id) if uid}
    if not ids:
        return {}
    return {u.id: UserRef(id=u.id, username=u.username)
            for u in db.scalars(select(User).where(User.id.in_(sorted(ids))))}


def scope_label(plant: Any, department: Any) -> str:
    if plant and department:
        return f"{department.name} — {plant.name}"
    if department:
        return f"{department.name}: all plants"
    if plant:
        return f"{plant.name}: all departments"
    return "Company-wide"


def _summary(version: MatrixVersion, users: dict[int, UserRef]) -> VersionSummary:
    def user(uid: int | None) -> UserRef | None:
        return users.get(uid) if uid else None

    return VersionSummary(
        id=version.id, version_no=version.version_no, status=version.status,
        schema_version=version.schema_version, effective_from=version.effective_from,
        effective_to=version.effective_to, change_summary=version.change_summary,
        source=version.source, source_file_name=version.source_file_name,
        template_version=version.template_version,
        created_by=user(version.created_by_user_id), created_at=version.created_at,
        updated_at=version.updated_at, submitted_by=user(version.submitted_by_user_id),
        submitted_at=version.submitted_at, approved_by=user(version.approved_by_user_id),
        approved_at=version.approved_at, approval_note=version.approval_note,
        rejected_by=user(version.rejected_by_user_id), rejected_at=version.rejected_at,
        rejection_reason=version.rejection_reason, published_by=user(version.published_by_user_id),
        published_at=version.published_at, superseded_at=version.superseded_at,
        applicability=[
            ScopeRead(plant=PlantRef.model_validate(s.plant) if s.plant else None,
                      department=DepartmentRef.model_validate(s.department) if s.department else None,
                      label=scope_label(s.plant, s.department))
            for s in version.scopes
        ],
    )


def _matrix_summary(db: Session, matrix: Matrix) -> dict[str, Any]:
    spec = service.spec_for(matrix.matrix_type)
    users = _users(db, list(matrix.versions))
    open_version = service.open_version(matrix)
    in_force = service.version_in_force(matrix, clock.today())
    policy = service.policy_for(db, matrix)
    has_published = any(v.status == MatrixVersionStatus.PUBLISHED for v in matrix.versions)
    return dict(
        id=matrix.id, code=matrix.code, matrix_type=matrix.matrix_type, type_name=spec.name,
        name=matrix.name, description=matrix.description, attributes=matrix.attributes or {},
        latest_version=_summary(service.latest_version(matrix), users),
        open_version=_summary(open_version, users) if open_version else None,
        in_force=_summary(in_force, users) if in_force else None,
        policy=PolicyLink(id=policy.id, code=policy.code, name=policy.name) if policy else None,
        policy_note=None if has_published else spec.policy_note,
    )


def _detail(db: Session, principal: Principal, matrix: Matrix) -> MatrixDetail:
    latest = service.latest_version(matrix)
    return MatrixDetail(
        **_matrix_summary(db, matrix),
        versions=[_summary(v, _users(db, list(matrix.versions)))
                  for v in sorted(matrix.versions, key=lambda v: v.version_no, reverse=True)],
        can_write=service.can_write(principal, latest),
        can_revise=service.can_write(principal, latest) and service.open_version(matrix) is None,
    )


def _rule_summaries(definition: rules.Definition) -> list[RuleSummary]:
    return [RuleSummary(priority=r.priority, label=r.label,
                        description=rules.describe_rule(definition, r),
                        outputs=rules.jsonable(r.outputs)) for r in definition.rules]


def _version_read(db: Session, principal: Principal, matrix: Matrix,
                  version: MatrixVersion) -> VersionRead:
    spec = service.spec_for(matrix.matrix_type)
    check = service.check_version(matrix, version)
    definition, _report = rules.analyse(spec, version.definition, matrix.attributes)
    writer = service.can_write(principal, version)
    approver = service.can_approve(principal, version)
    is_author = principal.user_id in (version.created_by_user_id, version.submitted_by_user_id)
    summary = _summary(version, _users(db, [version]))
    return VersionRead(
        **summary.model_dump(), matrix_id=matrix.id, definition=version.definition,
        definition_hash=version.definition_hash, check=check.as_dict(),
        rule_summaries=_rule_summaries(definition),
        actions=VersionActions(
            can_edit=writer and version.status == MatrixVersionStatus.DRAFT,
            can_submit=writer and version.status == MatrixVersionStatus.DRAFT,
            can_withdraw=writer and version.status == MatrixVersionStatus.SUBMITTED,
            can_approve=approver and not is_author
            and version.status == MatrixVersionStatus.SUBMITTED,
            can_publish=(writer or approver) and version.status == MatrixVersionStatus.APPROVED,
        ),
    )


def _scopes(items: list[ScopeIn]) -> list[ApplicabilityInput]:
    return [ApplicabilityInput(s.plant_id, s.department_id) for s in items]


def _check_size(definition: dict[str, Any]) -> None:
    if len(json.dumps(definition)) > MAX_DEFINITION_BYTES:
        raise ValidationFailedError([Issue("The configuration is too large.", "definition")])


def _readable_spec(principal: Principal, code: str) -> MatrixTypeSpec:
    spec = service.spec_for(code)
    if principal.scope_for(spec.read_permission).is_empty:
        raise PermissionDeniedError("You do not have access to this matrix type.")
    return spec


def _require_templates(spec: MatrixTypeSpec) -> None:
    if not spec.excel_templates:
        raise ConflictError(f"{spec.name}s are configured in the portal; there is no Excel "
                            "template for them.")


def _xlsx(data: bytes, filename: str) -> Response:
    return Response(content=data, media_type=XLSX,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _codes(db: Session, principal: Principal) -> tuple[list[Plant], list[Department]]:
    scope = principal.org_scope
    plants = [p for p in db.scalars(select(Plant).where(Plant.is_active).order_by(Plant.code))
              if plant_visible(db, scope, p.id)]
    departments = [d for d in db.scalars(select(Department).where(Department.is_active)
                                         .order_by(Department.code))
                   if department_visible(db, scope, d.id)]
    return plants, departments


# --- types ---------------------------------------------------------------------------------

@router.get("/matrix-types")
def list_types(db: DbSession, principal: CurrentPrincipal) -> list[dict[str, Any]]:
    specs = service.readable_types(principal)
    if not specs:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="You do not have access to matrix configurations.")
    # The "awaiting approved configuration" note applies only until a version
    # of the type has been approved and published.
    published = set(db.scalars(select(Matrix.matrix_type).join(MatrixVersion).where(
        Matrix.is_active, MatrixVersion.status == MatrixVersionStatus.PUBLISHED)).all())
    return [{**type_metadata(s), "policy_note": None if s.code in published else s.policy_note}
            for s in specs]


@router.get("/matrix-types/{code}/template")
def type_template(code: str, db: DbSession, principal: CurrentPrincipal) -> Response:
    """A blank, generated workbook for creating a new matrix of this type."""
    spec = _readable_spec(principal, code)
    if principal.scope_for(Permission.MATRIX_WRITE).is_empty:
        raise PermissionDeniedError("Only HR Head users configure matrices.")
    _require_templates(spec)
    scope = principal.scope_for(Permission.MATRIX_WRITE)
    plants, departments = _codes(db, principal)
    ctx = templates.TemplateContext(spec=spec, applicability=[("ALL", "ALL")] if scope.is_global
                                    else [])
    return _xlsx(templates.build_template(ctx, plants, departments),
                 f"{spec.code.lower()}-template.xlsx")


@router.post("/matrix-types/{code}/check")
def check_definition(code: str, body: DefinitionCheckRequest,
                     principal: CurrentPrincipal) -> dict[str, Any]:
    """Validate (and optionally preview) unsaved content; nothing is stored."""
    spec = _readable_spec(principal, code)
    _check_size(body.definition)
    definition, report = rules.analyse(spec, body.definition, body.attributes)
    result: dict[str, Any] = {"check": report.as_dict(),
                              "rule_summaries": [r.model_dump() for r in
                                                 _rule_summaries(definition)],
                              "preview": None, "preview_error": None}
    if body.inputs is not None:
        if not report.ok:
            result["preview_error"] = "Fix the configuration's errors before previewing."
        else:
            try:
                result["preview"] = rules.evaluate(definition, body.inputs).as_dict(definition)
            except rules.EvaluationError as exc:
                result["preview_error"] = str(exc)
    return result


# --- matrices ------------------------------------------------------------------------------

@router.get("/matrices", response_model=list[MatrixSummary])
def list_matrices(db: DbSession, principal: CurrentPrincipal,
                  matrix_type: Annotated[str | None, Query(max_length=40)] = None,
                  status_filter: Annotated[MatrixVersionStatus | None, Query(alias="status")] = None,
                  search: Annotated[str | None, Query(max_length=100)] = None):
    if not service.readable_types(principal):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="You do not have access to matrix configurations.")
    return [MatrixSummary(**_matrix_summary(db, m)) for m in service.list_matrices(
        db, principal, matrix_type=matrix_type, status=status_filter, search=search)]


@router.post("/matrices", response_model=MatrixDetail, status_code=status.HTTP_201_CREATED)
def create_matrix(body: MatrixCreate, db: DbSession, principal: CurrentPrincipal,
                  actor: AuditActorDep):
    with transaction(db):
        matrix = service.create_matrix(db, principal, actor, matrix_type=body.matrix_type,
                                       name=body.name, description=body.description,
                                       attributes=body.attributes,
                                       applicability=_scopes(body.applicability))
    return _detail(db, principal, service.get_matrix(db, principal, matrix.id))


@router.get("/matrices/{matrix_id}", response_model=MatrixDetail)
def get_matrix(matrix_id: int, db: DbSession, principal: CurrentPrincipal):
    return _detail(db, principal, service.get_matrix(db, principal, matrix_id))


@router.put("/matrices/{matrix_id}", response_model=MatrixDetail)
def update_matrix(matrix_id: int, body: MatrixUpdate, db: DbSession, principal: CurrentPrincipal,
                  actor: AuditActorDep):
    with transaction(db):
        service.update_matrix(db, principal, actor, matrix_id, name=body.name,
                              description=body.description)
    return _detail(db, principal, service.get_matrix(db, principal, matrix_id))


@router.post("/matrices/{matrix_id}/revisions", response_model=VersionRead,
             status_code=status.HTTP_201_CREATED)
def revise(matrix_id: int, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        version = service.revise(db, principal, actor, service.get_matrix(db, principal, matrix_id))
    matrix, version = service.get_version(db, principal, matrix_id, version.id)
    return _version_read(db, principal, matrix, version)


@router.get("/matrices/{matrix_id}/versions/{version_id}", response_model=VersionRead)
def get_version(matrix_id: int, version_id: int, db: DbSession, principal: CurrentPrincipal):
    matrix, version = service.get_version(db, principal, matrix_id, version_id)
    return _version_read(db, principal, matrix, version)


@router.put("/matrices/{matrix_id}/versions/{version_id}", response_model=VersionRead)
def save_draft(matrix_id: int, version_id: int, body: DraftSave, db: DbSession,
               principal: CurrentPrincipal, actor: AuditActorDep):
    """Save a draft, even with errors; the response's `check` lists them."""
    _check_size(body.definition)
    with transaction(db):
        matrix, version = service.get_version(db, principal, matrix_id, version_id)
        service.save_draft(db, principal, actor, matrix, version, service.DraftContent(
            definition=body.definition, effective_from=body.effective_from,
            effective_to=body.effective_to, applicability=_scopes(body.applicability),
            change_summary=body.change_summary))
    matrix, version = service.get_version(db, principal, matrix_id, version_id)
    return _version_read(db, principal, matrix, version)


@router.post("/matrices/{matrix_id}/versions/{version_id}/preview", response_model=PreviewResult)
def preview_version(matrix_id: int, version_id: int, body: PreviewRequest, db: DbSession,
                    principal: CurrentPrincipal):
    matrix, version = service.get_version(db, principal, matrix_id, version_id)
    try:
        definition, evaluation = service.evaluate_version(matrix, version, body.inputs)
    except rules.EvaluationError as exc:
        raise ValidationFailedError([Issue(str(exc), "inputs")]) from None
    return PreviewResult(**evaluation.as_dict(definition))


def _step(name: str):
    def endpoint(matrix_id: int, version_id: int, db: DbSession, principal: CurrentPrincipal,
                 actor: AuditActorDep):
        with transaction(db):
            matrix, version = service.get_version(db, principal, matrix_id, version_id)
            getattr(service, name)(db, principal, actor, matrix, version)
        matrix, version = service.get_version(db, principal, matrix_id, version_id)
        return _version_read(db, principal, matrix, version)

    endpoint.__name__ = f"{name}_version"
    return endpoint


for _name, _doc in (("submit", "Submit a valid draft for CHRO approval."),
                    ("withdraw", "Withdraw a submitted version back to draft."),
                    ("publish", "Put an approved version in force from its effective date.")):
    _endpoint = _step(_name)
    _endpoint.__doc__ = _doc
    router.add_api_route(f"/matrices/{{matrix_id}}/versions/{{version_id}}/{_name}", _endpoint,
                         methods=["POST"], response_model=VersionRead)


@router.post("/matrices/{matrix_id}/versions/{version_id}/approve", response_model=VersionRead)
def approve(matrix_id: int, version_id: int, body: ApproveRequest, db: DbSession,
            principal: CurrentPrincipal, actor: AuditActorDep):
    """CHRO approval (not the author or submitter)."""
    with transaction(db):
        matrix, version = service.get_version(db, principal, matrix_id, version_id)
        service.approve(db, principal, actor, matrix, version, body.note)
    matrix, version = service.get_version(db, principal, matrix_id, version_id)
    return _version_read(db, principal, matrix, version)


@router.post("/matrices/{matrix_id}/versions/{version_id}/reject", response_model=VersionRead)
def reject(matrix_id: int, version_id: int, body: ReasonRequest, db: DbSession,
           principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        matrix, version = service.get_version(db, principal, matrix_id, version_id)
        service.reject(db, principal, actor, matrix, version, body.reason)
    matrix, version = service.get_version(db, principal, matrix_id, version_id)
    return _version_read(db, principal, matrix, version)


@router.get("/matrices/{matrix_id}/versions/{version_id}/template")
def version_template(matrix_id: int, version_id: int, db: DbSession,
                     principal: CurrentPrincipal) -> Response:
    """The version's content as a template, to edit in Excel and upload again."""
    matrix, version = service.get_version(db, principal, matrix_id, version_id)
    spec = service.spec_for(matrix.matrix_type)
    _require_templates(spec)
    plants, departments = _codes(db, principal)
    ctx = templates.TemplateContext(
        spec=spec, matrix_code=matrix.code, version_no=version.version_no, name=matrix.name,
        description=matrix.description, attributes=matrix.attributes or {},
        definition=version.definition, effective_from=version.effective_from,
        effective_to=version.effective_to, change_summary=version.change_summary,
        applicability=[(s.plant.code if s.plant else "ALL", s.department.code if s.department
                        else "ALL") for s in version.scopes])
    return _xlsx(templates.build_template(ctx, plants, departments),
                 f"{matrix.code}-v{version.version_no}.xlsx")


# --- uploads --------------------------------------------------------------------------------

def _read(file: UploadFile) -> bytes:
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise ValidationFailedError([Issue("Upload an Excel workbook (.xlsx) generated by the "
                                           "portal.")])
    return file.file.read(templates.MAX_BYTES + 1)


@router.post("/matrices/uploads/preview", response_model=UploadPreviewRead)
def upload_preview(db: DbSession, principal: CurrentPrincipal,
                   file: Annotated[UploadFile, File()]):
    """Validate a filled-in template; nothing is saved."""
    plan = uploads.analyse_upload(db, principal, _read(file))
    definition = plan.parsed_definition
    return UploadPreviewRead(
        action=plan.action, matrix_type=plan.spec.code if plan.spec else None,
        type_name=plan.spec.name if plan.spec else None, matrix_code=plan.code, name=plan.name,
        target_version_no=plan.target.version_no if plan.target else None,
        template_version=plan.template_version, schema_version=plan.schema_version,
        effective_from=plan.effective_from, effective_to=plan.effective_to,
        applicability=plan.applicability_labels,
        fields=[f for f in plan.definition.get("fields") or []],
        rules=_rule_summaries(definition) if definition else [],
        test_results=[t.as_dict() for t in plan.report.test_results] if plan.report else [],
        problems=[LocatedProblem(location=p.location, message=p.message) for p in plan.problems],
        warnings=[LocatedProblem(location=p.location, message=p.message) for p in plan.warnings],
        ready=plan.ready,
    )


@router.post("/matrices/uploads/confirm", response_model=UploadConfirmed)
def upload_confirm(db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep,
                   file: Annotated[UploadFile, File()]):
    """Re-validate and save as a draft, all or nothing."""
    data = _read(file)
    with transaction(db):
        matrix, version = uploads.confirm_upload(db, principal, actor, data,
                                                 file.filename or "upload.xlsx")
        result = UploadConfirmed(matrix_id=matrix.id, matrix_code=matrix.code,
                                 version_id=version.id, version_no=version.version_no)
    return result
