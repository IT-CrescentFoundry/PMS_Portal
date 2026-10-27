"""Quarterly KPI results: calculate, review, publish; manual score overrides.

Calculation, per item of a PUBLISHED or LOCKED sheet:
  1. The monthly source values of the months of the quarter in which the
     assignment was active (kpi_monthly_values).
  2. Combined into the quarterly actual with the item's FROZEN measurement
     (aggregation); extra imported inputs combine as their field declares.
  3. The frozen matrix version's inputs are derived (actual, target, actual ÷
     target × 100, actual − target, imported values) and the version is
     evaluated after verifying its content hash. Items published before
     Stage K use their frozen Stage J bands.
  4. Contribution = score × weightage ÷ 100, in exact decimals.
The calculated score is the sum of the contributions (exact, at most 4
decimals). The final score is that sum rounded half-up to 2 decimals, and is
set only when every KPI is scored from every expected month. Until then the
calculated score is provisional.

Lifecycle: CALCULATED -> REVIEWED (the manager; kpi:write) -> PUBLISHED,
which is final. Since Stage M a published result may be followed by a
corrected version (app/services/versions.py): a new row with a higher
version_no, reviewed in the correction's own steps; the published row is
SUPERSEDED only when the corrected version is published. Since Stage L, results are published only with their whole
quarter, after department review and normalization (app/services/quarterly.py);
there is no per-sheet publication. A result is stale when its inputs changed
after calculation; stale or incomplete results can't be reviewed. Data and
calculation are possible only while the quarter collects data; review and
overrides only during collection or department review. Once published,
nothing changes a result: imports, deviations and recalculation are refused.

An employee reading only their own sheet sees its result once published.

A manual override of the final score is a separate request, applied only
after an HR Head (or the CHRO) and a Plant Head approve it (two different
people, neither the requester). Recalculation with changed inputs voids
pending and applied overrides.
"""
from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.auth.permissions import Permission, Principal
from app.models import (
    Employee,
    EmployeeAssignment,
    KpiAggregation,
    KpiMonthlyValue,
    KpiScoreOverride,
    KpiSheet,
    KpiSheetItem,
    KpiSheetResult,
    KpiSheetStatus,
    MatrixVersion,
    PlantDepartment,
    ReportingFrequency,
    ScoreOverrideStatus,
    ScoreResultStatus,
)
from app.services import clock, scoring, versions
from app.services import matrix_rules as rules
from app.services import matrix_service
from app.services.audit import AuditActor, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services.kpi_sheets import get_quarter, require_collection, require_review
from app.services.matrix_types import Aggregation, Source

CENT = Decimal("0.01")
HUNDRED = Decimal(100)
SCORABLE = (KpiSheetStatus.PUBLISHED, KpiSheetStatus.LOCKED)


def _sheet_query():
    return select(KpiSheet).options(
        joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.employee),
        joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.designation),
        joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.plant_department)
        .joinedload(PlantDepartment.plant),
        joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.plant_department)
        .joinedload(PlantDepartment.department),
        joinedload(KpiSheet.quarter),
        selectinload(KpiSheet.items).joinedload(KpiSheetItem.kpi_definition),
        selectinload(KpiSheet.items).joinedload(KpiSheetItem.matrix_version)
        .joinedload(MatrixVersion.matrix),
    )


def _unit(sheet: KpiSheet) -> PlantDepartment:
    return sheet.assignment.plant_department


def _allows(principal: Principal, permission: Permission, sheet: KpiSheet) -> bool:
    unit = _unit(sheet)
    return principal.scope_for(permission).allows_unit(unit.plant_id, unit.department_id)


def get_sheet(db: Session, principal: Principal, sheet_id: int) -> KpiSheet:
    sheet = db.scalars(_sheet_query().where(KpiSheet.id == sheet_id)).unique().one_or_none()
    if sheet is None:
        raise NotFoundError("KPI sheet", sheet_id)
    own = principal.can_read_self and sheet.assignment.employee_id == principal.employee_id
    if not own and not _allows(principal, Permission.ORG_READ, sheet):
        raise NotFoundError("KPI sheet", sheet_id)
    return sheet


def result_for(db: Session, sheet_id: int) -> KpiSheetResult | None:
    """The working result: the highest version."""
    return db.scalars(select(KpiSheetResult).where(KpiSheetResult.sheet_id == sheet_id)
                      .order_by(KpiSheetResult.version_no.desc()).limit(1)).first()


def published_result(db: Session, sheet_id: int) -> KpiSheetResult | None:
    return db.scalars(select(KpiSheetResult).where(
        KpiSheetResult.sheet_id == sheet_id,
        KpiSheetResult.status == ScoreResultStatus.PUBLISHED)).one_or_none()


def result_versions(db: Session, sheet_id: int) -> list[KpiSheetResult]:
    return list(db.scalars(select(KpiSheetResult).where(KpiSheetResult.sheet_id == sheet_id)
                           .order_by(KpiSheetResult.version_no)).all())


def latest_results(db: Session, sheet_ids: Sequence[int]) -> dict[int, KpiSheetResult]:
    """{sheet: working result (highest version)}."""
    return versions.latest(db.scalars(select(KpiSheetResult).where(
        KpiSheetResult.sheet_id.in_(list(sheet_ids) or [0]))).all(), lambda r: r.sheet_id)


def phase_of(db: Session, sheet: KpiSheet, result: KpiSheetResult | None):
    """The review step that applies to a result (its version's phase)."""
    return versions.phase(db, sheet.quarter, result.version_no if result else 1)


def published(db: Session, sheet_id: int) -> bool:
    return bool(db.scalar(select(KpiSheetResult.id).where(
        KpiSheetResult.sheet_id == sheet_id, KpiSheetResult.status == ScoreResultStatus.PUBLISHED)))


# --- calculation ---------------------------------------------------------------------------

def expected_months(sheet: KpiSheet) -> list[date]:
    """Months of the quarter in which the assignment was active."""
    quarter, a = sheet.quarter, sheet.assignment
    start = max(quarter.start_date, a.effective_from)
    end = quarter.end_date if a.effective_to is None else min(quarter.end_date, a.effective_to)
    return clock.months_between(start, end) if start <= end else []


def _combine(values: Sequence[Any], how: str) -> Any:
    if not values:
        return None
    match how:
        case "SUM":
            return sum(values, Decimal(0))
        case "AVERAGE":
            return sum(values, Decimal(0)) / Decimal(len(values))
        case "MIN":
            return min(values)
        case "MAX":
            return max(values)
        case "FIRST":
            return values[0]
        case "LAST":
            return values[-1]
        case "ANY":
            return any(values)
        case "ALL":
            return all(values)
    raise ValueError(f"Unknown aggregation {how}.")


def _text(value: Any) -> Any:
    return rules.jsonable(value)


@dataclass
class Computation:
    items: list[dict[str, Any]]
    calculated: Decimal | None
    final: Decimal | None
    complete: bool
    inputs_hash: str


def _item(sheet: KpiSheet, item: KpiSheetItem, values: dict[date, KpiMonthlyValue],
          months: list[date]) -> dict[str, Any]:
    measurement = item.measurement_snapshot or {}
    legacy = item.matrix_version_id is None
    kpi = item.kpi_definition
    frequency = measurement.get("reporting_frequency") or (
        kpi.reporting_frequency.value if kpi.reporting_frequency else ReportingFrequency.MONTHLY.value)
    aggregation = measurement.get("aggregation") or (
        kpi.aggregation.value if kpi.aggregation else None)
    present = [m for m in months if m in values]
    monthly = [values[m] for m in present]
    result: dict[str, Any] = {
        "item_id": item.id, "kpi_id": kpi.id, "kpi_code": kpi.code, "kpi_name": kpi.name,
        "unit": item.unit, "weightage": _text(item.weightage),
        "target": _text(item.target_value), "reporting_frequency": frequency,
        "aggregation": aggregation,
        "months_expected": [f"{m:%Y-%m}" for m in months],
        "months_missing": [],
        "monthly": [{"month": f"{v.period_month:%Y-%m}", "actual": _text(v.actual_value),
                     "inputs": v.input_values, "import_id": v.data_import_id, "row": v.source_row,
                     **({"correction_id": v.correction_id}
                        if isinstance(v, versions.CorrectedValue) else {})}
                    for v in monthly],
        "quarterly_actual": None, "inputs": {}, "matrix": None, "legacy_rule": legacy,
        "rule": None, "used_default": False, "score": None, "contribution": None,
        "status": "no_data", "message": None,
    }
    if frequency == ReportingFrequency.QUARTERLY.value:
        if len(monthly) > 1:
            result.update(status="error", message="A quarterly KPI has more than one value in "
                                                  "the quarter; keep one.")
            return result
        missing = [] if monthly else ["quarter"]
    else:
        missing = [f"{m:%Y-%m}" for m in months if m not in values]
    result["months_missing"] = missing
    actuals = [v.actual_value for v in monthly if v.actual_value is not None]
    if frequency == ReportingFrequency.QUARTERLY.value:
        actual = actuals[0] if actuals else None
    elif aggregation is None:
        result.update(status="error", message="The KPI's monthly aggregation is not defined.")
        return result
    else:
        actual = _combine(actuals, KpiAggregation(aggregation).value)
    result["quarterly_actual"] = _text(actual)
    target = item.target_value

    try:
        if legacy:
            score = _legacy_score(item, actual, target)
            if score is None:
                return result
            result["rule"] = {"description": "Stage J scoring bands frozen at publication"}
        else:
            version = item.matrix_version
            result["matrix"] = {"matrix_id": version.matrix_id, "code": version.matrix.code,
                                "name": version.matrix.name, "version_id": version.id,
                                "version_no": version.version_no,
                                "definition_hash": version.definition_hash}
            definition = matrix_service.frozen_definition(version)
            inputs: dict[str, Any] = {}
            for f in definition.inputs:
                value = _derive(f, actual, target, monthly)
                if value is not None:
                    inputs[f.key] = value
            result["inputs"] = {k: _text(v) for k, v in inputs.items()}
            lacking = [f.label for f in definition.inputs if f.required and f.key not in inputs]
            if lacking:
                result["message"] = f"No data yet for: {', '.join(lacking)}."
                return result
            evaluation = rules.evaluate(definition, inputs)
            score = int(evaluation.outputs["score"])
            result["used_default"] = evaluation.used_default
            if evaluation.rule is not None:
                result["rule"] = {"priority": evaluation.rule.priority,
                                  "label": evaluation.rule.label,
                                  "description": rules.describe_rule(definition, evaluation.rule)}
            else:
                result["rule"] = {"description": "No rule matched: the default output applied"}
    except (rules.EvaluationError, matrix_service.IntegrityProblem, ValueError,
            InvalidOperation, ZeroDivisionError) as exc:
        result.update(status="error", message=str(exc) or "The score could not be calculated.")
        return result
    result["score"] = score
    result["contribution"] = _text(Decimal(score) * item.weightage / HUNDRED)
    result["status"] = "provisional" if missing else "scored"
    if missing:
        result["message"] = f"Missing month(s): {', '.join(missing)}."
    return result


def _derive(f: rules.FieldDef, actual: Decimal | None, target: Decimal | None,
            monthly: Sequence[KpiMonthlyValue]) -> Any:
    match f.source:
        case Source.ACTUAL:
            return actual
        case Source.TARGET:
            return target
        case Source.PERCENT_OF_TARGET:
            if actual is None or target is None:
                return None
            if target == 0:
                raise ValueError("Actual ÷ target is undefined for a target of 0.")
            return actual / target * HUNDRED
        case Source.DIFFERENCE_FROM_TARGET:
            return None if actual is None or target is None else actual - target
        case Source.IMPORTED:
            raw = [v.input_values[f.key] for v in monthly
                   if v.input_values and v.input_values.get(f.key) is not None]
            typed = [rules.parse_value(f, r) for r in raw]
            return _combine(typed, (f.aggregation or Aggregation.LAST).value) if typed else None
    raise ValueError(f"{f.label} has no source in the KPI data.")


def _legacy_score(item: KpiSheetItem, actual: Decimal | None, target: Decimal | None) -> int | None:
    snapshot = item.scoring_snapshot or {}
    if actual is None or not snapshot.get("direction"):
        return None
    if snapshot["direction"] == "ZERO_TOLERANCE":
        return scoring.evaluate(snapshot, actual=actual)
    if target in (None, 0):
        raise ValueError("Actual ÷ target needs a target other than 0.")
    return scoring.evaluate(snapshot, achievement=actual / target * HUNDRED)


def _values(db: Session, sheet_ids: Sequence[int]) -> dict[int, dict[int, dict[date, Any]]]:
    """Stored monthly values with every approved correction applied on top."""
    grouped: dict[int, dict[int, dict[date, Any]]] = {}
    for v in db.scalars(select(KpiMonthlyValue).where(KpiMonthlyValue.sheet_id.in_(
            list(sheet_ids) or [0]))).all():
        grouped.setdefault(v.sheet_id, {}).setdefault(v.kpi_definition_id, {})[v.period_month] = v
    overlay = versions.value_overlay(db, sheet_ids)
    return versions.merge_values(grouped, overlay) if overlay else grouped


def inputs_hash(sheet: KpiSheet, values: dict[int, dict[date, KpiMonthlyValue]]) -> str:
    months = expected_months(sheet)
    data = {
        "sheet": sheet.id,
        "months": [f"{m:%Y-%m}" for m in months],
        "items": [{
            "id": i.id, "kpi": i.kpi_definition_id, "weightage": _text(i.weightage),
            "target": _text(i.target_value), "matrix_version_id": i.matrix_version_id,
            "snapshot": i.scoring_snapshot, "measurement": i.measurement_snapshot,
        } for i in sheet.items],
        "values": [{
            "kpi": kpi_id, "month": f"{m:%Y-%m}", "actual": _text(v.actual_value),
            "inputs": v.input_values,
        } for kpi_id in sorted(values) if any(i.kpi_definition_id == kpi_id for i in sheet.items)
            for m, v in sorted(values[kpi_id].items()) if m in months],
    }
    return hashlib.sha256(rules.canonical_json(data).encode("utf-8")).hexdigest()


def compute(sheet: KpiSheet, values: dict[int, dict[date, KpiMonthlyValue]]) -> Computation:
    months = expected_months(sheet)
    items = [_item(sheet, i, values.get(i.kpi_definition_id, {}), months) for i in sheet.items]
    scored = [Decimal(r["contribution"]) for r in items if r["contribution"] is not None]
    complete = bool(items) and all(r["status"] == "scored" for r in items)
    calculated = sum(scored, Decimal(0)) if scored else None
    final = calculated.quantize(CENT, rounding=ROUND_HALF_UP) if complete and calculated is not None else None
    return Computation(items, calculated, final, complete, inputs_hash(sheet, values))


def calculate(db: Session, principal: Principal, actor: AuditActor, quarter_id: int,
              sheet_ids: Sequence[int] | None = None) -> dict[str, int]:
    """(Re)calculate results for scorable sheets in the caller's scope."""
    if principal.scope_for(Permission.KPI_WRITE).is_empty:
        raise PermissionDeniedError("You cannot calculate KPI scores.")
    quarter = get_quarter(db, quarter_id)
    require_collection(quarter)
    stmt = _sheet_query().join(KpiSheet.assignment).join(EmployeeAssignment.plant_department).where(
        KpiSheet.cycle_quarter_id == quarter.id, KpiSheet.status.in_(SCORABLE),
        principal.scope_for(Permission.KPI_WRITE).unit_condition())
    if sheet_ids is not None:
        stmt = stmt.where(KpiSheet.id.in_(list(sheet_ids) or [0]))
    sheets = db.scalars(stmt).unique().all()
    if sheet_ids is not None and len(sheets) != len(set(sheet_ids)):
        raise NotFoundError("KPI sheet", ", ".join(str(i) for i in sorted(set(sheet_ids))))
    values = _values(db, [s.id for s in sheets])
    results = latest_results(db, [s.id for s in sheets])
    counts = {"calculated": 0, "unchanged": 0, "published": 0, "complete": 0}
    for sheet in sheets:
        result = results.get(sheet.id)
        if result is not None and result.status == ScoreResultStatus.PUBLISHED:
            counts["published"] += 1
            continue
        computation = compute(sheet, values.get(sheet.id, {}))
        if result is not None and result.inputs_hash == computation.inputs_hash:
            counts["unchanged"] += 1
            counts["complete"] += int(result.is_complete)
            continue
        voided = _void_overrides(db, result) if result is not None else []
        if result is None:
            result = KpiSheetResult(sheet_id=sheet.id)
            db.add(result)
        result.status = ScoreResultStatus.CALCULATED
        result.is_complete = computation.complete
        result.calculated_score = computation.calculated
        result.final_score = computation.final
        result.override_score = None
        result.explanation = {"items": computation.items,
                              "months": [f"{m:%Y-%m}" for m in expected_months(sheet)]}
        result.inputs_hash = computation.inputs_hash
        result.calculated_by_user_id = principal.user_id
        result.calculated_at = func.now()
        result.reviewed_by_user_id = None
        result.reviewed_at = None
        db.flush()
        counts["calculated"] += 1
        counts["complete"] += int(computation.complete)
        unit = _unit(sheet)
        record_event(db, actor=actor, action="kpi_result.calculate", entity_type="kpi_sheet",
                     entity_id=sheet.id,
                     summary=(f"Calculated the {quarter.name} score of "
                              f"{sheet.assignment.employee.employee_code}: "
                              + (f"{computation.final}" if computation.final is not None
                                 else "incomplete")),
                     changes={"calculated_score": computation.calculated,
                              "final_score": computation.final, "complete": computation.complete,
                              "inputs_sha256": computation.inputs_hash,
                              "voided_overrides": voided,
                              "items": [{"kpi": r["kpi_code"], "score": r["score"],
                                         "status": r["status"],
                                         "matrix_version_id": (r["matrix"] or {}).get("version_id")}
                                        for r in computation.items]},
                     plant_id=unit.plant_id, department_id=unit.department_id)
    return counts


def _void_overrides(db: Session, result: KpiSheetResult) -> list[int]:
    voided = []
    for override in db.scalars(select(KpiScoreOverride).where(
            KpiScoreOverride.result_id == result.id,
            KpiScoreOverride.status.in_((ScoreOverrideStatus.PENDING, ScoreOverrideStatus.APPLIED)))):
        override.status = ScoreOverrideStatus.VOIDED
        override.voided_at = func.now()
        voided.append(override.id)
    return voided


# --- viewing ---------------------------------------------------------------------------------

@dataclass
class ResultView:
    sheet: KpiSheet
    result: KpiSheetResult | None
    stale: bool
    pending_override: KpiScoreOverride | None
    applied_override: KpiScoreOverride | None


def _overrides(db: Session, result_ids: Sequence[int]) -> dict[int, list[KpiScoreOverride]]:
    grouped: dict[int, list[KpiScoreOverride]] = {}
    for o in db.scalars(select(KpiScoreOverride).where(KpiScoreOverride.result_id.in_(
            list(result_ids) or [0])).order_by(KpiScoreOverride.id)).all():
        grouped.setdefault(o.result_id, []).append(o)
    return grouped


def _view(sheet: KpiSheet, result: KpiSheetResult | None, values: dict[int, dict[date, KpiMonthlyValue]],
          overrides: list[KpiScoreOverride]) -> ResultView:
    stale = (result is not None and result.status != ScoreResultStatus.PUBLISHED
             and result.inputs_hash != inputs_hash(sheet, values))
    pending = next((o for o in overrides if o.status == ScoreOverrideStatus.PENDING), None)
    applied = next((o for o in overrides if o.status == ScoreOverrideStatus.APPLIED), None)
    return ResultView(sheet, result, stale, pending, applied)


def self_only(principal: Principal, sheet: KpiSheet) -> bool:
    """The caller reads this sheet only as its employee (no org access to it)."""
    return not _allows(principal, Permission.ORG_READ, sheet)


def is_own(principal: Principal, sheet: KpiSheet) -> bool:
    """The sheet belongs to the caller's own employee record."""
    return (principal.employee_id is not None
            and sheet.assignment.employee_id == principal.employee_id)


def get_view(db: Session, principal: Principal, sheet_id: int) -> ResultView:
    sheet = get_sheet(db, principal, sheet_id)
    if self_only(principal, sheet):
        # The employee sees the published version only, never work in progress.
        result = published_result(db, sheet.id)
        return ResultView(sheet, result, False, None, None)
    result = result_for(db, sheet.id)
    overrides = _overrides(db, [result.id]).get(result.id, []) if result else []
    return _view(sheet, result, _values(db, [sheet.id]).get(sheet.id, {}), overrides)


def list_views(db: Session, principal: Principal, quarter_id: int, *, plant_id: int | None = None,
               department_id: int | None = None, search: str | None = None) -> list[ResultView]:
    quarter = get_quarter(db, quarter_id)
    stmt = (_sheet_query().join(KpiSheet.assignment).join(EmployeeAssignment.plant_department)
            .join(EmployeeAssignment.employee)
            .where(KpiSheet.cycle_quarter_id == quarter.id, KpiSheet.status.in_(SCORABLE),
                   principal.org_scope.unit_condition())
            .order_by(Employee.employee_code, KpiSheet.id))
    if plant_id is not None:
        stmt = stmt.where(PlantDepartment.plant_id == plant_id)
    if department_id is not None:
        stmt = stmt.where(PlantDepartment.department_id == department_id)
    term = (search or "").strip()
    if term:
        like = f"%{term.replace('%', r'\%').replace('_', r'\_')}%"
        stmt = stmt.where(or_(Employee.employee_code.like(like), Employee.full_name.like(like)))
    sheets = db.scalars(stmt).unique().all()
    values = _values(db, [s.id for s in sheets])
    results = latest_results(db, [s.id for s in sheets])
    overrides = _overrides(db, [r.id for r in results.values()])
    return [_view(s, results.get(s.id), values.get(s.id, {}),
                  overrides.get(results[s.id].id, []) if s.id in results else [])
            for s in sheets]


def quarter_views(db: Session, quarter_id: int, employee_id: int | None = None) -> list[ResultView]:
    """Every locked sheet of a quarter with its result, company-wide (for the
    quarter's gates and consolidation; callers filter by access)."""
    stmt = (_sheet_query().join(KpiSheet.assignment)
            .where(KpiSheet.cycle_quarter_id == quarter_id,
                   KpiSheet.status == KpiSheetStatus.LOCKED)
            .order_by(KpiSheet.id))
    if employee_id is not None:
        stmt = stmt.where(EmployeeAssignment.employee_id == employee_id)
    sheets = db.scalars(stmt).unique().all()
    values = _values(db, [s.id for s in sheets])
    results = latest_results(db, [s.id for s in sheets])
    overrides = _overrides(db, [r.id for r in results.values()])
    return [_view(s, results.get(s.id), values.get(s.id, {}),
                  overrides.get(results[s.id].id, []) if s.id in results else [])
            for s in sheets]


# --- review and publication ------------------------------------------------------------------

def _ready_view(db: Session, principal: Principal, sheet_id: int, permission: Permission,
                action: str) -> ResultView:
    view = get_view(db, principal, sheet_id)
    if not _allows(principal, permission, view.sheet):
        raise PermissionDeniedError(f"You cannot {action} scores for this plant and department.")
    if view.result is None:
        raise ConflictError("Calculate the score first.")
    require_review(view.sheet.quarter, phase_of(db, view.sheet, view.result))
    if view.sheet.status != KpiSheetStatus.LOCKED:
        raise ConflictError("Scores can be reviewed and published only after quarterly scoring "
                            "has started (the sheet is locked).")
    if view.stale:
        raise ConflictError("The data changed after the score was calculated; recalculate it "
                            "first.")
    if not view.result.is_complete:
        raise ConflictError("The score is incomplete: every KPI needs a value for every month.")
    if view.pending_override is not None:
        raise ConflictError("A score override is awaiting approval.")
    return view


def _audit(db: Session, actor: AuditActor, sheet: KpiSheet, action: str, summary: str, *,
           changes: dict[str, Any] | None = None, reason: str | None = None) -> None:
    unit = _unit(sheet)
    record_event(db, actor=actor, action=action, entity_type="kpi_sheet", entity_id=sheet.id,
                 summary=summary, changes=changes, reason=reason, plant_id=unit.plant_id,
                 department_id=unit.department_id)


def review(db: Session, principal: Principal, actor: AuditActor, sheet_id: int) -> ResultView:
    view = _ready_view(db, principal, sheet_id, Permission.KPI_WRITE, "review")
    if is_own(principal, view.sheet):
        raise PermissionDeniedError("Your own score is reviewed by someone else with authority "
                                    "over the department.")
    if view.result.status != ScoreResultStatus.CALCULATED:
        raise ConflictError("Only a calculated score can be marked as reviewed.")
    view.result.status = ScoreResultStatus.REVIEWED
    view.result.reviewed_by_user_id = principal.user_id
    view.result.reviewed_at = func.now()
    db.flush()
    _audit(db, actor, view.sheet, "kpi_result.review",
           f"Reviewed the {view.sheet.quarter.name} score of "
           f"{view.sheet.assignment.employee.employee_code}",
           changes={"final_score": view.result.final_score,
                    "override_score": view.result.override_score})
    return get_view(db, principal, sheet_id)


def publish(db: Session, principal: Principal, actor: AuditActor, sheet_id: int) -> ResultView:
    """Retired in Stage L: a score is published only with its whole quarter,
    after department review and normalization."""
    get_view(db, principal, sheet_id)  # 404 outside the caller's access
    raise ConflictError("Scores are published for the whole quarter, after department review "
                        "and normalization; use the quarterly overview.")


def publish_result(principal: Principal, result: KpiSheetResult) -> None:
    """One result, as part of the quarter's publication (quarterly.publish) or
    of a corrected version's (corrections.publish)."""
    result.published_score = (result.override_score if result.override_score is not None
                              else result.final_score)
    result.status = ScoreResultStatus.PUBLISHED
    result.published_by_user_id = principal.user_id
    result.published_at = func.now()


# --- overrides -------------------------------------------------------------------------------

def _override_query():
    return select(KpiScoreOverride).options(joinedload(KpiScoreOverride.result))


def get_override(db: Session, principal: Principal, override_id: int) -> tuple[KpiScoreOverride, KpiSheet]:
    override = db.scalars(_override_query().where(KpiScoreOverride.id == override_id)).one_or_none()
    if override is None:
        raise NotFoundError("Score override", override_id)
    sheet = db.scalars(_sheet_query().where(KpiSheet.id == override.result.sheet_id)).unique().one()
    if not _allows(principal, Permission.ORG_READ, sheet):
        raise NotFoundError("Score override", override_id)
    return override, sheet


def list_overrides(db: Session, principal: Principal, *,
                   status: ScoreOverrideStatus | None = None) -> list[tuple[KpiScoreOverride, KpiSheet]]:
    stmt = _override_query().order_by(KpiScoreOverride.id.desc())
    if status is not None:
        stmt = stmt.where(KpiScoreOverride.status == status)
    pairs = []
    for override in db.scalars(stmt).all():
        sheet = db.scalars(_sheet_query().where(KpiSheet.id == override.result.sheet_id)).unique().one()
        if _allows(principal, Permission.ORG_READ, sheet):
            pairs.append((override, sheet))
    return pairs


def request_override(db: Session, principal: Principal, actor: AuditActor, sheet_id: int, *,
                     proposed_score: Decimal, reason: str) -> KpiScoreOverride:
    view = get_view(db, principal, sheet_id)
    if not _allows(principal, Permission.KPI_WRITE, view.sheet):
        raise PermissionDeniedError("You cannot request score overrides for this plant and "
                                    "department.")
    result = view.result
    require_review(view.sheet.quarter, phase_of(db, view.sheet, result))
    if result is None or result.status == ScoreResultStatus.PUBLISHED:
        raise ConflictError("Only a calculated, unpublished score can be overridden.")
    if view.stale or not result.is_complete:
        raise ConflictError("Recalculate a complete score before requesting an override.")
    if view.pending_override is not None:
        raise ConflictError("An override for this score is already awaiting approval.")
    if len(reason.strip()) < 10:
        raise ValidationFailedError([Issue("Explain the override (at least 10 characters).",
                                           "reason")])
    if not Decimal(0) <= proposed_score <= Decimal(5) or proposed_score != proposed_score.quantize(CENT):
        raise ValidationFailedError([Issue("The score must be between 0 and 5, with at most two "
                                           "decimals.", "proposed_score")])
    override = KpiScoreOverride(result_id=result.id, original_score=result.final_score,
                                proposed_score=proposed_score, reason=reason.strip()[:1000],
                                requested_by_user_id=principal.user_id)
    db.add(override)
    db.flush()
    if result.status == ScoreResultStatus.REVIEWED:  # the reviewed score is changing
        result.status = ScoreResultStatus.CALCULATED
        result.reviewed_by_user_id = None
        result.reviewed_at = None
    _audit(db, actor, view.sheet, "kpi_override.request",
           f"Requested a score override for {view.sheet.assignment.employee.employee_code} "
           f"({view.sheet.quarter.name})", reason=override.reason,
           changes={"override_id": override.id, "original": result.final_score,
                    "proposed": proposed_score})
    return override


SIDES = {
    "HR_HEAD": (Permission.DEVIATION_APPROVE_HR, "hr_approved_by_user_id", "hr_approved_at"),
    "PLANT_HEAD": (Permission.DEVIATION_APPROVE_PLANT, "plant_approved_by_user_id",
                   "plant_approved_at"),
}


def approve_override(db: Session, principal: Principal, actor: AuditActor, override_id: int,
                     side: str) -> KpiScoreOverride:
    override, sheet = get_override(db, principal, override_id)
    if side not in SIDES:
        raise ValidationFailedError([Issue("Approve as HR_HEAD or PLANT_HEAD.", "as")])
    permission, by_field, at_field = SIDES[side]
    if not _allows(principal, permission, sheet):
        raise PermissionDeniedError(f"You cannot approve as {side.replace('_', ' ').title()} for "
                                    "this plant.")
    if override.status != ScoreOverrideStatus.PENDING:
        raise ConflictError("This override is no longer awaiting approval.")
    require_review(sheet.quarter, phase_of(db, sheet, override.result))
    if principal.user_id == override.requested_by_user_id:
        raise PermissionDeniedError("The requester cannot approve their own override.")
    other = "plant_approved_by_user_id" if side == "HR_HEAD" else "hr_approved_by_user_id"
    if getattr(override, by_field) is not None:
        raise ConflictError("This approval has already been given.")
    if getattr(override, other) == principal.user_id:
        raise PermissionDeniedError("The two approvals must come from two different people.")
    setattr(override, by_field, principal.user_id)
    setattr(override, at_field, func.now())
    db.flush()
    _audit(db, actor, sheet, "kpi_override.approve",
           f"Approved score override {override.id} as {side.replace('_', ' ').title()}",
           changes={"override_id": override.id, "side": side})
    if override.hr_approved_by_user_id and override.plant_approved_by_user_id:
        result = override.result
        result.override_score = override.proposed_score
        override.status = ScoreOverrideStatus.APPLIED
        override.applied_at = func.now()
        db.flush()
        db.refresh(override)
        _audit(db, actor, sheet, "kpi_override.apply",
               f"Applied score override {override.id} for "
               f"{sheet.assignment.employee.employee_code} ({sheet.quarter.name})",
               reason=override.reason,
               changes={"override_id": override.id, "original": override.original_score,
                        "revised": override.proposed_score,
                        "requested_by_user_id": override.requested_by_user_id,
                        "hr_approved_by_user_id": override.hr_approved_by_user_id,
                        "hr_approved_at": override.hr_approved_at,
                        "plant_approved_by_user_id": override.plant_approved_by_user_id,
                        "plant_approved_at": override.plant_approved_at})
    return override


def reject_override(db: Session, principal: Principal, actor: AuditActor, override_id: int,
                    reason: str) -> KpiScoreOverride:
    override, sheet = get_override(db, principal, override_id)
    if not any(_allows(principal, p, sheet) for p, _b, _a in SIDES.values()):
        raise PermissionDeniedError("Only an HR Head or Plant Head for this plant can reject.")
    if override.status != ScoreOverrideStatus.PENDING:
        raise ConflictError("This override is no longer awaiting approval.")
    require_review(sheet.quarter, phase_of(db, sheet, override.result))
    if principal.user_id == override.requested_by_user_id:
        raise PermissionDeniedError("The requester cannot decide their own override.")
    if not reason.strip():
        raise ValidationFailedError([Issue("Give a reason for rejecting.", "reason")])
    override.status = ScoreOverrideStatus.REJECTED
    override.rejected_by_user_id = principal.user_id
    override.rejected_at = func.now()
    override.rejection_reason = reason.strip()[:1000]
    db.flush()
    _audit(db, actor, sheet, "kpi_override.reject", f"Rejected score override {override.id}",
           reason=override.rejection_reason, changes={"override_id": override.id})
    return override
