"""Budget distribution and department allocation proposals API (Stage O)."""
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.auth.dependencies import AuditActorDep, CurrentPrincipal, get_current_user
from app.auth.permissions import Permission, Principal
from app.dependencies import get_db, transaction
from app.models import (
    AllocationProposal,
    AllocationStatus,
    BudgetDistribution,
    BudgetLineStatus,
    BudgetScenario,
    BudgetScenarioLine,
    CompensationCycle,
    CompensationCycleStatus,
    DistributionLevel,
    DistributionStatus,
)
from app.routers.annual import _users, audit_entries
from app.routers.compensation import _places
from app.schemas.allocation import (
    AllocationCycle,
    DistributionActions,
    DistributionCreate,
    DistributionPlantRead,
    DistributionRead,
    DistributionSummary,
    DistributionTotals,
    DistributionUnitRead,
    DistributionWrite,
    ExcludedRead,
    ForwardRequest,
    OverviewActions,
    OverviewRead,
    OverviewSummary,
    PolicyRead,
    PolicyWrite,
    ProposalActions,
    ProposalBrief,
    ProposalLineRead,
    ProposalRead,
    ProposalStart,
    ProposalWrite,
    ReportLine,
    UnitRow,
)
from app.schemas.employee import EmployeeRef
from app.schemas.jd import ReasonRequest
from app.services import allocation as alloc
from app.services import audit, compensation
from app.services import matrix_rules as rules

router = APIRouter(prefix="/api/allocations", tags=["budget distribution and allocation"],
                   dependencies=[Depends(get_current_user)])
DbSession = Annotated[Session, Depends(get_db)]


def _num(value: Any) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else rules.decimal_text(value)


def _cycle(db: Session, cycle: CompensationCycle) -> AllocationCycle:
    published = alloc.published_distribution(db, cycle.id)
    return AllocationCycle(
        id=cycle.id, code=cycle.code, name=cycle.name, status=cycle.status,
        currency=cycle.currency, effective_date=cycle.effective_date,
        revision_no=cycle.revision_no,
        budget_finalized=cycle.status == CompensationCycleStatus.FINALIZED
        and compensation.finalized_scenario(db, cycle.id) is not None,
        distribution_version=published.version_no if published else None)


def _policy(policy: dict[str, Any]) -> PolicyRead:
    return PolicyRead(mode=policy["mode"], max_increase_points=policy.get("max_increase_points"),
                      max_decrease_points=policy.get("max_decrease_points"),
                      version=int(policy.get("version", 0)),
                      configured=bool(policy.get("configured", True)))


def _totals(totals: dict[str, Any]) -> DistributionTotals:
    return DistributionTotals(**{k: totals.get(k) for k in DistributionTotals.model_fields})


# --- cycles, overview, policy --------------------------------------------------------------------

@router.get("/cycles", response_model=list[AllocationCycle])
def list_cycles(db: DbSession, principal: CurrentPrincipal):
    """Compensation cycles, for anyone working on budgets or allocations."""
    return [_cycle(db, c) for c in alloc.cycles(db, principal)]


def _brief(db: Session, p: AllocationProposal | None, ctx: alloc.Context,
           hide: bool) -> ProposalBrief | None:
    if p is None:
        return None
    return ProposalBrief(id=p.id, version_no=p.version_no, status=p.status,
                         proposed_total=None if hide else _num(p.proposed_total),
                         changed_count=p.changed_count,
                         stale_reasons=alloc.stale_reasons(db, p, ctx),
                         submitted_at=p.submitted_at, decided_at=p.decided_at)


def _excluded(db: Session, lines: list[BudgetScenarioLine]) -> list[ExcludedRead]:
    plants, departments = _places(db, {x.plant_id for x in lines},
                                  {x.department_id for x in lines})
    return [ExcludedRead(employee=EmployeeRef.model_validate(x.employee),
                         plant=plants.get(x.plant_id or 0),
                         department=departments.get(x.department_id or 0),
                         code=x.exclusion_code, reason=x.exclusion_reason) for x in lines]


def _distribution_summary(db: Session, d: BudgetDistribution, users) -> DistributionSummary:
    return DistributionSummary(
        id=d.id, version_no=d.version_no, status=d.status,
        budget_amount=rules.decimal_text(d.budget_amount), totals=_totals(d.totals),
        revision_reason=d.revision_reason, created_by=users.get(d.created_by_user_id),
        created_at=d.created_at, published_by=users.get(d.published_by_user_id or 0),
        published_at=d.published_at)


@router.get("/cycles/{cycle_id}", response_model=OverviewRead)
def overview(cycle_id: int, db: DbSession, principal: CurrentPrincipal,
             plant_id: int | None = None, department_id: int | None = None,
             proposal_status: Annotated[str | None, Query(alias="status")] = None,
             stale_only: bool = False):
    """The allocation dashboard and final report: company and unit figures,
    filtered by plant, department, proposal status or staleness."""
    found = alloc.overview(db, principal, cycle_id, plant_id=plant_id,
                           department_id=department_id, status=proposal_status,
                           stale_only=stale_only)
    ctx: alloc.Context = found["ctx"]
    rows = found["units"]
    plants, departments = _places(db, {r["plant_id"] for r in rows},
                                  {r["department_id"] for r in rows})
    units = [UnitRow(
        plant=plants[r["plant_id"]], department=departments[r["department_id"]],
        distributed=_num(r["distributed"]), included=r["included"], excluded=r["excluded"],
        excluded_by_reason=r["excluded_by_reason"], recommended=_num(r["recommended"]),
        proposed=_num(r["proposed"]), approved=_num(r["approved"]),
        difference=_num(r["difference"]), suppressed=r["suppressed"],
        latest=_brief(db, r["latest"], ctx, r["suppressed"]),
        approved_proposal=_brief(db, r["approved_proposal"], ctx, r["suppressed"]),
        can_start=r["can_start"]) for r in rows]
    summary = found["summary"]
    distribution = ctx.distribution
    users = _users(db, {distribution.created_by_user_id, distribution.published_by_user_id}
                   if distribution else set())
    return OverviewRead(
        cycle=_cycle(db, found["cycle"]), policy=_policy(found["policy"]),
        distribution=_distribution_summary(db, distribution, users) if distribution else None,
        summary=OverviewSummary(**{k: (_num(v) if k not in (
            "by_status", "stale", "excluded_by_reason", "reconciliation") else v)
            for k, v in summary.items()}) if summary else None,
        units=units, excluded=_excluded(db, found["excluded"]),
        actions=OverviewActions(
            can_distribute=found["can_distribute"],
            draft_distribution_id=next((d.id for d in alloc.distributions(db, cycle_id)
                                        if d.status == DistributionStatus.DRAFT), None)
            if found["can_distribute"] else None,
            can_set_policy=principal.scope_for(Permission.COMPENSATION_MANAGE).is_global,
            can_read_employees=not (principal.scope_for(Permission.COMPENSATION_READ).is_empty
                                    and principal.scope_for(
                                        Permission.ALLOCATION_PROPOSE).is_empty)))


@router.put("/cycles/{cycle_id}/policy", response_model=PolicyRead)
def set_policy(cycle_id: int, body: PolicyWrite, db: DbSession, principal: CurrentPrincipal,
               actor: AuditActorDep):
    """The discretion policy (GLOBAL compensation:manage, HR Head)."""
    with transaction(db):
        cycle = alloc.set_policy(db, principal, actor, cycle_id, mode=body.mode,
                                 max_increase=body.max_increase_points,
                                 max_decrease=body.max_decrease_points)
        result = _policy(alloc.policy_of(cycle))
    return result


@router.get("/cycles/{cycle_id}/employees", response_model=list[ReportLine])
def employee_report(cycle_id: int, db: DbSession, principal: CurrentPrincipal,
                    plant_id: int | None = None, department_id: int | None = None,
                    search: str | None = None,
                    proposal_status: Annotated[str | None, Query(alias="status")] = None):
    """Employee lines of each unit's latest proposal version (employee-level readers)."""
    found = alloc.employee_report(db, principal, cycle_id, plant_id=plant_id,
                                  department_id=department_id, search=search,
                                  status=proposal_status)
    if not found:
        return []
    ctx = alloc.context(db, db.get(CompensationCycle, cycle_id))
    stale = {p.id: bool(alloc.stale_reasons(db, p, ctx)) for p, _x in found}
    plants, departments = _places(db, {p.plant_id for p, _x in found},
                                  {p.department_id for p, _x in found})
    return [ReportLine(
        plant=plants[p.plant_id], department=departments[p.department_id], proposal_id=p.id,
        version_no=p.version_no, status=p.status, stale=stale[p.id],
        employee=EmployeeRef.model_validate(x.employee),
        current_salary=rules.decimal_text(x.current_salary),
        recommended_percent=rules.decimal_text(x.recommended_percent),
        recommended_amount=rules.decimal_text(x.recommended_amount),
        proposed_percent=rules.decimal_text(x.proposed_percent),
        proposed_amount=rules.decimal_text(x.proposed_amount),
        difference=rules.decimal_text(x.proposed_amount - x.recommended_amount),
        reason=x.reason) for p, x in found]


# --- distribution --------------------------------------------------------------------------------

def _distribution_read(db: Session, principal: Principal,
                       d: BudgetDistribution) -> DistributionRead:
    cycle = db.get(CompensationCycle, d.cycle_id)
    all_versions = alloc.distributions(db, cycle.id)
    users = _users(db, {u for x in all_versions for u in (x.created_by_user_id,
                                                         x.published_by_user_id)})
    plant_lines = [x for x in d.lines if x.level == DistributionLevel.PLANT]
    plants, departments = _places(db, {x.plant_id for x in d.lines},
                                  {x.department_id for x in d.lines})
    per_plant = {p["plant_id"]: p for p in d.totals.get("plants", [])}
    finalized = compensation.finalized_scenario(db, cycle.id)
    stale = []
    if d.status == DistributionStatus.PUBLISHED:
        if cycle.status != CompensationCycleStatus.FINALIZED:
            stale.append(f"The company budget is being revised (revision {cycle.revision_no}).")
        elif finalized is None or finalized.id != d.scenario_id:
            stale.append("The company budget was revised after this version was published; "
                         "publish a new version.")
    can = alloc.can_distribute(principal)
    budget_open = cycle.status == CompensationCycleStatus.FINALIZED and finalized is not None
    has_draft = any(x.status == DistributionStatus.DRAFT for x in all_versions)
    return DistributionRead(
        **_distribution_summary(db, d, users).model_dump(),
        cycle=_cycle(db, cycle), allow_mixed_methods=d.allow_mixed_methods, note=d.note,
        scenario_id=d.scenario_id, budget_decision_id=d.budget_decision_id,
        plants=[DistributionPlantRead(
            id=p.id, plant=plants[p.plant_id], method=p.method, percent=_num(p.percent),
            amount=rules.decimal_text(p.amount), amount_exact=rules.decimal_text(p.amount_exact),
            units_total=per_plant.get(p.plant_id, {}).get("units_total", "0"),
            unallocated=per_plant.get(p.plant_id, {}).get("unallocated",
                                                          rules.decimal_text(p.amount)),
            rounding_residual=per_plant.get(p.plant_id, {}).get("rounding_residual", "0"),
            units=[DistributionUnitRead(
                id=u.id, department=departments[u.department_id], method=u.method,
                percent=_num(u.percent), amount=rules.decimal_text(u.amount),
                amount_exact=rules.decimal_text(u.amount_exact))
                for u in d.lines if u.parent_id == p.id]) for p in plant_lines],
        stale_reasons=stale,
        versions=[_distribution_summary(db, x, users) for x in all_versions],
        actions=DistributionActions(
            can_edit=can and d.status == DistributionStatus.DRAFT and budget_open,
            can_publish=can and d.status == DistributionStatus.DRAFT and budget_open,
            can_start_revision=can and budget_open and not has_draft),
        history=audit_entries(audit.history(db, "budget_distribution",
                                            [x.id for x in all_versions])))


@router.get("/cycles/{cycle_id}/distributions", response_model=list[DistributionSummary])
def list_distributions(cycle_id: int, db: DbSession, principal: CurrentPrincipal):
    alloc.get_cycle(db, principal, cycle_id)
    found = alloc.distributions(db, cycle_id)
    if found:
        alloc.get_distribution(db, principal, found[0].id)  # access check
    users = _users(db, {u for x in found for u in (x.created_by_user_id, x.published_by_user_id)})
    return [_distribution_summary(db, x, users) for x in found]


@router.post("/cycles/{cycle_id}/distributions", response_model=DistributionRead,
             status_code=status.HTTP_201_CREATED)
def create_distribution(cycle_id: int, body: DistributionCreate, db: DbSession,
                        principal: CurrentPrincipal, actor: AuditActorDep):
    """A new draft version (GLOBAL budget:distribute), copied from the published one."""
    with transaction(db):
        distribution_id = alloc.create_distribution(
            db, principal, actor, cycle_id, revision_reason=body.revision_reason).id
    return _distribution_read(db, principal, alloc.get_distribution(db, principal,
                                                                    distribution_id))


@router.get("/distributions/{distribution_id}", response_model=DistributionRead)
def get_distribution(distribution_id: int, db: DbSession, principal: CurrentPrincipal):
    return _distribution_read(db, principal, alloc.get_distribution(db, principal,
                                                                    distribution_id))


@router.put("/distributions/{distribution_id}", response_model=DistributionRead)
def save_distribution(distribution_id: int, body: DistributionWrite, db: DbSession,
                      principal: CurrentPrincipal, actor: AuditActorDep):
    data = alloc.DistributionInput(
        allow_mixed_methods=body.allow_mixed_methods, note=body.note,
        plants=[alloc.PlantInput(p.plant_id, p.method, p.value,
                                 [alloc.UnitInput(u.department_id, u.method, u.value)
                                  for u in p.units]) for p in body.plants])
    with transaction(db):
        alloc.save_distribution(db, principal, actor, distribution_id, data)
    return _distribution_read(db, principal, alloc.get_distribution(db, principal,
                                                                    distribution_id))


@router.post("/distributions/{distribution_id}/publish", response_model=DistributionRead)
def publish_distribution(distribution_id: int, db: DbSession, principal: CurrentPrincipal,
                         actor: AuditActorDep):
    with transaction(db):
        alloc.publish_distribution(db, principal, actor, distribution_id)
    return _distribution_read(db, principal, alloc.get_distribution(db, principal,
                                                                    distribution_id))


# --- proposals -----------------------------------------------------------------------------------

def _proposal_read(db: Session, principal: Principal, p: AllocationProposal) -> ProposalRead:
    cycle = db.get(CompensationCycle, p.cycle_id)
    ctx = alloc.context(db, cycle)
    all_versions = alloc.versions(db, p)
    detail = alloc.employee_level(principal, p.plant_id, p.department_id)
    hide = not detail and p.included_count < alloc.MIN_GROUP
    users = _users(db, {p.prepared_by_user_id, p.submitted_by_user_id,
                        p.admin_reviewed_by_user_id, p.decided_by_user_id})
    plants, departments = _places(db, {p.plant_id}, {p.department_id})
    distribution = db.get(BudgetDistribution, p.distribution_id)
    current = ctx.unit_budget(p.plant_id, p.department_id)
    stale = alloc.stale_reasons(db, p, ctx)
    has_open = any(x.status in alloc.OPEN for x in all_versions)
    lines = excluded = None
    if detail:
        lines = [ProposalLineRead(
            employee=EmployeeRef.model_validate(x.employee),
            own=principal.employee_id is not None and x.employee_id == principal.employee_id,
            annual_result_id=x.annual_result_id,
            current_salary=rules.decimal_text(x.current_salary),
            recommended_percent=rules.decimal_text(x.recommended_percent),
            recommended_amount=rules.decimal_text(x.recommended_amount),
            proposed_percent=rules.decimal_text(x.proposed_percent),
            proposed_amount=rules.decimal_text(x.proposed_amount),
            new_salary=rules.decimal_text(x.new_salary),
            difference=rules.decimal_text(x.proposed_amount - x.recommended_amount),
            reason=x.reason) for x in p.lines]
        scenario = db.get(BudgetScenario, p.scenario_id)
        excluded = _excluded(db, [x for x in alloc.unit_scenario_lines(
            db, scenario, p.plant_id, p.department_id) if x.status == BudgetLineStatus.EXCLUDED])
    return ProposalRead(
        id=p.id, cycle=_cycle(db, cycle), plant=plants[p.plant_id],
        department=departments[p.department_id], version_no=p.version_no, status=p.status,
        scenario_id=p.scenario_id, budget_decision_id=p.budget_decision_id,
        distribution_id=p.distribution_id,
        distribution_version=distribution.version_no if distribution else None,
        unit_budget=rules.decimal_text(p.unit_budget), current_unit_budget=_num(current),
        included_count=p.included_count, changed_count=p.changed_count,
        recommended_total=None if hide else _num(p.recommended_total),
        proposed_total=None if hide else _num(p.proposed_total),
        remaining_budget=None if hide else _num(p.unit_budget - p.proposed_total),
        suppressed=hide,
        # A draft follows the policy in force; a submitted version keeps its copy.
        policy=_policy(alloc.policy_of(cycle) if p.status == AllocationStatus.DRAFT
                       else {**p.policy, "configured": p.policy.get("configured", True)}),
        note=p.note, prepared_by=users.get(p.prepared_by_user_id), created_at=p.created_at,
        submitted_by=users.get(p.submitted_by_user_id or 0), submitted_at=p.submitted_at,
        admin_reviewed_by=users.get(p.admin_reviewed_by_user_id or 0),
        admin_reviewed_at=p.admin_reviewed_at, admin_note=p.admin_note,
        decided_by=users.get(p.decided_by_user_id or 0), decided_at=p.decided_at,
        decision_reason=p.decision_reason, stale_reasons=stale, lines=lines, excluded=excluded,
        versions=[_brief(db, x, ctx, hide) for x in all_versions],
        actions=ProposalActions(**alloc.actions(db, principal, p, bool(stale), has_open)),
        history=audit_entries(audit.history(db, "allocation_proposal",
                                            [x.id for x in all_versions])))


def _read(db: Session, principal: Principal, proposal_id: int) -> ProposalRead:
    return _proposal_read(db, principal, alloc.get_proposal(db, principal, proposal_id))


@router.post("/cycles/{cycle_id}/proposals", response_model=ProposalRead,
             status_code=status.HTTP_201_CREATED)
def start_proposal(cycle_id: int, body: ProposalStart, db: DbSession,
                   principal: CurrentPrincipal, actor: AuditActorDep):
    """The next version of a unit's proposal (allocation:propose covering the unit)."""
    with transaction(db):
        proposal_id = alloc.start_proposal(db, principal, actor, cycle_id, body.plant_id,
                                           body.department_id).id
    return _read(db, principal, proposal_id)


@router.get("/proposals/{proposal_id}", response_model=ProposalRead)
def get_proposal(proposal_id: int, db: DbSession, principal: CurrentPrincipal):
    return _read(db, principal, proposal_id)


@router.put("/proposals/{proposal_id}", response_model=ProposalRead)
def save_proposal(proposal_id: int, body: ProposalWrite, db: DbSession,
                  principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        alloc.save_proposal(db, principal, actor, proposal_id,
                            lines=[alloc.LineInput(x.employee_id, x.proposed_percent, x.reason)
                                   for x in body.lines], note=body.note)
    return _read(db, principal, proposal_id)


@router.post("/proposals/{proposal_id}/refresh", response_model=ProposalRead)
def refresh_proposal(proposal_id: int, db: DbSession, principal: CurrentPrincipal,
                     actor: AuditActorDep):
    with transaction(db):
        alloc.refresh_proposal(db, principal, actor, proposal_id)
    return _read(db, principal, proposal_id)


@router.post("/proposals/{proposal_id}/submit", response_model=ProposalRead)
def submit_proposal(proposal_id: int, db: DbSession, principal: CurrentPrincipal,
                    actor: AuditActorDep):
    with transaction(db):
        alloc.submit_proposal(db, principal, actor, proposal_id)
    return _read(db, principal, proposal_id)


@router.post("/proposals/{proposal_id}/forward", response_model=ProposalRead)
def forward_proposal(proposal_id: int, body: ForwardRequest, db: DbSession,
                     principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        alloc.forward_proposal(db, principal, actor, proposal_id, body.note)
    return _read(db, principal, proposal_id)


@router.post("/proposals/{proposal_id}/return", response_model=ProposalRead)
def return_proposal(proposal_id: int, body: ReasonRequest, db: DbSession,
                    principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        alloc.return_proposal(db, principal, actor, proposal_id, body.reason)
    return _read(db, principal, proposal_id)


@router.post("/proposals/{proposal_id}/approve", response_model=ProposalRead)
def approve_proposal(proposal_id: int, body: ReasonRequest, db: DbSession,
                     principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        alloc.approve_proposal(db, principal, actor, proposal_id, body.reason)
    return _read(db, principal, proposal_id)


@router.post("/proposals/{proposal_id}/reject", response_model=ProposalRead)
def reject_proposal(proposal_id: int, body: ReasonRequest, db: DbSession,
                    principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        alloc.reject_proposal(db, principal, actor, proposal_id, body.reason)
    return _read(db, principal, proposal_id)

