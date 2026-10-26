"""Matrix configurations: versions, CHRO approval and resolution.

Workflow (docs/database-design.md, "Configurable matrices"):
  DRAFT --submit--> SUBMITTED --approve (CHRO)--> APPROVED --publish--> PUBLISHED
                    SUBMITTED --reject (CHRO, reason)--> REJECTED
                    SUBMITTED --withdraw--> DRAFT
  A published version is in force from effective_from to effective_to.
  Publishing a newer version ends earlier ones the day before it starts (or
  supersedes them if they had not started). Content changes only in DRAFT;
  any later change is a new version (revise).

Authority: HR Head (matrix:write, scoped; company-wide needs GLOBAL) authors,
submits, withdraws and publishes; the CHRO (matrix:approve) approves or
rejects, and may publish. The approver must differ from the submitter
(also a CHECK constraint) and from the author. Every action writes an audit
event in the caller's transaction.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.auth.permissions import Permission, Principal
from app.models import (
    KpiDirection,
    KpiScoringPolicy,
    Matrix,
    MatrixVersion,
    MatrixVersionScope,
    MatrixVersionSource,
    MatrixVersionStatus,
    PlantDepartment,
)
from app.services import matrix_rules as rules
from app.services.audit import AuditActor, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services.applicability import (
    ApplicabilityInput,
    applicability_visible,
    applicability_writable,
)
from app.services.matrix_types import (
    REGISTRY,
    MatrixTypeSpec,
    Selection,
    UnknownMatrixType,
    get_type,
)

OPEN = (MatrixVersionStatus.DRAFT, MatrixVersionStatus.SUBMITTED)


# --- types and access ----------------------------------------------------------------------

def spec_for(code: str) -> MatrixTypeSpec:
    try:
        return get_type(code)
    except UnknownMatrixType:
        raise ValidationFailedError([Issue(f"Unknown matrix type '{code}'.", "matrix_type")]) from None


def readable_types(principal: Principal) -> list[MatrixTypeSpec]:
    return [s for s in REGISTRY.values() if not principal.scope_for(s.read_permission).is_empty]


def _scopes_of(version: MatrixVersion) -> list[ApplicabilityInput]:
    return [ApplicabilityInput(s.plant_id, s.department_id) for s in version.scopes]


def _visible(db: Session, principal: Principal, matrix: Matrix) -> bool:
    spec = REGISTRY.get(matrix.matrix_type)
    if spec is None:
        return False
    scope = principal.scope_for(spec.read_permission)
    if scope.is_empty:
        return False
    return any(applicability_visible(db, scope, s) for v in matrix.versions for s in v.scopes)


def _covers(principal: Principal, permission: Permission,
            scopes: Iterable[ApplicabilityInput]) -> bool:
    access = principal.scope_for(permission)
    scopes = list(scopes)
    return bool(scopes) and all(applicability_writable(access, a) for a in scopes)


def _require_write(principal: Principal, scopes: Iterable[ApplicabilityInput]) -> None:
    if not _covers(principal, Permission.MATRIX_WRITE, scopes):
        raise PermissionDeniedError(
            "Only an HR Head whose scope covers this matrix's applicability can change it "
            "(company-wide matrices need company-wide scope).")


def can_write(principal: Principal, version: MatrixVersion) -> bool:
    return _covers(principal, Permission.MATRIX_WRITE, _scopes_of(version))


def can_approve(principal: Principal, version: MatrixVersion) -> bool:
    return _covers(principal, Permission.MATRIX_APPROVE, _scopes_of(version))


def _check_scopes(db: Session, scopes: Sequence[ApplicabilityInput]) -> None:
    if not scopes:
        raise ValidationFailedError([Issue("Choose where this matrix applies.", "applicability")])
    if len({(a.plant_id, a.department_id) for a in scopes}) != len(scopes):
        raise ValidationFailedError([Issue("The same applicability is listed twice.",
                                           "applicability")])
    for a in scopes:
        if a.plant_id is not None and a.department_id is not None:
            exists = db.scalar(select(func.count()).select_from(PlantDepartment).where(
                PlantDepartment.plant_id == a.plant_id,
                PlantDepartment.department_id == a.department_id))
            if not exists:
                raise ValidationFailedError([Issue("That department is not set up at that "
                                                   "plant.", "applicability")])


def _query():
    return select(Matrix).options(
        selectinload(Matrix.versions).selectinload(MatrixVersion.scopes)
        .selectinload(MatrixVersionScope.plant),
        selectinload(Matrix.versions).selectinload(MatrixVersion.scopes)
        .selectinload(MatrixVersionScope.department),
    )


def get_matrix(db: Session, principal: Principal, matrix_id: int) -> Matrix:
    matrix = db.scalars(_query().where(Matrix.id == matrix_id)).one_or_none()
    if matrix is None or not _visible(db, principal, matrix):
        raise NotFoundError("Matrix", matrix_id)
    return matrix


def get_version(db: Session, principal: Principal, matrix_id: int,
                version_id: int) -> tuple[Matrix, MatrixVersion]:
    matrix = get_matrix(db, principal, matrix_id)
    version = next((v for v in matrix.versions if v.id == version_id), None)
    if version is None:
        raise NotFoundError("Matrix version", version_id)
    return matrix, version


def list_matrices(db: Session, principal: Principal, *, matrix_type: str | None = None,
                  status: MatrixVersionStatus | None = None,
                  search: str | None = None) -> list[Matrix]:
    stmt = _query().order_by(Matrix.matrix_type, Matrix.name)
    if matrix_type:
        stmt = stmt.where(Matrix.matrix_type == matrix_type)
    term = (search or "").strip()
    if term:
        like = f"%{term.replace('%', r'\%').replace('_', r'\_')}%"
        stmt = stmt.where(Matrix.name.like(like) | Matrix.code.like(like))
    result = []
    for matrix in db.scalars(stmt).all():
        if not _visible(db, principal, matrix):
            continue
        if status is not None and not any(v.status == status for v in matrix.versions):
            continue
        result.append(matrix)
    return result


def latest_version(matrix: Matrix) -> MatrixVersion:
    return max(matrix.versions, key=lambda v: v.version_no)


def open_version(matrix: Matrix) -> MatrixVersion | None:
    return next((v for v in matrix.versions if v.status in OPEN), None)


def in_force(version: MatrixVersion, on: date) -> bool:
    return (version.status == MatrixVersionStatus.PUBLISHED
            and version.effective_from is not None and version.effective_from <= on
            and (version.effective_to is None or version.effective_to >= on))


def version_in_force(matrix: Matrix, on: date) -> MatrixVersion | None:
    """The published version in force on a date (anywhere it applies)."""
    return next((v for v in matrix.versions if in_force(v, on)), None)


def _covers_unit(version: MatrixVersion, plant_id: int, department_id: int) -> bool:
    return any(s.plant_id in (None, plant_id) and s.department_id in (None, department_id)
               for s in version.scopes)


def resolve(db: Session, matrix_id: int, on: date, plant_id: int,
            department_id: int) -> MatrixVersion | None:
    """The published version of a matrix in force on `on` for one unit."""
    versions = db.scalars(
        select(MatrixVersion).where(MatrixVersion.matrix_id == matrix_id,
                                    MatrixVersion.status == MatrixVersionStatus.PUBLISHED)
        .options(selectinload(MatrixVersion.scopes))
    ).all()
    matching = [v for v in versions if in_force(v, on) and _covers_unit(v, plant_id, department_id)]
    if len(matching) > 1:  # prevented at publication; never pick one silently
        raise ConflictError("More than one published version applies; ask HR to correct the "
                            "matrix's effective dates.")
    return matching[0] if matching else None


# --- analysis ------------------------------------------------------------------------------

@dataclass
class VersionCheck:
    """Validation report plus what submission additionally needs."""

    report: rules.Report
    readiness: list[rules.Problem]

    @property
    def ready(self) -> bool:
        return self.report.ok and not self.readiness

    def as_dict(self) -> dict[str, Any]:
        data = self.report.as_dict()
        data["readiness"] = [p.as_dict() for p in self.readiness]
        data["ready_to_submit"] = self.ready
        return data


def check_version(matrix: Matrix, version: MatrixVersion) -> VersionCheck:
    spec = spec_for(matrix.matrix_type)
    raw = version.definition
    readiness: list[rules.Problem] = []
    if version.schema_version != spec.schema_version:
        try:
            raw = rules.migrate_definition(spec, raw, version.schema_version)
        except rules.SchemaMismatch as exc:
            readiness.append(rules.Problem("schema_version", str(exc)))
    _definition, report = rules.analyse(spec, raw, matrix.attributes)
    if version.effective_from is None:
        readiness.append(rules.Problem("effective_from", "Set the date from which this version "
                                                         "applies."))
    if not version.scopes:
        readiness.append(rules.Problem("applicability", "Choose where this version applies."))
    return VersionCheck(report, readiness)


def evaluate_version(matrix: Matrix, version: MatrixVersion,
                     inputs: Mapping[str, Any]) -> tuple[rules.Definition, rules.Evaluation]:
    """Preview: evaluate any version (drafts included) for the given inputs."""
    if version.status in OPEN or version.schema_version != spec_for(matrix.matrix_type).schema_version:
        definition, report = rules.analyse(spec_for(matrix.matrix_type), version.definition,
                                           matrix.attributes)
        if not report.ok:
            raise rules.EvaluationError("Fix the configuration's errors before previewing: "
                                        f"{report.errors[0].message}")
    else:
        definition = frozen_definition(version)
    return definition, rules.evaluate(definition, inputs)


class IntegrityProblem(RuntimeError):
    pass


def frozen_definition(version: MatrixVersion) -> rules.Definition:
    """An approved version's content, verified against its stored hash."""
    if rules.definition_hash(version.definition) != version.definition_hash:
        raise IntegrityProblem(f"Matrix version {version.id} no longer matches the content that "
                               "was approved; scoring with it is refused.")
    return rules.frozen_definition(version.definition)


# --- audit ---------------------------------------------------------------------------------

def _label(matrix: Matrix, version: MatrixVersion | None = None) -> str:
    return f"{matrix.code} '{matrix.name}'" + (f" v{version.version_no}" if version else "")


def _audit(db: Session, actor: AuditActor, matrix: Matrix, action: str, summary: str, *,
           version: MatrixVersion | None = None, changes: Mapping[str, Any] | None = None,
           reason: str | None = None) -> None:
    data = {"matrix_type": matrix.matrix_type, **(changes or {})}
    if version is not None:
        data.setdefault("version_no", version.version_no)
        data.setdefault("version_id", version.id)
    record_event(db, actor=actor, action=action, entity_type="matrix", entity_id=matrix.id,
                 summary=summary, changes=data, reason=reason)


def _content_summary(version: MatrixVersion) -> dict[str, Any]:
    definition = version.definition or {}
    return {
        "content_sha256": version.definition_hash,
        "fields": [f.get("key") for f in definition.get("fields") or [] if isinstance(f, Mapping)],
        "rules": len(definition.get("rules") or []),
        "test_cases": len(definition.get("test_cases") or []),
        "effective_from": version.effective_from,
        "effective_to": version.effective_to,
        "applicability": [[s.plant_id, s.department_id] for s in version.scopes],
    }


# --- create and edit -----------------------------------------------------------------------

def _clean_attributes(spec: MatrixTypeSpec, attributes: Mapping[str, Any] | None) -> dict[str, Any]:
    attributes = dict(attributes or {})
    unknown = set(attributes) - {a.key for a in spec.attributes}
    if unknown:
        raise ValidationFailedError([Issue(f"Unknown attribute(s): {', '.join(sorted(unknown))}.",
                                           "attributes")])
    for a in spec.attributes:
        if attributes.get(a.key) not in a.allowed_values:
            raise ValidationFailedError([Issue(f"Choose {a.label.lower()}.",
                                               f"attributes.{a.key}")])
    return attributes


def _norm_name(name: str) -> str:
    return " ".join(name.split())


def create_matrix(db: Session, principal: Principal, actor: AuditActor, *, matrix_type: str,
                  name: str, description: str | None, attributes: Mapping[str, Any] | None,
                  applicability: Sequence[ApplicabilityInput]) -> Matrix:
    spec = spec_for(matrix_type)
    if principal.scope_for(Permission.MATRIX_WRITE).is_empty:
        raise PermissionDeniedError("Only HR Head users can create matrix configurations.")
    _check_scopes(db, applicability)
    _require_write(principal, applicability)
    clean = _clean_attributes(spec, attributes)
    name = _norm_name(name)
    if db.scalar(select(Matrix.id).where(Matrix.matrix_type == spec.code, Matrix.name == name)):
        raise ConflictError(f"A {spec.name.lower()} with this name already exists.")
    if spec.code == "KPI_SCORING" and db.scalar(
            select(KpiScoringPolicy.id).where(KpiScoringPolicy.name == name)):
        raise ConflictError("A scoring policy with this name already exists.")
    matrix = Matrix(code="pending", matrix_type=spec.code, name=name,
                    description=(description or "").strip() or None, attributes=clean,
                    created_by_user_id=principal.user_id)
    db.add(matrix)
    db.flush()
    matrix.code = f"{spec.code_prefix}-{matrix.id:04d}"
    definition = rules.new_definition(spec)
    version = MatrixVersion(
        matrix_id=matrix.id, version_no=1, status=MatrixVersionStatus.DRAFT,
        schema_version=spec.schema_version, definition=definition,
        definition_hash=rules.definition_hash(definition), created_by_user_id=principal.user_id,
        source=MatrixVersionSource.PORTAL,
        scopes=[MatrixVersionScope(plant_id=a.plant_id, department_id=a.department_id)
                for a in applicability],
    )
    db.add(version)
    db.flush()
    if spec.code == "KPI_SCORING":
        _create_policy_handle(db, matrix, clean)
    _audit(db, actor, matrix, "matrix.create", f"Created {spec.name.lower()} {_label(matrix)}",
           version=version, changes={"attributes": clean,
                                     "applicability": [[a.plant_id, a.department_id]
                                                       for a in applicability]})
    db.expire(matrix)
    return get_matrix(db, principal, matrix.id)


def _create_policy_handle(db: Session, matrix: Matrix, attributes: Mapping[str, Any]) -> None:
    """KPIs refer to scoring POLICIES; each KPI-scoring matrix gets one."""
    policy = KpiScoringPolicy(code="pending", name=matrix.name, description=matrix.description,
                              direction=KpiDirection(attributes["direction"]), bands=[],
                              fallback_score=0, matrix_id=matrix.id)
    db.add(policy)
    db.flush()
    policy.code = f"POL-{policy.id:03d}"


def policy_for(db: Session, matrix: Matrix) -> KpiScoringPolicy | None:
    return db.scalars(select(KpiScoringPolicy).where(KpiScoringPolicy.matrix_id == matrix.id)).first()


def update_matrix(db: Session, principal: Principal, actor: AuditActor, matrix_id: int, *,
                  name: str, description: str | None) -> Matrix:
    matrix = get_matrix(db, principal, matrix_id)
    _require_write(principal, _scopes_of(latest_version(matrix)))
    name = _norm_name(name)
    clash = db.scalar(select(Matrix.id).where(Matrix.matrix_type == matrix.matrix_type,
                                              Matrix.name == name, Matrix.id != matrix.id))
    if clash:
        raise ConflictError("Another matrix of this type already has this name.")
    before = {"name": matrix.name, "description": matrix.description}
    matrix.name, matrix.description = name, (description or "").strip() or None
    policy = policy_for(db, matrix)
    if policy is not None:
        if db.scalar(select(KpiScoringPolicy.id).where(KpiScoringPolicy.name == name,
                                                       KpiScoringPolicy.id != policy.id)):
            raise ConflictError("A scoring policy with this name already exists.")
        policy.name, policy.description = matrix.name, matrix.description
    db.flush()
    after = {"name": matrix.name, "description": matrix.description}
    _audit(db, actor, matrix, "matrix.update", f"Renamed or described {_label(matrix)}",
           changes={k: {"from": before[k], "to": after[k]} for k in before if before[k] != after[k]})
    return matrix


@dataclass(frozen=True)
class DraftContent:
    definition: Mapping[str, Any]
    effective_from: date | None
    effective_to: date | None
    applicability: Sequence[ApplicabilityInput]
    change_summary: str | None = None


@dataclass(frozen=True)
class UploadSource:
    file_name: str
    sha256: str
    template_version: int


def save_draft(db: Session, principal: Principal, actor: AuditActor, matrix: Matrix,
               version: MatrixVersion, content: DraftContent,
               upload: UploadSource | None = None) -> VersionCheck:
    """Replace a DRAFT's content. Saved even when invalid (drafts may be
    incomplete); the returned check says what still needs fixing."""
    if version.status != MatrixVersionStatus.DRAFT:
        raise ConflictError("Only a draft can be edited. Revise the matrix to change it.")
    _require_write(principal, _scopes_of(version))
    _check_scopes(db, content.applicability)
    _require_write(principal, content.applicability)
    if (content.effective_from and content.effective_to
            and content.effective_to < content.effective_from):
        raise ValidationFailedError([Issue("The end date is before the start date.",
                                           "effective_to")])
    spec = spec_for(matrix.matrix_type)
    before = _content_summary(version)
    version.definition = rules.jsonable(dict(content.definition))
    version.definition_hash = rules.definition_hash(version.definition)
    version.schema_version = spec.schema_version
    version.effective_from = content.effective_from
    version.effective_to = content.effective_to
    version.change_summary = (content.change_summary or "").strip()[:1000] or None
    new_keys = sorted((a.plant_id or 0, a.department_id or 0) for a in content.applicability)
    old_keys = sorted((s.plant_id or 0, s.department_id or 0) for s in version.scopes)
    if new_keys != old_keys:
        version.scopes.clear()
        db.flush()
        version.scopes.extend(MatrixVersionScope(plant_id=a.plant_id, department_id=a.department_id)
                              for a in content.applicability)
    if upload is not None:
        version.source = MatrixVersionSource.UPLOAD
        version.source_file_name = upload.file_name[:255]
        version.source_file_sha256 = upload.sha256
        version.template_version = upload.template_version
    db.flush()
    after = _content_summary(version)
    changes = {k: {"from": before[k], "to": after[k]} for k in after if before[k] != after[k]}
    if upload is not None:
        changes["upload"] = {"file": upload.file_name[:255], "sha256": upload.sha256,
                             "template_version": upload.template_version,
                             "schema_version": spec.schema_version}
    _audit(db, actor, matrix, "matrix_version.upload" if upload else "matrix_version.update",
           f"{'Uploaded' if upload else 'Saved'} draft {_label(matrix, version)}",
           version=version, changes=changes)
    return check_version(matrix, version)


# --- workflow ------------------------------------------------------------------------------

def submit(db: Session, principal: Principal, actor: AuditActor, matrix: Matrix,
           version: MatrixVersion) -> MatrixVersion:
    if version.status != MatrixVersionStatus.DRAFT:
        raise ConflictError("Only a draft can be submitted.")
    _require_write(principal, _scopes_of(version))
    check = check_version(matrix, version)
    if not check.ready:
        problems = check.report.errors + check.readiness
        raise ValidationFailedError([Issue(p.message, p.path) for p in problems])
    version.status = MatrixVersionStatus.SUBMITTED
    version.submitted_by_user_id = principal.user_id
    version.submitted_at = func.now()
    db.flush()
    _audit(db, actor, matrix, "matrix_version.submit",
           f"Submitted {_label(matrix, version)} for CHRO approval", version=version,
           changes={"content_sha256": version.definition_hash})
    return version


def withdraw(db: Session, principal: Principal, actor: AuditActor, matrix: Matrix,
             version: MatrixVersion) -> MatrixVersion:
    if version.status != MatrixVersionStatus.SUBMITTED:
        raise ConflictError("Only a submitted version can be withdrawn.")
    _require_write(principal, _scopes_of(version))
    version.status = MatrixVersionStatus.DRAFT
    version.submitted_by_user_id = None
    version.submitted_at = None
    db.flush()
    _audit(db, actor, matrix, "matrix_version.withdraw",
           f"Withdrew {_label(matrix, version)} to draft", version=version)
    return version


def _require_approver(principal: Principal, version: MatrixVersion) -> None:
    if not can_approve(principal, version):
        raise PermissionDeniedError("Only the CHRO can approve or reject matrix configurations.")
    if principal.user_id in (version.submitted_by_user_id, version.created_by_user_id):
        raise PermissionDeniedError("The approver must be a different person from the author "
                                    "and the submitter.")


def approve(db: Session, principal: Principal, actor: AuditActor, matrix: Matrix,
            version: MatrixVersion, note: str | None) -> MatrixVersion:
    if version.status != MatrixVersionStatus.SUBMITTED:
        raise ConflictError("Only a submitted version can be approved.")
    _require_approver(principal, version)
    check = check_version(matrix, version)
    if not check.ready:  # e.g. the type changed since submission
        problems = check.report.errors + check.readiness
        raise ValidationFailedError([Issue(p.message, p.path) for p in problems])
    version.status = MatrixVersionStatus.APPROVED
    version.approved_by_user_id = principal.user_id
    version.approved_at = func.now()
    version.approval_note = (note or "").strip()[:1000] or None
    db.flush()
    _audit(db, actor, matrix, "matrix_version.approve", f"Approved {_label(matrix, version)}",
           version=version, reason=version.approval_note,
           changes={"content_sha256": version.definition_hash})
    return version


def reject(db: Session, principal: Principal, actor: AuditActor, matrix: Matrix,
           version: MatrixVersion, reason: str) -> MatrixVersion:
    if version.status != MatrixVersionStatus.SUBMITTED:
        raise ConflictError("Only a submitted version can be rejected.")
    _require_approver(principal, version)
    if not reason.strip():
        raise ValidationFailedError([Issue("Give a reason for rejecting.", "reason")])
    version.status = MatrixVersionStatus.REJECTED
    version.rejected_by_user_id = principal.user_id
    version.rejected_at = func.now()
    version.rejection_reason = reason.strip()[:1000]
    db.flush()
    _audit(db, actor, matrix, "matrix_version.reject", f"Rejected {_label(matrix, version)}",
           version=version, reason=version.rejection_reason)
    return version


def _dates_overlap(a_from: date, a_to: date | None, b_from: date, b_to: date | None) -> bool:
    return (a_to is None or a_to >= b_from) and (b_to is None or b_to >= a_from)


def _scopes_overlap(a: Sequence[ApplicabilityInput], b: Sequence[ApplicabilityInput]) -> bool:
    return any(
        (x.plant_id is None or y.plant_id is None or x.plant_id == y.plant_id)
        and (x.department_id is None or y.department_id is None
             or x.department_id == y.department_id)
        for x in a for y in b
    )


def publish(db: Session, principal: Principal, actor: AuditActor, matrix: Matrix,
            version: MatrixVersion) -> MatrixVersion:
    """Put an approved version in force from its effective date."""
    if version.status != MatrixVersionStatus.APPROVED:
        raise ConflictError("Only an approved version can be published.")
    scopes = _scopes_of(version)
    if not (_covers(principal, Permission.MATRIX_WRITE, scopes)
            or _covers(principal, Permission.MATRIX_APPROVE, scopes)):
        raise PermissionDeniedError("Only an HR Head or the CHRO can publish this configuration.")
    start, end = version.effective_from, version.effective_to
    if start is None:
        raise ValidationFailedError([Issue("Set the effective date first.", "effective_from")])
    ended, superseded = [], []
    for other in matrix.versions:
        if other.id == version.id or other.status != MatrixVersionStatus.PUBLISHED:
            continue
        o_from, o_to = other.effective_from, other.effective_to
        if not _dates_overlap(start, end, o_from, o_to):
            continue
        runs_past_end = end is not None and (o_to is None or o_to > end)
        if runs_past_end:
            raise ConflictError(
                f"Version {other.version_no} would still apply after this version ends "
                f"({end.isoformat()}). Leave this version open-ended, or revise version "
                f"{other.version_no} instead.")
        if o_from >= start:
            other.status = MatrixVersionStatus.SUPERSEDED
            other.superseded_at = func.now()
            superseded.append(other.version_no)
        else:
            other.effective_to = start - timedelta(days=1)
            ended.append({"version_no": other.version_no, "effective_to": other.effective_to})
    spec = spec_for(matrix.matrix_type)
    if spec.selection == Selection.APPLICABILITY:
        clashes = db.scalars(
            select(MatrixVersion).join(Matrix)
            .where(Matrix.matrix_type == matrix.matrix_type, Matrix.id != matrix.id,
                   MatrixVersion.status == MatrixVersionStatus.PUBLISHED)
            .options(selectinload(MatrixVersion.scopes), selectinload(MatrixVersion.matrix))
        ).all()
        for other in clashes:
            if (_dates_overlap(start, end, other.effective_from, other.effective_to)
                    and _scopes_overlap(scopes, _scopes_of(other))):
                raise ConflictError(
                    f"{other.matrix.code} '{other.matrix.name}' version {other.version_no} "
                    "already applies to part of the same plants, departments and dates. Only one "
                    f"{spec.name.lower()} may apply at a time.")
    version.status = MatrixVersionStatus.PUBLISHED
    version.published_by_user_id = principal.user_id
    version.published_at = func.now()
    db.flush()
    _audit(db, actor, matrix, "matrix_version.publish",
           f"Published {_label(matrix, version)} from {start.isoformat()}", version=version,
           changes={"effective_from": start, "effective_to": end,
                    "content_sha256": version.definition_hash,
                    "earlier_versions_ended": ended, "superseded_versions": superseded})
    return version


def revise(db: Session, principal: Principal, actor: AuditActor, matrix: Matrix) -> MatrixVersion:
    """A new DRAFT copied from the latest version (content and applicability)."""
    if open_version(matrix) is not None:
        raise ConflictError("Finish or withdraw the open draft before starting a new revision.")
    base = latest_version(matrix)
    scopes = _scopes_of(base)
    _require_write(principal, scopes)
    spec = spec_for(matrix.matrix_type)
    definition = dict(base.definition)
    try:
        definition = rules.migrate_definition(spec, definition, base.schema_version)
    except rules.SchemaMismatch:
        pass  # copied as-is; validation reports what must change
    version = MatrixVersion(
        matrix_id=matrix.id, version_no=base.version_no + 1, status=MatrixVersionStatus.DRAFT,
        schema_version=spec.schema_version, definition=definition,
        definition_hash=rules.definition_hash(definition), created_by_user_id=principal.user_id,
        source=MatrixVersionSource.PORTAL,
        scopes=[MatrixVersionScope(plant_id=a.plant_id, department_id=a.department_id)
                for a in scopes],
    )
    db.add(version)
    db.flush()
    _audit(db, actor, matrix, "matrix_version.revise",
           f"Started revision {_label(matrix, version)} from version {base.version_no}",
           version=version, changes={"based_on_version": base.version_no})
    db.expire(matrix)
    return version
