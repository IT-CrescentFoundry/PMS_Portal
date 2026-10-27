"""Controlled corrections of published quarters (Stage M).

A published quarter is never edited. Policy (approved by the business):

A. An HR Head (quarter:correction_request) requests a correction of a
   published quarter: the monthly source values and the contribution weights
   to change, each with its value before and after, and a reason. The request
   is checked exactly as it would be calculated; its projected effect (sheet
   and employee scores before and after, the cohorts and annual results that
   depend on them) is stored for review.

B. The CHRO (quarter:correction_approve) approves or rejects it, with a
   reason; never their own request, nor one that changes their own result.

C. Approval, in one transaction, creates the next version of the quarter's
   results without touching the published one:
     * the correction's items apply to its version (and later ones) only, as
       an overlay of the stored values and weights (app/services/versions.py);
     * each affected KPI sheet is recalculated with the matrix versions frozen
       on it, as a new CALCULATED result row of the version;
     * the dependent results are recorded: the affected employees, the
       normalization cohorts they belong to and those cohorts' other members;
     * annual results calculated from the quarter for those employees are
       marked as needing recalculation (app/services/annual.py).
   The version then completes the review steps again (GLOBAL quarter:start,
   each gated, one step back with a reason):
     DEPARTMENT_REVIEW  the recalculated sheets are reviewed (overrides allowed)
     NORMALIZATION      the affected employees' scores are consolidated again and
                        every affected cohort renormalized, as runs of the version
     READY              every affected cohort approved
   and is published (GLOBAL score:publish) in one transaction: its rows become
   PUBLISHED and the rows they replace SUPERSEDED. Until then the earlier
   published version stays current. Nothing is deleted.

Only one correction of a quarter may be open at a time (a unique key), so the
same correction can't be approved or published twice, and a request made
against a version that has since been replaced can't be approved.
"""
from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.auth.permissions import Permission, Principal
from app.models import (
    CorrectionItemKind,
    CorrectionStatus,
    EmployeeAssignment,
    EmployeeQuarterResult,
    EmployeeResultStatus,
    KpiSheet,
    KpiSheetResult,
    KpiSheetStatus,
    NormalizationRun,
    NormalizationRunStatus,
    PlantDepartment,
    PmsCycleQuarter,
    QuarterCorrection,
    QuarterCorrectionItem,
    QuarterStatus,
    ReportingFrequency,
    ScoreResultStatus,
)
from app.services import annual, kpi_data, kpi_results, normalization, quarterly, versions
from app.services import matrix_rules as rules
from app.services.audit import AuditActor, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services.kpi_sheets import get_quarter

CENT = Decimal("0.01")
HUNDRED = Decimal(100)
FORWARD = {CorrectionStatus.DEPARTMENT_REVIEW: CorrectionStatus.NORMALIZATION,
           CorrectionStatus.NORMALIZATION: CorrectionStatus.READY}
BACKWARD = {after: before for before, after in FORWARD.items()}
STATUS_LABELS = {
    CorrectionStatus.REQUESTED: "awaiting the CHRO's decision",
    CorrectionStatus.REJECTED: "rejected",
    CorrectionStatus.DEPARTMENT_REVIEW: "department review",
    CorrectionStatus.NORMALIZATION: "normalization",
    CorrectionStatus.READY: "ready for publication",
    CorrectionStatus.PUBLISHED: "published",
}


@dataclass
class ValueIn:
    sheet_id: int
    kpi_definition_id: int
    period: str
    actual: Any
    inputs: dict[str, Any] | None


@dataclass
class WeightsIn:
    employee_id: int
    weights: list[tuple[int, Decimal]]


def _label(sheet: KpiSheet) -> str:
    a = sheet.assignment
    unit = a.plant_department
    return f"{a.employee.employee_code} {a.employee.full_name} ({unit.department.name} — {unit.plant.name})"


def _sheets(db: Session, quarter: PmsCycleQuarter, sheet_ids: Sequence[int]) -> dict[int, KpiSheet]:
    return {s.id: s for s in db.scalars(kpi_results._sheet_query().where(
        KpiSheet.id.in_(sorted(set(sheet_ids)) or [0]), KpiSheet.cycle_quarter_id == quarter.id,
        KpiSheet.status == KpiSheetStatus.LOCKED)).unique()}


def _published_row(db: Session, quarter_id: int, employee_id: int) -> EmployeeQuarterResult | None:
    return db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.cycle_quarter_id == quarter_id,
        EmployeeQuarterResult.employee_id == employee_id,
        EmployeeQuarterResult.status == EmployeeResultStatus.PUBLISHED)).one_or_none()


# --- building and checking a request ---------------------------------------------------------

def build_items(db: Session, principal: Principal, quarter: PmsCycleQuarter,
                values: Sequence[ValueIn], weights: Sequence[WeightsIn],
                permission: Permission) -> list[QuarterCorrectionItem]:
    """The correction's items, with the effective values before; raises 422
    listing every problem and 403 for anything outside the caller's scope."""
    issues: list[Issue] = []
    items: list[QuarterCorrectionItem] = []
    scope = principal.scope_for(permission)
    if not values and not weights:
        raise ValidationFailedError([Issue("Specify at least one corrected value or set of "
                                           "contribution weights.", "values")])
    sheets = _sheets(db, quarter, [v.sheet_id for v in values])
    effective = kpi_results._values(db, list(sheets))
    seen: set[tuple[int, int, Any]] = set()
    for n, v in enumerate(values, 1):
        sheet = sheets.get(v.sheet_id)
        if sheet is None:
            issues.append(Issue(f"Change {n}: KPI sheet {v.sheet_id} is not a scored sheet of "
                                f"{quarter.name}.", "values"))
            continue
        unit = sheet.assignment.plant_department
        if not scope.allows_unit(unit.plant_id, unit.department_id):
            raise PermissionDeniedError(f"You cannot correct results of {unit.department.name} — "
                                        f"{unit.plant.name}.")
        item = next((i for i in sheet.items if i.kpi_definition_id == v.kpi_definition_id), None)
        if item is None:
            issues.append(Issue(f"Change {n}: the KPI is not on {_label(sheet)}'s sheet.",
                                "values"))
            continue
        try:
            month = kpi_data.parse_period(v.period)
        except ValidationFailedError:
            issues.append(Issue(f"Change {n}: choose the month as YYYY-MM.", "values"))
            continue
        label = f"Change {n} ({_label(sheet)}, {item.kpi_definition.code}, {month:%B %Y})"
        if month not in kpi_results.expected_months(sheet):
            issues.append(Issue(f"{label}: the month is outside the months the assignment was "
                                "active in the quarter.", "values"))
            continue
        key = (sheet.id, item.kpi_definition_id, month)
        if key in seen:
            issues.append(Issue(f"{label}: given twice.", "values"))
            continue
        seen.add(key)
        ctx = kpi_data._item_context(sheet, item)
        if ctx.problem:
            issues.append(Issue(f"{label}: {ctx.problem}", "values"))
            continue
        stored = effective.get(sheet.id, {}).get(item.kpi_definition_id, {})
        frequency = (item.measurement_snapshot or {}).get("reporting_frequency")
        if (frequency == ReportingFrequency.QUARTERLY.value
                and any(m != month for m in stored)):
            issues.append(Issue(f"{label}: this quarterly KPI's value is stored for "
                                f"{min(stored):%B %Y}; correct that month.", "values"))
            continue
        actual = None
        if v.actual is None or (isinstance(v.actual, str) and not v.actual.strip()):
            if ctx.needs_actual:
                issues.append(Issue(f"{label}: the corrected actual value is needed.", "values"))
                continue
        else:
            try:
                actual, _note = kpi_data._parse_actual(v.actual, ctx)
            except ValueError as exc:
                issues.append(Issue(f"{label}: actual — {exc}", "values"))
                continue
        inputs: dict[str, Any] = {}
        given = dict(v.inputs or {})
        known = {f.key: f for f in ctx.imported}
        unknown = sorted(set(given) - set(known))
        if unknown:
            issues.append(Issue(f"{label}: the matrix has no imported input {', '.join(unknown)}.",
                                "values"))
            continue
        bad = False
        for f in ctx.imported:
            raw = given.get(f.key)
            if raw is None or (isinstance(raw, str) and not raw.strip()):
                if f.required:
                    issues.append(Issue(f"{label}: {f.label} is needed.", "values"))
                    bad = True
                continue
            try:
                inputs[f.key] = rules.jsonable(rules.parse_value(f, raw))
            except ValueError as exc:
                issues.append(Issue(f"{label}: {f.label} — {exc}", "values"))
                bad = True
        if bad:
            continue
        current = stored.get(month)
        before_actual = current.actual_value if current is not None else None
        before_inputs = current.input_values if current is not None else None
        if current is not None and before_actual == actual and (before_inputs or {}) == inputs:
            issues.append(Issue(f"{label}: the value is unchanged.", "values"))
            continue
        items.append(QuarterCorrectionItem(
            kind=CorrectionItemKind.VALUE, sheet_id=sheet.id,
            kpi_definition_id=item.kpi_definition_id, period_month=month,
            had_value=current is not None, before_actual=before_actual, after_actual=actual,
            before_inputs=before_inputs, after_inputs=inputs or None))

    done: set[int] = set()
    for n, w in enumerate(weights, 1):
        found = quarterly.consolidate(db, quarter, employee_id=w.employee_id)
        if not found or w.employee_id in done:
            issues.append(Issue(f"Weights {n}: employee {w.employee_id} has no scored assignments "
                                f"in {quarter.name}, or is given twice.", "weights"))
            continue
        done.add(w.employee_id)
        c = found[0]
        who = f"Weights {n} ({c.employee.employee_code} {c.employee.full_name})"
        units = [(x.assignment.plant_department.plant_id, x.assignment.plant_department.department_id)
                 for x in c.components]
        if not all(scope.allows_unit(*u) for u in units):
            raise PermissionDeniedError("Contribution weights can be corrected only with authority "
                                        "over every scored assignment of the employee.")
        if len(c.components) < 2:
            issues.append(Issue(f"{who}: a single scored assignment always counts 100 %.",
                                "weights"))
            continue
        ids = {x.assignment.id for x in c.components}
        given_w = dict(w.weights)
        if len(given_w) != len(w.weights) or set(given_w) != ids:
            issues.append(Issue(f"{who}: give one weight for each scored assignment, and no other.",
                                "weights"))
            continue
        if any(not Decimal(0) < x <= HUNDRED or x != x.quantize(CENT) for x in given_w.values()):
            issues.append(Issue(f"{who}: each weight must be above 0 and at most 100, with at "
                                "most two decimals.", "weights"))
            continue
        total = sum(given_w.values(), Decimal(0))
        if total != HUNDRED:
            issues.append(Issue(f"{who}: the weights total {rules.decimal_text(total)} %; they "
                                "must total exactly 100 %.", "weights"))
            continue
        before = {str(x.assignment.id): rules.decimal_text(x.weight) for x in c.components
                  if x.weight is not None}
        after = {str(k): rules.decimal_text(v) for k, v in sorted(given_w.items())}
        if before == after:
            issues.append(Issue(f"{who}: the weights are unchanged.", "weights"))
            continue
        items.append(QuarterCorrectionItem(kind=CorrectionItemKind.WEIGHTS,
                                           employee_id=w.employee_id,
                                           before_weights=before or None, after_weights=after))
    if issues:
        raise ValidationFailedError(issues[:100])
    return items


def _dependents(db: Session, quarter: PmsCycleQuarter, employees: Sequence[int]) -> dict[str, Any]:
    """The published cohorts of the employees and those cohorts' members."""
    cohorts: list[dict[str, Any]] = []
    seen: set[int] = set()
    members_all: set[int] = set()
    for emp in sorted(set(employees)):
        row = _published_row(db, quarter.id, emp)
        if row is None or row.normalization_run_id is None or row.normalization_run_id in seen:
            continue
        seen.add(row.normalization_run_id)
        run = db.get(NormalizationRun, row.normalization_run_id)
        members = sorted(db.scalars(select(EmployeeQuarterResult.employee_id).where(
            EmployeeQuarterResult.normalization_run_id == run.id,
            EmployeeQuarterResult.status == EmployeeResultStatus.PUBLISHED)).all())
        members_all |= set(members)
        cohorts.append({"run_id": run.id, "cohort_key": run.cohort_key, "members": members})
    return {"employees": sorted(set(employees)), "cohorts": cohorts,
            "dependents": sorted(members_all - set(employees))}


def project(db: Session, quarter: PmsCycleQuarter,
            items: Sequence[QuarterCorrectionItem]) -> dict[str, Any]:
    """The correction's effect, calculated as it will be on approval."""
    value_items = [i for i in items if i.kind == CorrectionItemKind.VALUE]
    weight_items = [i for i in items if i.kind == CorrectionItemKind.WEIGHTS]
    sheet_ids = sorted({i.sheet_id for i in value_items})
    sheets = _sheets(db, quarter, sheet_ids)
    merged = versions.merge_values(kpi_results._values(db, sheet_ids),
                                   versions.value_overlay(db, [], extra=value_items))
    problems: list[str] = []
    sheet_rows = []
    after_scores: dict[int, Decimal | None] = {}
    for sid in sheet_ids:
        sheet = sheets[sid]
        comp = kpi_results.compute(sheet, merged.get(sid, {}))
        published = kpi_results.published_result(db, sid)
        after_scores[sid] = comp.final
        if not comp.complete:
            gaps = [f"{i['kpi_code']}: {i['message'] or i['status']}" for i in comp.items
                    if i["status"] != "scored"]
            problems.append(f"{_label(sheet)}: the corrected result would be incomplete "
                            f"({'; '.join(gaps)})")
        sheet_rows.append({
            "sheet_id": sid, "employee_id": sheet.assignment.employee_id,
            "employee": f"{sheet.assignment.employee.employee_code} "
                        f"{sheet.assignment.employee.full_name}",
            "unit": f"{sheet.assignment.plant_department.department.name} — "
                    f"{sheet.assignment.plant_department.plant.name}",
            "before": rules.jsonable(published.published_score if published else None),
            "after": rules.jsonable(comp.final), "complete": comp.complete,
            "kpis": [{"kpi_code": i["kpi_code"], "score": i["score"],
                      "quarterly_actual": i["quarterly_actual"]} for i in comp.items]})
    employees = sorted({sheets[s].assignment.employee_id for s in sheet_ids}
                       | {i.employee_id for i in weight_items})
    weight_by_emp = {i.employee_id: {int(k): Decimal(v) for k, v in i.after_weights.items()}
                     for i in weight_items}
    employee_rows = []
    for emp in employees:
        found = quarterly.consolidate(db, quarter, employee_id=emp)
        if not found:
            continue
        c = found[0]
        published = _published_row(db, quarter.id, emp)
        weights = weight_by_emp.get(emp) or {x.assignment.id: x.weight for x in c.components}
        parts = []
        for x in c.components:
            score = after_scores[x.view.sheet.id] if x.view.sheet.id in after_scores else (
                x.view.result.published_score if x.view.result is not None else None)
            w = weights.get(x.assignment.id)
            parts.append(None if score is None or w is None else score * w / HUNDRED)
        after = (None if any(p is None for p in parts)
                 else sum(parts, Decimal(0)).quantize(CENT, rounding=ROUND_HALF_UP))
        employee_rows.append({
            "employee_id": emp, "employee": f"{c.employee.employee_code} {c.employee.full_name}",
            "before": rules.jsonable(published.final_score if published else None),
            "after": rules.jsonable(after)})
    return {"sheets": sheet_rows, "employees": employee_rows, "problems": problems,
            "affected": _dependents(db, quarter, employees)}


def _require_correctable(db: Session, quarter: PmsCycleQuarter) -> None:
    if quarter.status != QuarterStatus.PUBLISHED:
        raise ConflictError(f"Only a published quarter is corrected this way; {quarter.name} is "
                            "still in its review steps.")
    existing = versions.open_correction(db, quarter.id)
    if existing is not None:
        raise ConflictError(f"Correction {existing.id} of {quarter.name} is still open "
                            f"({STATUS_LABELS[existing.status]}); one correction at a time.")


def preview(db: Session, principal: Principal, quarter_id: int, values: Sequence[ValueIn],
            weights: Sequence[WeightsIn]) -> dict[str, Any]:
    if principal.scope_for(Permission.QUARTER_CORRECTION_REQUEST).is_empty:
        raise PermissionDeniedError("Corrections of published quarters are requested by an HR "
                                    "Head.")
    quarter = get_quarter(db, quarter_id)
    _require_correctable(db, quarter)
    items = build_items(db, principal, quarter, values, weights,
                        Permission.QUARTER_CORRECTION_REQUEST)
    return project(db, quarter, items)


def request(db: Session, principal: Principal, actor: AuditActor, quarter_id: int, *,
            reason: str, values: Sequence[ValueIn],
            weights: Sequence[WeightsIn]) -> QuarterCorrection:
    if principal.scope_for(Permission.QUARTER_CORRECTION_REQUEST).is_empty:
        raise PermissionDeniedError("Corrections of published quarters are requested by an HR "
                                    "Head.")
    quarter = quarterly._locked_quarter(db, quarter_id)
    _require_correctable(db, quarter)
    if len(reason.strip()) < 10:
        raise ValidationFailedError([Issue("Explain the correction (at least 10 characters).",
                                           "reason")])
    items = build_items(db, principal, quarter, values, weights,
                        Permission.QUARTER_CORRECTION_REQUEST)
    projection = project(db, quarter, items)
    if projection["problems"]:
        raise ValidationFailedError([Issue(p, "values") for p in projection["problems"]])
    base = versions.published_version(db, quarter)
    correction = QuarterCorrection(cycle_quarter_id=quarter.id, base_version=base,
                                   reason=reason.strip()[:2000], preview=projection,
                                   requested_by_user_id=principal.user_id, items=items)
    db.add(correction)
    db.flush()
    _audit(db, actor, correction, quarter, "quarter_correction.request",
           f"Requested correction {correction.id} of {quarter.name} (published version {base})",
           reason=correction.reason, changes={
               "base_version": base, "items": [_item_summary(i) for i in items][:50],
               "sheets": [[s["sheet_id"], s["before"], s["after"]] for s in projection["sheets"]],
               "employees": [[e["employee_id"], e["before"], e["after"]]
                             for e in projection["employees"]]})
    return correction


def _item_summary(item: QuarterCorrectionItem) -> dict[str, Any]:
    if item.kind == CorrectionItemKind.VALUE:
        return {"sheet_id": item.sheet_id, "kpi_id": item.kpi_definition_id,
                "month": f"{item.period_month:%Y-%m}",
                "before": rules.jsonable(item.before_actual),
                "after": rules.jsonable(item.after_actual),
                "inputs_before": item.before_inputs, "inputs_after": item.after_inputs}
    return {"employee_id": item.employee_id, "weights_before": item.before_weights,
            "weights_after": item.after_weights}


def _audit(db: Session, actor: AuditActor, correction: QuarterCorrection,
           quarter: PmsCycleQuarter, action: str, summary: str, *, reason: str | None = None,
           changes: dict[str, Any] | None = None) -> None:
    record_event(db, actor=actor, action=action, entity_type="quarter_correction",
                 entity_id=correction.id, summary=summary, reason=reason,
                 changes={"quarter_id": quarter.id, **(changes or {})})


# --- reading ---------------------------------------------------------------------------------

def _units(db: Session, correction: QuarterCorrection) -> list[tuple[int, int]]:
    sheet_ids = [i.sheet_id for i in correction.items if i.sheet_id]
    assignment_ids = [int(k) for i in correction.items for k in (i.after_weights or {})]
    units = set()
    for plant_id, dept_id in db.execute(
            select(PlantDepartment.plant_id, PlantDepartment.department_id)
            .join(EmployeeAssignment, EmployeeAssignment.plant_department_id == PlantDepartment.id)
            .join(KpiSheet, KpiSheet.employee_assignment_id == EmployeeAssignment.id)
            .where(KpiSheet.id.in_(sheet_ids or [0]))):
        units.add((plant_id, dept_id))
    for plant_id, dept_id in db.execute(
            select(PlantDepartment.plant_id, PlantDepartment.department_id)
            .join(EmployeeAssignment, EmployeeAssignment.plant_department_id == PlantDepartment.id)
            .where(EmployeeAssignment.id.in_(assignment_ids or [0]))):
        units.add((plant_id, dept_id))
    return sorted(units)


def _covers(principal: Principal, permission: Permission, units: Sequence[tuple[int, int]]) -> bool:
    scope = principal.scope_for(permission)
    return bool(units) and all(scope.allows_unit(*u) for u in units)


def _query():
    return select(QuarterCorrection).options(joinedload(QuarterCorrection.quarter),
                                             selectinload(QuarterCorrection.items))


def get_correction(db: Session, principal: Principal, correction_id: int) -> QuarterCorrection:
    correction = db.scalars(_query().where(QuarterCorrection.id == correction_id)).unique().one_or_none()
    if correction is None or not _covers(principal, Permission.ORG_READ, _units(db, correction)):
        raise NotFoundError("Quarter correction", correction_id)
    return correction


def list_corrections(db: Session, principal: Principal, *, quarter_id: int | None = None,
                     status: CorrectionStatus | None = None) -> list[QuarterCorrection]:
    if principal.org_scope.is_empty:
        raise PermissionDeniedError("You do not have access to organizational data.")
    stmt = _query().order_by(QuarterCorrection.id.desc())
    if quarter_id is not None:
        stmt = stmt.where(QuarterCorrection.cycle_quarter_id == quarter_id)
    if status is not None:
        stmt = stmt.where(QuarterCorrection.status == status)
    return [c for c in db.scalars(stmt).unique().all()
            if _covers(principal, Permission.ORG_READ, _units(db, c))]


@dataclass
class CorrectionState:
    correction: QuarterCorrection
    next_status: CorrectionStatus | None
    previous_status: CorrectionStatus | None
    blockers: list[str]
    can_decide: bool
    can_advance: bool
    can_return: bool
    can_publish: bool


def state(db: Session, principal: Principal, correction: QuarterCorrection) -> CorrectionState:
    status = correction.status
    units = _units(db, correction)
    direct = set((correction.affected or correction.preview.get("affected") or {})
                 .get("employees", []))
    can_decide = (status == CorrectionStatus.REQUESTED
                  and _covers(principal, Permission.QUARTER_CORRECTION_APPROVE, units)
                  and principal.user_id != correction.requested_by_user_id
                  and principal.employee_id not in direct)
    stepper = principal.scope_for(Permission.QUARTER_START).is_global
    publisher = principal.scope_for(Permission.SCORE_PUBLISH).is_global
    next_status = FORWARD.get(status)
    blockers: list[str] = []
    if next_status is not None and stepper:
        blockers = gate(db, correction, next_status)
    elif status == CorrectionStatus.READY and publisher:
        blockers = publication_blockers(db, correction)
    return CorrectionState(correction, next_status, BACKWARD.get(status), blockers, can_decide,
                           stepper and next_status is not None,
                           stepper and status in BACKWARD,
                           publisher and status == CorrectionStatus.READY)


# --- the CHRO's decision ---------------------------------------------------------------------

def _locked(db: Session, correction_id: int) -> QuarterCorrection:
    correction = db.scalars(select(QuarterCorrection).where(QuarterCorrection.id == correction_id)
                            .with_for_update()).one_or_none()
    if correction is None:
        raise NotFoundError("Quarter correction", correction_id)
    return correction


def _decision_checks(db: Session, principal: Principal, correction_id: int,
                     reason: str) -> tuple[QuarterCorrection, PmsCycleQuarter]:
    correction = _locked(db, correction_id)
    get_correction(db, principal, correction_id)  # 404 outside the caller's access
    quarter = quarterly._locked_quarter(db, correction.cycle_quarter_id)
    if not _covers(principal, Permission.QUARTER_CORRECTION_APPROVE, _units(db, correction)):
        raise PermissionDeniedError("Corrections of published quarters are decided by the CHRO.")
    if principal.user_id == correction.requested_by_user_id:
        raise PermissionDeniedError("The requester cannot decide their own correction.")
    if principal.employee_id in set((correction.preview.get("affected") or {})
                                    .get("employees", [])):
        raise PermissionDeniedError("You cannot decide a correction of your own result.")
    if correction.status != CorrectionStatus.REQUESTED:
        raise ConflictError("This correction is no longer awaiting a decision.")
    if len(reason.strip()) < 10:
        raise ValidationFailedError([Issue("Give the reason for the decision (at least 10 "
                                           "characters).", "reason")])
    return correction, quarter


def reject(db: Session, principal: Principal, actor: AuditActor, correction_id: int,
           reason: str) -> QuarterCorrection:
    correction, quarter = _decision_checks(db, principal, correction_id, reason)
    correction.status = CorrectionStatus.REJECTED
    correction.decided_by_user_id = principal.user_id
    correction.decided_at = func.now()
    correction.decision_reason = reason.strip()[:1000]
    db.flush()
    _audit(db, actor, correction, quarter, "quarter_correction.reject",
           f"Rejected correction {correction.id} of {quarter.name}",
           reason=correction.decision_reason)
    return correction


def approve(db: Session, principal: Principal, actor: AuditActor, correction_id: int,
            reason: str) -> QuarterCorrection:
    correction, quarter = _decision_checks(db, principal, correction_id, reason)
    published = versions.published_version(db, quarter)
    if published != correction.base_version:
        raise ConflictError(f"{quarter.name} has been republished (version {published}) since "
                            f"this request was made against version {correction.base_version}; "
                            "reject it and request the correction again.")
    for item in correction.items:  # the values it replaces are still the current ones
        if item.kind != CorrectionItemKind.VALUE:
            continue
        current = (kpi_results._values(db, [item.sheet_id]).get(item.sheet_id, {})
                   .get(item.kpi_definition_id, {}).get(item.period_month))
        if (current.actual_value if current is not None else None) != item.before_actual:
            raise ConflictError("A value this correction replaces has changed since the request; "
                                "reject it and request the correction again.")
    version = correction.base_version + 1
    correction.version_no = version
    correction.status = CorrectionStatus.DEPARTMENT_REVIEW
    correction.decided_by_user_id = principal.user_id
    correction.decided_at = func.now()
    correction.decision_reason = reason.strip()[:1000]
    db.flush()  # the items now apply (versions.APPLIED)
    recalculated = _recalculate(db, principal, quarter, correction)
    affected = _dependents(db, quarter, sorted(
        {s.assignment.employee_id for s in _sheets(db, quarter, list(recalculated)).values()}
        | {i.employee_id for i in correction.items if i.kind == CorrectionItemKind.WEIGHTS}))
    flagged = annual.flag_for_correction(
        db, quarter, affected["employees"] + affected["dependents"],
        f"{quarter.name} is being corrected (correction {correction.id}); recalculate once the "
        "corrected version is published.")
    correction.affected = {**affected, "sheets": sorted(recalculated),
                           "annual_results_flagged": flagged}
    db.flush()
    _audit(db, actor, correction, quarter, "quarter_correction.approve",
           f"Approved correction {correction.id} of {quarter.name}: version {version} opened "
           "for review", reason=correction.decision_reason, changes={
               "version_no": version, "sheets": [[sid, s] for sid, s in recalculated.items()],
               "employees": affected["employees"], "dependents": affected["dependents"],
               "cohorts": [c["run_id"] for c in affected["cohorts"]],
               "annual_results_flagged": flagged})
    return correction


def _recalculate(db: Session, principal: Principal, quarter: PmsCycleQuarter,
                 correction: QuarterCorrection) -> dict[int, Any]:
    """New result rows of the correction's version for every corrected sheet,
    with the matrix versions frozen on it."""
    sheet_ids = sorted({i.sheet_id for i in correction.items if i.kind == CorrectionItemKind.VALUE})
    sheets = _sheets(db, quarter, sheet_ids)
    values = kpi_results._values(db, sheet_ids)
    found = {}
    for sid in sheet_ids:
        sheet = sheets[sid]
        comp = kpi_results.compute(sheet, values.get(sid, {}))
        if not comp.complete:
            raise ConflictError(f"{_label(sheet)}: the corrected result is incomplete; reject the "
                                "correction and request it again with every value.")
        db.add(KpiSheetResult(
            sheet_id=sid, version_no=correction.version_no, status=ScoreResultStatus.CALCULATED,
            is_complete=comp.complete, calculated_score=comp.calculated, final_score=comp.final,
            explanation={"items": comp.items, "correction_id": correction.id,
                         "months": [f"{m:%Y-%m}" for m in kpi_results.expected_months(sheet)]},
            inputs_hash=comp.inputs_hash, calculated_by_user_id=principal.user_id,
            calculated_at=func.now()))
        found[sid] = rules.jsonable(comp.final)
    db.flush()
    return found


# --- review steps ----------------------------------------------------------------------------

def _version_rows(db: Session, correction: QuarterCorrection) -> dict[int, EmployeeQuarterResult]:
    return {r.employee_id: r for r in db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.cycle_quarter_id == correction.cycle_quarter_id,
        EmployeeQuarterResult.version_no == correction.version_no))}


def _version_runs(db: Session, correction: QuarterCorrection) -> list[NormalizationRun]:
    return list(db.scalars(normalization._run_query().where(
        NormalizationRun.cycle_quarter_id == correction.cycle_quarter_id,
        NormalizationRun.version_no == correction.version_no)
        .order_by(NormalizationRun.id)).unique().all())


def _sheet_views(db: Session, correction: QuarterCorrection) -> list[kpi_results.ResultView]:
    sheet_ids = set((correction.affected or {}).get("sheets", []))
    return [v for v in kpi_results.quarter_views(db, correction.cycle_quarter_id)
            if v.sheet.id in sheet_ids]


def _direct(db: Session, quarter: PmsCycleQuarter,
            correction: QuarterCorrection) -> dict[int, quarterly.Consolidation]:
    employees = (correction.affected or {}).get("employees", [])
    found = {}
    for emp in employees:
        c = quarterly.consolidate(db, quarter, employee_id=emp)
        if c:
            found[emp] = c[0]
    return found


def _plans(db: Session, quarter: PmsCycleQuarter, correction: QuarterCorrection,
           rows: dict[int, EmployeeQuarterResult]) -> dict[str, normalization.CohortPlan]:
    plans = {}
    for cohort in (correction.affected or {}).get("cohorts", []):
        run = db.get(NormalizationRun, cohort["run_id"])
        definition, settings = normalization.frozen_policy(run.matrix_version)
        plans[run.cohort_key] = normalization.CohortPlan(
            run.cohort_key, run.matrix_version, definition, settings, run.cohort_level,
            run.plant_id, run.department_id, [rows[e] for e in cohort["members"] if e in rows])
    return plans


def gate(db: Session, correction: QuarterCorrection, target: CorrectionStatus) -> list[str]:
    quarter = correction.quarter
    blockers: list[str] = []
    if target == CorrectionStatus.NORMALIZATION:
        for v in _sheet_views(db, correction):
            if v.result is None or v.result.version_no != correction.version_no:
                blockers.append(f"{_label(v.sheet)}: the corrected result is missing")
                continue
            blockers += [f"{_label(v.sheet)}: {p}"
                         for p in quarterly.sheet_problems(v, for_review=True)]
        for emp, c in _direct(db, quarter, correction).items():
            blockers += [f"{c.employee.employee_code} {c.employee.full_name}: {i}"
                         for i in c.issues()]
            published = _published_row(db, quarter.id, emp)
            if (c.primary is not None and published is not None
                    and (c.primary.plant_department.plant_id,
                         c.primary.plant_department.department_id)
                    != (published.plant_id, published.department_id)):
                blockers.append(f"{c.employee.employee_code}: the employee's home unit changed "
                                "since publication; the correction can't move them to another "
                                "cohort")
    elif target == CorrectionStatus.READY:
        rows = _version_rows(db, correction)
        plans = _plans(db, quarter, correction, rows)
        runs = {r.cohort_key: r for r in _version_runs(db, correction)}
        for key, plan in plans.items():
            run = runs.get(key)
            if run is None or run.inputs_hash != plan.digest():
                blockers.append("An affected cohort is out of date; return the correction to "
                                "department review and back to recompute it.")
                continue
            view = normalization._view(db, run)
            if view.problem:
                blockers.append(f"{view.label}: {view.problem}")
            if view.unresolved:
                blockers.append(f"{view.label}: {len(view.unresolved)} employee(s) still need to "
                                "be placed by a reviewer.")
            if view.rating_errors:
                blockers.append(f"{view.label}: the policy gives no rating to "
                                f"{len(view.rating_errors)} employee(s).")
            if run.status != NormalizationRunStatus.APPROVED:
                blockers.append(f"{view.label}: awaits approval.")
    return blockers


def _freeze(db: Session, principal: Principal, quarter: PmsCycleQuarter,
            correction: QuarterCorrection) -> int:
    """Employee results of the version for every member of an affected cohort
    (recomputed for the affected employees, carried over for the others),
    then the cohorts renormalized as runs of the version."""
    direct = _direct(db, quarter, correction)
    rows = _version_rows(db, correction)
    cohorts = (correction.affected or {}).get("cohorts", [])
    in_cohorts = {e for c in cohorts for e in c["members"]}
    # An affected employee outside every published cohort still gets a row.
    members = [e for c in cohorts for e in c["members"]] + [e for e in direct
                                                            if e not in in_cohorts]
    for emp in members:
        published = _published_row(db, quarter.id, emp)
        row = rows.get(emp)
        if row is None:
            row = EmployeeQuarterResult(cycle_quarter_id=quarter.id, employee_id=emp,
                                        version_no=correction.version_no)
            db.add(row)
            rows[emp] = row
        c = direct.get(emp)
        if c is not None:
            unit = c.primary.plant_department
            fields = dict(primary_assignment_id=c.primary.id, plant_id=unit.plant_id,
                          department_id=unit.department_id, components=c.components_json(),
                          weights_source=c.weights_source, calculated_score=c.calculated,
                          final_score=c.final, inputs_hash=c.inputs_hash())
        else:
            fields = dict(primary_assignment_id=published.primary_assignment_id,
                          plant_id=published.plant_id, department_id=published.department_id,
                          components=published.components,
                          weights_source=published.weights_source,
                          calculated_score=published.calculated_score,
                          final_score=published.final_score, inputs_hash=published.inputs_hash)
        if row.id is not None and row.inputs_hash != fields["inputs_hash"]:
            normalization.clear_outcome(row)
        for name, value in fields.items():
            setattr(row, name, value)
        row.status = EmployeeResultStatus.DRAFT
    db.flush()
    plans = _plans(db, quarter, correction, rows)
    existing = {r.cohort_key: r for r in _version_runs(db, correction)}
    normalization.place_cohorts(db, principal, quarter, plans, existing,
                                version_no=correction.version_no)
    return len(rows)


def transition(db: Session, principal: Principal, actor: AuditActor, correction_id: int,
               target: CorrectionStatus, reason: str | None = None) -> QuarterCorrection:
    if not principal.scope_for(Permission.QUARTER_START).is_global:
        raise PermissionDeniedError("Moving a correction between review steps needs company-wide "
                                    "HR authority.")
    correction = _locked(db, correction_id)
    get_correction(db, principal, correction_id)
    quarter = quarterly._locked_quarter(db, correction.cycle_quarter_id)
    current = correction.status
    changes: dict[str, Any] = {"from": current.value, "to": target.value,
                               "version_no": correction.version_no}
    if FORWARD.get(current) == target:
        blockers = gate(db, correction, target)
        if blockers:
            raise ValidationFailedError([Issue(b, "correction") for b in blockers[:200]])
        if target == CorrectionStatus.NORMALIZATION:
            changes["employees"] = _freeze(db, principal, quarter, correction)
        action = "quarter_correction.advance"
    elif BACKWARD.get(current) == target:
        if reason is None or len(reason.strip()) < 10:
            raise ValidationFailedError([Issue("Explain why the correction goes back a step (at "
                                               "least 10 characters).", "reason")])
        action = "quarter_correction.return"
    else:
        allowed = [s.value for s in (FORWARD.get(current), BACKWARD.get(current)) if s]
        raise ConflictError(f"Correction {correction.id} is {STATUS_LABELS[current]}; it can move "
                            f"to {' or '.join(allowed) or 'no other step here'}.")
    correction.status = target
    db.flush()
    _audit(db, actor, correction, quarter, action,
           f"Correction {correction.id} of {quarter.name}: {STATUS_LABELS[current]} → "
           f"{STATUS_LABELS[target]}",
           reason=reason.strip() if reason and action.endswith("return") else None,
           changes=changes)
    return correction


# --- publication -------------------------------------------------------------------------------

def publication_blockers(db: Session, correction: QuarterCorrection) -> list[str]:
    quarter = correction.quarter
    blockers = []
    for v in _sheet_views(db, correction):
        if v.result is None or v.result.version_no != correction.version_no:
            blockers.append(f"{_label(v.sheet)}: the corrected result is missing")
            continue
        blockers += [f"{_label(v.sheet)}: {p}" for p in quarterly.sheet_problems(v, for_review=True)]
    rows = _version_rows(db, correction)
    for emp, c in _direct(db, quarter, correction).items():
        row = rows.get(emp)
        if row is None or row.inputs_hash != c.inputs_hash():
            blockers.append(f"{c.employee.employee_code} {c.employee.full_name}: the score changed "
                            "after normalization started; return the correction to department "
                            "review")
    blockers += gate(db, correction, CorrectionStatus.READY)
    return blockers


def _digest(data: Any) -> str:
    return hashlib.sha256(rules.canonical_json(data).encode("utf-8")).hexdigest()


def publish(db: Session, principal: Principal, actor: AuditActor,
            correction_id: int) -> QuarterCorrection:
    """Make the corrected version current: its rows PUBLISHED, the rows they
    replace SUPERSEDED, in one transaction."""
    if not principal.scope_for(Permission.SCORE_PUBLISH).is_global:
        raise PermissionDeniedError("Publishing a corrected quarter needs company-wide HR Head or "
                                    "CHRO authority.")
    correction = _locked(db, correction_id)
    get_correction(db, principal, correction_id)
    quarter = quarterly._locked_quarter(db, correction.cycle_quarter_id)
    if correction.status != CorrectionStatus.READY:
        raise ConflictError(f"Correction {correction.id} is {STATUS_LABELS[correction.status]}; "
                            "only a correction ready for publication can be published.")
    blockers = publication_blockers(db, correction)
    if blockers:
        raise ValidationFailedError([Issue(b, "correction") for b in blockers[:200]])
    version = correction.version_no
    sheet_rows = [v.result for v in _sheet_views(db, correction)]
    employee_rows = list(_version_rows(db, correction).values())
    runs = [r for r in _version_runs(db, correction) if r.status == NormalizationRunStatus.APPROVED]
    superseded: dict[str, list[int]] = {"sheet_results": [], "employee_results": [], "runs": []}
    for r in sheet_rows:
        old = kpi_results.published_result(db, r.sheet_id)
        if old is not None:
            old.status = ScoreResultStatus.SUPERSEDED
            superseded["sheet_results"].append(old.id)
    for r in employee_rows:
        old = _published_row(db, quarter.id, r.employee_id)
        if old is not None:
            old.status = EmployeeResultStatus.SUPERSEDED
            superseded["employee_results"].append(old.id)
    for run in runs:
        old = db.scalars(select(NormalizationRun).where(
            NormalizationRun.cycle_quarter_id == quarter.id,
            NormalizationRun.cohort_key == run.cohort_key,
            NormalizationRun.status == NormalizationRunStatus.PUBLISHED)).one_or_none()
        if old is not None:
            old.status = NormalizationRunStatus.SUPERSEDED
            superseded["runs"].append(old.id)
    db.flush()  # one PUBLISHED row per sheet, employee and cohort at every moment
    for r in sheet_rows:
        kpi_results.publish_result(principal, r)
    for r in employee_rows:
        r.status = EmployeeResultStatus.PUBLISHED
        r.published_by_user_id = principal.user_id
        r.published_at = func.now()
    published_runs = normalization.publish_runs(db, quarter, version)
    correction.status = CorrectionStatus.PUBLISHED
    correction.published_by_user_id = principal.user_id
    correction.published_at = func.now()
    db.flush()
    flagged = annual.flag_for_correction(
        db, quarter, [r.employee_id for r in employee_rows],
        f"{quarter.name} version {version} (correction {correction.id}) was published; "
        "recalculate the annual result.")
    _audit(db, actor, correction, quarter, "quarter_correction.publish",
           f"Published version {version} of {quarter.name} (correction {correction.id}): "
           f"{len(sheet_rows)} KPI sheets, {len(employee_rows)} employees, "
           f"{len(published_runs)} cohorts", changes={
               "version_no": version, "superseded": superseded,
               "annual_results_flagged": flagged,
               "sheet_results_sha256": _digest([[r.sheet_id, r.inputs_hash,
                                                 rules.jsonable(r.published_score)]
                                                for r in sheet_rows]),
               "employee_results_sha256": _digest([[r.employee_id, r.inputs_hash,
                                                    rules.jsonable(r.final_score), r.group_key,
                                                    rules.jsonable(r.normalized_rating)]
                                                   for r in employee_rows]),
               "cohorts_sha256": _digest([[r.cohort_key, r.inputs_hash] for r in published_runs])})
    return correction
