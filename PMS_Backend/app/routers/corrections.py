"""Controlled corrections of published quarters API (Stage M)."""
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import AuditActorDep, CurrentPrincipal, get_current_user
from app.auth.permissions import Principal
from app.dependencies import get_db, transaction
from app.models import (
    CorrectionItemKind,
    CorrectionStatus,
    Employee,
    EmployeeAssignment,
    KpiDefinition,
    KpiSheet,
    NormalizationRun,
    QuarterCorrection,
)
from app.routers.annual import _users, audit_entries
from app.routers.kpi import _quarter
from app.schemas.annual import (
    AffectedCohort,
    AffectedRead,
    CorrectionActions,
    CorrectionCreate,
    CorrectionItemRead,
    CorrectionPreview,
    CorrectionRead,
    CorrectionSummary,
    CorrectionTransition,
    DecisionRequest,
    ProjectedEmployee,
    ProjectedSheet,
    QuarterVersionRead,
    VersionCohort,
    VersionSheet,
    WeightRead,
)
from app.schemas.employee import EmployeeRef
from app.services import audit, corrections, kpi_results, normalization, versions
from app.services import matrix_rules as rules
from app.services.errors import PermissionDeniedError
from app.services.kpi_sheets import get_quarter

router = APIRouter(prefix="/api/kpi", tags=["quarter corrections"],
                   dependencies=[Depends(get_current_user)])
DbSession = Annotated[Session, Depends(get_db)]


def _num(value: Any) -> str | None:
    return None if value is None else rules.decimal_text(value)


def _inputs(body: CorrectionCreate) -> tuple[list[corrections.ValueIn], list[corrections.WeightsIn]]:
    values = [corrections.ValueIn(v.sheet_id, v.kpi_definition_id, v.period, v.actual, v.inputs)
              for v in body.values]
    weights = [corrections.WeightsIn(w.employee_id, [(x.assignment_id, x.weight) for x in w.weights])
               for w in body.weights]
    return values, weights


def _employees(db: Session, ids: set[int]) -> dict[int, EmployeeRef]:
    return {e.id: EmployeeRef.model_validate(e) for e in db.scalars(
        select(Employee).where(Employee.id.in_(sorted(ids) or [0])))}


def _affected(db: Session, data: dict[str, Any] | None) -> AffectedRead:
    data = data or {}
    people = _employees(db, set(data.get("employees", [])) | set(data.get("dependents", [])))
    cohorts = []
    for c in data.get("cohorts", []):
        run = db.get(NormalizationRun, c["run_id"])
        cohorts.append(AffectedCohort(run_id=run.id, label=normalization._view(db, run).label,
                                      members=len(c["members"])))
    return AffectedRead(
        employees=[people[e] for e in data.get("employees", []) if e in people],
        dependents=[people[e] for e in data.get("dependents", []) if e in people],
        cohorts=cohorts, annual_results_flagged=data.get("annual_results_flagged", []))


def _preview_read(db: Session, data: dict[str, Any]) -> CorrectionPreview:
    return CorrectionPreview(
        sheets=[ProjectedSheet(sheet_id=s["sheet_id"], employee=s["employee"], unit=s["unit"],
                               before=s["before"], after=s["after"], complete=s["complete"])
                for s in data.get("sheets", [])],
        employees=[ProjectedEmployee(**e) for e in data.get("employees", [])],
        problems=data.get("problems", []), affected=_affected(db, data.get("affected")))


def _unit_labels(db: Session, assignment_ids: set[int]) -> dict[int, str]:
    found = {}
    for a in db.scalars(select(EmployeeAssignment).where(
            EmployeeAssignment.id.in_(sorted(assignment_ids) or [0]))):
        unit = a.plant_department
        found[a.id] = f"{unit.department.name} — {unit.plant.name}"
    return found


def _summary(c: QuarterCorrection, users) -> dict[str, Any]:
    return dict(id=c.id, status=c.status, quarter=_quarter(c.quarter), base_version=c.base_version,
                version_no=c.version_no, reason=c.reason,
                requested_by=users.get(c.requested_by_user_id), requested_at=c.requested_at,
                items=len(c.items))


def _read(db: Session, principal: Principal, c: QuarterCorrection) -> CorrectionRead:
    users = _users(db, {c.requested_by_user_id, c.decided_by_user_id, c.published_by_user_id})
    sheets = {s.id: s for s in db.scalars(kpi_results._sheet_query().where(
        KpiSheet.id.in_([i.sheet_id for i in c.items if i.sheet_id] or [0]))).unique()}
    kpis = {k.id: k for k in db.scalars(select(KpiDefinition).where(
        KpiDefinition.id.in_([i.kpi_definition_id for i in c.items if i.kpi_definition_id] or [0])))}
    people = _employees(db, {i.employee_id for i in c.items if i.employee_id})
    labels = _unit_labels(db, {int(k) for i in c.items
                               for k in [*(i.before_weights or {}), *(i.after_weights or {})]})

    def weights(data: dict[str, Any] | None) -> list[WeightRead]:
        return [WeightRead(assignment_id=int(k), unit=labels.get(int(k), str(k)), weight=str(v))
                for k, v in sorted((data or {}).items(), key=lambda kv: int(kv[0]))]

    changes = []
    for i in c.items:
        if i.kind == CorrectionItemKind.VALUE:
            sheet = sheets.get(i.sheet_id)
            unit = sheet.assignment.plant_department if sheet else None
            kpi = kpis.get(i.kpi_definition_id)
            changes.append(CorrectionItemRead(
                id=i.id, kind=i.kind,
                employee=EmployeeRef.model_validate(sheet.assignment.employee) if sheet else None,
                unit=f"{unit.department.name} — {unit.plant.name}" if unit else None,
                sheet_id=i.sheet_id, kpi_code=kpi.code if kpi else None,
                kpi_name=kpi.name if kpi else None, period=f"{i.period_month:%Y-%m}",
                had_value=i.had_value, before_actual=_num(i.before_actual),
                after_actual=_num(i.after_actual), before_inputs=i.before_inputs,
                after_inputs=i.after_inputs, before_weights=[], after_weights=[]))
        else:
            changes.append(CorrectionItemRead(
                id=i.id, kind=i.kind, employee=people.get(i.employee_id), unit=None,
                sheet_id=None, kpi_code=None, kpi_name=None, period=None, had_value=True,
                before_actual=None, after_actual=None, before_inputs=None, after_inputs=None,
                before_weights=weights(i.before_weights), after_weights=weights(i.after_weights)))

    sheet_ids = (c.affected or {}).get("sheets") or [s["sheet_id"] for s in c.preview.get("sheets", [])]
    version_sheets = []
    for v in kpi_results.quarter_views(db, c.cycle_quarter_id):
        if v.sheet.id not in sheet_ids:
            continue
        r = v.result
        unit = v.sheet.assignment.plant_department
        version_sheets.append(VersionSheet(
            sheet_id=v.sheet.id, employee=EmployeeRef.model_validate(v.sheet.assignment.employee),
            unit=f"{unit.department.name} — {unit.plant.name}",
            status=r.status if r is not None and r.version_no == c.version_no else None,
            final_score=_num(r.final_score) if r is not None and r.version_no == c.version_no
            else None,
            published_score=_num(kpi_results.published_result(db, v.sheet.id).published_score)
            if kpi_results.published_result(db, v.sheet.id) else None))
    cohorts = []
    if c.version_no:
        for run in corrections._version_runs(db, c):
            cohorts.append(VersionCohort(run_id=run.id, label=normalization._view(db, run).label,
                                         status=run.status.value))
    st = corrections.state(db, principal, c)
    return CorrectionRead(
        **_summary(c, users), decided_by=users.get(c.decided_by_user_id or 0),
        decided_at=c.decided_at, decision_reason=c.decision_reason,
        published_by=users.get(c.published_by_user_id or 0), published_at=c.published_at,
        changes=changes, preview=_preview_read(db, c.preview),
        affected=_affected(db, c.affected) if c.affected else None,
        sheets=version_sheets, cohorts=cohorts, next_status=st.next_status,
        previous_status=st.previous_status, blockers=st.blockers,
        actions=CorrectionActions(can_decide=st.can_decide, can_advance=st.can_advance,
                                  can_return=st.can_return, can_publish=st.can_publish),
        history=audit_entries(audit.history(db, "quarter_correction", [c.id])))


def _get(db: Session, principal: Principal, correction_id: int) -> CorrectionRead:
    return _read(db, principal, corrections.get_correction(db, principal, correction_id))


@router.post("/quarters/{quarter_id}/corrections/preview", response_model=CorrectionPreview)
def preview(quarter_id: int, body: CorrectionCreate, db: DbSession, principal: CurrentPrincipal):
    """Check a correction and project its effect; nothing is saved."""
    values, weights = _inputs(body)
    return _preview_read(db, corrections.preview(db, principal, quarter_id, values, weights))


@router.post("/quarters/{quarter_id}/corrections", response_model=CorrectionRead,
             status_code=status.HTTP_201_CREATED)
def request(quarter_id: int, body: CorrectionCreate, db: DbSession, principal: CurrentPrincipal,
            actor: AuditActorDep):
    """An HR Head requests a correction of a published quarter."""
    values, weights = _inputs(body)
    with transaction(db):
        c = corrections.request(db, principal, actor, quarter_id, reason=body.reason,
                                values=values, weights=weights)
        correction_id = c.id
    return _get(db, principal, correction_id)


@router.get("/corrections", response_model=list[CorrectionSummary])
def list_corrections(db: DbSession, principal: CurrentPrincipal, quarter_id: int | None = None,
                     status_filter: Annotated[CorrectionStatus | None, Query(alias="status")] = None):
    found = corrections.list_corrections(db, principal, quarter_id=quarter_id, status=status_filter)
    users = _users(db, {c.requested_by_user_id for c in found})
    return [CorrectionSummary(**_summary(c, users)) for c in found]


@router.get("/corrections/{correction_id}", response_model=CorrectionRead)
def get_correction(correction_id: int, db: DbSession, principal: CurrentPrincipal):
    return _get(db, principal, correction_id)


@router.post("/corrections/{correction_id}/approve", response_model=CorrectionRead)
def approve(correction_id: int, body: DecisionRequest, db: DbSession,
            principal: CurrentPrincipal, actor: AuditActorDep):
    """The CHRO approves: the corrected version is created and opened for review."""
    with transaction(db):
        corrections.approve(db, principal, actor, correction_id, body.reason)
    return _get(db, principal, correction_id)


@router.post("/corrections/{correction_id}/reject", response_model=CorrectionRead)
def reject(correction_id: int, body: DecisionRequest, db: DbSession,
           principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        corrections.reject(db, principal, actor, correction_id, body.reason)
    return _get(db, principal, correction_id)


@router.post("/corrections/{correction_id}/transition", response_model=CorrectionRead)
def transition(correction_id: int, body: CorrectionTransition, db: DbSession,
               principal: CurrentPrincipal, actor: AuditActorDep):
    """One review step forward (gated) or back (with a reason): GLOBAL quarter:start."""
    with transaction(db):
        corrections.transition(db, principal, actor, correction_id, body.to, body.reason)
    return _get(db, principal, correction_id)


@router.post("/corrections/{correction_id}/publish", response_model=CorrectionRead)
def publish(correction_id: int, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    """Make the corrected version current: GLOBAL score:publish."""
    with transaction(db):
        corrections.publish(db, principal, actor, correction_id)
    return _get(db, principal, correction_id)


@router.get("/quarters/{quarter_id}/versions", response_model=list[QuarterVersionRead])
def quarter_versions(quarter_id: int, db: DbSession, principal: CurrentPrincipal):
    """The quarter's published versions, oldest first (org:read)."""
    if principal.org_scope.is_empty:
        raise PermissionDeniedError("You do not have access to organizational data.")
    quarter = get_quarter(db, quarter_id)
    if quarter.published_at is None:
        return []
    current = versions.published_version(db, quarter)
    published = db.scalars(select(QuarterCorrection).where(
        QuarterCorrection.cycle_quarter_id == quarter.id,
        QuarterCorrection.status == CorrectionStatus.PUBLISHED)
        .order_by(QuarterCorrection.version_no)).all()
    users = _users(db, {quarter.published_by_user_id} | {c.published_by_user_id for c in published})
    return [QuarterVersionRead(version_no=1, current=current == 1, correction_id=None,
                               published_by=users.get(quarter.published_by_user_id or 0),
                               published_at=quarter.published_at)] + [
        QuarterVersionRead(version_no=c.version_no, current=current == c.version_no,
                           correction_id=c.id, published_by=users.get(c.published_by_user_id or 0),
                           published_at=c.published_at) for c in published]

