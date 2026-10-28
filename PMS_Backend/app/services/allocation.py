"""Budget distribution and department allocation proposals (Stage O).

Workflow (business decisions, 2026-10-28):
  * the budget owner (budget:distribute, GLOBAL) distributes the finalized
    company budget to plants and then to plant-department units, and publishes
    each version directly (a reason for every revision);
  * the HR Head (compensation:manage, GLOBAL) sets the cycle's discretion
    policy: recommendation only (the default), changes with a reason, or
    changes with a reason within +/- percentage-point limits;
  * a Department Head (allocation:propose, scoped) prepares the unit's
    proposal from the finalized scenario's recommendations and submits it;
    it can't be submitted over the unit's distributed budget;
  * an Admin (allocation:review, GLOBAL) forwards it to the CHRO or returns it;
  * the CHRO (allocation:approve, GLOBAL) approves, rejects or returns it.

Nobody reviews or decides what they prepared or submitted, nor a proposal
containing their own increment; a preparer can't change their own line.
A proposal never changes the scenario, the matrices or the annual results;
nothing is adjusted automatically to fit a budget. Staleness is computed
from the sources (budget revision, distribution change, annual result
change), never by rewriting history.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.auth.permissions import Permission, Principal
from app.models import (
    AllocationProposal,
    AllocationProposalLine,
    AllocationStatus,
    BudgetDecision,
    BudgetDistribution,
    BudgetDistributionLine,
    BudgetLineStatus,
    BudgetScenario,
    BudgetScenarioLine,
    CompensationCycle,
    CompensationCycleStatus,
    DiscretionMode,
    DistributionLevel,
    DistributionMethod,
    DistributionStatus,
    Plant,
    PlantDepartment,
    User,
)
from app.services import compensation
from app.services import matrix_rules as rules
from app.services.audit import AuditActor, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)

CENT = Decimal("0.01")
EXACT = Decimal("0.000001")
HUNDRED = Decimal(100)
MAX_AMOUNT = Decimal("1e14")
MIN_GROUP = 3  # same small-group rule as Stage N
OPEN = (AllocationStatus.DRAFT, AllocationStatus.ADMIN_REVIEW, AllocationStatus.CHRO_REVIEW)
IN_REVIEW = (AllocationStatus.ADMIN_REVIEW, AllocationStatus.CHRO_REVIEW)
ACTIVE = (*OPEN, AllocationStatus.APPROVED)  # count towards the proposed total


def _text(value: Decimal | None) -> str | None:
    return None if value is None else rules.decimal_text(value)


def _audit(db: Session, actor: AuditActor, entity: tuple[str, int], action: str, summary: str, *,
           reason: str | None = None, changes: dict[str, Any] | None = None,
           unit: tuple[int, int] | None = None) -> None:
    record_event(db, actor=actor, action=action, entity_type=entity[0], entity_id=entity[1],
                 summary=summary, reason=reason, changes=changes,
                 plant_id=unit[0] if unit else None, department_id=unit[1] if unit else None)


# --- access ------------------------------------------------------------------------------------

def _global(principal: Principal, permission: Permission) -> bool:
    return principal.scope_for(permission).is_global


def _require_global(principal: Principal, permission: Permission, message: str) -> None:
    if not _global(principal, permission):
        raise PermissionDeniedError(message)


def can_read(principal: Principal) -> bool:
    return any(not principal.scope_for(p).is_empty for p in (
        Permission.BUDGET_READ, Permission.COMPENSATION_READ, Permission.ALLOCATION_PROPOSE,
        Permission.ALLOCATION_REVIEW, Permission.ALLOCATION_APPROVE))


def _require_read(principal: Principal) -> None:
    if not can_read(principal):
        raise PermissionDeniedError("You do not have access to budget allocations.")


def sees_company(principal: Principal) -> bool:
    """Company-wide totals: global budget, compensation or allocation authority."""
    return any(_global(principal, p) for p in (
        Permission.BUDGET_READ, Permission.COMPENSATION_READ, Permission.ALLOCATION_REVIEW,
        Permission.ALLOCATION_APPROVE))


def employee_level(principal: Principal, plant_id: int | None, department_id: int | None) -> bool:
    """Employee lines (salaries, recommendations, proposals) of a unit."""
    if _global(principal, Permission.COMPENSATION_READ):
        return True
    if plant_id is None or department_id is None:
        return False
    return (principal.scope_for(Permission.COMPENSATION_READ).allows_unit(plant_id, department_id)
            or principal.scope_for(Permission.ALLOCATION_PROPOSE).allows_unit(plant_id,
                                                                              department_id))


def sees_unit(principal: Principal, plant_id: int | None, department_id: int | None) -> bool:
    if sees_company(principal) or employee_level(principal, plant_id, department_id):
        return True
    if plant_id is None or department_id is None:
        return False
    return principal.scope_for(Permission.BUDGET_READ).allows_unit(plant_id, department_id)


def can_propose(principal: Principal, plant_id: int, department_id: int) -> bool:
    return principal.scope_for(Permission.ALLOCATION_PROPOSE).allows_unit(plant_id, department_id)


def can_distribute(principal: Principal) -> bool:
    return _global(principal, Permission.BUDGET_DISTRIBUTE)


# --- cycles, sources, policy ---------------------------------------------------------------------

def get_cycle(db: Session, principal: Principal, cycle_id: int) -> CompensationCycle:
    _require_read(principal)
    cycle = db.get(CompensationCycle, cycle_id)
    if cycle is None:
        raise NotFoundError("Compensation cycle", cycle_id)
    return cycle


def cycles(db: Session, principal: Principal) -> list[CompensationCycle]:
    _require_read(principal)
    return list(db.scalars(select(CompensationCycle).order_by(
        CompensationCycle.effective_date.desc(), CompensationCycle.id.desc())))


def _require_finalized(db: Session, cycle: CompensationCycle) -> BudgetScenario:
    scenario = compensation.finalized_scenario(db, cycle.id)
    if cycle.status != CompensationCycleStatus.FINALIZED or scenario is None:
        if cycle.revision_no and scenario is not None:
            raise ConflictError(
                f"The budget of {cycle.name} is being revised (revision {cycle.revision_no}); "
                "distribution and allocation resume when the CHRO approves the revised budget.")
        raise ConflictError(f"The company budget of {cycle.name} is not finalized yet.")
    return scenario


def _locked_cycle(db: Session, cycle_id: int) -> CompensationCycle:
    """Lock order everywhere: the cycle first, then its distribution or proposal."""
    cycle = db.scalars(select(CompensationCycle).where(CompensationCycle.id == cycle_id)
                       .with_for_update().execution_options(populate_existing=True)
                       ).one_or_none()
    if cycle is None:
        raise NotFoundError("Compensation cycle", cycle_id)
    return cycle


def policy_of(cycle: CompensationCycle) -> dict[str, Any]:
    """The discretion policy in force; recommendation only until the HR Head sets one."""
    if not cycle.allocation_policy:
        return {"mode": DiscretionMode.RECOMMENDATION_ONLY.value, "max_increase_points": None,
                "max_decrease_points": None, "version": 0, "configured": False}
    return {**cycle.allocation_policy, "configured": True}


def _points(value: Decimal | None, label: str, issues: list[Issue]) -> Decimal | None:
    if value is None:
        issues.append(Issue(f"Give the maximum {label} in percentage points.", label))
        return None
    if value < 0 or value > HUNDRED or value.as_tuple().exponent < -2:
        issues.append(Issue(f"The maximum {label} must be 0–100 percentage points with at most "
                            "two decimals.", label))
        return None
    return value


def set_policy(db: Session, principal: Principal, actor: AuditActor, cycle_id: int, *,
               mode: DiscretionMode, max_increase: Decimal | None,
               max_decrease: Decimal | None) -> CompensationCycle:
    _require_global(principal, Permission.COMPENSATION_MANAGE,
                    "The discretion policy is set by an HR Head with company-wide authority.")
    cycle = _locked_cycle(db, cycle_id)
    if db.scalar(select(func.count()).select_from(AllocationProposal).where(
            AllocationProposal.cycle_id == cycle.id,
            AllocationProposal.status.in_(IN_REVIEW))):
        raise ConflictError("Proposals are in review; change the policy when no proposal awaits "
                            "the Admin or the CHRO.")
    issues: list[Issue] = []
    inc = dec = None
    if mode == DiscretionMode.WITHIN_LIMITS:
        inc = _points(max_increase, "increase", issues)
        dec = _points(max_decrease, "decrease", issues)
    elif max_increase is not None or max_decrease is not None:
        issues.append(Issue("Limits apply only to the 'within limits' policy.", "mode"))
    if issues:
        raise ValidationFailedError(issues)
    before = policy_of(cycle)
    after = {"mode": mode.value, "max_increase_points": _text(inc),
             "max_decrease_points": _text(dec), "version": before["version"] + 1,
             "set_by_user_id": principal.user_id}
    cycle.allocation_policy = after
    db.flush()
    _audit(db, actor, ("compensation_cycle", cycle.id), "allocation_policy.set",
           f"Set the discretion policy of {cycle.code} to {mode.value} "
           f"(version {after['version']})",
           changes={"before": {k: before[k] for k in ("mode", "max_increase_points",
                                                        "max_decrease_points", "version")},
                    "after": after})
    return cycle


# --- distribution --------------------------------------------------------------------------------

@dataclass
class UnitInput:
    department_id: int
    method: DistributionMethod
    value: Decimal


@dataclass
class PlantInput:
    plant_id: int
    method: DistributionMethod
    value: Decimal
    units: list[UnitInput] = field(default_factory=list)


@dataclass
class DistributionInput:
    allow_mixed_methods: bool
    note: str | None
    plants: list[PlantInput]


def distributions(db: Session, cycle_id: int) -> list[BudgetDistribution]:
    return list(db.scalars(select(BudgetDistribution).where(
        BudgetDistribution.cycle_id == cycle_id).order_by(BudgetDistribution.version_no.desc())))


def published_distribution(db: Session, cycle_id: int) -> BudgetDistribution | None:
    return db.scalars(select(BudgetDistribution).where(
        BudgetDistribution.cycle_id == cycle_id,
        BudgetDistribution.status == DistributionStatus.PUBLISHED)).one_or_none()


def get_distribution(db: Session, principal: Principal, distribution_id: int) -> BudgetDistribution:
    if not (can_distribute(principal) or sees_company(principal)
            or not principal.scope_for(Permission.BUDGET_READ).is_empty):
        raise PermissionDeniedError("You do not have access to budget distributions.")
    distribution = db.get(BudgetDistribution, distribution_id)
    if distribution is None:
        raise NotFoundError("Budget distribution", distribution_id)
    return distribution


def _resolve(parent: Decimal, method: DistributionMethod,
             value: Decimal) -> tuple[Decimal, Decimal]:
    """(allocation, exact): a percentage is rounded DOWN to the cent so that
    children never exceed their parent; the cents left over stay unallocated."""
    if method == DistributionMethod.PERCENT:
        exact = parent * value / HUNDRED
        return exact.quantize(CENT, rounding=ROUND_DOWN), exact.quantize(EXACT, ROUND_HALF_UP)
    return value, value


def _check_value(method: DistributionMethod, value: Decimal, where: str,
                 issues: list[Issue]) -> bool:
    if method == DistributionMethod.PERCENT:
        if not (0 < value <= HUNDRED) or value.as_tuple().exponent < -4:
            issues.append(Issue(f"{where}: a percentage must be above 0 and at most 100, with at "
                                "most four decimals.", "value"))
            return False
    elif value < 0 or value >= MAX_AMOUNT or value.as_tuple().exponent < -2:
        issues.append(Issue(f"{where}: an amount must be 0 or more, with at most two decimals.",
                            "value"))
        return False
    return True


@dataclass
class _Planned:
    plant_id: int
    method: DistributionMethod
    percent: Decimal | None
    amount: Decimal
    exact: Decimal
    units: list[tuple[int, DistributionMethod, Decimal | None, Decimal, Decimal]]


def _plan(db: Session, budget: Decimal, data: DistributionInput,
          strict: bool) -> tuple[list[_Planned], list[Issue]]:
    """Resolve the amounts and check the rules. `strict` adds the sums (a copy
    of an earlier version may not fit a revised budget until it is edited)."""
    issues: list[Issue] = []
    plants = {p.id: p for p in db.scalars(select(Plant).where(
        Plant.id.in_([x.plant_id for x in data.plants] or [0])))}
    mapped = {(u.plant_id, u.department_id): u for u in db.scalars(select(PlantDepartment).where(
        PlantDepartment.plant_id.in_([x.plant_id for x in data.plants] or [0])))}
    if not data.allow_mixed_methods and len({x.method for x in data.plants}) > 1:
        issues.append(Issue("Plants use different methods; allow mixed methods or use one.",
                            "plants"))
    planned: list[_Planned] = []
    seen_plants: set[int] = set()
    for p in data.plants:
        plant = plants.get(p.plant_id)
        name = plant.name if plant else f"Plant {p.plant_id}"
        if plant is None or not plant.is_active:
            issues.append(Issue(f"{name} is not an active plant.", "plant_id"))
            continue
        if p.plant_id in seen_plants:
            issues.append(Issue(f"{name} appears more than once; allocate each plant once.",
                                "plant_id"))
            continue
        seen_plants.add(p.plant_id)
        if not _check_value(p.method, p.value, name, issues):
            continue
        amount, exact = _resolve(budget, p.method, p.value)
        if not data.allow_mixed_methods and len({u.method for u in p.units}) > 1:
            issues.append(Issue(f"{name}: departments use different methods; allow mixed methods "
                                "or use one.", "units"))
        units = []
        seen_units: set[int] = set()
        for u in p.units:
            unit = mapped.get((p.plant_id, u.department_id))
            where = f"{name}, department {u.department_id}"
            if unit is None or not unit.is_active:
                issues.append(Issue(f"{where} is not an active department of the plant.",
                                    "department_id"))
                continue
            where = f"{name} — {unit.department.name}"
            if u.department_id in seen_units:
                issues.append(Issue(f"{where} appears more than once; allocate each unit once.",
                                    "department_id"))
                continue
            seen_units.add(u.department_id)
            if not _check_value(u.method, u.value, where, issues):
                continue
            u_amount, u_exact = _resolve(amount, u.method, u.value)
            units.append((u.department_id, u.method,
                          u.value if u.method == DistributionMethod.PERCENT else None,
                          u_amount, u_exact))
        if strict and sum((x[3] for x in units), Decimal(0)) > amount:
            issues.append(Issue(f"{name}: its departments are allocated "
                                f"{_text(sum((x[3] for x in units), Decimal(0)))}, more than the "
                                f"plant's {_text(amount)}.", "units"))
        planned.append(_Planned(p.plant_id, p.method,
                                p.value if p.method == DistributionMethod.PERCENT else None,
                                amount, exact, units))
    total = sum((x.amount for x in planned), Decimal(0))
    if strict and total > budget:
        issues.append(Issue(f"The plants are allocated {_text(total)}, more than the company "
                            f"budget of {_text(budget)}.", "plants"))
    return planned, issues


def _totals(budget: Decimal, lines: Sequence[BudgetDistributionLine]) -> dict[str, Any]:
    """Sums, unallocated balances and rounding residuals (never redistributed)."""
    plant_lines = [x for x in lines if x.level == DistributionLevel.PLANT]
    by_parent: dict[int, list[BudgetDistributionLine]] = defaultdict(list)
    for x in lines:
        if x.level == DistributionLevel.UNIT and x.parent_id is not None:
            by_parent[x.parent_id].append(x)

    def residual(items: Iterable[BudgetDistributionLine]) -> Decimal:
        return sum((x.amount_exact - x.amount for x in items
                    if x.method == DistributionMethod.PERCENT), Decimal(0))

    plants = []
    for p in plant_lines:
        children = by_parent.get(p.id, [])
        units_total = sum((u.amount for u in children), Decimal(0))
        plants.append({"plant_id": p.plant_id, "amount": _text(p.amount),
                       "units_total": _text(units_total),
                       "unallocated": _text(p.amount - units_total),
                       "rounding_residual": _text(residual(children)), "units": len(children)})
    plants_total = sum((p.amount for p in plant_lines), Decimal(0))
    units_total = sum((u.amount for x in by_parent.values() for u in x), Decimal(0))
    return {"budget": _text(budget), "plants_total": _text(plants_total),
            "unallocated": _text(budget - plants_total),
            "rounding_residual": _text(residual(plant_lines)),
            "units_total": _text(units_total),
            "plants_unallocated": _text(plants_total - units_total),
            "plants": plants}


def _inputs(distribution: BudgetDistribution) -> DistributionInput:
    plant_lines = [x for x in distribution.lines if x.level == DistributionLevel.PLANT]
    return DistributionInput(
        allow_mixed_methods=distribution.allow_mixed_methods, note=distribution.note,
        plants=[PlantInput(
            p.plant_id, p.method, p.percent if p.method == DistributionMethod.PERCENT else p.amount,
            [UnitInput(u.department_id, u.method,
                       u.percent if u.method == DistributionMethod.PERCENT else u.amount)
             for u in distribution.lines if u.parent_id == p.id])
            for p in plant_lines])


def _store(db: Session, distribution: BudgetDistribution, planned: list[_Planned]) -> None:
    # A draft's working lines are replaced (published versions never change):
    # units before their plants, because of the parent foreign key.
    for x in [x for x in distribution.lines if x.level == DistributionLevel.UNIT]:
        distribution.lines.remove(x)
    db.flush()
    distribution.lines.clear()
    db.flush()
    for p in planned:
        line = BudgetDistributionLine(level=DistributionLevel.PLANT, plant_id=p.plant_id,
                                      method=p.method, percent=p.percent, amount=p.amount,
                                      amount_exact=p.exact)
        distribution.lines.append(line)
        db.flush()
        for dept, method, percent, amount, exact in p.units:
            distribution.lines.append(BudgetDistributionLine(
                level=DistributionLevel.UNIT, plant_id=p.plant_id, department_id=dept,
                parent_id=line.id, method=method, percent=percent, amount=amount,
                amount_exact=exact))
    db.flush()
    distribution.totals = _totals(distribution.budget_amount, distribution.lines)


def _follow_budget(db: Session, distribution: BudgetDistribution,
                   scenario: BudgetScenario) -> None:
    """A draft always distributes the current finalized budget."""
    decision = db.get(BudgetDecision, scenario.budget_decision_id)
    distribution.scenario_id = scenario.id
    distribution.budget_decision_id = decision.id
    distribution.budget_amount = decision.approved_amount


def _locked_distribution(db: Session,
                         distribution_id: int) -> tuple[BudgetDistribution, CompensationCycle]:
    found = db.get(BudgetDistribution, distribution_id)
    if found is None:
        raise NotFoundError("Budget distribution", distribution_id)
    cycle = _locked_cycle(db, found.cycle_id)
    distribution = db.scalars(select(BudgetDistribution).where(
        BudgetDistribution.id == distribution_id).with_for_update()
        .execution_options(populate_existing=True)).one()
    return distribution, cycle


def create_distribution(db: Session, principal: Principal, actor: AuditActor, cycle_id: int, *,
                        revision_reason: str | None) -> BudgetDistribution:
    """A new draft version, starting from the published one when there is one."""
    _require_global(principal, Permission.BUDGET_DISTRIBUTE,
                    "Budgets are distributed by the budget owner with company-wide authority.")
    cycle = _locked_cycle(db, cycle_id)
    scenario = _require_finalized(db, cycle)
    if db.scalar(select(BudgetDistribution.id).where(
            BudgetDistribution.cycle_id == cycle.id,
            BudgetDistribution.status == DistributionStatus.DRAFT)):
        raise ConflictError("A draft distribution already exists; edit or publish it.")
    published = published_distribution(db, cycle.id)
    reason = (revision_reason or "").strip()
    if published is not None and len(reason) < 10:
        raise ValidationFailedError([Issue("Give the reason for revising the published "
                                           "distribution (at least 10 characters).",
                                           "revision_reason")])
    number = (db.scalar(select(func.max(BudgetDistribution.version_no)).where(
        BudgetDistribution.cycle_id == cycle.id)) or 0) + 1
    draft = BudgetDistribution(cycle_id=cycle.id, version_no=number,
                               status=DistributionStatus.DRAFT,
                               allow_mixed_methods=published.allow_mixed_methods if published
                               else False, note=published.note if published else None,
                               revision_reason=reason or None, totals={},
                               created_by_user_id=principal.user_id)
    _follow_budget(db, draft, scenario)
    db.add(draft)
    db.flush()
    planned, _issues = _plan(db, draft.budget_amount,
                             _inputs(published) if published else
                             DistributionInput(draft.allow_mixed_methods, draft.note, []),
                             strict=False)
    _store(db, draft, planned)
    _audit(db, actor, ("budget_distribution", draft.id), "budget_distribution.create",
           f"Started distribution version {number} of {cycle.code}", reason=reason or None,
           changes={"from_version": published.version_no if published else None,
                    "budget_amount": _text(draft.budget_amount), "scenario_id": scenario.id})
    return draft


def save_distribution(db: Session, principal: Principal, actor: AuditActor, distribution_id: int,
                      data: DistributionInput) -> BudgetDistribution:
    _require_global(principal, Permission.BUDGET_DISTRIBUTE,
                    "Budgets are distributed by the budget owner with company-wide authority.")
    distribution, cycle = _locked_distribution(db, distribution_id)
    if distribution.status != DistributionStatus.DRAFT:
        raise ConflictError("Only a draft distribution can be changed; start a new version.")
    scenario = _require_finalized(db, cycle)
    _follow_budget(db, distribution, scenario)
    planned, issues = _plan(db, distribution.budget_amount, data, strict=True)
    if issues:
        raise ValidationFailedError(issues)
    before = distribution.totals
    distribution.allow_mixed_methods = data.allow_mixed_methods
    distribution.note = (data.note or "").strip()[:1000] or None
    _store(db, distribution, planned)
    _audit(db, actor, ("budget_distribution", distribution.id), "budget_distribution.save",
           f"Saved draft distribution version {distribution.version_no} of {cycle.code}",
           changes={"before": before, "after": distribution.totals})
    return distribution


def _unit_amounts(distribution: BudgetDistribution | None) -> dict[tuple[int, int], Decimal]:
    if distribution is None:
        return {}
    return {(x.plant_id, x.department_id): x.amount for x in distribution.lines
            if x.level == DistributionLevel.UNIT}


def publish_distribution(db: Session, principal: Principal, actor: AuditActor,
                         distribution_id: int) -> BudgetDistribution:
    _require_global(principal, Permission.BUDGET_DISTRIBUTE,
                    "Budgets are distributed by the budget owner with company-wide authority.")
    distribution, cycle = _locked_distribution(db, distribution_id)
    if distribution.status != DistributionStatus.DRAFT:
        raise ConflictError("Only a draft distribution can be published.")
    scenario = _require_finalized(db, cycle)
    _follow_budget(db, distribution, scenario)
    planned, issues = _plan(db, distribution.budget_amount, _inputs(distribution), strict=True)
    if not planned:
        issues.append(Issue("Allocate the budget to at least one plant.", "plants"))
    if issues:
        raise ValidationFailedError(issues)
    _store(db, distribution, planned)
    previous = published_distribution(db, cycle.id)
    if previous is not None:
        previous.status = DistributionStatus.SUPERSEDED
        previous.superseded_at = func.now()
        db.flush()  # free the cycle's one-PUBLISHED key
    distribution.status = DistributionStatus.PUBLISHED
    distribution.published_by_user_id = principal.user_id
    distribution.published_at = func.now()
    db.flush()
    before, after = _unit_amounts(previous), _unit_amounts(distribution)
    changed = [{"plant_id": k[0], "department_id": k[1], "before": _text(before.get(k)),
                "after": _text(after.get(k))}
               for k in sorted(set(before) | set(after)) if before.get(k) != after.get(k)]
    _audit(db, actor, ("budget_distribution", distribution.id), "budget_distribution.publish",
           f"Published distribution version {distribution.version_no} of {cycle.code}",
           reason=distribution.revision_reason,
           changes={"superseded_version": previous.version_no if previous else None,
                    "budget_amount": _text(distribution.budget_amount),
                    "scenario_id": distribution.scenario_id,
                    "budget_decision_id": distribution.budget_decision_id,
                    "totals": distribution.totals, "units_changed": changed})
    return distribution


# --- proposals: building and checking -------------------------------------------------------

@dataclass
class LineInput:
    employee_id: int
    proposed_percent: Decimal
    reason: str | None


def _amounts(salary: Decimal, percent: Decimal) -> tuple[Decimal, Decimal, Decimal]:
    """(amount, exact, new salary): salary x % / 100, half up to the cent (as Stage N)."""
    exact = salary * percent / HUNDRED
    amount = exact.quantize(CENT, rounding=ROUND_HALF_UP)
    return amount, exact.quantize(EXACT, rounding=ROUND_HALF_UP), salary + amount


def _line_issues(policy: dict[str, Any], recommended: Decimal, proposed: Decimal,
                 reason: str | None, own: bool, who: str) -> list[Issue]:
    if proposed == recommended:
        return []
    mode = policy["mode"]
    if own:
        return [Issue(f"{who}: you can't change your own increment; it stays at the "
                      "recommendation.", "proposed_percent")]
    if mode == DiscretionMode.RECOMMENDATION_ONLY:
        return [Issue(f"{who}: the cycle's policy allows the recommendation only.",
                      "proposed_percent")]
    if proposed < 0 or proposed.as_tuple().exponent < -2 or proposed > HUNDRED * 10:
        return [Issue(f"{who}: give an increment of 0 % or more with at most two decimals.",
                      "proposed_percent")]
    if mode == DiscretionMode.WITHIN_LIMITS:
        low = recommended - Decimal(policy["max_decrease_points"])
        high = recommended + Decimal(policy["max_increase_points"])
        if not (low <= proposed <= high):
            return [Issue(f"{who}: the policy allows {_text(max(low, Decimal(0)))} % to "
                          f"{_text(high)} %.", "proposed_percent")]
    if len((reason or "").strip()) < 10:
        return [Issue(f"{who}: give the reason for departing from the recommendation (at least "
                      "10 characters).", "reason")]
    return []


def _locked_proposal(db: Session,
                     proposal_id: int) -> tuple[AllocationProposal, CompensationCycle]:
    found = db.get(AllocationProposal, proposal_id)
    if found is None:
        raise NotFoundError("Allocation proposal", proposal_id)
    cycle = _locked_cycle(db, found.cycle_id)
    proposal = db.scalars(select(AllocationProposal).where(
        AllocationProposal.id == proposal_id).with_for_update()
        .execution_options(populate_existing=True)).one()
    return proposal, cycle


def unit_scenario_lines(db: Session, scenario: BudgetScenario, plant_id: int,
                        department_id: int) -> list[BudgetScenarioLine]:
    return list(db.scalars(select(BudgetScenarioLine).where(
        BudgetScenarioLine.scenario_id == scenario.id, BudgetScenarioLine.plant_id == plant_id,
        BudgetScenarioLine.department_id == department_id)
        .options(joinedload(BudgetScenarioLine.employee)).order_by(BudgetScenarioLine.id)))


def _totals_of(proposal: AllocationProposal) -> None:
    proposal.included_count = len(proposal.lines)
    proposal.recommended_total = sum((x.recommended_amount for x in proposal.lines), Decimal(0))
    proposal.proposed_total = sum((x.proposed_amount for x in proposal.lines), Decimal(0))
    proposal.changed_count = sum(1 for x in proposal.lines
                                 if x.proposed_percent != x.recommended_percent)


def _fill(db: Session, proposal: AllocationProposal, scenario: BudgetScenario,
          carried: dict[int, AllocationProposalLine], own_employee: int | None) -> None:
    """Lines from the scenario's included employees of the unit; a value and
    reason are carried over where the recommendation and annual result are
    unchanged (never for the preparer's own line)."""
    proposal.lines.clear()
    db.flush()
    for s in unit_scenario_lines(db, scenario, proposal.plant_id, proposal.department_id):
        if s.status != BudgetLineStatus.INCLUDED:
            continue
        before = carried.get(s.employee_id)
        keep = (before is not None and s.employee_id != own_employee
                and before.recommended_percent == s.increment_percent
                and before.annual_result_id == s.annual_result_id)
        percent = before.proposed_percent if keep else s.increment_percent
        amount, exact, new_salary = _amounts(s.current_salary, percent)
        if percent == s.increment_percent:  # the recommendation exactly as calculated
            amount, exact, new_salary = (s.increment_amount, s.increment_amount_exact,
                                         s.new_salary)
        proposal.lines.append(AllocationProposalLine(
            employee_id=s.employee_id, scenario_line_id=s.id, annual_result_id=s.annual_result_id,
            current_salary=s.current_salary, recommended_percent=s.increment_percent,
            recommended_amount=s.increment_amount, proposed_percent=percent,
            proposed_amount=amount, proposed_amount_exact=exact, new_salary=new_salary,
            reason=before.reason if keep and percent != s.increment_percent else None))
    db.flush()
    _totals_of(proposal)


def _sources(db: Session, proposal: AllocationProposal, scenario: BudgetScenario,
             distribution: BudgetDistribution) -> None:
    proposal.scenario_id = scenario.id
    proposal.budget_decision_id = scenario.budget_decision_id
    proposal.distribution_id = distribution.id
    line = next((x for x in distribution.lines if x.level == DistributionLevel.UNIT
                 and (x.plant_id, x.department_id) == (proposal.plant_id,
                                                         proposal.department_id)), None)
    proposal.distribution_line_id = line.id if line else None
    proposal.unit_budget = line.amount if line else Decimal(0)


@dataclass
class Context:
    """Current sources of a cycle, computed once per request."""

    cycle: CompensationCycle
    scenario: BudgetScenario | None
    distribution: BudgetDistribution | None
    changed_employees: dict[int, set[int]]  # scenario id -> employees with changed annual results

    def unit_budget(self, plant_id: int, department_id: int) -> Decimal | None:
        return _unit_amounts(self.distribution).get((plant_id, department_id))


def context(db: Session, cycle: CompensationCycle) -> Context:
    return Context(cycle, compensation.finalized_scenario(db, cycle.id),
                   published_distribution(db, cycle.id), {})


def _changed(db: Session, ctx: Context, scenario_id: int) -> set[int]:
    if scenario_id not in ctx.changed_employees:
        scenario = db.get(BudgetScenario, scenario_id)
        outdated, newer = compensation.annual_changes(db, scenario)
        ctx.changed_employees[scenario_id] = outdated | newer
    return ctx.changed_employees[scenario_id]


def stale_reasons(db: Session, proposal: AllocationProposal, ctx: Context) -> list[str]:
    """Why a proposal no longer matches its sources (computed, never stored)."""
    if proposal.status in (AllocationStatus.SUPERSEDED, AllocationStatus.REJECTED,
                           AllocationStatus.RETURNED):
        return []
    reasons = []
    cycle = ctx.cycle
    if cycle.status != CompensationCycleStatus.FINALIZED:
        reasons.append(f"The company budget is being revised (revision {cycle.revision_no}).")
    if ctx.scenario is None or proposal.scenario_id != ctx.scenario.id:
        reasons.append("The company budget was revised after this version was prepared.")
    budget = ctx.unit_budget(proposal.plant_id, proposal.department_id)
    if ctx.distribution is None:
        reasons.append("No distribution is published.")
    elif (budget or Decimal(0)) != proposal.unit_budget:
        reasons.append(f"The unit's distributed budget changed from {_text(proposal.unit_budget)} "
                       f"to {_text(budget or Decimal(0))}.")
    changed = _changed(db, ctx, proposal.scenario_id) & {x.employee_id for x in proposal.lines}
    if changed:
        reasons.append(f"{len(changed)} employee(s)' approved annual result changed after the "
                       "budget was finalized; the CHRO must revise the company budget.")
    return reasons


def _require_current(db: Session, proposal: AllocationProposal, ctx: Context) -> None:
    reasons = stale_reasons(db, proposal, ctx)
    if reasons:
        raise ValidationFailedError([Issue(r, "proposal") for r in reasons])


def _require_within_budget(proposal: AllocationProposal, ctx: Context) -> None:
    budget = ctx.unit_budget(proposal.plant_id, proposal.department_id) or Decimal(0)
    if proposal.proposed_total > budget:
        raise ValidationFailedError([Issue(
            f"The proposed total {_text(proposal.proposed_total)} exceeds the unit's distributed "
            f"budget of {_text(budget)} by {_text(proposal.proposed_total - budget)}. Reduce it "
            "within the discretion policy, or ask the budget owner to revise the distribution.",
            "proposed_total")])


def _policy_issues(proposal: AllocationProposal, policy: dict[str, Any],
                   own_employees: set[int]) -> list[Issue]:
    issues = []
    for x in proposal.lines:
        who = f"{x.employee.full_name} ({x.employee.employee_code})"
        issues += _line_issues(policy, x.recommended_percent, x.proposed_percent, x.reason,
                               x.employee_id in own_employees, who)
    return issues


def _own_line(principal: Principal, proposal: AllocationProposal) -> bool:
    return principal.employee_id is not None and any(
        x.employee_id == principal.employee_id for x in proposal.lines)


def _unit_label(db: Session, plant_id: int, department_id: int) -> str:
    unit = db.scalars(select(PlantDepartment).where(
        PlantDepartment.plant_id == plant_id, PlantDepartment.department_id == department_id)
        .options(joinedload(PlantDepartment.plant), joinedload(PlantDepartment.department))
    ).one_or_none()
    if unit is None:
        return f"unit {plant_id}/{department_id}"
    return f"{unit.department.name} — {unit.plant.name}"


# --- proposals: workflow ------------------------------------------------------------------------

def get_proposal(db: Session, principal: Principal, proposal_id: int) -> AllocationProposal:
    _require_read(principal)
    proposal = db.get(AllocationProposal, proposal_id)
    if proposal is None or not sees_unit(principal, proposal.plant_id, proposal.department_id):
        raise NotFoundError("Allocation proposal", proposal_id)
    return proposal


def versions(db: Session, proposal: AllocationProposal) -> list[AllocationProposal]:
    return list(db.scalars(select(AllocationProposal).where(
        AllocationProposal.cycle_id == proposal.cycle_id,
        AllocationProposal.plant_id == proposal.plant_id,
        AllocationProposal.department_id == proposal.department_id)
        .order_by(AllocationProposal.version_no.desc())))


def start_proposal(db: Session, principal: Principal, actor: AuditActor, cycle_id: int,
                   plant_id: int, department_id: int) -> AllocationProposal:
    """A new draft version for a unit: from the finalized scenario and the
    published distribution, carrying values over from the latest version."""
    if not can_propose(principal, plant_id, department_id):
        raise PermissionDeniedError("You can't prepare allocation proposals for this unit.")
    cycle = _locked_cycle(db, cycle_id)
    scenario = _require_finalized(db, cycle)
    distribution = published_distribution(db, cycle.id)
    if distribution is None:
        raise ConflictError("The budget owner has not published a distribution yet.")
    if db.scalar(select(PlantDepartment.id).where(
            PlantDepartment.plant_id == plant_id,
            PlantDepartment.department_id == department_id)) is None:
        raise NotFoundError("Plant department", f"{plant_id}/{department_id}")
    existing = list(db.scalars(select(AllocationProposal).where(
        AllocationProposal.cycle_id == cycle.id, AllocationProposal.plant_id == plant_id,
        AllocationProposal.department_id == department_id)
        .order_by(AllocationProposal.version_no.desc()).with_for_update()))
    open_version = next((x for x in existing if x.status in OPEN), None)
    if open_version is not None:
        raise ConflictError(f"Version {open_version.version_no} of this unit's proposal is still "
                            "open.")
    if not any(s.status == BudgetLineStatus.INCLUDED
               for s in unit_scenario_lines(db, scenario, plant_id, department_id)):
        raise ConflictError("No employee of this unit has an increment recommendation in the "
                            "approved budget.")
    previous = existing[0] if existing else None
    proposal = AllocationProposal(
        cycle_id=cycle.id, plant_id=plant_id, department_id=department_id,
        version_no=(previous.version_no + 1) if previous else 1, status=AllocationStatus.DRAFT,
        previous_id=previous.id if previous else None, policy=policy_of(cycle),
        included_count=0, recommended_total=Decimal(0), proposed_total=Decimal(0),
        prepared_by_user_id=principal.user_id)
    _sources(db, proposal, scenario, distribution)
    db.add(proposal)
    db.flush()
    carried = {x.employee_id: x for x in previous.lines} if previous else {}
    _fill(db, proposal, scenario, carried, principal.employee_id)
    _audit(db, actor, ("allocation_proposal", proposal.id), "allocation_proposal.create",
           f"Started version {proposal.version_no} of the allocation proposal for "
           f"{_unit_label(db, plant_id, department_id)} ({cycle.code})",
           changes={"previous_version": previous.version_no if previous else None,
                    "scenario_id": scenario.id, "distribution_version": distribution.version_no,
                    "employees": proposal.included_count},
           unit=(plant_id, department_id))
    return proposal


def _editable(db: Session, principal: Principal,
              proposal_id: int) -> tuple[AllocationProposal, CompensationCycle, BudgetScenario]:
    proposal, cycle = _locked_proposal(db, proposal_id)
    if not can_propose(principal, proposal.plant_id, proposal.department_id):
        raise PermissionDeniedError("You can't prepare allocation proposals for this unit.")
    if proposal.status != AllocationStatus.DRAFT:
        raise ConflictError("Only a draft proposal can be changed.")
    return proposal, cycle, _require_finalized(db, cycle)


def refresh_proposal(db: Session, principal: Principal, actor: AuditActor,
                     proposal_id: int) -> AllocationProposal:
    """Bring a draft up to date with the current sources (controlled
    recalculation): the approved budget's recommendations and the unit's
    published budget; values are kept where the recommendation is unchanged."""
    proposal, cycle, scenario = _editable(db, principal, proposal_id)
    distribution = published_distribution(db, cycle.id)
    if distribution is None:
        raise ConflictError("The budget owner has not published a distribution yet.")
    before = {"scenario_id": proposal.scenario_id, "unit_budget": _text(proposal.unit_budget),
              "employees": proposal.included_count}
    carried = {x.employee_id: x for x in proposal.lines}
    _sources(db, proposal, scenario, distribution)
    proposal.policy = policy_of(cycle)
    _fill(db, proposal, scenario, carried, principal.employee_id)
    _audit(db, actor, ("allocation_proposal", proposal.id), "allocation_proposal.refresh",
           f"Refreshed version {proposal.version_no} from the current budget and distribution",
           changes={"before": before, "after": {"scenario_id": proposal.scenario_id,
                                                "unit_budget": _text(proposal.unit_budget),
                                                "employees": proposal.included_count}},
           unit=(proposal.plant_id, proposal.department_id))
    return proposal


def save_proposal(db: Session, principal: Principal, actor: AuditActor, proposal_id: int, *,
                  lines: Sequence[LineInput], note: str | None) -> AllocationProposal:
    proposal, cycle, _scenario = _editable(db, principal, proposal_id)
    policy = policy_of(cycle)
    by_employee = {x.employee_id: x for x in proposal.lines}
    issues: list[Issue] = []
    seen: set[int] = set()
    changes = []
    for item in lines:
        line = by_employee.get(item.employee_id)
        if line is None or item.employee_id in seen:
            issues.append(Issue(f"Employee {item.employee_id} is not in this proposal (or appears "
                                "twice).", "employee_id"))
            continue
        seen.add(item.employee_id)
        who = f"{line.employee.full_name} ({line.employee.employee_code})"
        reason = (item.reason or "").strip()[:500] or None
        found = _line_issues(policy, line.recommended_percent, item.proposed_percent, reason,
                             item.employee_id == principal.employee_id, who)
        if found:
            issues += found
            continue
        if item.proposed_percent != line.proposed_percent or reason != line.reason:
            changes.append({"employee_id": item.employee_id,
                            "recommended_percent": _text(line.recommended_percent),
                            "before": _text(line.proposed_percent),
                            "after": _text(item.proposed_percent)})
        line.proposed_percent = item.proposed_percent
        line.reason = reason if item.proposed_percent != line.recommended_percent else None
        if item.proposed_percent == line.recommended_percent:
            line.proposed_amount = line.recommended_amount
            s = db.get(BudgetScenarioLine, line.scenario_line_id)
            line.proposed_amount_exact, line.new_salary = s.increment_amount_exact, s.new_salary
        else:
            line.proposed_amount, line.proposed_amount_exact, line.new_salary = _amounts(
                line.current_salary, item.proposed_percent)
    if issues:
        raise ValidationFailedError(issues)
    proposal.note = (note or "").strip()[:1000] or None
    _totals_of(proposal)
    db.flush()
    # Percentages only: amounts would reveal salaries in the audit trail.
    _audit(db, actor, ("allocation_proposal", proposal.id), "allocation_proposal.save",
           f"Saved version {proposal.version_no} ({proposal.changed_count} departure(s) from the "
           "recommendation)", changes={"lines": changes},
           unit=(proposal.plant_id, proposal.department_id))
    return proposal


def submit_proposal(db: Session, principal: Principal, actor: AuditActor,
                    proposal_id: int) -> AllocationProposal:
    proposal, cycle, _scenario = _editable(db, principal, proposal_id)
    ctx = context(db, cycle)
    _require_current(db, proposal, ctx)
    policy = policy_of(cycle)
    preparer = db.get(User, proposal.prepared_by_user_id)
    own = {e for e in (preparer.employee_id if preparer else None, principal.employee_id) if e}
    issues = _policy_issues(proposal, policy, own)
    if issues:
        raise ValidationFailedError(issues)
    _require_within_budget(proposal, ctx)
    proposal.policy = policy
    proposal.status = AllocationStatus.ADMIN_REVIEW
    proposal.submitted_by_user_id = principal.user_id
    proposal.submitted_at = func.now()
    db.flush()
    _audit(db, actor, ("allocation_proposal", proposal.id), "allocation_proposal.submit",
           f"Submitted version {proposal.version_no} for Admin review",
           changes={"policy": policy, "departures": proposal.changed_count,
                    "within_budget": True},
           unit=(proposal.plant_id, proposal.department_id))
    return proposal


def _review_checks(db: Session, principal: Principal, proposal: AllocationProposal,
                   who: str) -> None:
    if principal.user_id in (proposal.prepared_by_user_id, proposal.submitted_by_user_id):
        raise PermissionDeniedError(f"You prepared or submitted this proposal; another {who} "
                                    "decides it.")
    if _own_line(principal, proposal):
        raise PermissionDeniedError(f"This proposal includes your own increment; another {who} "
                                    "decides it.")


def _reason(reason: str, what: str) -> str:
    text = (reason or "").strip()
    if len(text) < 10:
        raise ValidationFailedError([Issue(f"Give the reason for {what} (at least 10 "
                                           "characters).", "reason")])
    return text[:1000]


def forward_proposal(db: Session, principal: Principal, actor: AuditActor, proposal_id: int,
                     note: str | None) -> AllocationProposal:
    _require_global(principal, Permission.ALLOCATION_REVIEW,
                    "Allocation proposals are reviewed by an Admin.")
    proposal, cycle = _locked_proposal(db, proposal_id)
    if proposal.status != AllocationStatus.ADMIN_REVIEW:
        raise ConflictError("Only a proposal awaiting Admin review can be forwarded.")
    _review_checks(db, principal, proposal, "Admin")
    ctx = context(db, cycle)
    _require_current(db, proposal, ctx)
    proposal.status = AllocationStatus.CHRO_REVIEW
    proposal.admin_reviewed_by_user_id = principal.user_id
    proposal.admin_reviewed_at = func.now()
    proposal.admin_note = (note or "").strip()[:1000] or None
    db.flush()
    _audit(db, actor, ("allocation_proposal", proposal.id), "allocation_proposal.forward",
           f"Forwarded version {proposal.version_no} to the CHRO", reason=proposal.admin_note,
           unit=(proposal.plant_id, proposal.department_id))
    return proposal


def return_proposal(db: Session, principal: Principal, actor: AuditActor, proposal_id: int,
                    reason: str) -> AllocationProposal:
    proposal, _cycle = _locked_proposal(db, proposal_id)
    if proposal.status == AllocationStatus.ADMIN_REVIEW:
        _require_global(principal, Permission.ALLOCATION_REVIEW,
                        "Proposals awaiting Admin review are returned by an Admin.")
        who = "Admin"
    elif proposal.status == AllocationStatus.CHRO_REVIEW:
        _require_global(principal, Permission.ALLOCATION_APPROVE,
                        "Proposals awaiting the CHRO are returned by the CHRO.")
        who = "approver"
    else:
        raise ConflictError("Only a proposal in review can be returned.")
    _review_checks(db, principal, proposal, who)
    text = _reason(reason, "returning the proposal")
    before = proposal.status
    proposal.status = AllocationStatus.RETURNED
    proposal.decided_by_user_id = principal.user_id
    proposal.decided_at = func.now()
    proposal.decision_reason = text
    db.flush()
    _audit(db, actor, ("allocation_proposal", proposal.id), "allocation_proposal.return",
           f"Returned version {proposal.version_no} for revision", reason=text,
           changes={"status": {"before": before.value, "after": "RETURNED"}},
           unit=(proposal.plant_id, proposal.department_id))
    return proposal


def _decide(db: Session, principal: Principal, proposal_id: int,
            reason: str, what: str) -> tuple[AllocationProposal, CompensationCycle, str]:
    _require_global(principal, Permission.ALLOCATION_APPROVE,
                    "Allocation proposals are approved or rejected by the CHRO.")
    proposal, cycle = _locked_proposal(db, proposal_id)
    if proposal.status != AllocationStatus.CHRO_REVIEW:
        raise ConflictError("Only a proposal forwarded by an Admin awaits the CHRO's decision.")
    _review_checks(db, principal, proposal, "approver")
    if principal.user_id == proposal.admin_reviewed_by_user_id:
        raise PermissionDeniedError("You reviewed this proposal as Admin; someone else decides "
                                    "it.")
    return proposal, cycle, _reason(reason, what)


def approve_proposal(db: Session, principal: Principal, actor: AuditActor, proposal_id: int,
                     reason: str) -> AllocationProposal:
    proposal, cycle, text = _decide(db, principal, proposal_id, reason, "the approval")
    ctx = context(db, cycle)
    _require_current(db, proposal, ctx)
    _require_within_budget(proposal, ctx)
    previous = db.scalars(select(AllocationProposal).where(
        AllocationProposal.cycle_id == proposal.cycle_id,
        AllocationProposal.plant_id == proposal.plant_id,
        AllocationProposal.department_id == proposal.department_id,
        AllocationProposal.status == AllocationStatus.APPROVED)).one_or_none()
    if previous is not None:
        previous.status = AllocationStatus.SUPERSEDED
        previous.superseded_at = func.now()
        db.flush()  # free the unit's one-APPROVED key
    proposal.status = AllocationStatus.APPROVED
    proposal.decided_by_user_id = principal.user_id
    proposal.decided_at = func.now()
    proposal.decision_reason = text
    db.flush()
    _audit(db, actor, ("allocation_proposal", proposal.id), "allocation_proposal.approve",
           f"Approved version {proposal.version_no} of the allocation for "
           f"{_unit_label(db, proposal.plant_id, proposal.department_id)}", reason=text,
           changes={"superseded_version": previous.version_no if previous else None,
                    "scenario_id": proposal.scenario_id,
                    "budget_decision_id": proposal.budget_decision_id,
                    "distribution_id": proposal.distribution_id,
                    "departures": proposal.changed_count},
           unit=(proposal.plant_id, proposal.department_id))
    return proposal


def reject_proposal(db: Session, principal: Principal, actor: AuditActor, proposal_id: int,
                    reason: str) -> AllocationProposal:
    proposal, _cycle, text = _decide(db, principal, proposal_id, reason, "the rejection")
    proposal.status = AllocationStatus.REJECTED
    proposal.decided_by_user_id = principal.user_id
    proposal.decided_at = func.now()
    proposal.decision_reason = text
    db.flush()
    _audit(db, actor, ("allocation_proposal", proposal.id), "allocation_proposal.reject",
           f"Rejected version {proposal.version_no}", reason=text,
           unit=(proposal.plant_id, proposal.department_id))
    return proposal


def actions(db: Session, principal: Principal, proposal: AllocationProposal,
            stale: bool, has_open: bool) -> dict[str, bool]:
    s = proposal.status
    propose = can_propose(principal, proposal.plant_id, proposal.department_id)
    involved = principal.user_id in (proposal.prepared_by_user_id, proposal.submitted_by_user_id)
    own = _own_line(principal, proposal)
    review = _global(principal, Permission.ALLOCATION_REVIEW) and not involved and not own
    approve = _global(principal, Permission.ALLOCATION_APPROVE) and not involved and not own \
        and principal.user_id != proposal.admin_reviewed_by_user_id
    return {
        "can_edit": propose and s == AllocationStatus.DRAFT,
        "can_refresh": propose and s == AllocationStatus.DRAFT and stale,
        "can_submit": propose and s == AllocationStatus.DRAFT and not stale,
        "can_forward": review and s == AllocationStatus.ADMIN_REVIEW and not stale,
        "can_return": (review and s == AllocationStatus.ADMIN_REVIEW)
        or (approve and s == AllocationStatus.CHRO_REVIEW),
        "can_approve": approve and s == AllocationStatus.CHRO_REVIEW and not stale,
        "can_reject": approve and s == AllocationStatus.CHRO_REVIEW,
        "can_start_next": propose and not has_open and s in (
            AllocationStatus.RETURNED, AllocationStatus.REJECTED, AllocationStatus.APPROVED),
    }


# --- report --------------------------------------------------------------------------------------

def _unit_rows(db: Session, ctx: Context) -> dict[tuple[int, int], dict[str, Any]]:
    """Every unit with a distribution line or a scenario line."""
    units: dict[tuple[int, int], dict[str, Any]] = {}

    def unit(key: tuple[int, int]) -> dict[str, Any]:
        return units.setdefault(key, {"included": 0, "excluded": 0,
                                      "recommended": Decimal(0), "excluded_reasons": Counter()})

    for key in _unit_amounts(ctx.distribution):
        unit(key)
    if ctx.scenario is not None:
        for line in ctx.scenario.lines:
            if line.plant_id is None or line.department_id is None:
                continue
            u = unit((line.plant_id, line.department_id))
            if line.status == BudgetLineStatus.INCLUDED:
                u["included"] += 1
                u["recommended"] += line.increment_amount
            else:
                u["excluded"] += 1
                u["excluded_reasons"][line.exclusion_code] += 1
    return units


def overview(db: Session, principal: Principal, cycle_id: int, *, plant_id: int | None = None,
             department_id: int | None = None, status: str | None = None,
             stale_only: bool = False) -> dict[str, Any]:
    """Company and unit figures for the allocation dashboard and final report."""
    cycle = get_cycle(db, principal, cycle_id)
    ctx = context(db, cycle)
    proposals = list(db.scalars(select(AllocationProposal).where(
        AllocationProposal.cycle_id == cycle.id).order_by(AllocationProposal.version_no)))
    latest: dict[tuple[int, int], AllocationProposal] = {}
    approved: dict[tuple[int, int], AllocationProposal] = {}
    for p in proposals:
        key = (p.plant_id, p.department_id)
        latest[key] = p
        if p.status == AllocationStatus.APPROVED:
            approved[key] = p
    rows = _unit_rows(db, ctx)
    for key in latest:
        rows.setdefault(key, {"included": 0, "excluded": 0, "recommended": Decimal(0),
                              "excluded_reasons": Counter()})
    budgets = _unit_amounts(ctx.distribution)
    units = []
    counts: Counter[str] = Counter()
    stale_count = 0
    company = sees_company(principal)
    for key, u in sorted(rows.items()):
        if not sees_unit(principal, *key):
            continue
        p, a = latest.get(key), approved.get(key)
        reasons = stale_reasons(db, p, ctx) if p is not None else []
        a_reasons = stale_reasons(db, a, ctx) if a is not None and a is not p else reasons
        p_status = p.status.value if p is not None else "NOT_STARTED"
        counts[p_status] += 1
        stale_count += 1 if reasons else 0
        if (plant_id and key[0] != plant_id) or (department_id and key[1] != department_id) or (
                status and p_status != status) or (stale_only and not reasons):
            continue
        detail = employee_level(principal, *key)
        hide = not detail and u["included"] < MIN_GROUP
        budget = budgets.get(key)
        proposed = p.proposed_total if p is not None and p.status in ACTIVE else None
        units.append({
            "plant_id": key[0], "department_id": key[1], "distributed": budget,
            "included": u["included"], "excluded": u["excluded"],
            "excluded_by_reason": dict(u["excluded_reasons"]) if detail or company else {},
            "recommended": None if hide else u["recommended"],
            "proposed": None if hide else proposed,
            "approved": None if hide or a is None else a.proposed_total,
            "difference": None if hide or budget is None else
            budget - (proposed if proposed is not None else u["recommended"]),
            "suppressed": hide,
            "latest": p, "latest_stale": reasons, "approved_proposal": a,
            "approved_stale": a_reasons if a is not None else [],
            "can_start": (can_propose(principal, *key) and ctx.distribution is not None
                          and cycle.status == CompensationCycleStatus.FINALIZED
                          and u["included"] > 0 and (p is None or p.status not in OPEN)),
        })
    summary = None
    if company:
        totals = (ctx.distribution.totals if ctx.distribution else {})
        active = [p for k, p in latest.items() if p.status in ACTIVE]
        approved_lines = [x.employee_id for p in approved.values() for x in p.lines]
        scenario_included = [x for x in (ctx.scenario.lines if ctx.scenario else [])
                             if x.status == BudgetLineStatus.INCLUDED]
        unit_recommended = sum((u["recommended"] for u in rows.values()), Decimal(0))
        summary = {
            "budget": ctx.distribution.budget_amount if ctx.distribution else (
                db.get(BudgetDecision, ctx.scenario.budget_decision_id).approved_amount
                if ctx.scenario else None),
            "distributed_to_plants": totals.get("plants_total"),
            "distributed_to_units": totals.get("units_total"),
            "unallocated_company": totals.get("unallocated"),
            "unallocated_plants": totals.get("plants_unallocated"),
            "rounding_residual": totals.get("rounding_residual"),
            "recommended_total": ctx.scenario.total_increment if ctx.scenario else None,
            "proposed_total": sum((p.proposed_total for p in active), Decimal(0)),
            "approved_total": sum((p.proposed_total for p in approved.values()), Decimal(0)),
            "by_status": dict(counts), "stale": stale_count,
            "excluded_by_reason": dict(Counter(
                x.exclusion_code for x in (ctx.scenario.lines if ctx.scenario else [])
                if x.status == BudgetLineStatus.EXCLUDED)),
            "reconciliation": {
                "units_recommended_total": _text(unit_recommended),
                "scenario_recommended_total": _text(sum(
                    (x.increment_amount for x in scenario_included), Decimal(0))),
                "every_included_employee_in_one_unit": len(scenario_included) == len(
                    {x.employee_id for x in scenario_included}) and all(
                    x.plant_id is not None for x in scenario_included),
                "no_employee_in_two_approved_proposals":
                    len(approved_lines) == len(set(approved_lines)),
                "approved_within_unit_budgets": all(
                    p.proposed_total <= (budgets.get(k) or Decimal(0))
                    for k, p in approved.items()),
            },
        }
    excluded = []
    if ctx.scenario is not None:
        for x in ctx.scenario.lines:
            if x.status == BudgetLineStatus.EXCLUDED and employee_level(
                    principal, x.plant_id, x.department_id) and (
                    not plant_id or x.plant_id == plant_id) and (
                    not department_id or x.department_id == department_id):
                excluded.append(x)
    return {"cycle": cycle, "ctx": ctx, "policy": policy_of(cycle), "summary": summary,
            "units": units, "excluded": excluded,
            "can_distribute": can_distribute(principal)}


def employee_report(db: Session, principal: Principal, cycle_id: int, *,
                    plant_id: int | None = None, department_id: int | None = None,
                    search: str | None = None,
                    status: str | None = None) -> list[tuple[AllocationProposal,
                                                              AllocationProposalLine]]:
    """Employee lines of each unit's latest version, for employee-level readers."""
    if principal.scope_for(Permission.COMPENSATION_READ).is_empty and principal.scope_for(
            Permission.ALLOCATION_PROPOSE).is_empty:
        raise PermissionDeniedError("Employee-level allocations are visible only to compensation "
                                    "roles and the units' Department Heads.")
    cycle = get_cycle(db, principal, cycle_id)
    found = []
    latest: dict[tuple[int, int], AllocationProposal] = {}
    for p in db.scalars(select(AllocationProposal).where(
            AllocationProposal.cycle_id == cycle.id).order_by(AllocationProposal.version_no)):
        latest[(p.plant_id, p.department_id)] = p
    needle = (search or "").strip().lower()
    for key, p in sorted(latest.items()):
        if not employee_level(principal, *key) or (plant_id and key[0] != plant_id) or (
                department_id and key[1] != department_id) or (status and p.status.value != status):
            continue
        for x in p.lines:
            if needle and needle not in x.employee.full_name.lower() and (
                    needle not in x.employee.employee_code.lower()):
                continue
            found.append((p, x))
    return found
