"""Monthly KPI data import and quarterly results API (Stage K)."""
import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import AuditActorDep, CurrentPrincipal, OrgScope, get_current_user
from app.auth.permissions import Permission, Principal
from app.dependencies import get_db, transaction
from app.models import KpiScoreOverride, KpiSheet, ScoreOverrideStatus, ScoreResultStatus, User
from app.routers.kpi import _assignment, _quarter
from app.schemas.employee import EmployeeRef
from app.schemas.jd import ReasonRequest, UserRef
from app.schemas.kpi import DeviationApprove, IssueRead
from app.schemas.kpi_scores import (
    CalculateRequest,
    CalculateResult,
    ContractFieldRead,
    DuplicateImport,
    ImportConfirmed,
    ImportLineRead,
    ImportPreviewRead,
    ImportRead,
    MonthlyValueRead,
    OverrideCreate,
    OverrideRead,
    ResultActions,
    ResultBrief,
    ResultList,
    ResultRead,
    ResultRow,
    ResultSheet,
)
from app.schemas.organization import DepartmentRef, PlantRef
from app.services import kpi_data, kpi_results
from app.services import matrix_rules as rules
from app.services.errors import Issue, ValidationFailedError
from app.services.kpi_sheets import COLLECTION_STATUSES, REVIEW_STATUSES, get_quarter

router = APIRouter(prefix="/api/kpi", tags=["kpi scores"], dependencies=[Depends(get_current_user)])
DbSession = Annotated[Session, Depends(get_db)]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_LINES = 500


def _num(value: Any) -> str | None:
    return None if value is None else rules.decimal_text(value)


def _users(db: Session, ids: set[int | None]) -> dict[int, UserRef]:
    wanted = sorted(i for i in ids if i)
    if not wanted:
        return {}
    return {u.id: UserRef(id=u.id, username=u.username)
            for u in db.scalars(select(User).where(User.id.in_(wanted)))}


# --- monthly data ----------------------------------------------------------------------------

def _mapping(text: str | None) -> dict[str, str | None] | None:
    if not text:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        raise ValidationFailedError([Issue("The column mapping is not valid JSON.", "mapping")]) from None
    if not isinstance(data, dict) or not all(
            isinstance(k, str) and (v is None or isinstance(v, str)) for k, v in data.items()):
        raise ValidationFailedError([Issue("The column mapping must map field keys to column "
                                           "names.", "mapping")])
    return data


def _read(file: UploadFile) -> bytes:
    return file.file.read(kpi_data.MAX_BYTES + 1)


@router.get("/data/template")
def data_template(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope, quarter_id: int,
                  period: Annotated[str, Query(pattern=r"^\d{4}-\d{2}$")]) -> Response:
    """A workbook pre-filled with the KPIs needing data for the month."""
    content = kpi_data.build_template(db, principal, quarter_id, period)
    return Response(content=content, media_type=XLSX, headers={
        "Content-Disposition": f'attachment; filename="kpi-data-{period}.xlsx"'})


def _preview(check: kpi_data.ImportCheck) -> ImportPreviewRead:
    return ImportPreviewRead(
        quarter=_quarter(check.quarter), period=f"{check.period:%Y-%m}", file_name=check.file_name,
        file_format=check.file_format, columns=check.columns,
        contract=[ContractFieldRead(key=c.key, label=c.label, required=c.required,
                                    description=c.description) for c in check.contract],
        mapping=check.mapping, row_count=check.row_count,
        counts={a: check.count(a) for a in ("new", "replace", "unchanged")},
        issues=[IssueRead(message=i.message, field=i.field, row=i.row) for i in check.issues],
        warnings=check.warnings,
        lines=[ImportLineRead(row=line.row, employee_code=line.employee_code,
                              employee_name=line.employee_name, assignment=line.unit_label,
                              kpi_code=line.kpi_code, kpi_name=line.kpi_name,
                              actual=_num(line.actual), inputs=line.inputs, action=line.action,
                              previous_actual=_num(line.previous_actual), note=line.note)
               for line in check.lines[:MAX_LINES]],
        lines_truncated=len(check.lines) > MAX_LINES,
        duplicate_import=DuplicateImport(id=check.duplicate_of.id,
                                         file_name=check.duplicate_of.file_name,
                                         created_at=check.duplicate_of.created_at)
        if check.duplicate_of else None,
        ready=check.ready,
    )


@router.post("/data/preview", response_model=ImportPreviewRead)
def data_preview(db: DbSession, principal: CurrentPrincipal,
                 quarter_id: Annotated[int, Form()], period: Annotated[str, Form()],
                 file: Annotated[UploadFile, File()],
                 mapping: Annotated[str | None, Form()] = None,
                 replace_existing: Annotated[bool, Form()] = False):
    """Validate a monthly data file; nothing is saved."""
    check = kpi_data.check_import(db, principal, quarter_id=quarter_id, period=period,
                                  file_name=file.filename or "data", data=_read(file),
                                  mapping=_mapping(mapping), replace_existing=replace_existing)
    return _preview(check)


@router.post("/data/confirm", response_model=ImportConfirmed)
def data_confirm(db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep,
                 quarter_id: Annotated[int, Form()], period: Annotated[str, Form()],
                 file: Annotated[UploadFile, File()],
                 mapping: Annotated[str | None, Form()] = None,
                 replace_existing: Annotated[bool, Form()] = False):
    """Re-validate and store every value of the file, or none."""
    data = _read(file)
    with transaction(db):
        record = kpi_data.confirm_import(db, principal, actor, quarter_id=quarter_id, period=period,
                                         file_name=file.filename or "data", data=data,
                                         mapping=_mapping(mapping),
                                         replace_existing=replace_existing)
        result = ImportConfirmed(import_id=record.id, created=record.rows_created,
                                 replaced=record.rows_replaced, unchanged=record.rows_unchanged,
                                 rows=record.row_count)
    return result


@router.get("/data/imports", response_model=list[ImportRead])
def list_imports(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope, quarter_id: int):
    return [ImportRead(id=r.id, period=f"{r.period_month:%Y-%m}", file_name=r.file_name,
                       file_format=r.file_format, file_size=r.file_size, row_count=r.row_count,
                       rows_created=r.rows_created, rows_replaced=r.rows_replaced,
                       rows_unchanged=r.rows_unchanged, created_by=username,
                       created_at=r.created_at)
            for r, username in kpi_data.list_imports(db, principal, quarter_id)]


@router.get("/sheets/{sheet_id}/values", response_model=list[MonthlyValueRead])
def sheet_values(sheet_id: int, db: DbSession, principal: CurrentPrincipal):
    """The imported source values of a sheet (readers of the sheet)."""
    kpi_results.get_sheet(db, principal, sheet_id)
    return [MonthlyValueRead(kpi_id=v.kpi_definition_id, kpi_code=v.kpi_definition.code,
                             kpi_name=v.kpi_definition.name, period=f"{v.period_month:%Y-%m}",
                             actual=_num(v.actual_value), inputs=v.input_values,
                             import_id=v.data_import_id,
                             file_name=v.data_import.file_name if v.data_import else None,
                             source_row=v.source_row)
            for v in kpi_data.sheet_values(db, sheet_id)]


# --- results ---------------------------------------------------------------------------------

def _brief(view: kpi_results.ResultView) -> ResultBrief | None:
    r = view.result
    if r is None:
        return None
    return ResultBrief(status=r.status, is_complete=r.is_complete, stale=view.stale,
                       calculated_score=_num(r.calculated_score), final_score=_num(r.final_score),
                       override_score=_num(r.override_score),
                       published_score=_num(r.published_score), calculated_at=r.calculated_at,
                       reviewed_at=r.reviewed_at, published_at=r.published_at,
                       pending_override_id=view.pending_override.id if view.pending_override else None)


def _override(db: Session, override: KpiScoreOverride, sheet: KpiSheet) -> OverrideRead:
    users = _users(db, {override.requested_by_user_id, override.hr_approved_by_user_id,
                        override.plant_approved_by_user_id, override.rejected_by_user_id})
    unit = sheet.assignment.plant_department
    return OverrideRead(
        id=override.id, status=override.status, sheet_id=sheet.id,
        employee=EmployeeRef.model_validate(sheet.assignment.employee),
        plant=PlantRef.model_validate(unit.plant), department=DepartmentRef.model_validate(unit.department),
        quarter_name=sheet.quarter.name, original_score=_num(override.original_score),
        proposed_score=_num(override.proposed_score), reason=override.reason,
        requested_by=users.get(override.requested_by_user_id), requested_at=override.requested_at,
        hr_approved_by=users.get(override.hr_approved_by_user_id),
        hr_approved_at=override.hr_approved_at,
        plant_approved_by=users.get(override.plant_approved_by_user_id),
        plant_approved_at=override.plant_approved_at,
        rejected_by=users.get(override.rejected_by_user_id), rejected_at=override.rejected_at,
        rejection_reason=override.rejection_reason, applied_at=override.applied_at,
        voided_at=override.voided_at)


def _result_read(db: Session, principal: Principal, view: kpi_results.ResultView) -> ResultRead:
    sheet, result = view.sheet, view.result
    unit = sheet.assignment.plant_department
    writer = principal.scope_for(Permission.KPI_WRITE).allows_unit(unit.plant_id, unit.department_id)
    ready = (result is not None and not view.stale and result.is_complete
             and sheet.status.value == "LOCKED" and view.pending_override is None)
    collecting = sheet.quarter.status in COLLECTION_STATUSES
    reviewing = sheet.quarter.status in REVIEW_STATUSES
    users = _users(db, {result.calculated_by_user_id, result.reviewed_by_user_id,
                        result.published_by_user_id} if result else set())
    explanation = result.explanation if result else {}
    return ResultRead(
        sheet=ResultSheet(id=sheet.id, status=sheet.status), quarter=_quarter(sheet.quarter),
        assignment=_assignment(sheet.assignment), result=_brief(view),
        months=explanation.get("months") or [f"{m:%Y-%m}" for m in
                                             kpi_results.expected_months(sheet)],
        items=explanation.get("items") or [],
        calculated_by=users.get(result.calculated_by_user_id) if result else None,
        reviewed_by=users.get(result.reviewed_by_user_id) if result else None,
        published_by=users.get(result.published_by_user_id) if result else None,
        pending_override=_override(db, view.pending_override, sheet) if view.pending_override else None,
        applied_override=_override(db, view.applied_override, sheet) if view.applied_override else None,
        actions=ResultActions(
            can_calculate=writer and collecting
            and (result is None or result.status != ScoreResultStatus.PUBLISHED),
            can_review=writer and reviewing and ready
            and result.status == ScoreResultStatus.CALCULATED
            and not kpi_results.is_own(principal, sheet),
            # Published with the whole quarter (Stage L), never per sheet.
            can_publish=False,
            can_request_override=writer and reviewing and result is not None and not view.stale
            and result.is_complete and result.status != ScoreResultStatus.PUBLISHED
            and view.pending_override is None),
    )


@router.post("/results/calculate", response_model=CalculateResult)
def calculate(body: CalculateRequest, db: DbSession, principal: CurrentPrincipal,
              actor: AuditActorDep):
    """(Re)calculate scores for published or locked sheets in your scope."""
    with transaction(db):
        counts = kpi_results.calculate(db, principal, actor, body.quarter_id, body.sheet_ids)
    return CalculateResult(**counts)


@router.get("/results", response_model=ResultList)
def list_results(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope, quarter_id: int,
                 plant_id: int | None = None, department_id: int | None = None,
                 search: Annotated[str | None, Query(max_length=100)] = None):
    views = kpi_results.list_views(db, principal, quarter_id, plant_id=plant_id,
                                   department_id=department_id, search=search)
    return ResultList(quarter=_quarter(get_quarter(db, quarter_id)), rows=[
        ResultRow(assignment=_assignment(v.sheet.assignment),
                  sheet=ResultSheet(id=v.sheet.id, status=v.sheet.status), result=_brief(v))
        for v in views])


@router.get("/results/{sheet_id}", response_model=ResultRead)
def get_result(sheet_id: int, db: DbSession, principal: CurrentPrincipal):
    return _result_read(db, principal, kpi_results.get_view(db, principal, sheet_id))


@router.post("/results/{sheet_id}/review", response_model=ResultRead)
def review(sheet_id: int, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        kpi_results.review(db, principal, actor, sheet_id)
    return _result_read(db, principal, kpi_results.get_view(db, principal, sheet_id))


@router.post("/results/{sheet_id}/publish", response_model=ResultRead)
def publish(sheet_id: int, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    """Final and immutable (HR Head or CHRO)."""
    with transaction(db):
        kpi_results.publish(db, principal, actor, sheet_id)
    return _result_read(db, principal, kpi_results.get_view(db, principal, sheet_id))


@router.post("/results/{sheet_id}/overrides", response_model=OverrideRead,
             status_code=status.HTTP_201_CREATED)
def request_override(sheet_id: int, body: OverrideCreate, db: DbSession,
                     principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        override = kpi_results.request_override(db, principal, actor, sheet_id,
                                                proposed_score=body.proposed_score,
                                                reason=body.reason)
    override, sheet = kpi_results.get_override(db, principal, override.id)
    return _override(db, override, sheet)


@router.get("/overrides", response_model=list[OverrideRead])
def list_overrides(db: DbSession, principal: CurrentPrincipal, _scope: OrgScope,
                   status_filter: Annotated[ScoreOverrideStatus | None, Query(alias="status")] = None):
    return [_override(db, o, s) for o, s in kpi_results.list_overrides(db, principal,
                                                                       status=status_filter)]


@router.get("/overrides/{override_id}", response_model=OverrideRead)
def get_override(override_id: int, db: DbSession, principal: CurrentPrincipal, _scope: OrgScope):
    return _override(db, *kpi_results.get_override(db, principal, override_id))


@router.post("/overrides/{override_id}/approve", response_model=OverrideRead)
def approve_override(override_id: int, body: DeviationApprove, db: DbSession,
                     principal: CurrentPrincipal, actor: AuditActorDep):
    """Approve as HR Head or Plant Head; applied when both have approved."""
    with transaction(db):
        kpi_results.approve_override(db, principal, actor, override_id, body.as_role)
    return _override(db, *kpi_results.get_override(db, principal, override_id))


@router.post("/overrides/{override_id}/reject", response_model=OverrideRead)
def reject_override(override_id: int, body: ReasonRequest, db: DbSession,
                    principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        kpi_results.reject_override(db, principal, actor, override_id, body.reason)
    return _override(db, *kpi_results.get_override(db, principal, override_id))
