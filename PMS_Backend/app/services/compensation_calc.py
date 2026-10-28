"""Explainable increment proposals for one employee (Stage N).

Chain (business decision, 2026-10-27):

  1. The employee's APPROVED annual result (annual_results, PUBLISHED) gives
     the annual final score. A result flagged for recalculation (a source
     quarter is being corrected) is not used.
  2. The KRA performance matrix (weighted_score -> rating) maps the annual
     score to a 1-5 rating.
  3. Compa-ratio = current salary / reference salary from the cycle's salary
     baseline, rounded half-up to 4 decimals (a ratio: 1.0000 = at the
     reference). The reference is whatever the cycle names (for example the
     salary-range midpoint); the formula is configuration, not policy.
  4. The increment matrix gives the base increment % (output
     increment_percent) from the rating, compa-ratio and any other input it
     declares (grade, annual_score).
  5. With the IMPACT_MULTIPLIER method, a CR-impact matrix gives the output
     increment_multiplier, applied to the base increment. With MATRIX_INPUT,
     compa-ratio acts only inside the increment matrix.
  6. Final increment % = base x multiplier, rounded half-up to 2 decimals.
     Increment amount = current salary x final % / 100, rounded half-up to
     the currency's 2 decimals (the unrounded amount is kept for
     reconciliation). New salary = current salary + increment amount.

Matrices are the PUBLISHED versions in force on the cycle's effective date
for the employee's attribution unit, unless a version is chosen explicitly
for analysis. Every step's inputs, matched rule and outputs are kept in the
trace. An employee who can't be calculated is EXCLUDED with a code and a
reason, never dropped or counted as zero.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy.orm import Session

from app.models import (
    AnnualResult,
    BudgetLineStatus,
    CompaRatioMethod,
    CompensationBaselineRow,
    MatrixVersion,
    MatrixVersionStatus,
)
from app.services import matrix_service
from app.services import matrix_rules as rules
from app.services.errors import ConflictError

KRA, INCREMENT, CR_IMPACT = "KRA_PERFORMANCE", "INCREMENT", "CR_IMPACT"
TYPES = (KRA, INCREMENT, CR_IMPACT)
TYPE_LABELS = {KRA: "KRA performance matrix", INCREMENT: "increment matrix",
               CR_IMPACT: "compa-ratio impact matrix"}
CENT = Decimal("0.01")
RATIO = Decimal("0.0001")
HUNDRED = Decimal(100)
MULTIPLIER_OUTPUT = "increment_multiplier"


class Excluded(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def ref(version: MatrixVersion) -> dict[str, Any]:
    return {"version_id": version.id, "matrix_id": version.matrix_id, "code": version.matrix.code,
            "name": version.matrix.name, "version_no": version.version_no,
            "status": version.status.value, "content_sha256": version.definition_hash}


@dataclass
class Resolver:
    """Matrix versions per type and unit, resolved once per scenario."""

    db: Session
    on: Any  # date
    overrides: dict[str, MatrixVersion] = field(default_factory=dict)
    _cache: dict[tuple[str, int | None, int | None], Any] = field(default_factory=dict)
    _definitions: dict[int, rules.Definition] = field(default_factory=dict)

    def get(self, matrix_type: str, plant_id: int | None,
            department_id: int | None) -> tuple[MatrixVersion, rules.Definition]:
        if matrix_type in self.overrides:
            version = self.overrides[matrix_type]
        else:
            key = (matrix_type, plant_id, department_id)
            if key not in self._cache:
                try:
                    self._cache[key] = matrix_service.resolve_by_type(
                        self.db, matrix_type, self.on, plant_id, department_id)
                except ConflictError as exc:
                    self._cache[key] = exc
            found = self._cache[key]
            if isinstance(found, ConflictError):
                raise Excluded("MATRIX_CONFLICT", str(found))
            if found is None:
                raise Excluded(f"NO_{matrix_type}",
                               f"No approved {TYPE_LABELS[matrix_type]} applies to the employee's "
                               f"unit on {self.on.isoformat()}.")
            version = found
        if version.id not in self._definitions:
            try:
                self._definitions[version.id] = matrix_service.frozen_definition(version)
            except (matrix_service.IntegrityProblem, rules.EvaluationError) as exc:
                raise Excluded("MATRIX_UNREADABLE", f"{version.matrix.code} v{version.version_no}: "
                                                    f"{exc}") from None
        return version, self._definitions[version.id]


@dataclass
class Proposal:
    employee_id: int
    status: BudgetLineStatus = BudgetLineStatus.EXCLUDED
    code: str | None = None
    reason: str | None = None
    plant_id: int | None = None
    department_id: int | None = None
    annual: AnnualResult | None = None
    row: CompensationBaselineRow | None = None
    compa_ratio: Decimal | None = None
    rating: int | None = None
    base_percent: Decimal | None = None
    multiplier: Decimal | None = None
    percent: Decimal | None = None
    amount: Decimal | None = None
    amount_exact: Decimal | None = None
    new_salary: Decimal | None = None
    versions: dict[str, MatrixVersion] = field(default_factory=dict)
    trace: dict[str, Any] = field(default_factory=dict)

    def exclude(self, code: str, reason: str) -> Proposal:
        self.status = BudgetLineStatus.EXCLUDED
        self.code, self.reason = code, reason
        self.trace["excluded"] = {"code": code, "reason": reason}
        return self


def _step(resolver: Resolver, matrix_type: str, p: Proposal,
          available: dict[str, Any]) -> rules.Evaluation:
    version, definition = resolver.get(matrix_type, p.plant_id, p.department_id)
    p.versions[matrix_type] = version
    inputs = {f.key: available[f.key] for f in definition.inputs
              if available.get(f.key) is not None}
    missing = [f.label for f in definition.inputs if f.required and f.key not in inputs]
    if missing:
        raise Excluded("MATRIX_INPUT_MISSING",
                       f"{version.matrix.code} v{version.version_no} needs "
                       f"{', '.join(missing)}, which is not available for this employee.")
    try:
        evaluation = rules.evaluate(definition, inputs)
    except rules.EvaluationError as exc:
        raise Excluded("MATRIX_NO_RESULT",
                       f"{version.matrix.code} v{version.version_no}: {exc}") from None
    p.trace.setdefault("steps", []).append(
        {"type": matrix_type, "matrix": ref(version), **evaluation.as_dict(definition)})
    return evaluation


def _decimal(value: Any, label: str, version: MatrixVersion) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError):
        raise Excluded("MATRIX_NO_RESULT", f"{version.matrix.code} v{version.version_no} gave no "
                                           f"numeric {label}.") from None


def propose(resolver: Resolver, method: CompaRatioMethod, employee_id: int,
            annual: AnnualResult | None, row: CompensationBaselineRow | None,
            pms_cycle_name: str, home: tuple[int, int] | None = None) -> Proposal:
    """One employee's proposal, or the reason they are excluded. `home` is the
    primary unit of an employee without an annual result (attribution only)."""
    p = Proposal(employee_id, annual=annual, row=row)
    if annual is not None:
        p.plant_id, p.department_id = annual.plant_id, annual.department_id
        p.trace["annual"] = {"annual_result_id": annual.id, "version_no": annual.version_no,
                             "final_score": rules.decimal_text(annual.final_score),
                             "calculated_score": rules.decimal_text(annual.calculated_score),
                             "adjusted_score": rules.jsonable(annual.adjusted_score)}
    elif home is not None:
        p.plant_id, p.department_id = home
    if row is not None:
        p.trace["baseline"] = {"row": row.source_row, "grade": row.grade, "eligible": row.eligible,
                               "current_salary": rules.jsonable(row.current_salary),
                               "reference_salary": rules.jsonable(row.reference_salary)}
    # An explicit eligibility decision (with its reason) outranks missing performance data.
    if row is not None and not row.eligible:
        return p.exclude("NOT_ELIGIBLE", row.exclusion_reason or "Marked not eligible in the "
                                                                "salary baseline.")
    if annual is None:
        return p.exclude("NO_ANNUAL_RESULT", f"No approved annual result in {pms_cycle_name}.")
    if annual.recalculation_required:
        return p.exclude("ANNUAL_UNDER_RECALCULATION",
                         "The approved annual result is being recalculated after a quarter "
                         "correction; it is not used until approved again.")
    if row is None:
        return p.exclude("NOT_IN_BASELINE", "Not in the salary baseline of this cycle.")
    if row.current_salary is None:
        return p.exclude("NO_SALARY", "The salary baseline has no current salary.")
    salary = row.current_salary
    if row.reference_salary is not None:
        exact_cr = salary / row.reference_salary
        p.compa_ratio = exact_cr.quantize(RATIO, rounding=ROUND_HALF_UP)
        p.trace["compa_ratio"] = {"current_salary": rules.jsonable(salary),
                                  "reference_salary": rules.jsonable(row.reference_salary),
                                  "exact": rules.decimal_text(exact_cr.quantize(Decimal("1E-12"))),
                                  "rounded": rules.decimal_text(p.compa_ratio),
                                  "rounding": "half up to 4 decimals"}
    available: dict[str, Any] = {"weighted_score": annual.final_score,
                                 "annual_score": annual.final_score,
                                 "compa_ratio": p.compa_ratio, "grade": row.grade}
    try:
        kra = _step(resolver, KRA, p, available)
        rating = kra.outputs.get("rating")
        if rating is None:
            raise Excluded("MATRIX_NO_RESULT", "The KRA performance matrix gave no rating.")
        p.rating = int(rating)
        available["performance_rating"] = p.rating
        increment = _step(resolver, INCREMENT, p, available)
        version = p.versions[INCREMENT]
        if increment.outputs.get("increment_percent") is None:
            raise Excluded("MATRIX_NO_RESULT", f"{version.matrix.code} v{version.version_no} gave "
                                               "no increment %.")
        p.base_percent = _decimal(increment.outputs["increment_percent"], "increment %", version)
        p.multiplier = Decimal(1)
        if method == CompaRatioMethod.IMPACT_MULTIPLIER:
            impact = _step(resolver, CR_IMPACT, p, available)
            cr_version = p.versions[CR_IMPACT]
            if impact.outputs.get(MULTIPLIER_OUTPUT) is None:
                raise Excluded("NO_MULTIPLIER_OUTPUT",
                               f"{cr_version.matrix.code} v{cr_version.version_no} has no "
                               f"'{MULTIPLIER_OUTPUT}' output, which this cycle's compa-ratio "
                               "method needs.")
            p.multiplier = _decimal(impact.outputs[MULTIPLIER_OUTPUT], "multiplier", cr_version)
    except Excluded as exc:
        return p.exclude(exc.code, exc.message)
    p.percent = (p.base_percent * p.multiplier).quantize(CENT, rounding=ROUND_HALF_UP)
    p.amount_exact = salary * p.percent / HUNDRED
    p.amount = p.amount_exact.quantize(CENT, rounding=ROUND_HALF_UP)
    p.new_salary = salary + p.amount
    p.status = BudgetLineStatus.INCLUDED
    p.trace["result"] = {
        "method": method.value, "base_increment_percent": rules.decimal_text(p.base_percent),
        "multiplier": rules.decimal_text(p.multiplier),
        "increment_percent": rules.decimal_text(p.percent),
        "increment_amount_exact": rules.decimal_text(p.amount_exact),
        "increment_amount": rules.decimal_text(p.amount),
        "new_salary": rules.decimal_text(p.new_salary),
        "rounding": "increment % half up to 2 decimals; amount half up to 2 decimals",
    }
    return p


def is_approved(version: MatrixVersion) -> bool:
    return version.status == MatrixVersionStatus.PUBLISHED
