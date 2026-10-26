"""Quarterly review, employee consolidation and publication (Stage L).

Quarter lifecycle (pms_cycle_quarters.status):

    DRAFT -> OPEN (start scoring; app/services/kpi_sheets.py)
         -> DEPARTMENT_REVIEW -> NORMALIZATION -> READY -> PUBLISHED

Every forward step is taken by a GLOBAL `quarter:start` user and passes an
explicit, company-wide gate; each can be undone one step with a recorded
reason. Publication needs GLOBAL `score:publish` and is one transaction.

Employee consolidation: an employee's quarterly score is built from the
assignments that have a locked KPI sheet in the quarter. Each contributes its
final score (2 decimals) or approved override. One scored assignment counts
100 %; several need explicit contribution weights for exactly those
assignments, totalling 100.00 %. The exact weighted sum is kept to 4
decimals and the final score rounded half-up to 2. Missing data, missing
weights or a missing primary assignment block the employee; nothing is ever
averaged without weights or treated as zero.

Attribution (for cohorts, and to count each person once): the primary
assignment active at the end of the quarter, else the latest primary that
overlaps it.
"""
from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.auth.permissions import Permission, Principal
from app.models import (
    AssignmentScoreWeight,
    DeviationStatus,
    Employee,
    EmployeeAssignment,
    EmployeeQuarterResult,
    EmployeeResultStatus,
    KpiDeviation,
    KpiSheet,
    KpiSheetResult,
    KpiSheetStatus,
    PlantDepartment,
    PmsCycleQuarter,
    QuarterStatus,
    ScoreResultStatus,
)
from app.services import kpi_results, normalization
from app.services import matrix_rules as rules
from app.services.audit import AuditActor, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services.kpi_results import ResultView
from app.services.kpi_sheets import QUARTER_LABELS, get_quarter, require_review

CENT = Decimal("0.01")
FOUR = Decimal("0.0001")
HUNDRED = Decimal(100)

FORWARD = {
    QuarterStatus.OPEN: QuarterStatus.DEPARTMENT_REVIEW,
    QuarterStatus.DEPARTMENT_REVIEW: QuarterStatus.NORMALIZATION,
    QuarterStatus.NORMALIZATION: QuarterStatus.READY,
}
BACKWARD = {after: before for before, after in FORWARD.items()}
FROZEN = (QuarterStatus.NORMALIZATION, QuarterStatus.READY, QuarterStatus.PUBLISHED)


def _unit_label(unit: PlantDepartment) -> str:
    return f"{unit.department.name} — {unit.plant.name}"


def _who(view: ResultView) -> str:
    a = view.sheet.assignment
    return f"{a.employee.employee_code} {a.employee.full_name} ({_unit_label(a.plant_department)})"


def sheet_problems(view: ResultView, *, for_review: bool) -> list[str]:
    """Why a sheet's result is not yet usable: for data collection to close
    (for_review=False), or for normalization (also reviewed, no override)."""
    r = view.result
    if r is None:
        return ["not calculated"]
    problems = []
    if view.stale:
        problems.append("the data changed after the calculation; recalculate")
    if not r.is_complete:
        missing = [f"{i['kpi_code']} {', '.join(i['months_missing'])}"
                   for i in (r.explanation or {}).get("items", []) if i.get("months_missing")]
        errors = [i["kpi_code"] for i in (r.explanation or {}).get("items", [])
                  if i.get("status") == "error"]
        detail = "; ".join(filter(None, [
            f"missing {', '.join(missing)}" if missing else "",
            f"cannot be scored: {', '.join(errors)}" if errors else ""]))
        problems.append(f"incomplete ({detail or 'not every KPI is scored'})")
    if for_review:
        if view.pending_override is not None:
            problems.append("a score override awaits approval")
        if r.status == ScoreResultStatus.CALCULATED:
            problems.append("not reviewed by the department")
    return problems


# --- consolidation ---------------------------------------------------------------------------

@dataclass
class Component:
    view: ResultView
    weight: Decimal | None

    @property
    def assignment(self) -> EmployeeAssignment:
        return self.view.sheet.assignment

    @property
    def score(self) -> Decimal | None:
        r = self.view.result
        if r is None:
            return None
        return r.override_score if r.override_score is not None else r.final_score

    @property
    def score_source(self) -> str | None:
        r = self.view.result
        if r is None or self.score is None:
            return None
        return "override" if r.override_score is not None else "final"

    @property
    def contribution(self) -> Decimal | None:
        if self.score is None or self.weight is None:
            return None
        return self.score * self.weight / HUNDRED

    def as_json(self) -> dict[str, Any]:
        unit = self.assignment.plant_department
        r = self.view.result
        return {
            "assignment_id": self.assignment.id, "sheet_id": self.view.sheet.id,
            "result_id": r.id if r else None, "result_inputs_sha256": r.inputs_hash if r else None,
            "plant_id": unit.plant_id, "department_id": unit.department_id,
            "unit": _unit_label(unit), "is_primary": self.assignment.is_primary,
            "score": rules.jsonable(self.score), "score_source": self.score_source,
            "weight": rules.jsonable(self.weight),
            "contribution": rules.jsonable(self.contribution),
        }


@dataclass
class Consolidation:
    employee: Employee
    components: list[Component]
    weights_source: str  # SINGLE | CONFIGURED | MISSING | INVALID
    weight_issues: list[str]
    primary: EmployeeAssignment | None

    @property
    def exact(self) -> Decimal | None:
        parts = [c.contribution for c in self.components]
        if self.weight_issues or any(p is None for p in parts):
            return None
        return sum(parts, Decimal(0))

    @property
    def calculated(self) -> Decimal | None:
        exact = self.exact
        return None if exact is None else exact.quantize(FOUR, rounding=ROUND_HALF_UP)

    @property
    def final(self) -> Decimal | None:
        exact = self.exact
        return None if exact is None else exact.quantize(CENT, rounding=ROUND_HALF_UP)

    def issues(self, *, for_review: bool = True) -> list[str]:
        found = []
        for c in self.components:
            for problem in sheet_problems(c.view, for_review=for_review):
                found.append(f"{_unit_label(c.assignment.plant_department)}: {problem}")
        found += self.weight_issues
        if self.primary is None:
            found.append("no primary assignment in the quarter, so the employee cannot be "
                         "attributed to a normalization cohort")
        return found

    @property
    def ready(self) -> bool:
        return not self.issues() and self.final is not None

    def components_json(self) -> list[dict[str, Any]]:
        return [c.as_json() for c in self.components]

    def inputs_hash(self) -> str:
        data = {"employee": self.employee.id,
                "primary": self.primary.id if self.primary else None,
                "weights_source": self.weights_source, "components": self.components_json()}
        return hashlib.sha256(rules.canonical_json(data).encode("utf-8")).hexdigest()


def attribution(assignments: Sequence[EmployeeAssignment],
                quarter: PmsCycleQuarter) -> EmployeeAssignment | None:
    primaries = [a for a in assignments if a.is_primary and a.effective_from <= quarter.end_date
                 and (a.effective_to is None or a.effective_to >= quarter.start_date)]
    if not primaries:
        return None
    at_end = [a for a in primaries if a.effective_to is None or a.effective_to >= quarter.end_date]
    if at_end:
        return max(at_end, key=lambda a: a.effective_from)
    return max(primaries, key=lambda a: a.effective_to)


def _check_weights(components: Sequence[Component],
                   configured: dict[int, Decimal]) -> tuple[str, list[str], dict[int, Decimal]]:
    if len(components) == 1:
        return "SINGLE", [], {components[0].assignment.id: HUNDRED}
    ids = [c.assignment.id for c in components]
    issues = []
    missing = [_unit_label(c.assignment.plant_department) for c in components
               if c.assignment.id not in configured]
    if missing:
        issues.append(f"contribution weights are missing for {', '.join(missing)} (several "
                      "scored assignments need explicit weights totalling 100 %)")
    if any(aid not in ids for aid in configured):
        issues.append("a contribution weight is set for an assignment without a locked KPI sheet "
                      "this quarter")
    total = sum((configured[aid] for aid in ids if aid in configured), Decimal(0))
    if not missing and total != HUNDRED:
        issues.append(f"contribution weights total {rules.decimal_text(total)} %, not 100 %")
    source = "CONFIGURED" if not issues else ("MISSING" if missing else "INVALID")
    return source, issues, {aid: w for aid, w in configured.items() if aid in ids}


def consolidate(db: Session, quarter: PmsCycleQuarter, views: Sequence[ResultView] | None = None,
                employee_id: int | None = None) -> list[Consolidation]:
    """One consolidation per employee with at least one locked sheet."""
    if views is None:
        views = kpi_results.quarter_views(db, quarter.id, employee_id)
    by_employee: dict[int, list[ResultView]] = defaultdict(list)
    for v in views:
        by_employee[v.sheet.assignment.employee_id].append(v)
    if not by_employee:
        return []
    weights: dict[int, dict[int, Decimal]] = defaultdict(dict)
    for w in db.scalars(select(AssignmentScoreWeight).where(
            AssignmentScoreWeight.cycle_quarter_id == quarter.id,
            AssignmentScoreWeight.employee_id.in_(sorted(by_employee)))):
        weights[w.employee_id][w.employee_assignment_id] = w.weight
    assignments: dict[int, list[EmployeeAssignment]] = defaultdict(list)
    for a in db.scalars(select(EmployeeAssignment).where(
            EmployeeAssignment.employee_id.in_(sorted(by_employee))).options(
            joinedload(EmployeeAssignment.plant_department).joinedload(PlantDepartment.plant),
            joinedload(EmployeeAssignment.plant_department).joinedload(PlantDepartment.department),
            joinedload(EmployeeAssignment.designation))).unique():
        assignments[a.employee_id].append(a)
    found = []
    for emp_id, emp_views in by_employee.items():
        emp_views = sorted(emp_views, key=lambda v: (not v.sheet.assignment.is_primary,
                                                    _unit_label(v.sheet.assignment.plant_department)))
        comps = [Component(v, None) for v in emp_views]
        source, issues, applied = _check_weights(comps, weights.get(emp_id, {}))
        for c in comps:
            c.weight = applied.get(c.assignment.id)
        found.append(Consolidation(emp_views[0].sheet.assignment.employee, comps, source, issues,
                                   attribution(assignments[emp_id], quarter)))
    return sorted(found, key=lambda c: c.employee.employee_code)


def consolidation_visible(principal: Principal, units: Sequence[tuple[int, int]],
                          home: tuple[int, int] | None) -> bool:
    """An employee's consolidated result: for org readers of their home
    (attribution) unit, or of every unit it is built from."""
    scope = principal.org_scope
    if home is not None and scope.allows_unit(*home):
        return True
    return bool(units) and all(scope.allows_unit(*u) for u in units)


# --- overview and gates ----------------------------------------------------------------------

@dataclass
class Overview:
    quarter: PmsCycleQuarter
    sheets: dict[str, int]
    employees: dict[str, int]
    cohorts: dict[str, int]
    unscorable_sheets: int
    blockers: list[str]
    next_status: QuarterStatus | None
    previous_status: QuarterStatus | None
    can_advance: bool
    can_return: bool
    can_publish: bool


def _pending_deviations(db: Session, quarter: PmsCycleQuarter) -> list[KpiDeviation]:
    return db.scalars(select(KpiDeviation).join(KpiSheet, KpiDeviation.sheet_id == KpiSheet.id)
                      .where(KpiSheet.cycle_quarter_id == quarter.id,
                             KpiDeviation.status == DeviationStatus.PENDING)).all()


def gate(db: Session, quarter: PmsCycleQuarter, target: QuarterStatus,
         views: Sequence[ResultView], consolidations: Sequence[Consolidation]) -> list[str]:
    """Everything that blocks the quarter from reaching `target` (company-wide)."""
    blockers: list[str] = []
    if target == QuarterStatus.DEPARTMENT_REVIEW:
        for v in views:
            blockers += [f"{_who(v)}: {p}" for p in sheet_problems(v, for_review=False)]
        for d in _pending_deviations(db, quarter):
            blockers.append(f"A KPI deviation for sheet {d.sheet_id} awaits approval.")
    elif target == QuarterStatus.NORMALIZATION:
        for c in consolidations:
            blockers += [f"{c.employee.employee_code} {c.employee.full_name}: {i}"
                         for i in c.issues()]
        for c in consolidations:
            if c.primary is None or c.issues():
                continue
            unit = c.primary.plant_department
            try:
                policy = normalization.policy_for(db, quarter, unit.plant_id, unit.department_id)
            except ConflictError as exc:
                blockers.append(f"{_unit_label(unit)}: {exc}")
                continue
            if policy is None:
                blockers.append(f"{c.employee.employee_code} {c.employee.full_name}: no approved "
                                f"normalization policy applies to {_unit_label(unit)} on "
                                f"{quarter.start_date.isoformat()}")
    elif target == QuarterStatus.READY:
        blockers += normalization.approval_blockers(db, quarter)
    return blockers


def _counts(views: Sequence[ResultView]) -> dict[str, int]:
    results = [v.result for v in views if v.result is not None]
    return {
        "locked": len(views),
        "calculated": len(results),
        "complete": sum(1 for v in views if v.result and v.result.is_complete and not v.stale),
        "stale": sum(1 for v in views if v.stale),
        "reviewed": sum(1 for r in results if r.status in (ScoreResultStatus.REVIEWED,
                                                          ScoreResultStatus.PUBLISHED)),
        "pending_overrides": sum(1 for v in views if v.pending_override is not None),
        "published": sum(1 for r in results if r.status == ScoreResultStatus.PUBLISHED),
    }


def overview(db: Session, principal: Principal, quarter_id: int) -> Overview:
    if principal.org_scope.is_empty:
        raise PermissionDeniedError("You do not have access to organizational data.")
    quarter = get_quarter(db, quarter_id)
    all_views = kpi_results.quarter_views(db, quarter.id)
    scope = principal.org_scope
    views = [v for v in all_views if scope.allows_unit(
        v.sheet.assignment.plant_department.plant_id,
        v.sheet.assignment.plant_department.department_id)]
    consolidations = consolidate(db, quarter, all_views)
    visible = [c for c in consolidations if consolidation_visible(
        principal, [(x.assignment.plant_department.plant_id,
                     x.assignment.plant_department.department_id) for x in c.components],
        (c.primary.plant_department.plant_id, c.primary.plant_department.department_id)
        if c.primary else None)]
    employees = {
        "total": len(visible),
        "ready": sum(1 for c in visible if c.ready),
        "multi_assignment": sum(1 for c in visible if len(c.components) > 1),
        "weights_needed": sum(1 for c in visible if c.weights_source in ("MISSING", "INVALID")),
    }
    unscorable = db.scalar(select(func.count()).select_from(KpiSheet)
                           .join(EmployeeAssignment, KpiSheet.employee_assignment_id == EmployeeAssignment.id)
                           .join(PlantDepartment)
                           .where(KpiSheet.cycle_quarter_id == quarter.id,
                                  KpiSheet.status != KpiSheetStatus.LOCKED,
                                  scope.unit_condition())) if quarter.status != QuarterStatus.DRAFT else 0
    stepper = principal.scope_for(Permission.QUARTER_START).is_global
    publisher = principal.scope_for(Permission.SCORE_PUBLISH).is_global
    next_status = FORWARD.get(quarter.status)
    blockers: list[str] = []
    if next_status is not None and (stepper or publisher):
        blockers = gate(db, quarter, next_status, all_views, consolidations)
    elif quarter.status == QuarterStatus.READY and publisher:
        blockers = publication_blockers(db, quarter, all_views, consolidations)
    return Overview(
        quarter=quarter, sheets=_counts(views), employees=employees,
        cohorts=normalization.cohort_counts(db, principal, quarter),
        unscorable_sheets=unscorable or 0, blockers=blockers, next_status=next_status,
        previous_status=BACKWARD.get(quarter.status),
        can_advance=stepper and next_status is not None,
        can_return=stepper and quarter.status in BACKWARD,
        can_publish=publisher and quarter.status == QuarterStatus.READY,
    )


# --- transitions -------------------------------------------------------------------------------

def _locked_quarter(db: Session, quarter_id: int) -> PmsCycleQuarter:
    quarter = db.scalars(select(PmsCycleQuarter).where(PmsCycleQuarter.id == quarter_id)
                         .with_for_update()).one_or_none()
    if quarter is None:
        raise NotFoundError("Quarter", quarter_id)
    return quarter


def freeze_employee_results(db: Session, quarter: PmsCycleQuarter,
                            consolidations: Sequence[Consolidation]) -> list[EmployeeQuarterResult]:
    """Store each employee's consolidated score for normalization. A row whose
    inputs changed loses its earlier normalization outcome."""
    existing = {r.employee_id: r for r in db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.cycle_quarter_id == quarter.id))}
    rows = []
    for c in consolidations:
        digest = c.inputs_hash()
        row = existing.get(c.employee.id)
        if row is None:
            row = EmployeeQuarterResult(cycle_quarter_id=quarter.id, employee_id=c.employee.id)
            db.add(row)
        elif row.inputs_hash != digest:
            normalization.clear_outcome(row)
        unit = c.primary.plant_department
        row.status = EmployeeResultStatus.DRAFT
        row.primary_assignment_id = c.primary.id
        row.plant_id, row.department_id = unit.plant_id, unit.department_id
        row.components = c.components_json()
        row.weights_source = c.weights_source
        row.calculated_score = c.calculated
        row.final_score = c.final
        row.inputs_hash = digest
        rows.append(row)
    db.flush()
    return rows


def transition(db: Session, principal: Principal, actor: AuditActor, quarter_id: int,
               target: QuarterStatus, reason: str | None = None) -> PmsCycleQuarter:
    if not principal.scope_for(Permission.QUARTER_START).is_global:
        raise PermissionDeniedError("Moving a quarter between review steps needs company-wide HR "
                                    "authority.")
    quarter = _locked_quarter(db, quarter_id)
    current = quarter.status
    changes: dict[str, Any] = {"from": current.value, "to": target.value}
    if FORWARD.get(current) == target:
        views = kpi_results.quarter_views(db, quarter.id)
        consolidations = consolidate(db, quarter, views)
        blockers = gate(db, quarter, target, views, consolidations)
        if blockers:
            raise ValidationFailedError([Issue(b, "quarter") for b in blockers[:200]])
        if target == QuarterStatus.NORMALIZATION:
            rows = freeze_employee_results(db, quarter, consolidations)
            changes["employees"] = len(rows)
            changes["cohorts"] = normalization.compute(db, principal, quarter)
        action = "quarter.advance"
    elif BACKWARD.get(current) == target:
        if reason is None or len(reason.strip()) < 10:
            raise ValidationFailedError([Issue("Explain why the quarter goes back a step (at least "
                                               "10 characters).", "reason")])
        action = "quarter.return"
    else:
        allowed = [s.value for s in (FORWARD.get(current), BACKWARD.get(current)) if s]
        raise ConflictError(f"{quarter.name} is in {QUARTER_LABELS[current]}; it can move to "
                            f"{' or '.join(allowed) or 'no other step here'}.")
    quarter.status = target
    db.flush()
    record_event(db, actor=actor, action=action, entity_type="cycle_quarter", entity_id=quarter.id,
                 summary=(f"{quarter.name}: {QUARTER_LABELS[current]} → "
                          f"{QUARTER_LABELS[target]}"),
                 reason=reason.strip() if reason and action == "quarter.return" else None,
                 changes=changes)
    return quarter


# --- publication -----------------------------------------------------------------------------

def publication_blockers(db: Session, quarter: PmsCycleQuarter, views: Sequence[ResultView],
                         consolidations: Sequence[Consolidation]) -> list[str]:
    """Re-verify, at publication, that nothing changed since normalization."""
    blockers = [f"{_who(v)}: {p}" for v in views for p in sheet_problems(v, for_review=True)]
    rows = {r.employee_id: r for r in db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.cycle_quarter_id == quarter.id))}
    for c in consolidations:
        row = rows.get(c.employee.id)
        if row is None or row.inputs_hash != c.inputs_hash():
            blockers.append(f"{c.employee.employee_code} {c.employee.full_name}: the score changed "
                            "after normalization started; return the quarter to department review")
    blockers += normalization.approval_blockers(db, quarter)
    return blockers


def _digest(data: Any) -> str:
    return hashlib.sha256(rules.canonical_json(data).encode("utf-8")).hexdigest()


def publish(db: Session, principal: Principal, actor: AuditActor, quarter_id: int) -> PmsCycleQuarter:
    """Publish every result of the quarter in one transaction, and lock it."""
    if not principal.scope_for(Permission.SCORE_PUBLISH).is_global:
        raise PermissionDeniedError("Publishing a quarter's scores needs company-wide HR Head or "
                                    "CHRO authority.")
    quarter = _locked_quarter(db, quarter_id)
    if quarter.status != QuarterStatus.READY:
        raise ConflictError(f"{quarter.name} is in {QUARTER_LABELS[quarter.status]}; only a "
                            "quarter ready for publication (every cohort approved) can be "
                            "published.")
    views = kpi_results.quarter_views(db, quarter.id)
    consolidations = consolidate(db, quarter, views)
    blockers = publication_blockers(db, quarter, views, consolidations)
    if blockers:
        raise ValidationFailedError([Issue(b, "quarter") for b in blockers[:200]])
    for v in views:
        kpi_results.publish_result(principal, v.result)
    rows = db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.cycle_quarter_id == quarter.id)
        .order_by(EmployeeQuarterResult.employee_id)).all()
    for row in rows:
        row.status = EmployeeResultStatus.PUBLISHED
        row.published_by_user_id = principal.user_id
        row.published_at = func.now()
    runs = normalization.publish_runs(db, quarter)
    quarter.status = QuarterStatus.PUBLISHED
    quarter.published_by_user_id = principal.user_id
    quarter.published_at = func.now()
    db.flush()
    record_event(
        db, actor=actor, action="quarter.publish", entity_type="cycle_quarter", entity_id=quarter.id,
        summary=(f"Published the scores of {quarter.name}: {len(rows)} employees, "
                 f"{len(views)} KPI sheets, {len(runs)} normalization cohorts"),
        changes={
            "sheets": len(views), "employees": len(rows), "cohorts": len(runs),
            "sheet_results_sha256": _digest([
                [v.sheet.id, v.result.inputs_hash, rules.jsonable(v.result.published_score)]
                for v in views]),
            "employee_results_sha256": _digest([
                [r.employee_id, r.inputs_hash, rules.jsonable(r.final_score), r.group_key,
                 rules.jsonable(r.normalized_rating)] for r in rows]),
            "cohorts_sha256": _digest([[r.cohort_key, r.inputs_hash] for r in runs]),
        })
    return quarter


# --- contribution weights ---------------------------------------------------------------------

def set_weights(db: Session, principal: Principal, actor: AuditActor, quarter_id: int,
                employee_id: int, weights: Sequence[tuple[int, Decimal]]) -> Consolidation:
    quarter = get_quarter(db, quarter_id)
    require_review(quarter)
    found = consolidate(db, quarter, employee_id=employee_id)
    if not found:
        raise NotFoundError("Employee result", employee_id)
    c = found[0]
    units = [(x.assignment.plant_department.plant_id, x.assignment.plant_department.department_id)
             for x in c.components]
    if not consolidation_visible(principal, units, None if c.primary is None else (
            c.primary.plant_department.plant_id, c.primary.plant_department.department_id)):
        raise NotFoundError("Employee result", employee_id)
    scope = principal.scope_for(Permission.SCORE_PUBLISH)
    if not all(scope.allows_unit(*u) for u in units):
        raise PermissionDeniedError("Contribution weights need HR Head or CHRO authority over "
                                    "every scored assignment of the employee.")
    if len(c.components) == 1:
        raise ConflictError("A single scored assignment always counts 100 %; no weights are "
                            "needed.")
    ids = {x.assignment.id for x in c.components}
    given = dict(weights)
    issues = []
    if len(given) != len(weights) or set(given) != ids:
        issues.append(Issue("Give one weight for each scored assignment of the employee, and no "
                            "other.", "weights"))
    for aid, w in given.items():
        if not Decimal(0) < w <= HUNDRED or w != w.quantize(CENT):
            issues.append(Issue("Each weight must be above 0 and at most 100, with at most two "
                                "decimals.", "weights"))
            break
    total = sum(given.values(), Decimal(0))
    if not issues and total != HUNDRED:
        issues.append(Issue(f"The weights total {rules.decimal_text(total)} %; they must total "
                            "exactly 100 %.", "weights"))
    if issues:
        raise ValidationFailedError(issues)
    rows = {w.employee_assignment_id: w for w in db.scalars(select(AssignmentScoreWeight).where(
        AssignmentScoreWeight.cycle_quarter_id == quarter.id,
        AssignmentScoreWeight.employee_id == employee_id))}
    before = {aid: rules.jsonable(w.weight) for aid, w in rows.items()}
    for aid, row in list(rows.items()):
        if aid not in given:
            db.delete(row)
    for aid, w in given.items():
        row = rows.get(aid)
        if row is None:
            db.add(AssignmentScoreWeight(cycle_quarter_id=quarter.id, employee_id=employee_id,
                                         employee_assignment_id=aid, weight=w,
                                         set_by_user_id=principal.user_id))
        else:
            row.weight = w
            row.set_by_user_id = principal.user_id
    db.flush()
    home = c.primary.plant_department if c.primary else c.components[0].assignment.plant_department
    record_event(db, actor=actor, action="employee_weights.set", entity_type="employee",
                 entity_id=employee_id,
                 summary=(f"Set the {quarter.name} contribution weights of "
                          f"{c.employee.employee_code}"),
                 changes={"quarter_id": quarter.id, "before": {str(k): v for k, v in before.items()},
                          "after": {str(k): rules.jsonable(v) for k, v in given.items()}},
                 plant_id=home.plant_id, department_id=home.department_id)
    return consolidate(db, quarter, employee_id=employee_id)[0]


# --- employee results ------------------------------------------------------------------------

@dataclass
class EmployeeView:
    """A consolidated result, live (before normalization) or stored."""

    employee: Employee
    quarter: PmsCycleQuarter
    consolidation: Consolidation | None   # live
    row: EmployeeQuarterResult | None     # stored (from normalization on)

    @property
    def units(self) -> list[tuple[int, int]]:
        if self.row is not None:
            return [(c["plant_id"], c["department_id"]) for c in self.row.components]
        return [(x.assignment.plant_department.plant_id, x.assignment.plant_department.department_id)
                for x in self.consolidation.components]

    @property
    def home(self) -> tuple[int, int] | None:
        if self.row is not None:
            return (self.row.plant_id, self.row.department_id)
        p = self.consolidation.primary
        return None if p is None else (p.plant_department.plant_id, p.plant_department.department_id)


def employee_views(db: Session, principal: Principal, quarter_id: int, *,
                   employee_id: int | None = None) -> list[EmployeeView]:
    if principal.org_scope.is_empty:
        raise PermissionDeniedError("You do not have access to organizational data.")
    quarter = get_quarter(db, quarter_id)
    found: list[EmployeeView] = []
    if quarter.status in FROZEN:
        stmt = (select(EmployeeQuarterResult)
                .where(EmployeeQuarterResult.cycle_quarter_id == quarter.id)
                .options(joinedload(EmployeeQuarterResult.employee),
                         joinedload(EmployeeQuarterResult.run)))
        if employee_id is not None:
            stmt = stmt.where(EmployeeQuarterResult.employee_id == employee_id)
        found = [EmployeeView(r.employee, quarter, None, r) for r in db.scalars(stmt).unique()]
        if employee_id is not None and not found:
            found = [EmployeeView(c.employee, quarter, c, None)
                     for c in consolidate(db, quarter, employee_id=employee_id)]
    else:
        found = [EmployeeView(c.employee, quarter, c, None)
                 for c in consolidate(db, quarter, employee_id=employee_id)]
    return sorted((v for v in found if consolidation_visible(principal, v.units, v.home)),
                  key=lambda v: v.employee.employee_code)


def get_employee_view(db: Session, principal: Principal, quarter_id: int,
                      employee_id: int) -> EmployeeView:
    found = employee_views(db, principal, quarter_id, employee_id=employee_id)
    if not found:
        raise NotFoundError("Employee result", employee_id)
    return found[0]


def can_set_weights(principal: Principal, view: EmployeeView) -> bool:
    if view.quarter.status not in (QuarterStatus.OPEN, QuarterStatus.DEPARTMENT_REVIEW):
        return False
    if view.consolidation is None or len(view.consolidation.components) < 2:
        return False
    scope = principal.scope_for(Permission.SCORE_PUBLISH)
    return all(scope.allows_unit(*u) for u in view.units)


# --- the employee's own sheets ----------------------------------------------------------------

@dataclass
class OwnSheet:
    sheet: KpiSheet
    published_score: Decimal | None
    published_at: Any
    employee_result: EmployeeQuarterResult | None


def own_sheets(db: Session, principal: Principal) -> list[OwnSheet]:
    """The caller's own KPI sheets (published or locked), with published
    outcomes only."""
    if principal.employee_id is None or not principal.can_read_self:
        raise PermissionDeniedError("Your account is not linked to an employee record.")
    sheets = db.scalars(
        kpi_results._sheet_query().join(KpiSheet.assignment)
        .where(EmployeeAssignment.employee_id == principal.employee_id,
               KpiSheet.status != KpiSheetStatus.DRAFT)
        .order_by(KpiSheet.id.desc())).unique().all()
    results = {r.sheet_id: r for r in db.scalars(select(KpiSheetResult).where(
        KpiSheetResult.sheet_id.in_([s.id for s in sheets] or [0]),
        KpiSheetResult.status == ScoreResultStatus.PUBLISHED))}
    employee_rows = {r.cycle_quarter_id: r for r in db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.employee_id == principal.employee_id,
        EmployeeQuarterResult.status == EmployeeResultStatus.PUBLISHED))}
    found = []
    for s in sorted(sheets, key=lambda s: (s.quarter.start_date, s.id), reverse=True):
        r = results.get(s.id)
        found.append(OwnSheet(s, r.published_score if r else None, r.published_at if r else None,
                              employee_rows.get(s.cycle_quarter_id)))
    return found

