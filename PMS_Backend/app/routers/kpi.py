"""KPI management API: scoring policies, KPI library, quarterly sheets,
Excel upload, quarter locking and deviations."""
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import AuditActorDep, CurrentPrincipal, OrgScope, get_current_user
from app.auth.permissions import Permission, Principal
from app.dependencies import get_db, transaction
from app.models import (
    DeviationStatus,
    EmployeeAssignment,
    KpiApplicability,
    KpiDefinition,
    KpiDeviation,
    KpiScoringPolicy,
    KpiSheet,
    KpiSheetStatus,
    MatrixVersion,
    PmsCycle,
    PmsCycleQuarter,
    QuarterStatus,
    User,
)
from app.schemas.employee import DesignationRef, EmployeeRef
from app.schemas.jd import ReasonRequest, UserRef
from app.schemas.kpi import (
    ApplicabilityRead,
    AssignmentBrief,
    CopyRequest,
    DeviationApprove,
    DeviationCreate,
    DeviationRead,
    IssueRead,
    ItemMatrixVersion,
    JDRef,
    KpiRead,
    KpiRef,
    KpiWrite,
    MatrixVersionBrief,
    PolicyMatrix,
    PolicyRead,
    PolicyRef,
    PolicyWrite,
    PreviewRequest,
    PreviewResult,
    QuarterRead,
    SheetBrief,
    SheetCreate,
    SheetItemIn,
    SheetItemRead,
    SheetList,
    SheetRead,
    SheetRow,
    SheetSaved,
    SheetUpdate,
    StartScoringResult,
    UploadConfirmed,
    UploadItemRead,
    UploadPreviewRead,
    UploadSheetRead,
)
from app.schemas.organization import DepartmentRef, PlantRef
from app.services import clock, kpi_library, kpi_sheets, kpi_upload, matrix_service
from app.services.errors import Issue, ValidationFailedError
from app.services.kpi_sheets import ItemInput

router = APIRouter(prefix="/api/kpi", tags=["kpi"], dependencies=[Depends(get_current_user)])
DbSession = Annotated[Session, Depends(get_db)]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# --- builders ------------------------------------------------------------------------------

def _applicability_label(a: KpiApplicability) -> str:
    if a.plant and a.department:
        return f"{a.department.name} — {a.plant.name}"
    if a.department:
        return f"{a.department.name}: all plants"
    if a.plant:
        return f"{a.plant.name}: all departments"
    return "Company-wide"


def _kpi(kpi: KpiDefinition) -> KpiRead:
    return KpiRead(
        id=kpi.id, code=kpi.code, name=kpi.name, direction=kpi.direction, description=kpi.description,
        unit=kpi.unit, default_scoring_policy=PolicyRef.model_validate(kpi.default_scoring_policy),
        data_source=kpi.data_source, is_active=kpi.is_active,
        reporting_frequency=kpi.reporting_frequency, aggregation=kpi.aggregation,
        measurement_method=kpi.measurement_method,
        applicability=[
            ApplicabilityRead(plant=PlantRef.model_validate(a.plant) if a.plant else None,
                              department=DepartmentRef.model_validate(a.department) if a.department else None,
                              label=_applicability_label(a))
            for a in kpi.applicabilities
        ],
    )


def _quarter(q: PmsCycleQuarter, cycle: PmsCycle | None = None) -> QuarterRead:
    cycle = cycle or q.cycle
    return QuarterRead(id=q.id, cycle_code=cycle.code, cycle_name=cycle.name, quarter_number=q.quarter_number,
                       name=q.name, start_date=q.start_date, end_date=q.end_date, status=q.status)


def _assignment(a: EmployeeAssignment) -> AssignmentBrief:
    unit = a.plant_department
    return AssignmentBrief(id=a.id, employee=EmployeeRef.model_validate(a.employee),
                           plant=PlantRef.model_validate(unit.plant),
                           department=DepartmentRef.model_validate(unit.department),
                           designation=DesignationRef.model_validate(a.designation), is_primary=a.is_primary)


def _can_write(principal: Principal, sheet: KpiSheet) -> bool:
    unit = sheet.assignment.plant_department
    return principal.scope_for(Permission.KPI_WRITE).allows_unit(unit.plant_id, unit.department_id)


def _sheet(db: Session, principal: Principal, sheet: KpiSheet, warnings: list[str] | None = None) -> SheetRead:
    if warnings is None:
        items = [ItemInput(i.kpi_definition_id, i.weightage, i.target_value, i.target_note, i.unit,
                           i.scoring_policy_id) for i in sheet.items]
        warnings = kpi_sheets.check_items(db, sheet.assignment, items, for_publish=False)[0].warnings
    pending = db.scalar(select(KpiDeviation.id).where(KpiDeviation.sheet_id == sheet.id,
                                                       KpiDeviation.status == DeviationStatus.PENDING))
    writable = _can_write(principal, sheet)
    started = sheet.quarter.status != QuarterStatus.DRAFT
    return SheetRead(
        id=sheet.id, status=sheet.status, quarter=_quarter(sheet.quarter),
        assignment=_assignment(sheet.assignment),
        job_description=JDRef(id=sheet.job_description.id, code=sheet.job_description.code,
                              title=sheet.job_description.title) if sheet.job_description else None,
        notes=sheet.notes,
        items=[SheetItemRead(
            id=i.id, kpi=KpiRef.model_validate(i.kpi_definition), weightage=float(i.weightage),
            target_value=None if i.target_value is None else float(i.target_value), target_note=i.target_note,
            unit=i.unit, scoring_policy=PolicyRef.model_validate(i.scoring_policy),
            frozen=i.scoring_snapshot is not None,
            matrix_version=ItemMatrixVersion(
                id=i.matrix_version.id, matrix_id=i.matrix_version.matrix_id,
                matrix_code=i.matrix_version.matrix.code, version_no=i.matrix_version.version_no,
            ) if i.matrix_version is not None else None,
            measurement=i.measurement_snapshot) for i in sheet.items],
        total=float(kpi_sheets.weight_total([i.weightage for i in sheet.items])),
        warnings=warnings, published_at=sheet.published_at, locked_at=sheet.locked_at,
        can_edit=writable and not started and sheet.status == KpiSheetStatus.DRAFT,
        can_request_deviation=writable and started and pending is None,
        pending_deviation_id=pending,
    )


def _items(body_items: list[SheetItemIn]) -> list[ItemInput]:
    return [ItemInput(i.kpi_definition_id, i.weightage, i.target_value, i.target_note, i.unit,
                      i.scoring_policy_id) for i in body_items]


def _deviation(db: Session, d: KpiDeviation) -> DeviationRead:
    ids = {d.requested_by_user_id, d.hr_approved_by_user_id, d.plant_approved_by_user_id, d.rejected_by_user_id}
    users = {u.id: UserRef(id=u.id, username=u.username)
             for u in db.scalars(select(User).where(User.id.in_(sorted(i for i in ids if i) or [0])))}
    names = {k.id: k.name for k in db.scalars(select(KpiDefinition).where(KpiDefinition.id.in_(
        sorted({i["kpi_definition_id"] for i in d.original_items + d.proposed_items}) or [0])))}
    unit = d.sheet.assignment.plant_department

    def named(items: list[dict]) -> list[dict]:
        return [{**i, "kpi": names.get(i["kpi_definition_id"], i.get("kpi"))} for i in items]

    return DeviationRead(
        id=d.id, status=d.status, sheet_id=d.sheet_id, employee=EmployeeRef.model_validate(d.sheet.assignment.employee),
        plant=PlantRef.model_validate(unit.plant), department=DepartmentRef.model_validate(unit.department),
        quarter_name=d.sheet.quarter.name, reason=d.reason, original_items=named(d.original_items),
        proposed_items=named(d.proposed_items), requested_by=users.get(d.requested_by_user_id),
        requested_at=d.requested_at, hr_approved_by=users.get(d.hr_approved_by_user_id),
        hr_approved_at=d.hr_approved_at, plant_approved_by=users.get(d.plant_approved_by_user_id),
        plant_approved_at=d.plant_approved_at, rejected_by=users.get(d.rejected_by_user_id),
        rejected_at=d.rejected_at, rejection_reason=d.rejection_reason, applied_at=d.applied_at,
    )


# --- scoring policies ----------------------------------------------------------------------

def _brief(version: MatrixVersion | None) -> MatrixVersionBrief | None:
    if version is None:
        return None
    return MatrixVersionBrief(id=version.id, version_no=version.version_no, status=version.status,
                              effective_from=version.effective_from,
                              effective_to=version.effective_to)


def _policy(db: Session, policy: KpiScoringPolicy) -> PolicyRead:
    matrix = kpi_library.policy_matrix(db, policy)
    return PolicyRead(
        id=policy.id, code=policy.code, name=policy.name, description=policy.description,
        direction=policy.direction, bands=policy.bands, fallback_score=policy.fallback_score,
        met_score=policy.met_score, breached_score=policy.breached_score,
        is_active=policy.is_active,
        matrix=PolicyMatrix(
            id=matrix.id, code=matrix.code,
            in_force=_brief(matrix_service.version_in_force(matrix, clock.today())),
            latest=_brief(matrix_service.latest_version(matrix)),
        ) if matrix is not None else None,
    )


@router.get("/policies", response_model=list[PolicyRead])
def list_policies(db: DbSession, _scope: OrgScope, include_inactive: bool = False):
    return [_policy(db, p) for p in kpi_library.list_policies(db, include_inactive)]


@router.post("/policies", response_model=PolicyRead, status_code=status.HTTP_201_CREATED)
def create_policy(body: PolicyWrite, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    """Creates a KPI-scoring matrix from bands as a DRAFT; it scores nothing
    until the CHRO approves it and it is published."""
    with transaction(db):
        policy = kpi_library.create_policy(db, principal, actor, body.model_dump())
    return _policy(db, policy)


@router.put("/policies/{policy_id}", response_model=PolicyRead)
def update_policy(policy_id: int, body: PolicyWrite, db: DbSession, principal: CurrentPrincipal,
                  actor: AuditActorDep):
    """Writes the bands to the policy matrix's draft (or a new draft revision)."""
    with transaction(db):
        policy = kpi_library.update_policy(db, principal, actor, policy_id, body.model_dump())
    return _policy(db, policy)


@router.post("/policies/{policy_id}/preview", response_model=PreviewResult)
def preview_policy(policy_id: int, body: PreviewRequest, db: DbSession, _scope: OrgScope):
    """Score for an achievement % (or an actual value, e.g. incidents), using
    the matrix version in force today, else the latest version."""
    policy = kpi_library.get_policy(db, policy_id)
    try:
        result = kpi_library.preview_policy(
            db, policy,
            achievement=None if body.achievement_percent is None else Decimal(str(body.achievement_percent)),
            actual=None if body.actual is None else Decimal(str(body.actual)),
        )
    except ValueError as exc:
        raise ValidationFailedError([Issue(str(exc))]) from None
    return PreviewResult(**result)


# --- KPI library ---------------------------------------------------------------------------

def _scopes(body: KpiWrite) -> list[kpi_library.ApplicabilityInput]:
    return [kpi_library.ApplicabilityInput(a.plant_id, a.department_id) for a in body.applicability]


@router.get("/library", response_model=list[KpiRead])
def list_kpis(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope, plant_id: int | None = None,
              department_id: int | None = None, search: Annotated[str | None, Query(max_length=100)] = None,
              include_inactive: bool = False):
    return [_kpi(k) for k in kpi_library.list_definitions(db, principal, plant_id=plant_id,
                                                          department_id=department_id, search=search,
                                                          include_inactive=include_inactive)]


@router.post("/library", response_model=KpiRead, status_code=status.HTTP_201_CREATED)
def create_kpi(body: KpiWrite, db: DbSession, principal: CurrentPrincipal, _scope: OrgScope,
               actor: AuditActorDep):
    with transaction(db):
        kpi = kpi_library.create_definition(db, principal, actor, body.model_dump(exclude={"applicability"}),
                                            _scopes(body))
    return _kpi(kpi_library.get_definition(db, principal, kpi.id))


@router.get("/library/{kpi_id}", response_model=KpiRead)
def get_kpi(kpi_id: int, db: DbSession, principal: CurrentPrincipal, _scope: OrgScope):
    return _kpi(kpi_library.get_definition(db, principal, kpi_id))


@router.put("/library/{kpi_id}", response_model=KpiRead)
def update_kpi(kpi_id: int, body: KpiWrite, db: DbSession, principal: CurrentPrincipal, _scope: OrgScope,
               actor: AuditActorDep):
    with transaction(db):
        kpi_library.update_definition(db, principal, actor, kpi_id, body.model_dump(exclude={"applicability"}),
                                      _scopes(body))
    return _kpi(kpi_library.get_definition(db, principal, kpi_id))


# --- quarters ------------------------------------------------------------------------------

@router.get("/quarters", response_model=list[QuarterRead])
def list_quarters(db: DbSession, _scope: OrgScope):
    rows = db.execute(select(PmsCycleQuarter, PmsCycle).join(PmsCycle, PmsCycleQuarter.cycle_id == PmsCycle.id)
                      .order_by(PmsCycle.start_date.desc(), PmsCycleQuarter.quarter_number)).all()
    return [_quarter(q, c) for q, c in rows]


@router.post("/quarters/{quarter_id}/start-scoring", response_model=StartScoringResult)
def start_scoring(quarter_id: int, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    """Lock the quarter's KPI configuration (HR Head / CHRO / Admin, company-wide)."""
    with transaction(db):
        result = kpi_sheets.start_scoring(db, principal, actor, quarter_id)
    return StartScoringResult(quarter=_quarter(kpi_sheets.get_quarter(db, quarter_id)), **result)


# --- sheets --------------------------------------------------------------------------------

@router.get("/sheets", response_model=SheetList)
def list_sheets(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope, quarter_id: int,
                plant_id: int | None = None, department_id: int | None = None,
                search: Annotated[str | None, Query(max_length=100)] = None):
    quarter, rows = kpi_sheets.list_sheet_rows(db, principal, quarter_id, plant_id=plant_id,
                                               department_id=department_id, search=search)
    return SheetList(quarter=_quarter(quarter), rows=[
        SheetRow(assignment=_assignment(r.assignment), sheet=SheetBrief(
            id=r.sheet.id, status=r.sheet.status, item_count=len(r.sheet.items),
            total=float(kpi_sheets.weight_total([i.weightage for i in r.sheet.items]))) if r.sheet else None)
        for r in rows
    ])


@router.post("/sheets", response_model=SheetRead, status_code=status.HTTP_201_CREATED)
def create_sheet(body: SheetCreate, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        sheet = kpi_sheets.create_sheet(db, principal, actor, assignment_id=body.assignment_id,
                                        quarter_id=body.quarter_id, job_description_id=body.job_description_id)
    return _sheet(db, principal, kpi_sheets.get_sheet(db, principal, sheet.id))


@router.get("/sheets/{sheet_id}", response_model=SheetRead)
def get_sheet(sheet_id: int, db: DbSession, principal: CurrentPrincipal):
    """Visible to org readers in scope and to the employee (self-service)."""
    return _sheet(db, principal, kpi_sheets.get_sheet(db, principal, sheet_id))


@router.put("/sheets/{sheet_id}", response_model=SheetSaved)
def update_sheet(sheet_id: int, body: SheetUpdate, db: DbSession, principal: CurrentPrincipal,
                 actor: AuditActorDep):
    with transaction(db):
        sheet, check = kpi_sheets.replace_items(db, principal, actor, sheet_id, _items(body.items),
                                                notes=body.notes, job_description_id=body.job_description_id)
    sheet = kpi_sheets.get_sheet(db, principal, sheet_id)
    return SheetSaved(sheet=_sheet(db, principal, sheet, check.warnings), warnings=check.warnings)


@router.post("/sheets/{sheet_id}/publish", response_model=SheetRead)
def publish_sheet(sheet_id: int, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        kpi_sheets.publish(db, principal, actor, sheet_id)
    return _sheet(db, principal, kpi_sheets.get_sheet(db, principal, sheet_id))


@router.post("/sheets/{sheet_id}/reopen", response_model=SheetRead)
def reopen_sheet(sheet_id: int, body: ReasonRequest, db: DbSession, principal: CurrentPrincipal,
                 actor: AuditActorDep):
    with transaction(db):
        kpi_sheets.reopen(db, principal, actor, sheet_id, body.reason)
    return _sheet(db, principal, kpi_sheets.get_sheet(db, principal, sheet_id))


@router.post("/sheets/{sheet_id}/copy", response_model=SheetRead, status_code=status.HTTP_201_CREATED)
def copy_sheet(sheet_id: int, body: CopyRequest, db: DbSession, principal: CurrentPrincipal,
               actor: AuditActorDep):
    with transaction(db):
        sheet = kpi_sheets.copy_to_quarter(db, principal, actor, sheet_id, body.target_quarter_id)
    return _sheet(db, principal, kpi_sheets.get_sheet(db, principal, sheet.id))


# --- Excel upload ------------------------------------------------------------------------------

@router.get("/uploads/template")
def upload_template(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope) -> Response:
    return Response(content=kpi_upload.template(db, principal), media_type=XLSX,
                    headers={"Content-Disposition": 'attachment; filename="kpi-upload-template.xlsx"'})


def _read_upload(file: UploadFile) -> bytes:
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise ValidationFailedError([Issue("Upload an Excel workbook (.xlsx).")])
    return file.file.read(kpi_upload.MAX_BYTES + 1)


def _preview(db: Session, quarter_id: int, result: kpi_upload.UploadResult) -> UploadPreviewRead:
    return UploadPreviewRead(
        quarter=_quarter(kpi_sheets.get_quarter(db, quarter_id)),
        row_count=result.row_count,
        issues=[IssueRead(message=i.message, field=i.field, row=i.row) for i in result.issues],
        sheets=[UploadSheetRead(
            employee=EmployeeRef.model_validate(s.assignment.employee),
            plant=PlantRef.model_validate(s.assignment.plant_department.plant),
            department=DepartmentRef.model_validate(s.assignment.plant_department.department),
            action="replace" if s.existing else "create",
            items=[UploadItemRead(row=i.row, kpi_name=i.kpi_name, weightage=float(i.weightage),
                                  target_value=None if i.target_value is None else float(i.target_value),
                                  unit=i.unit, scoring_policy=i.scoring_policy, target_note=i.target_note)
                   for i in s.items],
            total=float(s.total)) for s in result.sheets],
    )


@router.post("/uploads/preview", response_model=UploadPreviewRead)
def upload_preview(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope,
                   quarter_id: Annotated[int, Form()], file: Annotated[UploadFile, File()]):
    """Validate an upload without saving anything."""
    rows = kpi_upload.read_rows(_read_upload(file))
    return _preview(db, quarter_id, kpi_upload.validate(db, principal, quarter_id, rows))


@router.post("/uploads/confirm", response_model=UploadConfirmed)
def upload_confirm(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope, actor: AuditActorDep,
                   quarter_id: Annotated[int, Form()], file: Annotated[UploadFile, File()]):
    """Re-validate and save every sheet in the file as DRAFT, all or nothing."""
    rows = kpi_upload.read_rows(_read_upload(file))
    with transaction(db):
        result = kpi_upload.confirm(db, principal, actor, quarter_id, rows, file.filename or "upload.xlsx")
    return UploadConfirmed(**result)


# --- deviations ----------------------------------------------------------------------------------

@router.get("/deviations", response_model=list[DeviationRead])
def list_deviations(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope,
                    status_filter: Annotated[DeviationStatus | None, Query(alias="status")] = None):
    return [_deviation(db, d) for d in kpi_sheets.list_deviations(db, principal, status=status_filter)]


@router.post("/deviations", response_model=DeviationRead, status_code=status.HTTP_201_CREATED)
def request_deviation(body: DeviationCreate, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        deviation = kpi_sheets.request_deviation(db, principal, actor, body.sheet_id, body.reason,
                                                 _items(body.items))
    return _deviation(db, kpi_sheets.get_deviation(db, principal, deviation.id))


@router.get("/deviations/{deviation_id}", response_model=DeviationRead)
def get_deviation(deviation_id: int, db: DbSession, principal: CurrentPrincipal, _scope: OrgScope):
    return _deviation(db, kpi_sheets.get_deviation(db, principal, deviation_id))


@router.post("/deviations/{deviation_id}/approve", response_model=DeviationRead)
def approve_deviation(deviation_id: int, body: DeviationApprove, db: DbSession, principal: CurrentPrincipal,
                      actor: AuditActorDep):
    """Approve as HR Head or Plant Head; the change applies when both have approved."""
    with transaction(db):
        kpi_sheets.approve_deviation(db, principal, actor, deviation_id, body.as_role)
    return _deviation(db, kpi_sheets.get_deviation(db, principal, deviation_id))


@router.post("/deviations/{deviation_id}/reject", response_model=DeviationRead)
def reject_deviation(deviation_id: int, body: ReasonRequest, db: DbSession, principal: CurrentPrincipal,
                     actor: AuditActorDep):
    with transaction(db):
        kpi_sheets.reject_deviation(db, principal, actor, deviation_id, body.reason)
    return _deviation(db, kpi_sheets.get_deviation(db, principal, deviation_id))
