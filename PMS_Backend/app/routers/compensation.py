"""Compensation cycles, salary baselines, budget scenarios and decisions API (Stage N)."""
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import AuditActorDep, CurrentPrincipal, get_current_user
from app.auth.permissions import Permission, Principal
from app.dependencies import get_db, transaction
from app.models import (
    BudgetDecision,
    BudgetScenario,
    BudgetScenarioLine,
    BudgetScenarioStatus,
    CompensationBaseline,
    CompensationCycle,
    Department,
    Employee,
    Plant,
)
from app.routers.annual import _users, audit_entries
from app.schemas.compensation import (
    BaselineLineRead,
    BaselinePreview,
    BaselineRows,
    BaselineSummary,
    CycleActions,
    CycleRead,
    CycleSummary,
    CycleWrite,
    DecisionCreate,
    DecisionRead,
    LineRead,
    MatrixVersionRef,
    PmsCycleRef,
    PolicyTypeRead,
    PreviewRequest,
    ScenarioActions,
    ScenarioCreate,
    ScenarioRead,
    ScenarioSummary,
    TotalsRead,
    UnitTotal,
    VarianceRead,
)
from app.schemas.employee import EmployeeRef
from app.schemas.jd import ReasonRequest
from app.schemas.kpi import IssueRead
from app.schemas.organization import DepartmentRef, PlantRef
from app.services import audit, compensation, kpi_data
from app.services import matrix_rules as rules

router = APIRouter(prefix="/api/compensation", tags=["compensation and budget"],
                   dependencies=[Depends(get_current_user)])
DbSession = Annotated[Session, Depends(get_db)]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_LINES = 500
# Breakdown rows with fewer included employees are not shown with amounts to
# readers without employee-level access, so no one's salary can be inferred.
MIN_GROUP = 3


def _num(value: Any) -> str | None:
    return None if value is None else rules.decimal_text(value)


def _input(body: CycleWrite) -> compensation.CycleInput:
    return compensation.CycleInput(body.code, body.name, body.pms_cycle_id, body.currency.upper(),
                                   body.effective_date, body.cr_method, body.reference_label,
                                   body.notes)


def _summary(cycle: CompensationCycle, users) -> dict[str, Any]:
    p = cycle.pms_cycle
    return dict(id=cycle.id, code=cycle.code, name=cycle.name, status=cycle.status,
                pms_cycle=PmsCycleRef(id=p.id, code=p.code, name=p.name), currency=cycle.currency,
                effective_date=cycle.effective_date, cr_method=cycle.cr_method,
                reference_label=cycle.reference_label, notes=cycle.notes,
                finalized_at=cycle.finalized_at,
                finalized_by=users.get(cycle.finalized_by_user_id or 0))


def _variance(db: Session, scenario: BudgetScenario) -> VarianceRead | None:
    decision = (db.get(BudgetDecision, scenario.budget_decision_id)
                if scenario.budget_decision_id
                else compensation.current_decision(db, scenario.cycle_id))
    found = compensation.variance(scenario.total_increment, decision)
    return VarianceRead(**found) if found else None


def _scenario_summary(db: Session, principal: Principal, scenario: BudgetScenario,
                      users, baseline_versions: dict[int, int]) -> dict[str, Any]:
    company = compensation.sees_company_totals(principal)
    return dict(
        id=scenario.id, scenario_no=scenario.scenario_no, name=scenario.name,
        status=scenario.status, analysis_only=scenario.analysis_only,
        baseline_version_no=baseline_versions.get(scenario.baseline_id, 0),
        included_count=scenario.included_count, excluded_count=scenario.excluded_count,
        total_increment=_num(scenario.total_increment) if company else None,
        calculated_by=users.get(scenario.calculated_by_user_id),
        calculated_at=scenario.calculated_at,
        submitted_by=users.get(scenario.submitted_by_user_id or 0),
        submitted_at=scenario.submitted_at, decided_by=users.get(scenario.decided_by_user_id or 0),
        decided_at=scenario.decided_at, decision_reason=scenario.decision_reason,
        variance=_variance(db, scenario) if company else None)


def _history(db: Session, cycle_id: int) -> list:
    baseline_ids = db.scalars(select(CompensationBaseline.id).where(
        CompensationBaseline.cycle_id == cycle_id)).all()
    scenario_ids = db.scalars(select(BudgetScenario.id).where(
        BudgetScenario.cycle_id == cycle_id)).all()
    decision_ids = [d.id for d in compensation.decisions(db, cycle_id)]
    events = (audit.history(db, "compensation_cycle", [cycle_id])
              + audit.history(db, "compensation_baseline", baseline_ids)
              + audit.history(db, "budget_scenario", scenario_ids)
              + audit.history(db, "budget_decision", decision_ids))
    return audit_entries(sorted(events, key=lambda e: e.id, reverse=True))


def _cycle_read(db: Session, principal: Principal, cycle: CompensationCycle) -> CycleRead:
    baselines = compensation.baselines(db, cycle)
    decisions = compensation.decisions(db, cycle.id)
    scenarios = compensation.scenarios(db, cycle.id)
    users = _users(db, {cycle.finalized_by_user_id}
                   | {b.imported_by_user_id for b in baselines}
                   | {d.recorded_by_user_id for d in decisions}
                   | {u for s in scenarios for u in (s.calculated_by_user_id, s.submitted_by_user_id,
                                                     s.decided_by_user_id)})
    versions = {b.id: b.version_no for b in baselines}

    def allowed(permission: Permission) -> bool:
        return principal.scope_for(permission).is_global

    return CycleRead(
        **_summary(cycle, users),
        policy=[PolicyTypeRead(type=p["type"], label=p["label"], status=p["status"],
                               versions=[MatrixVersionRef(**{k: v[k] for k in (
                                   "version_id", "matrix_id", "code", "name", "version_no",
                                   "status")}) for v in p["versions"]])
                for p in compensation.policy_status(db, cycle)],
        baselines=[BaselineSummary(id=b.id, version_no=b.version_no, file_name=b.file_name,
                                   row_count=b.row_count,
                                   imported_by=users.get(b.imported_by_user_id or 0),
                                   created_at=b.created_at) for b in reversed(baselines)],
        decisions=[DecisionRead(id=d.id, version_no=d.version_no, status=d.status,
                                approved_amount=rules.decimal_text(d.approved_amount),
                                previous_amount=_num(d.previous_amount), reason=d.reason,
                                recorded_by=users.get(d.recorded_by_user_id),
                                recorded_at=d.recorded_at) for d in reversed(decisions)],
        scenarios=[ScenarioSummary(**_scenario_summary(db, principal, s, users, versions))
                   for s in scenarios],
        actions=CycleActions(can_manage=allowed(Permission.COMPENSATION_MANAGE),
                             can_record_budget=allowed(Permission.BUDGET_RECORD),
                             can_approve=allowed(Permission.BUDGET_APPROVE),
                             can_read_employees=allowed(Permission.COMPENSATION_READ)),
        history=_history(db, cycle.id))


@router.get("/cycles", response_model=list[CycleSummary])
def list_cycles(db: DbSession, principal: CurrentPrincipal):
    """Compensation cycles (budget:read)."""
    cycles = compensation.list_cycles(db, principal)
    users = _users(db, {c.finalized_by_user_id for c in cycles})
    return [CycleSummary(**_summary(c, users)) for c in cycles]


@router.post("/cycles", response_model=CycleRead, status_code=status.HTTP_201_CREATED)
def create_cycle(body: CycleWrite, db: DbSession, principal: CurrentPrincipal,
                 actor: AuditActorDep):
    """GLOBAL compensation:manage (HR Head)."""
    with transaction(db):
        cycle_id = compensation.create_cycle(db, principal, actor, _input(body)).id
    return _cycle_read(db, principal, compensation.get_cycle(db, principal, cycle_id))


@router.get("/cycles/{cycle_id}", response_model=CycleRead)
def get_cycle(cycle_id: int, db: DbSession, principal: CurrentPrincipal):
    return _cycle_read(db, principal, compensation.get_cycle(db, principal, cycle_id))


@router.put("/cycles/{cycle_id}", response_model=CycleRead)
def update_cycle(cycle_id: int, body: CycleWrite, db: DbSession, principal: CurrentPrincipal,
                 actor: AuditActorDep):
    with transaction(db):
        compensation.update_cycle(db, principal, actor, cycle_id, _input(body))
    return _cycle_read(db, principal, compensation.get_cycle(db, principal, cycle_id))


# --- salary baselines ------------------------------------------------------------------------

@router.get("/cycles/{cycle_id}/baseline/template")
def baseline_template(cycle_id: int, db: DbSession, principal: CurrentPrincipal) -> Response:
    content = compensation.template(db, principal, cycle_id)
    return Response(content=content, media_type=XLSX, headers={
        "Content-Disposition": f'attachment; filename="salary-baseline-{cycle_id}.xlsx"'})


def _read(file: UploadFile) -> bytes:
    return file.file.read(kpi_data.MAX_BYTES + 1)


def _baseline_line(line: Any) -> BaselineLineRead:
    """A checked file line (compensation.BaselineLine) or a stored baseline row."""
    return BaselineLineRead(row=getattr(line, "row", None) or line.source_row,
                            employee=EmployeeRef.model_validate(line.employee),
                            current_salary=_num(line.current_salary),
                            reference_salary=_num(line.reference_salary), grade=line.grade,
                            eligible=line.eligible, exclusion_reason=line.exclusion_reason)


@router.post("/cycles/{cycle_id}/baseline/preview", response_model=BaselinePreview)
def baseline_preview(cycle_id: int, db: DbSession, principal: CurrentPrincipal,
                     file: Annotated[UploadFile, File()]):
    """Validate a salary baseline file; nothing is saved."""
    check = compensation.check_baseline(db, principal, cycle_id, file.filename or "baseline",
                                        _read(file))
    eligible = sum(1 for line in check.lines if line.eligible)
    return BaselinePreview(
        file_name=check.file_name, file_format=check.file_format, rows=len(check.lines),
        eligible=eligible, not_eligible=len(check.lines) - eligible,
        issues=[IssueRead(message=i.message, field=i.field, row=i.row) for i in check.issues],
        warnings=check.warnings, lines=[_baseline_line(line) for line in check.lines[:MAX_LINES]],
        lines_truncated=len(check.lines) > MAX_LINES, ready=check.ready)


@router.post("/cycles/{cycle_id}/baseline/confirm", response_model=BaselineSummary,
             status_code=status.HTTP_201_CREATED)
def baseline_confirm(cycle_id: int, db: DbSession, principal: CurrentPrincipal,
                     actor: AuditActorDep, file: Annotated[UploadFile, File()]):
    """Re-validate and store the whole file as a new baseline version, or nothing."""
    data = _read(file)
    with transaction(db):
        baseline = compensation.confirm_baseline(db, principal, actor, cycle_id,
                                                 file.filename or "baseline", data)
        result = BaselineSummary(id=baseline.id, version_no=baseline.version_no,
                                 file_name=baseline.file_name, row_count=baseline.row_count,
                                 imported_by=None, created_at=baseline.created_at)
    return result


@router.get("/cycles/{cycle_id}/baselines/{baseline_id}", response_model=BaselineRows)
def baseline_rows(cycle_id: int, baseline_id: int, db: DbSession, principal: CurrentPrincipal):
    """The rows of one baseline (GLOBAL compensation:read)."""
    baseline, rows = compensation.baseline_rows(db, principal, cycle_id, baseline_id)
    users = _users(db, {baseline.imported_by_user_id})
    return BaselineRows(id=baseline.id, version_no=baseline.version_no,
                        file_name=baseline.file_name, row_count=baseline.row_count,
                        imported_by=users.get(baseline.imported_by_user_id or 0),
                        created_at=baseline.created_at, rows=[_baseline_line(r) for r in rows])


# --- budget decisions ------------------------------------------------------------------------

@router.post("/cycles/{cycle_id}/budget-decisions", response_model=CycleRead,
             status_code=status.HTTP_201_CREATED)
def record_decision(cycle_id: int, body: DecisionCreate, db: DbSession,
                    principal: CurrentPrincipal, actor: AuditActorDep):
    """The budget owner records the company-approved budget (GLOBAL budget:record)."""
    with transaction(db):
        compensation.record_decision(db, principal, actor, cycle_id, amount=body.amount,
                                     reason=body.reason)
    return _cycle_read(db, principal, compensation.get_cycle(db, principal, cycle_id))


# --- scenarios -------------------------------------------------------------------------------

def _places(db: Session, plant_ids: set, department_ids: set):
    plants = {p.id: PlantRef.model_validate(p) for p in db.scalars(
        select(Plant).where(Plant.id.in_(sorted(i for i in plant_ids if i) or [0])))}
    departments = {d.id: DepartmentRef.model_validate(d) for d in db.scalars(
        select(Department).where(Department.id.in_(sorted(i for i in department_ids if i)
                                                    or [0])))}
    return plants, departments


def _totals(db: Session, principal: Principal, totals: dict[str, Any]) -> TotalsRead:
    company = compensation.sees_company_totals(principal)
    employee_level = not principal.scope_for(Permission.COMPENSATION_READ).is_empty
    scope = principal.scope_for(Permission.BUDGET_READ)
    plants, departments = _places(db, {u["plant_id"] for u in totals["by_unit"]},
                                  {u["department_id"] for u in totals["by_unit"]})
    units = []
    for u in totals["by_unit"]:
        if not company and (u["plant_id"] is None
                            or not scope.allows_unit(u["plant_id"], u["department_id"])):
            continue
        hide = not employee_level and u["included"] < MIN_GROUP
        units.append(UnitTotal(plant=plants.get(u["plant_id"]),
                               department=departments.get(u["department_id"]),
                               included=u["included"], excluded=u["excluded"],
                               current_salary=None if hide else u["current_salary"],
                               increment=None if hide else u["increment"], suppressed=hide))

    def company_only(key: str) -> Any:
        return totals[key] if company else None

    return TotalsRead(
        population=totals["population"], included=totals["included"],
        excluded=totals["excluded"], excluded_by_reason=totals["excluded_by_reason"],
        excluded_salary=totals["excluded_salary"] if company and employee_level else None,
        total_current_salary=company_only("total_current_salary"),
        total_increment=company_only("total_increment"),
        total_increment_exact=company_only("total_increment_exact"),
        rounding_difference=company_only("rounding_difference"),
        average_increment_percent=company_only("average_increment_percent"),
        negative_adjustments=totals["negative_adjustments"], by_unit=units,
        reconciliation=totals["reconciliation"] if company else {})


def _line_read(line: BudgetScenarioLine, plants, departments, employee) -> LineRead:
    return LineRead(
        employee=EmployeeRef.model_validate(employee), status=line.status,
        exclusion_code=line.exclusion_code, exclusion_reason=line.exclusion_reason,
        plant=plants.get(line.plant_id), department=departments.get(line.department_id),
        annual_score=_num(line.annual_score), current_salary=_num(line.current_salary),
        reference_salary=_num(line.reference_salary), compa_ratio=_num(line.compa_ratio),
        performance_rating=line.performance_rating,
        base_increment_percent=_num(line.base_increment_percent),
        cr_multiplier=_num(line.cr_multiplier), increment_percent=_num(line.increment_percent),
        increment_amount=_num(line.increment_amount),
        increment_amount_exact=_num(line.increment_amount_exact),
        new_salary=_num(line.new_salary), trace=rules.jsonable(line.trace))


def _scenario_read(db: Session, principal: Principal, scenario: BudgetScenario) -> ScenarioRead:
    cycle = scenario.cycle
    baselines = {b.id: b.version_no for b in compensation.baselines(db, cycle)}
    users = _users(db, {scenario.calculated_by_user_id, scenario.submitted_by_user_id,
                        scenario.decided_by_user_id, cycle.finalized_by_user_id})
    lines = compensation.visible_lines(db, principal, scenario)
    line_reads = None
    if lines is not None:
        plants, departments = _places(db, {line.plant_id for line in lines},
                                      {line.department_id for line in lines})
        line_reads = [_line_read(line, plants, departments, line.employee) for line in lines]
    open_scenario = scenario.status in (BudgetScenarioStatus.CALCULATED,
                                        BudgetScenarioStatus.SUBMITTED)
    submitted = scenario.status == BudgetScenarioStatus.SUBMITTED
    approver = (principal.scope_for(Permission.BUDGET_APPROVE).is_global and submitted
                and principal.user_id not in (scenario.calculated_by_user_id,
                                              scenario.submitted_by_user_id))
    decision = compensation.current_decision(db, cycle.id)
    return ScenarioRead(
        **_scenario_summary(db, principal, scenario, users, baselines),
        cycle=CycleSummary(**_summary(cycle, users)), note=scenario.note,
        cr_method=scenario.cr_method, effective_date=scenario.effective_date,
        currency=scenario.currency, overrides=scenario.overrides,
        matrix_versions=scenario.matrix_versions, totals=_totals(db, principal, scenario.totals),
        stale_reasons=compensation.stale_reasons(db, scenario) if open_scenario else [],
        lines=line_reads,
        actions=ScenarioActions(
            can_submit=(principal.scope_for(Permission.COMPENSATION_MANAGE).is_global
                        and scenario.status == BudgetScenarioStatus.CALCULATED
                        and not scenario.analysis_only and scenario.included_count > 0),
            can_approve=approver and decision is not None
            and decision.recorded_by_user_id != principal.user_id,
            can_reject=approver),
        history=audit_entries(audit.history(db, "budget_scenario", [scenario.id])))


@router.post("/cycles/{cycle_id}/scenarios", response_model=ScenarioRead,
             status_code=status.HTTP_201_CREATED)
def calculate(cycle_id: int, body: ScenarioCreate, db: DbSession, principal: CurrentPrincipal,
              actor: AuditActorDep):
    """Calculate a new, frozen scenario (GLOBAL compensation:manage)."""
    with transaction(db):
        scenario_id = compensation.calculate(db, principal, actor, cycle_id, name=body.name,
                                             baseline_id=body.baseline_id,
                                             overrides=body.overrides, note=body.note).id
    return _scenario_read(db, principal, compensation.get_scenario(db, principal, scenario_id))


@router.get("/scenarios/{scenario_id}", response_model=ScenarioRead)
def get_scenario(scenario_id: int, db: DbSession, principal: CurrentPrincipal):
    return _scenario_read(db, principal, compensation.get_scenario(db, principal, scenario_id))


@router.post("/scenarios/{scenario_id}/submit", response_model=ScenarioRead)
def submit(scenario_id: int, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        compensation.submit(db, principal, actor, scenario_id)
    return _scenario_read(db, principal, compensation.get_scenario(db, principal, scenario_id))


@router.post("/scenarios/{scenario_id}/approve", response_model=ScenarioRead)
def approve(scenario_id: int, body: ReasonRequest, db: DbSession, principal: CurrentPrincipal,
            actor: AuditActorDep):
    """The CHRO finalizes the budget (GLOBAL budget:approve)."""
    with transaction(db):
        compensation.approve(db, principal, actor, scenario_id, body.reason)
    return _scenario_read(db, principal, compensation.get_scenario(db, principal, scenario_id))


@router.post("/scenarios/{scenario_id}/reject", response_model=ScenarioRead)
def reject(scenario_id: int, body: ReasonRequest, db: DbSession, principal: CurrentPrincipal,
           actor: AuditActorDep):
    with transaction(db):
        compensation.reject(db, principal, actor, scenario_id, body.reason)
    return _scenario_read(db, principal, compensation.get_scenario(db, principal, scenario_id))


@router.post("/cycles/{cycle_id}/preview", response_model=LineRead)
def preview(cycle_id: int, body: PreviewRequest, db: DbSession, principal: CurrentPrincipal):
    """One employee's proposal as it would be calculated now (compensation:read); nothing
    is saved. Explicit matrix versions may be chosen to test a revision."""
    proposal = compensation.preview(db, principal, cycle_id, body.employee_id,
                                    baseline_id=body.baseline_id, overrides=body.overrides)
    line = compensation._line(proposal)  # read like a stored line; never saved
    plants, departments = _places(db, {line.plant_id}, {line.department_id})
    return _line_read(line, plants, departments, db.get(Employee, line.employee_id))
