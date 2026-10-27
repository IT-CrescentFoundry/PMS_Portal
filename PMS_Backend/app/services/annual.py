"""Annual performance results, annual score deviations and CHRO approval (Stage M).

The annual score of an employee for a PMS cycle is built from their PUBLISHED
quarterly employee results (employee_quarter_results, Stage L): one identity
per person, cross-plant assignments already combined with their contribution
weights. Under the cycle's annual rule:

    exact      = sum(quarterly final score x quarter weight %) / 100
    calculated = exact rounded half-up to the rule's decimals (2)

The initial default rule is an equally weighted average of the four quarters
(25 % each): (Q1 + Q2 + Q3 + Q4) / 4. It is configuration, not a fixed
policy: pms_cycles.annual_rule, versioned, set by the CHRO before any annual
result of the cycle is approved. Each result stores the rule it used and its
SHA-256, the source quarterly result rows (id and version) with their scores,
and the scoring matrix and normalization policy versions behind them, so the
calculation is reproducible.

A quarter that is missing, not yet published or being corrected is never
treated as zero: the employee has no calculable annual score until every
required quarter is published, and the reasons are listed.

Lifecycle of a version (annual_results):
  CALCULATED  calculated by an HR Head or the CHRO (score:publish). A
              recalculation with different inputs (sources or rule) creates a
              new version; a draft it replaces is DISCARDED, together with any
              pending deviation.
  PUBLISHED   approved by the CHRO (annual:approve): final. The published
              version it replaces becomes SUPERSEDED. Nobody approves their own
              annual result.
An Admin (annual:deviation_request) may request a deviation on a calculated
version: the proposed score and a mandatory reason. Only the CHRO's approval
(never the requester's) applies it, as adjusted_score beside the unchanged
calculated_score. Pending and rejected requests change nothing.

Corrections of a source quarter (app/services/corrections.py) mark the
annual results that used it as needing recalculation, in the correction's own
transaction. The existing versions stay as they are; a recalculation from the
corrected published quarter creates a new version, which needs the CHRO's
approval again before it replaces a published one.
"""
from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.auth.permissions import Permission, Principal
from app.models import (
    AnnualDeviationStatus,
    AnnualResult,
    AnnualResultStatus,
    AnnualScoreDeviation,
    Employee,
    EmployeeAssignment,
    EmployeeQuarterResult,
    EmployeeResultStatus,
    KpiSheet,
    KpiSheetResult,
    KpiSheetStatus,
    NormalizationRun,
    PlantDepartment,
    PmsCycle,
    PmsCycleQuarter,
    QuarterCorrection,
    QuarterStatus,
)
from app.services import matrix_rules as rules
from app.services import versions
from app.services.audit import AuditActor, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services.kpi_sheets import QUARTER_LABELS

HUNDRED = Decimal(100)
CENT = Decimal("0.01")
FIVE = Decimal(5)

DEFAULT_RULE: dict[str, Any] = {
    "code": "QUARTERLY_WEIGHTED_AVERAGE",
    "version": 1,
    "quarter_weights": {"1": "25", "2": "25", "3": "25", "4": "25"},
    "decimals": 2,
    "rounding": "HALF_UP",
    "description": "Equally weighted average of the four published quarterly scores "
                   "(initial default).",
}
CURRENT = (AnnualResultStatus.CALCULATED, AnnualResultStatus.PUBLISHED)


# --- the rule ---------------------------------------------------------------------------------

def rule_of(cycle: PmsCycle) -> dict[str, Any]:
    return cycle.annual_rule or DEFAULT_RULE


def rule_hash(rule: dict[str, Any]) -> str:
    return hashlib.sha256(rules.canonical_json(rule).encode("utf-8")).hexdigest()


def quarter_weights(rule: dict[str, Any]) -> dict[int, Decimal]:
    return {int(k): Decimal(str(v)) for k, v in rule["quarter_weights"].items()}


def _round(exact: Decimal, rule: dict[str, Any]) -> Decimal:
    places = Decimal(1).scaleb(-int(rule.get("decimals", 2)))
    return exact.quantize(places, rounding=ROUND_HALF_UP)


def annual_score(scores: dict[int, Decimal], rule: dict[str, Any]) -> tuple[Decimal, Decimal]:
    """(exact, calculated) from {quarter number: quarterly final score}; every
    quarter with a weight above 0 must be present (never counted as zero)."""
    weights = quarter_weights(rule)
    missing = [n for n, w in weights.items() if w > 0 and n not in scores]
    if missing:
        raise ValueError(f"Quarter(s) {', '.join(f'Q{n}' for n in missing)} are missing.")
    exact = sum((scores[n] * w for n, w in weights.items() if w > 0), Decimal(0)) / HUNDRED
    return exact, _round(exact, rule)


# --- standings: one employee in one cycle ----------------------------------------------------

@dataclass
class QuarterSource:
    quarter: PmsCycleQuarter
    weight: Decimal
    row: EmployeeQuarterResult | None        # the current PUBLISHED result
    corrections: list[QuarterCorrection]     # open corrections affecting the employee

    @property
    def required(self) -> bool:
        return self.weight > 0


@dataclass
class Standing:
    employee: Employee
    cycle: PmsCycle
    rule: dict[str, Any]
    sources: list[QuarterSource]
    missing_quarters: list[int]             # required by the rule, not set up in the cycle
    home: tuple[int, int] | None
    units: list[tuple[int, int]]
    versions: list[AnnualResult] = field(default_factory=list)
    deviations: list[AnnualScoreDeviation] = field(default_factory=list)

    @property
    def draft(self) -> AnnualResult | None:
        return next((v for v in self.versions if v.status == AnnualResultStatus.CALCULATED), None)

    @property
    def published(self) -> AnnualResult | None:
        return next((v for v in self.versions if v.status == AnnualResultStatus.PUBLISHED), None)

    @property
    def pending(self) -> AnnualScoreDeviation | None:
        draft = self.draft
        return next((d for d in self.deviations if draft is not None
                     and d.annual_result_id == draft.id
                     and d.status == AnnualDeviationStatus.PENDING), None)

    @property
    def complete(self) -> bool:
        return not self.missing_quarters and all(
            s.row is not None for s in self.sources if s.required)

    @property
    def being_corrected(self) -> list[QuarterCorrection]:
        return [c for s in self.sources if s.required for c in s.corrections]

    def issues(self) -> list[str]:
        """Why the annual result can't be calculated or approved now."""
        found = [f"Q{n} is required by the annual rule but is not set up in {self.cycle.name}"
                 for n in self.missing_quarters]
        for s in self.sources:
            if not s.required:
                continue
            q = s.quarter
            if s.row is None:
                if q.status == QuarterStatus.PUBLISHED:
                    found.append(f"{q.name}: no published result for this employee")
                else:
                    found.append(f"{q.name} is not published yet "
                                 f"({QUARTER_LABELS.get(q.status, q.status.value.lower())})")
            for c in s.corrections:
                found.append(f"{q.name} is being corrected (correction {c.id}, "
                             f"{c.status.value.lower().replace('_', ' ')}); the annual result "
                             "waits for the corrected version")
        return found

    def scores(self) -> dict[int, Decimal]:
        return {s.quarter.quarter_number: s.row.final_score for s in self.sources
                if s.required and s.row is not None}

    def calculation(self) -> tuple[Decimal, Decimal] | None:
        if not self.complete:
            return None
        return annual_score(self.scores(), self.rule)

    def inputs_hash(self) -> str:
        data = {"employee": self.employee.id, "cycle": self.cycle.id,
                "rule_sha256": rule_hash(self.rule),
                "sources": [[s.quarter.id, s.row.id, s.row.version_no,
                             rules.decimal_text(s.row.final_score), s.row.inputs_hash]
                            for s in self.sources if s.required and s.row is not None]}
        return hashlib.sha256(rules.canonical_json(data).encode("utf-8")).hexdigest()


def get_cycle(db: Session, cycle_id: int) -> PmsCycle:
    cycle = db.scalars(select(PmsCycle).where(PmsCycle.id == cycle_id)
                       .options(joinedload(PmsCycle.quarters))).unique().one_or_none()
    if cycle is None:
        raise NotFoundError("PMS cycle", cycle_id)
    return cycle


def list_cycles(db: Session, principal: Principal) -> list[PmsCycle]:
    if principal.scope_for(Permission.ANNUAL_READ).is_empty:
        raise PermissionDeniedError("You do not have access to annual results.")
    return list(db.scalars(select(PmsCycle).options(joinedload(PmsCycle.quarters))
                           .order_by(PmsCycle.start_date.desc())).unique().all())


def _open_corrections(db: Session, quarter_ids: Sequence[int]) -> dict[int, list[QuarterCorrection]]:
    found: dict[int, list[QuarterCorrection]] = defaultdict(list)
    for c in db.scalars(select(QuarterCorrection).where(
            QuarterCorrection.cycle_quarter_id.in_(list(quarter_ids) or [0]),
            QuarterCorrection.status.in_(versions.OPEN))):
        found[c.cycle_quarter_id].append(c)
    return found


def correction_employees(c: QuarterCorrection) -> set[int]:
    """Employees whose quarterly result a correction changes or renormalizes."""
    affected = c.affected or (c.preview or {}).get("affected") or {}
    return set(affected.get("employees", [])) | set(affected.get("dependents", []))


def _standings(db: Session, cycle: PmsCycle,
               employee_ids: Sequence[int] | None = None) -> list[Standing]:
    rule = rule_of(cycle)
    weights = quarter_weights(rule)
    quarters = {q.quarter_number: q for q in cycle.quarters}
    qids = [q.id for q in cycle.quarters]
    wanted = set(employee_ids) if employee_ids is not None else None

    def limit(stmt, column):
        return stmt.where(column.in_(sorted(wanted) or [0])) if wanted is not None else stmt

    published: dict[tuple[int, int], EmployeeQuarterResult] = {}
    for r in db.scalars(limit(select(EmployeeQuarterResult).where(
            EmployeeQuarterResult.cycle_quarter_id.in_(qids or [0]),
            EmployeeQuarterResult.status == EmployeeResultStatus.PUBLISHED),
            EmployeeQuarterResult.employee_id)):
        published[(r.employee_id, r.cycle_quarter_id)] = r
    # Everyone with a scored sheet, a quarterly result or an annual result.
    sheet_units: dict[int, list[tuple[int, int, int, bool]]] = defaultdict(list)
    for emp_id, plant_id, dept_id, number, primary in db.execute(limit(
            select(EmployeeAssignment.employee_id, PlantDepartment.plant_id,
                   PlantDepartment.department_id, PmsCycleQuarter.quarter_number,
                   EmployeeAssignment.is_primary)
            .join(KpiSheet, KpiSheet.employee_assignment_id == EmployeeAssignment.id)
            .join(PlantDepartment, EmployeeAssignment.plant_department_id == PlantDepartment.id)
            .join(PmsCycleQuarter, KpiSheet.cycle_quarter_id == PmsCycleQuarter.id)
            .where(KpiSheet.cycle_quarter_id.in_(qids or [0]),
                   KpiSheet.status == KpiSheetStatus.LOCKED),
            EmployeeAssignment.employee_id)):
        sheet_units[emp_id].append((number, plant_id, dept_id, primary))
    results: dict[int, list[AnnualResult]] = defaultdict(list)
    for r in db.scalars(limit(select(AnnualResult).where(AnnualResult.cycle_id == cycle.id)
                              .order_by(AnnualResult.version_no), AnnualResult.employee_id)):
        results[r.employee_id].append(r)
    deviations: dict[int, list[AnnualScoreDeviation]] = defaultdict(list)
    all_ids = [r.id for rows in results.values() for r in rows]
    for d in db.scalars(select(AnnualScoreDeviation).where(
            AnnualScoreDeviation.annual_result_id.in_(all_ids or [0]))
            .order_by(AnnualScoreDeviation.id)):
        deviations[d.result.employee_id].append(d)
    employee_ids_all = ({e for e, _ in published} | set(sheet_units) | set(results))
    employees = {e.id: e for e in db.scalars(select(Employee).where(
        Employee.id.in_(sorted(employee_ids_all) or [0])))}
    open_corrections = _open_corrections(db, qids)

    found = []
    for emp_id in sorted(employee_ids_all):
        sources = []
        for number in sorted(set(quarters) | set(weights)):
            q = quarters.get(number)
            if q is None:
                continue
            row = published.get((emp_id, q.id))
            corrections = [c for c in open_corrections.get(q.id, [])
                           if emp_id in correction_employees(c)]
            sources.append(QuarterSource(q, weights.get(number, Decimal(0)), row, corrections))
        rows = [s.row for s in sources if s.row is not None]
        units = sorted({(c["plant_id"], c["department_id"]) for r in rows for c in r.components}
                       | {(r.plant_id, r.department_id) for r in rows})
        if rows:
            latest = max(rows, key=lambda r: next(s.quarter.quarter_number for s in sources
                                                  if s.row is r))
            home: tuple[int, int] | None = (latest.plant_id, latest.department_id)
        elif sheet_units.get(emp_id):
            best = max(sheet_units[emp_id], key=lambda u: (u[0], u[3]))
            home = (best[1], best[2])
            units = sorted({(u[1], u[2]) for u in sheet_units[emp_id]})
        elif results.get(emp_id):
            last = results[emp_id][-1]
            home = (last.plant_id, last.department_id)
        else:
            home = None
        found.append(Standing(
            employee=employees[emp_id], cycle=cycle, rule=rule, sources=sources,
            missing_quarters=[n for n, w in weights.items() if w > 0 and n not in quarters],
            home=home, units=units, versions=results.get(emp_id, []),
            deviations=deviations.get(emp_id, [])))
    return found


def _allows(principal: Principal, permission: Permission, st: Standing) -> bool:
    scope = principal.scope_for(permission)
    if st.home is not None and scope.allows_unit(*st.home):
        return True
    return bool(st.units) and all(scope.allows_unit(*u) for u in st.units)


def _own(principal: Principal, st: Standing) -> bool:
    return principal.employee_id is not None and principal.employee_id == st.employee.id


def standings(db: Session, principal: Principal, cycle_id: int,
              employee_ids: Sequence[int] | None = None) -> list[Standing]:
    if principal.scope_for(Permission.ANNUAL_READ).is_empty:
        raise PermissionDeniedError("You do not have access to annual results.")
    cycle = get_cycle(db, cycle_id)
    return [st for st in _standings(db, cycle, employee_ids)
            if _allows(principal, Permission.ANNUAL_READ, st)]


def get_standing(db: Session, principal: Principal, cycle_id: int, employee_id: int) -> Standing:
    found = standings(db, principal, cycle_id, [employee_id])
    if not found:
        raise NotFoundError("Annual result", employee_id)
    return found[0]


# --- actions -----------------------------------------------------------------------------------

def finalize_blockers(st: Standing, row: AnnualResult | None) -> list[str]:
    if row is None:
        return ["Calculate the annual result first."]
    blockers = st.issues()
    if row.recalculation_required:
        blockers.append(row.recalculation_reason or "A source quarter changed; recalculate.")
    elif st.complete and st.inputs_hash() != row.inputs_hash:
        blockers.append("The published quarterly results or the annual rule changed since the "
                        "calculation; recalculate.")
    if st.pending is not None:
        blockers.append("A deviation request awaits the CHRO's decision.")
    return blockers


@dataclass
class StandingActions:
    can_calculate: bool
    can_request_deviation: bool
    can_decide_deviation: bool
    can_finalize: bool


def actions(principal: Principal, st: Standing) -> StandingActions:
    draft = st.draft
    pending = st.pending
    current_draft = (draft is not None and not draft.recalculation_required and st.complete
                     and st.inputs_hash() == draft.inputs_hash)
    approver = _allows(principal, Permission.ANNUAL_APPROVE, st) and not _own(principal, st)
    return StandingActions(
        can_calculate=_allows(principal, Permission.SCORE_PUBLISH, st) and st.complete,
        can_request_deviation=_allows(principal, Permission.ANNUAL_DEVIATION_REQUEST, st)
        and current_draft and pending is None and draft.adjusted_score is None
        and not _own(principal, st),
        can_decide_deviation=approver and pending is not None and current_draft
        and pending.requested_by_user_id != principal.user_id,
        can_finalize=approver and not finalize_blockers(st, draft),
    )


def _sources_json(db: Session, st: Standing) -> list[dict[str, Any]]:
    rows = [s.row for s in st.sources if s.required and s.row is not None]
    result_ids = [c.get("result_id") for r in rows for c in r.components if c.get("result_id")]
    sheet_results = {r.id: r for r in db.scalars(select(KpiSheetResult).where(
        KpiSheetResult.id.in_(result_ids or [0])))}
    runs = {r.id: r for r in db.scalars(select(NormalizationRun).where(
        NormalizationRun.id.in_([r.normalization_run_id for r in rows
                                 if r.normalization_run_id] or [0]))
        .options(joinedload(NormalizationRun.matrix_version)))}
    found = []
    for s in st.sources:
        if not s.required or s.row is None:
            continue
        row = s.row
        scoring = []
        for c in row.components:
            result = sheet_results.get(c.get("result_id"))
            items = (result.explanation or {}).get("items", []) if result else []
            scoring.append({
                "sheet_id": c["sheet_id"], "result_id": c.get("result_id"),
                "result_version_no": result.version_no if result else None,
                "kpis": [{"kpi_code": i.get("kpi_code"),
                          "matrix_version_id": (i.get("matrix") or {}).get("version_id"),
                          "matrix_code": (i.get("matrix") or {}).get("code"),
                          "matrix_version_no": (i.get("matrix") or {}).get("version_no"),
                          "legacy_rule": i.get("legacy_rule", False)} for i in items]})
        run = runs.get(row.normalization_run_id)
        found.append({
            "quarter_id": s.quarter.id, "quarter_number": s.quarter.quarter_number,
            "quarter_name": s.quarter.name, "weight": rules.decimal_text(s.weight),
            "employee_result_id": row.id, "version_no": row.version_no,
            "final_score": rules.decimal_text(row.final_score),
            "calculated_score": rules.decimal_text(row.calculated_score),
            "weights_source": row.weights_source, "inputs_sha256": row.inputs_hash,
            "published_at": row.published_at.isoformat() if row.published_at else None,
            "components": row.components, "scoring": scoring,
            "normalization": None if run is None else {
                "run_id": run.id, "run_version_no": run.version_no,
                "matrix_version_id": run.matrix_version_id,
                "policy_version_no": run.matrix_version.version_no,
                "group_key": row.group_key,
                "normalized_rating": rules.jsonable(row.normalized_rating)},
        })
    return found


def _audit(db: Session, actor: AuditActor, row: AnnualResult, action: str, summary: str, *,
           reason: str | None = None, changes: dict[str, Any] | None = None,
           entity: tuple[str, int] | None = None) -> None:
    entity_type, entity_id = entity or ("annual_result", row.id)
    record_event(db, actor=actor, action=action, entity_type=entity_type, entity_id=entity_id,
                 summary=summary, reason=reason, changes=changes, plant_id=row.plant_id,
                 department_id=row.department_id)


def _void_pending(db: Session, row: AnnualResult) -> list[int]:
    voided = []
    for d in db.scalars(select(AnnualScoreDeviation).where(
            AnnualScoreDeviation.annual_result_id == row.id,
            AnnualScoreDeviation.status == AnnualDeviationStatus.PENDING)):
        d.status = AnnualDeviationStatus.VOIDED
        d.voided_at = func.now()
        voided.append(d.id)
    return voided


def calculate(db: Session, principal: Principal, actor: AuditActor, cycle_id: int,
              employee_ids: Sequence[int] | None = None) -> dict[str, int]:
    """Calculate (or recalculate) annual results in the caller's scope. An
    unchanged calculation is kept; a changed one is a new version."""
    if principal.scope_for(Permission.SCORE_PUBLISH).is_empty:
        raise PermissionDeniedError("Calculating annual results needs HR Head or CHRO authority.")
    cycle = get_cycle(db, cycle_id)
    counts = {"calculated": 0, "unchanged": 0, "incomplete": 0}
    found = [st for st in _standings(db, cycle, employee_ids)
             if _allows(principal, Permission.SCORE_PUBLISH, st)]
    if employee_ids is not None and len(found) != len(set(employee_ids)):
        raise NotFoundError("Annual result", ", ".join(str(i) for i in sorted(set(employee_ids))))
    for st in found:
        calculation = st.calculation()
        if calculation is None:
            counts["incomplete"] += 1
            continue
        digest = st.inputs_hash()
        draft, published = st.draft, st.published
        if (draft is not None and draft.inputs_hash == digest) or (
                draft is None and published is not None and published.inputs_hash == digest):
            counts["unchanged"] += 1
            continue
        exact, calculated = calculation
        voided: list[int] = []
        if draft is not None:
            draft.status = AnnualResultStatus.DISCARDED
            draft.superseded_at = func.now()
            voided = _void_pending(db, draft)
            db.flush()
        previous = draft or published
        number = (db.scalar(select(func.max(AnnualResult.version_no)).where(
            AnnualResult.cycle_id == cycle.id, AnnualResult.employee_id == st.employee.id)) or 0) + 1
        home = st.home
        row = AnnualResult(
            cycle_id=cycle.id, employee_id=st.employee.id, version_no=number,
            status=AnnualResultStatus.CALCULATED, plant_id=home[0], department_id=home[1],
            sources=_sources_json(db, st), rule=st.rule, rule_sha256=rule_hash(st.rule),
            inputs_hash=digest, calculated_exact=exact, calculated_score=calculated,
            adjusted_score=None, final_score=calculated, calculated_by_user_id=principal.user_id,
            calculated_at=func.now(), previous_id=previous.id if previous else None)
        db.add(row)
        db.flush()
        st.versions.append(row)
        counts["calculated"] += 1
        _audit(db, actor, row, "annual_result.calculate",
               f"Calculated the {cycle.name} annual result of {st.employee.employee_code} "
               f"(version {number}): {rules.decimal_text(calculated)}",
               changes={"version_no": number, "previous_id": row.previous_id,
                        "calculated_exact": exact, "calculated_score": calculated,
                        "rule_sha256": row.rule_sha256, "rule_version": st.rule.get("version"),
                        "inputs_sha256": digest, "voided_deviations": voided,
                        "sources": [[s["quarter_number"], s["employee_result_id"],
                                     s["version_no"], s["final_score"]] for s in row.sources]})
    return counts


def _locked(db: Session, result_id: int) -> AnnualResult:
    row = db.scalars(select(AnnualResult).where(AnnualResult.id == result_id)
                     .with_for_update()).one_or_none()
    if row is None:
        raise NotFoundError("Annual result", result_id)
    return row


def _standing_of(db: Session, principal: Principal, row: AnnualResult) -> Standing:
    found = [st for st in _standings(db, get_cycle(db, row.cycle_id), [row.employee_id])
             if _allows(principal, Permission.ANNUAL_READ, st)]
    if not found:
        raise NotFoundError("Annual result", row.id)
    return found[0]


def finalize(db: Session, principal: Principal, actor: AuditActor, result_id: int,
             note: str | None) -> AnnualResult:
    """The CHRO approves a calculated version: it becomes the published annual
    result, and the version it replaces SUPERSEDED."""
    row = _locked(db, result_id)
    st = _standing_of(db, principal, row)
    if not _allows(principal, Permission.ANNUAL_APPROVE, st):
        raise PermissionDeniedError("Approving annual results needs CHRO authority over the "
                                    "employee.")
    if _own(principal, st):
        raise PermissionDeniedError("Your own annual result is approved by someone else.")
    if row.status != AnnualResultStatus.CALCULATED:
        raise ConflictError("Only a calculated annual result awaiting approval can be approved.")
    blockers = finalize_blockers(st, row)
    if blockers:
        raise ValidationFailedError([Issue(b, "annual_result") for b in blockers])
    replaced = st.published
    if replaced is not None:
        replaced.status = AnnualResultStatus.SUPERSEDED
        replaced.superseded_at = func.now()
        db.flush()
    row.status = AnnualResultStatus.PUBLISHED
    row.published_by_user_id = principal.user_id
    row.published_at = func.now()
    row.approval_note = (note or "").strip()[:1000] or None
    db.flush()
    _audit(db, actor, row, "annual_result.publish",
           f"Approved the {st.cycle.name} annual result of {st.employee.employee_code} "
           f"(version {row.version_no}): {rules.decimal_text(row.final_score)}",
           reason=row.approval_note,
           changes={"version_no": row.version_no, "calculated_score": row.calculated_score,
                    "adjusted_score": row.adjusted_score, "final_score": row.final_score,
                    "superseded_id": replaced.id if replaced else None,
                    "inputs_sha256": row.inputs_hash})
    return row


# --- deviations --------------------------------------------------------------------------------

def request_deviation(db: Session, principal: Principal, actor: AuditActor, result_id: int, *,
                      original_score: Decimal, proposed_score: Decimal,
                      reason: str) -> AnnualScoreDeviation:
    row = _locked(db, result_id)
    st = _standing_of(db, principal, row)
    if not _allows(principal, Permission.ANNUAL_DEVIATION_REQUEST, st):
        raise PermissionDeniedError("Annual score deviations are requested by an authorized "
                                    "Admin.")
    if _own(principal, st):
        raise PermissionDeniedError("You cannot request a deviation of your own annual result.")
    if row.status != AnnualResultStatus.CALCULATED:
        raise ConflictError("A deviation applies to a calculated annual result awaiting approval; "
                            "a published result changes only through a recalculation.")
    if row.recalculation_required or st.inputs_hash() != row.inputs_hash:
        raise ConflictError("A source quarter changed; recalculate the annual result first.")
    if st.pending is not None:
        raise ConflictError("A deviation of this annual result already awaits the CHRO.")
    if row.adjusted_score is not None:
        raise ConflictError("This annual result already has an approved adjustment.")
    if original_score != row.calculated_score:
        raise ConflictError(f"The calculated annual score is {rules.decimal_text(row.calculated_score)}, "
                            "not the original score given; reload and try again.")
    issues = []
    if not Decimal(0) <= proposed_score <= FIVE or proposed_score != proposed_score.quantize(CENT):
        issues.append(Issue("The revised score must be between 0 and 5, with at most two "
                            "decimals.", "proposed_score"))
    elif proposed_score == row.calculated_score:
        issues.append(Issue("The revised score must differ from the calculated score.",
                            "proposed_score"))
    if len(reason.strip()) < 10:
        issues.append(Issue("Explain the deviation (at least 10 characters).", "reason"))
    if issues:
        raise ValidationFailedError(issues)
    deviation = AnnualScoreDeviation(annual_result_id=row.id, original_score=row.calculated_score,
                                     proposed_score=proposed_score, reason=reason.strip()[:1000],
                                     requested_by_user_id=principal.user_id)
    db.add(deviation)
    db.flush()
    _audit(db, actor, row, "annual_deviation.request",
           f"Requested an annual score deviation for {st.employee.employee_code} "
           f"({st.cycle.name}): {rules.decimal_text(row.calculated_score)} → "
           f"{rules.decimal_text(proposed_score)}",
           reason=deviation.reason, entity=("annual_deviation", deviation.id),
           changes={"annual_result_id": row.id, "version_no": row.version_no,
                    "original": row.calculated_score, "proposed": proposed_score})
    return deviation


def get_deviation(db: Session, principal: Principal, deviation_id: int) -> AnnualScoreDeviation:
    deviation = db.get(AnnualScoreDeviation, deviation_id)
    if deviation is None:
        raise NotFoundError("Annual deviation", deviation_id)
    _standing_of(db, principal, deviation.result)  # 404 outside the caller's access
    return deviation


def list_deviations(db: Session, principal: Principal, *,
                    status: AnnualDeviationStatus | None = None,
                    cycle_id: int | None = None) -> list[tuple[AnnualScoreDeviation, Standing]]:
    if principal.scope_for(Permission.ANNUAL_READ).is_empty:
        raise PermissionDeniedError("You do not have access to annual results.")
    stmt = (select(AnnualScoreDeviation).join(AnnualResult)
            .order_by(AnnualScoreDeviation.id.desc()))
    if status is not None:
        stmt = stmt.where(AnnualScoreDeviation.status == status)
    if cycle_id is not None:
        stmt = stmt.where(AnnualResult.cycle_id == cycle_id)
    found = []
    cache: dict[tuple[int, int], Standing | None] = {}
    for d in db.scalars(stmt).all():
        key = (d.result.cycle_id, d.result.employee_id)
        if key not in cache:
            matches = [st for st in _standings(db, get_cycle(db, key[0]), [key[1]])
                       if _allows(principal, Permission.ANNUAL_READ, st)]
            cache[key] = matches[0] if matches else None
        if cache[key] is not None:
            found.append((d, cache[key]))
    return found


def decide_deviation(db: Session, principal: Principal, actor: AuditActor, deviation_id: int, *,
                     approve: bool, reason: str) -> AnnualScoreDeviation:
    deviation = db.scalars(select(AnnualScoreDeviation).where(
        AnnualScoreDeviation.id == deviation_id).with_for_update()).one_or_none()
    if deviation is None:
        raise NotFoundError("Annual deviation", deviation_id)
    row = _locked(db, deviation.annual_result_id)
    st = _standing_of(db, principal, row)
    if not _allows(principal, Permission.ANNUAL_APPROVE, st):
        raise PermissionDeniedError("Annual score deviations are decided by the CHRO.")
    if principal.user_id == deviation.requested_by_user_id:
        raise PermissionDeniedError("The requester cannot decide their own deviation.")
    if _own(principal, st):
        raise PermissionDeniedError("You cannot decide a deviation of your own annual result.")
    if deviation.status != AnnualDeviationStatus.PENDING:
        raise ConflictError("This deviation is no longer awaiting a decision.")
    if len(reason.strip()) < 10:
        raise ValidationFailedError([Issue("Give the reason for the decision (at least 10 "
                                           "characters).", "reason")])
    if approve and (row.status != AnnualResultStatus.CALCULATED or row.recalculation_required
                    or st.inputs_hash() != row.inputs_hash):
        raise ConflictError("The annual result changed since the request (a source quarter is "
                            "being corrected or was republished); it must be recalculated.")
    deviation.status = (AnnualDeviationStatus.APPROVED if approve
                        else AnnualDeviationStatus.REJECTED)
    deviation.decided_by_user_id = principal.user_id
    deviation.decided_at = func.now()
    deviation.decision_reason = reason.strip()[:1000]
    before = row.final_score
    if approve:
        row.adjusted_score = deviation.proposed_score
        row.final_score = deviation.proposed_score
    db.flush()
    db.refresh(deviation)
    _audit(db, actor, row, "annual_deviation.approve" if approve else "annual_deviation.reject",
           f"{'Approved' if approve else 'Rejected'} annual score deviation {deviation.id} for "
           f"{st.employee.employee_code} ({st.cycle.name})",
           reason=deviation.decision_reason, entity=("annual_deviation", deviation.id),
           changes={"annual_result_id": row.id, "version_no": row.version_no,
                    "original": deviation.original_score, "proposed": deviation.proposed_score,
                    "final_before": before, "final_after": row.final_score,
                    "request_reason": deviation.reason,
                    "requested_by_user_id": deviation.requested_by_user_id,
                    "requested_at": deviation.requested_at,
                    "decided_by_user_id": deviation.decided_by_user_id,
                    "decided_at": deviation.decided_at})
    return deviation


# --- the annual rule ---------------------------------------------------------------------------

def set_rule(db: Session, principal: Principal, actor: AuditActor, cycle_id: int,
             weights: dict[int, Decimal]) -> dict[str, Any]:
    """The CHRO sets the quarter weights of the cycle's annual score, before
    any annual result of the cycle is approved."""
    if not principal.scope_for(Permission.ANNUAL_APPROVE).is_global:
        raise PermissionDeniedError("The annual rule is set by the CHRO with company-wide "
                                    "authority.")
    cycle = db.scalars(select(PmsCycle).where(PmsCycle.id == cycle_id)
                       .with_for_update()).one_or_none()
    if cycle is None:
        raise NotFoundError("PMS cycle", cycle_id)
    approved = db.scalar(select(func.count()).select_from(AnnualResult).where(
        AnnualResult.cycle_id == cycle.id,
        AnnualResult.status.in_((AnnualResultStatus.PUBLISHED, AnnualResultStatus.SUPERSEDED))))
    if approved:
        raise ConflictError("The annual rule can't change once an annual result of the cycle is "
                            "approved.")
    numbers = {q.quarter_number for q in cycle.quarters}
    issues = []
    if set(weights) != numbers:
        issues.append(Issue(f"Give one weight for each quarter of the cycle "
                            f"({', '.join(f'Q{n}' for n in sorted(numbers))}).", "weights"))
    for w in weights.values():
        try:
            ok = Decimal(0) <= w <= HUNDRED and w == w.quantize(CENT)
        except InvalidOperation:
            ok = False
        if not ok:
            issues.append(Issue("Each weight must be between 0 and 100, with at most two "
                                "decimals.", "weights"))
            break
    if not issues and sum(weights.values(), Decimal(0)) != HUNDRED:
        issues.append(Issue("The quarter weights must total exactly 100 %.", "weights"))
    if not issues and not any(w > 0 for w in weights.values()):
        issues.append(Issue("At least one quarter must count.", "weights"))
    if issues:
        raise ValidationFailedError(issues)
    before = rule_of(cycle)
    rule = {**before, "version": int(before.get("version", 1)) + 1,
            "quarter_weights": {str(n): rules.decimal_text(w) for n, w in sorted(weights.items())},
            "description": "Weighted average of the published quarterly scores, with quarter "
                           "weights set by the CHRO."}
    cycle.annual_rule = rule
    db.flush()
    record_event(db, actor=actor, action="annual_rule.set", entity_type="pms_cycle",
                 entity_id=cycle.id, summary=f"Set the annual rule of {cycle.name} "
                                             f"(version {rule['version']})",
                 changes={"before": before["quarter_weights"], "after": rule["quarter_weights"],
                          "rule_sha256": rule_hash(rule)})
    return rule


# --- corrections of a source quarter -------------------------------------------------------

def flag_for_correction(db: Session, quarter: PmsCycleQuarter, employee_ids: Sequence[int],
                        reason: str) -> list[int]:
    """Mark the current annual results calculated from `quarter` for these
    employees as needing recalculation (in the caller's transaction)."""
    flagged = []
    for row in db.scalars(select(AnnualResult).where(
            AnnualResult.cycle_id == quarter.cycle_id,
            AnnualResult.employee_id.in_(sorted(set(employee_ids)) or [0]),
            AnnualResult.status.in_(CURRENT))):
        if any(s.get("quarter_id") == quarter.id for s in row.sources):
            row.recalculation_required = True
            row.recalculation_reason = reason[:500]
            flagged.append(row.id)
    db.flush()
    return flagged


# --- the employee's own annual results ------------------------------------------------------

@dataclass
class OwnAnnual:
    cycle: PmsCycle
    result: AnnualResult
    notice: str | None


def my_results(db: Session, principal: Principal) -> list[OwnAnnual]:
    """Published annual results of the caller's own employee record, with a
    notice when an underlying quarter is being corrected."""
    if principal.employee_id is None or not principal.can_read_self:
        raise PermissionDeniedError("Your account is not linked to an employee record.")
    found = []
    for row in db.scalars(select(AnnualResult).where(
            AnnualResult.employee_id == principal.employee_id,
            AnnualResult.status == AnnualResultStatus.PUBLISHED)
            .options(joinedload(AnnualResult.cycle))
            .order_by(AnnualResult.cycle_id.desc())).unique():
        notice = None
        if row.recalculation_required:
            notice = ("A quarter this result was calculated from is being corrected; the annual "
                      "result will be recalculated and approved again.")
        found.append(OwnAnnual(row.cycle, row, notice))
    return found
