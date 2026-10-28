"""Compensation cycles, salary baselines, budget scenarios and budget decisions (Stage N).

Roles (business decision, 2026-10-27):
  * HR Head (compensation:manage, GLOBAL) sets up a cycle, imports the salary
    baseline, calculates scenarios and submits one;
  * the budget owner (budget:record, GLOBAL) records the company-approved
    budget amount, each revision with a reason;
  * the CHRO (budget:approve, GLOBAL) approves or rejects a submitted scenario
    against the current approved budget. The CHRO may not be the person who
    recorded that budget decision, nor who prepared or submitted the scenario.
  * Admin, CHRO and HR Head read employee-level compensation
    (compensation:read); budget owners read totals and breakdowns only
    (budget:read).

The budget does not change anyone's increment: the variance between the
calculated requirement and the approved budget is reported (unallocated
balance or overspend), and a different outcome needs a revised matrix
version and a new scenario. Scenarios are frozen when calculated; analysis
scenarios that use explicitly chosen (possibly unapproved) matrix versions
can never be submitted.

Salary amounts are never written to the audit trail: imports record counts
and the file's SHA-256, scenarios record aggregate totals.
"""
from __future__ import annotations

import hashlib
import io
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.auth.permissions import Permission, Principal
from app.models import (
    AnnualResult,
    AnnualResultStatus,
    BudgetDecision,
    BudgetDecisionStatus,
    BudgetLineStatus,
    BudgetScenario,
    BudgetScenarioLine,
    BudgetScenarioStatus,
    CompaRatioMethod,
    CompensationBaseline,
    CompensationBaselineRow,
    CompensationCycle,
    CompensationCycleStatus,
    Employee,
    Matrix,
    MatrixVersion,
    MatrixVersionStatus,
    PmsCycle,
)
from app.services import compensation_calc as calc
from app.services import kpi_data, matrix_service
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
HUNDRED = Decimal(100)
MAX_SALARY = Decimal("1e12")
OPEN_SCENARIOS = (BudgetScenarioStatus.CALCULATED, BudgetScenarioStatus.SUBMITTED)


def _require(principal: Principal, permission: Permission, message: str, *,
             global_scope: bool = True) -> None:
    scope = principal.scope_for(permission)
    if scope.is_empty or (global_scope and not scope.is_global):
        raise PermissionDeniedError(message)


def can_read_budget(principal: Principal) -> bool:
    return not principal.scope_for(Permission.BUDGET_READ).is_empty


def sees_company_totals(principal: Principal) -> bool:
    return principal.scope_for(Permission.BUDGET_READ).is_global


def _require_read(principal: Principal) -> None:
    if not can_read_budget(principal):
        raise PermissionDeniedError("You do not have access to compensation and budget data.")


def _audit(db: Session, actor: AuditActor, entity: tuple[str, int], action: str, summary: str, *,
           reason: str | None = None, changes: dict[str, Any] | None = None) -> None:
    record_event(db, actor=actor, action=action, entity_type=entity[0], entity_id=entity[1],
                 summary=summary, reason=reason, changes=changes)


# --- cycles ----------------------------------------------------------------------------------

@dataclass
class CycleInput:
    code: str
    name: str
    pms_cycle_id: int
    currency: str
    effective_date: date
    cr_method: CompaRatioMethod
    reference_label: str
    notes: str | None


def _validate_cycle(db: Session, data: CycleInput) -> list[Issue]:
    issues = []
    if not (1 <= len(data.code.strip()) <= 20):
        issues.append(Issue("Give the cycle a code of at most 20 characters.", "code"))
    if not data.name.strip():
        issues.append(Issue("Give the cycle a name.", "name"))
    if db.get(PmsCycle, data.pms_cycle_id) is None:
        issues.append(Issue("Choose the PMS cycle whose approved annual results are used.",
                            "pms_cycle_id"))
    if not (len(data.currency) == 3 and data.currency.isalpha() and data.currency.isupper()):
        issues.append(Issue("Give the currency as a three-letter ISO code, e.g. INR.", "currency"))
    if not data.reference_label.strip():
        issues.append(Issue("Name what the compa-ratio is measured against, e.g. the "
                            "salary-range midpoint.", "reference_label"))
    return issues


def create_cycle(db: Session, principal: Principal, actor: AuditActor,
                 data: CycleInput) -> CompensationCycle:
    _require(principal, Permission.COMPENSATION_MANAGE,
             "Compensation cycles are set up by an HR Head with company-wide authority.")
    issues = _validate_cycle(db, data)
    if db.scalar(select(CompensationCycle.id).where(CompensationCycle.code == data.code.strip())):
        issues.append(Issue("A compensation cycle with this code already exists.", "code"))
    if issues:
        raise ValidationFailedError(issues)
    cycle = CompensationCycle(code=data.code.strip(), name=data.name.strip(),
                              pms_cycle_id=data.pms_cycle_id, currency=data.currency,
                              effective_date=data.effective_date, cr_method=data.cr_method,
                              reference_label=data.reference_label.strip(),
                              notes=(data.notes or "").strip() or None,
                              created_by_user_id=principal.user_id)
    db.add(cycle)
    db.flush()
    _audit(db, actor, ("compensation_cycle", cycle.id), "compensation_cycle.create",
           f"Created compensation cycle {cycle.code}", changes=_cycle_fields(cycle))
    return cycle


def _cycle_fields(cycle: CompensationCycle) -> dict[str, Any]:
    return {"code": cycle.code, "name": cycle.name, "pms_cycle_id": cycle.pms_cycle_id,
            "currency": cycle.currency, "effective_date": cycle.effective_date,
            "cr_method": cycle.cr_method.value, "reference_label": cycle.reference_label}


def _locked_cycle(db: Session, cycle_id: int) -> CompensationCycle:
    cycle = db.scalars(select(CompensationCycle).where(CompensationCycle.id == cycle_id)
                       .with_for_update()).one_or_none()
    if cycle is None:
        raise NotFoundError("Compensation cycle", cycle_id)
    return cycle


def _require_open(cycle: CompensationCycle) -> None:
    if cycle.status != CompensationCycleStatus.OPEN:
        raise ConflictError(f"{cycle.name} is finalized; its budget and scenarios no longer "
                            "change.")


def update_cycle(db: Session, principal: Principal, actor: AuditActor, cycle_id: int,
                 data: CycleInput) -> CompensationCycle:
    _require(principal, Permission.COMPENSATION_MANAGE,
             "Compensation cycles are set up by an HR Head with company-wide authority.")
    cycle = _locked_cycle(db, cycle_id)
    _require_open(cycle)
    if db.scalar(select(func.count()).select_from(BudgetScenario).where(
            BudgetScenario.cycle_id == cycle.id,
            BudgetScenario.status == BudgetScenarioStatus.SUBMITTED)):
        raise ConflictError("A scenario awaits the CHRO's decision; the cycle can't change now.")
    issues = _validate_cycle(db, data)
    if data.code.strip() != cycle.code:
        issues.append(Issue("The code of a cycle can't change.", "code"))
    if issues:
        raise ValidationFailedError(issues)
    before = _cycle_fields(cycle)
    cycle.name, cycle.pms_cycle_id, cycle.currency = (data.name.strip(), data.pms_cycle_id,
                                                      data.currency)
    cycle.effective_date, cycle.cr_method = data.effective_date, data.cr_method
    cycle.reference_label = data.reference_label.strip()
    cycle.notes = (data.notes or "").strip() or None
    db.flush()
    after = _cycle_fields(cycle)
    _audit(db, actor, ("compensation_cycle", cycle.id), "compensation_cycle.update",
           f"Changed compensation cycle {cycle.code}",
           changes={k: {"from": before[k], "to": after[k]} for k in after if before[k] != after[k]})
    return cycle


def get_cycle(db: Session, principal: Principal, cycle_id: int) -> CompensationCycle:
    _require_read(principal)
    cycle = db.scalars(select(CompensationCycle).where(CompensationCycle.id == cycle_id)
                       .options(joinedload(CompensationCycle.pms_cycle))).unique().one_or_none()
    if cycle is None:
        raise NotFoundError("Compensation cycle", cycle_id)
    return cycle


def list_cycles(db: Session, principal: Principal) -> list[CompensationCycle]:
    _require_read(principal)
    return list(db.scalars(select(CompensationCycle)
                           .options(joinedload(CompensationCycle.pms_cycle))
                           .order_by(CompensationCycle.id.desc())).unique().all())


def policy_status(db: Session, cycle: CompensationCycle) -> list[dict[str, Any]]:
    """Which approved matrix versions are in force on the cycle's date (anywhere)."""
    needed = [calc.KRA, calc.INCREMENT] + (
        [calc.CR_IMPACT] if cycle.cr_method == CompaRatioMethod.IMPACT_MULTIPLIER else [])
    found = []
    for matrix_type in needed:
        versions = [v for v in db.scalars(
            select(MatrixVersion).join(Matrix)
            .where(Matrix.matrix_type == matrix_type, Matrix.is_active,
                   MatrixVersion.status == MatrixVersionStatus.PUBLISHED)
            .options(selectinload(MatrixVersion.matrix))).all()
            if matrix_service.in_force(v, cycle.effective_date)]
        found.append({"type": matrix_type, "label": calc.TYPE_LABELS[matrix_type],
                      "versions": [calc.ref(v) for v in versions],
                      "status": "APPROVED" if versions else "AWAITING_CONFIGURATION"})
    return found


# --- salary baselines -----------------------------------------------------------------------

COLUMNS: dict[str, tuple[str, bool, tuple[str, ...]]] = {
    "employee_code": ("Employee Code", True, ("employeecode", "empcode", "employeeid")),
    "current_salary": ("Current Salary", False, ("currentsalary", "currentannualsalary",
                                                 "annualsalary", "currentctc", "ctc")),
    "reference_salary": ("Reference Salary", False, ("referencesalary", "marketsalary",
                                                     "rangemidpoint", "midpoint")),
    "grade": ("Grade", False, ("grade", "level", "band")),
    "eligible": ("Eligible", False, ("eligible", "iseligible")),
    "exclusion_reason": ("Exclusion Reason", False, ("exclusionreason", "reason")),
}
TRUE = {"yes", "y", "true", "1"}
FALSE = {"no", "n", "false", "0"}


@dataclass
class BaselineLine:
    row: int
    employee: Employee
    current_salary: Decimal | None
    reference_salary: Decimal | None
    grade: str | None
    eligible: bool
    exclusion_reason: str | None


@dataclass
class BaselineCheck:
    file_name: str
    file_format: str
    sha256: str
    size: int
    lines: list[BaselineLine]
    issues: list[Issue]
    warnings: list[str]

    @property
    def ready(self) -> bool:
        return not self.issues and bool(self.lines)


def _money(raw: Any, label: str) -> Decimal:
    number = rules.parse_decimal(raw)
    if number <= 0:
        raise ValueError(f"{label} must be above 0.")
    if number >= MAX_SALARY:
        raise ValueError(f"{label} is too large.")
    if number != number.quantize(CENT):
        raise ValueError(f"{label} may have at most two decimals.")
    return number


def _annual_employees(db: Session, cycle: CompensationCycle) -> dict[int, AnnualResult]:
    return {r.employee_id: r for r in db.scalars(select(AnnualResult).where(
        AnnualResult.cycle_id == cycle.pms_cycle_id,
        AnnualResult.status == AnnualResultStatus.PUBLISHED))}


def check_baseline(db: Session, principal: Principal, cycle_id: int, file_name: str,
                   data: bytes) -> BaselineCheck:
    """Validate a salary baseline file; nothing is saved."""
    _require(principal, Permission.COMPENSATION_MANAGE,
             "Salary baselines are imported by an HR Head with company-wide authority.")
    cycle = get_cycle(db, principal, cycle_id)
    _require_open(cycle)
    table = kpi_data.read_table(file_name, data)
    by_alias = {}
    for key, (label, _required, aliases) in COLUMNS.items():
        for header in table.headers:
            norm = kpi_data._norm_header(header)
            if norm == kpi_data._norm_header(label) or norm in aliases:
                by_alias[key] = header
                break
    issues: list[Issue] = []
    for key, (label, required, _aliases) in COLUMNS.items():
        if required and key not in by_alias:
            issues.append(Issue(f"The file needs a column '{label}'.", key))
    if "current_salary" not in by_alias:
        issues.append(Issue("The file needs a column 'Current Salary'.", "current_salary"))
    if issues:
        raise ValidationFailedError(issues)
    codes = {kpi_data._text(values.get(by_alias["employee_code"])) for _, values in table.rows}
    employees = {e.employee_code.casefold(): e for e in db.scalars(select(Employee).where(
        Employee.employee_code.in_(sorted(c for c in codes if c) or [""])))}
    seen: dict[int, int] = {}
    lines: list[BaselineLine] = []
    for row_no, values in table.rows:
        def get(key: str) -> Any:
            header = by_alias.get(key)
            return values.get(header) if header else None

        def issue(message: str, key: str | None = None) -> None:
            issues.append(Issue(message, key, row_no))

        code = kpi_data._text(get("employee_code"))
        if not code:
            issue("The employee code is missing.", "employee_code")
            continue
        employee = employees.get(code.casefold())
        if employee is None:
            issue(f"Employee {code} is not in the PMS.", "employee_code")
            continue
        if employee.id in seen:
            issue(f"{code} already appears in row {seen[employee.id]}; one row per employee.",
                  "employee_code")
            continue
        seen[employee.id] = row_no
        raw_eligible = kpi_data._text(get("eligible"))
        if raw_eligible is None or raw_eligible.casefold() in TRUE:
            eligible = True
        elif raw_eligible.casefold() in FALSE:
            eligible = False
        else:
            issue(f"{code}: Eligible must be Yes or No.", "eligible")
            continue
        reason = kpi_data._text(get("exclusion_reason"))
        if not eligible and not reason:
            issue(f"{code}: give the reason the employee is not eligible.", "exclusion_reason")
            continue
        if reason and len(reason) > 255:
            issue(f"{code}: the exclusion reason is longer than 255 characters.",
                  "exclusion_reason")
            continue
        current = reference = None
        try:
            if kpi_data._blank(get("current_salary")):
                if eligible:
                    raise ValueError("Current Salary is needed for an eligible employee.")
            else:
                current = _money(get("current_salary"), "Current Salary")
            if not kpi_data._blank(get("reference_salary")):
                reference = _money(get("reference_salary"), "Reference Salary")
        except ValueError as exc:
            issue(f"{code}: {exc}", "current_salary")
            continue
        grade = kpi_data._text(get("grade"))
        if grade and len(grade) > 40:
            issue(f"{code}: the grade is longer than 40 characters.", "grade")
            continue
        lines.append(BaselineLine(row_no, employee, current, reference, grade, eligible,
                                  reason if not eligible else None))
    warnings = []
    annual = _annual_employees(db, cycle)
    missing = [e for e in annual if e not in seen]
    if missing:
        warnings.append(f"{len(missing)} employee(s) with an approved annual result in "
                        f"{cycle.pms_cycle.name} are not in the file; they will be excluded.")
    without = [line for line in lines if line.employee.id not in annual]
    if without:
        warnings.append(f"{len(without)} employee(s) in the file have no approved annual result "
                        f"in {cycle.pms_cycle.name}; they will be excluded.")
    if not table.rows:
        issues.append(Issue("The file has no data rows."))
    return BaselineCheck(file_name, table.file_format, hashlib.sha256(data).hexdigest(), len(data),
                         lines, issues, warnings)


def confirm_baseline(db: Session, principal: Principal, actor: AuditActor, cycle_id: int,
                     file_name: str, data: bytes) -> CompensationBaseline:
    """Re-validate and store every row of the file as a new baseline version, or none."""
    check = check_baseline(db, principal, cycle_id, file_name, data)
    if check.issues:
        raise ValidationFailedError(check.issues[:200])
    cycle = _locked_cycle(db, cycle_id)
    _require_open(cycle)
    number = (db.scalar(select(func.max(CompensationBaseline.version_no)).where(
        CompensationBaseline.cycle_id == cycle.id)) or 0) + 1
    baseline = CompensationBaseline(
        cycle_id=cycle.id, version_no=number, file_name=file_name[:255],
        file_sha256=check.sha256, file_size=check.size, file_format=check.file_format,
        row_count=len(check.lines), imported_by_user_id=principal.user_id,
        rows=[CompensationBaselineRow(employee_id=line.employee.id, source_row=line.row,
                                      current_salary=line.current_salary,
                                      reference_salary=line.reference_salary, grade=line.grade,
                                      eligible=line.eligible,
                                      exclusion_reason=line.exclusion_reason)
              for line in check.lines])
    db.add(baseline)
    db.flush()
    eligible = sum(1 for line in check.lines if line.eligible)
    _audit(db, actor, ("compensation_baseline", baseline.id), "compensation_baseline.import",
           f"Imported salary baseline version {number} of {cycle.code}: {len(check.lines)} "
           "employees", changes={"cycle_id": cycle.id, "version_no": number,
                                 "rows": len(check.lines), "eligible": eligible,
                                 "not_eligible": len(check.lines) - eligible,
                                 "file_name": baseline.file_name,
                                 "file_sha256": check.sha256})
    return baseline


def baselines(db: Session, cycle: CompensationCycle) -> list[CompensationBaseline]:
    return list(db.scalars(select(CompensationBaseline).where(
        CompensationBaseline.cycle_id == cycle.id).order_by(CompensationBaseline.version_no)))


def baseline_rows(db: Session, principal: Principal, cycle_id: int,
                  baseline_id: int) -> tuple[CompensationBaseline, list[CompensationBaselineRow]]:
    _require(principal, Permission.COMPENSATION_READ,
             "Salary baselines are visible only to compensation roles with company-wide access.")
    baseline = db.get(CompensationBaseline, baseline_id)
    if baseline is None or baseline.cycle_id != cycle_id:
        raise NotFoundError("Salary baseline", baseline_id)
    rows = db.scalars(select(CompensationBaselineRow).where(
        CompensationBaselineRow.baseline_id == baseline.id)
        .options(joinedload(CompensationBaselineRow.employee))
        .order_by(CompensationBaselineRow.source_row)).unique().all()
    return baseline, list(rows)


def template(db: Session, principal: Principal, cycle_id: int) -> bytes:
    """A workbook listing employees with an approved annual result, salaries blank."""
    _require(principal, Permission.COMPENSATION_MANAGE,
             "Salary baselines are imported by an HR Head with company-wide authority.")
    cycle = get_cycle(db, principal, cycle_id)
    wb = Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append([label for label, _r, _a in COLUMNS.values()] + ["Employee Name"])
    annual = _annual_employees(db, cycle)
    for e in db.scalars(select(Employee).where(Employee.id.in_(sorted(annual) or [0]))
                        .order_by(Employee.employee_code)):
        ws.append([e.employee_code, None, None, None, "Yes", None, e.full_name])
    notes = wb.create_sheet("Instructions")
    for line in (
            f"Salary baseline for {cycle.name} ({cycle.currency}).",
            "One row per employee. Current Salary: annual, in the cycle's currency, at most two "
            "decimals.",
            f"Reference Salary: the {cycle.reference_label} used for the compa-ratio "
            "(optional; needed when a matrix uses the compa-ratio).",
            "Grade: optional, for matrices that use it. Eligible: Yes or No; give an Exclusion "
            "Reason for No.",
            "Confidential: keep this file out of shared folders and version control."):
        notes.append([line])
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


# --- budget decisions ------------------------------------------------------------------------

def current_decision(db: Session, cycle_id: int) -> BudgetDecision | None:
    return db.scalars(select(BudgetDecision).where(
        BudgetDecision.cycle_id == cycle_id,
        BudgetDecision.status == BudgetDecisionStatus.CURRENT)).one_or_none()


def decisions(db: Session, cycle_id: int) -> list[BudgetDecision]:
    return list(db.scalars(select(BudgetDecision).where(BudgetDecision.cycle_id == cycle_id)
                           .order_by(BudgetDecision.version_no)))


def record_decision(db: Session, principal: Principal, actor: AuditActor, cycle_id: int, *,
                    amount: Decimal, reason: str) -> BudgetDecision:
    _require(principal, Permission.BUDGET_RECORD,
             "The approved budget is recorded by the budget owner with company-wide authority.")
    cycle = _locked_cycle(db, cycle_id)
    _require_open(cycle)
    issues = []
    try:
        ok = Decimal(0) <= amount < Decimal("1e14") and amount == amount.quantize(CENT)
    except InvalidOperation:
        ok = False
    if not ok:
        issues.append(Issue("Enter the approved budget as an amount of 0 or more with at most "
                            "two decimals.", "amount"))
    if len(reason.strip()) < 10:
        issues.append(Issue("Give the reason or source of the budget decision (at least 10 "
                            "characters).", "reason"))
    if issues:
        raise ValidationFailedError(issues)
    previous = current_decision(db, cycle.id)
    if previous is not None:
        previous.status = BudgetDecisionStatus.SUPERSEDED
        db.flush()
    number = (db.scalar(select(func.max(BudgetDecision.version_no)).where(
        BudgetDecision.cycle_id == cycle.id)) or 0) + 1
    decision = BudgetDecision(cycle_id=cycle.id, version_no=number, approved_amount=amount,
                              previous_amount=previous.approved_amount if previous else None,
                              reason=reason.strip()[:1000], recorded_by_user_id=principal.user_id)
    db.add(decision)
    db.flush()
    _audit(db, actor, ("budget_decision", decision.id), "budget_decision.record",
           f"Recorded the approved budget of {cycle.code} (version {number}): "
           f"{cycle.currency} {rules.decimal_text(amount)}", reason=decision.reason,
           changes={"cycle_id": cycle.id, "version_no": number,
                    "previous_amount": decision.previous_amount, "approved_amount": amount})
    return decision


# --- scenarios -------------------------------------------------------------------------------

def _override_versions(db: Session, principal: Principal,
                       overrides: dict[str, int] | None) -> dict[str, MatrixVersion]:
    found: dict[str, MatrixVersion] = {}
    for matrix_type, version_id in (overrides or {}).items():
        if matrix_type not in calc.TYPES:
            raise ValidationFailedError([Issue(f"'{matrix_type}' is not a compensation matrix "
                                               "type.", "overrides")])
        version = db.scalars(select(MatrixVersion).where(MatrixVersion.id == version_id)
                             .options(selectinload(MatrixVersion.matrix))).one_or_none()
        if version is None or version.matrix.matrix_type != matrix_type:
            raise ValidationFailedError([Issue(f"Version {version_id} is not a "
                                               f"{calc.TYPE_LABELS[matrix_type]}.", "overrides")])
        needed = (Permission.MATRIX_READ if matrix_type == calc.KRA
                  else Permission.MATRIX_READ_COMPENSATION)
        if principal.scope_for(needed).is_empty:
            raise NotFoundError("Matrix version", version_id)
        found[matrix_type] = version
    return found


def _proposals(db: Session, cycle: CompensationCycle, baseline: CompensationBaseline,
               resolver: calc.Resolver,
               employee_ids: Sequence[int] | None = None) -> list[calc.Proposal]:
    annual = _annual_employees(db, cycle)
    rows = {r.employee_id: r for r in db.scalars(select(CompensationBaselineRow).where(
        CompensationBaselineRow.baseline_id == baseline.id))}
    population = sorted(set(annual) | set(rows))
    if employee_ids is not None:
        population = [e for e in population if e in set(employee_ids)]
    name = cycle.pms_cycle.name
    return [calc.propose(resolver, cycle.cr_method, e, annual.get(e), rows.get(e), name)
            for e in population]


def summarize(proposals: Sequence[calc.Proposal]) -> dict[str, Any]:
    """Counts, sums, the breakdown by attribution unit and the reconciliation."""
    included = [p for p in proposals if p.status == BudgetLineStatus.INCLUDED]
    excluded = [p for p in proposals if p.status == BudgetLineStatus.EXCLUDED]
    salary = sum((p.row.current_salary for p in included), Decimal(0))
    total = sum((p.amount for p in included), Decimal(0))
    exact = sum((p.amount_exact for p in included), Decimal(0))
    units: dict[tuple[int | None, int | None], dict[str, Any]] = defaultdict(
        lambda: {"included": 0, "excluded": 0, "current_salary": Decimal(0),
                 "increment": Decimal(0)})
    for p in proposals:
        u = units[(p.plant_id, p.department_id)]
        if p.status == BudgetLineStatus.INCLUDED:
            u["included"] += 1
            u["current_salary"] += p.row.current_salary
            u["increment"] += p.amount
        else:
            u["excluded"] += 1
    employees = [p.employee_id for p in proposals]
    return {
        "population": len(proposals), "included": len(included), "excluded": len(excluded),
        "excluded_by_reason": dict(Counter(p.code for p in excluded)),
        "excluded_salary": rules.decimal_text(sum(
            (p.row.current_salary for p in excluded if p.row is not None
             and p.row.current_salary is not None), Decimal(0))),
        "total_current_salary": rules.decimal_text(salary),
        "total_increment": rules.decimal_text(total),
        "total_increment_exact": rules.decimal_text(exact),
        "rounding_difference": rules.decimal_text(total - exact),
        "average_increment_percent": rules.decimal_text(
            (total / salary * HUNDRED).quantize(CENT, rounding=ROUND_HALF_UP)) if salary else None,
        "negative_adjustments": sum(1 for p in included if p.percent < 0),
        "by_unit": [{"plant_id": k[0], "department_id": k[1], "included": v["included"],
                     "excluded": v["excluded"],
                     "current_salary": rules.decimal_text(v["current_salary"]),
                     "increment": rules.decimal_text(v["increment"])}
                    for k, v in sorted(units.items(), key=lambda kv: (kv[0][0] or 0, kv[0][1] or 0))],
        "reconciliation": {
            "lines_total": rules.decimal_text(sum((p.amount for p in included), Decimal(0))),
            "units_total": rules.decimal_text(sum((v["increment"] for v in units.values()),
                                                  Decimal(0))),
            "employees_counted_once": len(employees) == len(set(employees)),
            "every_employee_accounted": len(included) + len(excluded) == len(proposals),
        },
    }


def _versions_used(proposals: Sequence[calc.Proposal]) -> list[dict[str, Any]]:
    seen: dict[int, dict[str, Any]] = {}
    for p in proposals:
        for matrix_type, v in p.versions.items():
            seen.setdefault(v.id, {"type": matrix_type, **calc.ref(v)})
    return sorted(seen.values(), key=lambda r: (r["type"], r["version_id"]))


def _inputs_hash(cycle: CompensationCycle, baseline: CompensationBaseline,
                 proposals: Sequence[calc.Proposal], overrides: dict[str, int]) -> str:
    data = {"cycle": cycle.id, "baseline": baseline.id, "method": cycle.cr_method.value,
            "date": cycle.effective_date.isoformat(), "overrides": overrides,
            "annual": sorted([p.employee_id, p.annual.id, p.annual.version_no,
                              rules.decimal_text(p.annual.final_score)]
                             for p in proposals if p.annual is not None),
            "versions": [[v["version_id"], v["content_sha256"]] for v in _versions_used(proposals)]}
    return hashlib.sha256(rules.canonical_json(data).encode("utf-8")).hexdigest()


def _baseline_for(db: Session, cycle: CompensationCycle,
                  baseline_id: int | None) -> CompensationBaseline:
    if baseline_id is not None:
        baseline = db.get(CompensationBaseline, baseline_id)
        if baseline is None or baseline.cycle_id != cycle.id:
            raise NotFoundError("Salary baseline", baseline_id)
        return baseline
    baseline = db.scalars(select(CompensationBaseline).where(
        CompensationBaseline.cycle_id == cycle.id)
        .order_by(CompensationBaseline.version_no.desc()).limit(1)).first()
    if baseline is None:
        raise ConflictError("Import a salary baseline for this cycle first.")
    return baseline


def calculate(db: Session, principal: Principal, actor: AuditActor, cycle_id: int, *,
              name: str, baseline_id: int | None = None, overrides: dict[str, int] | None = None,
              note: str | None = None) -> BudgetScenario:
    """A new, frozen scenario: every employee of the cycle with their proposal
    or the reason they are excluded."""
    _require(principal, Permission.COMPENSATION_MANAGE,
             "Budget scenarios are calculated by an HR Head with company-wide authority.")
    cycle = _locked_cycle(db, cycle_id)
    _require_open(cycle)
    if not name.strip():
        raise ValidationFailedError([Issue("Name the scenario.", "name")])
    baseline = _baseline_for(db, cycle, baseline_id)
    chosen = _override_versions(db, principal, overrides)
    resolver = calc.Resolver(db, cycle.effective_date, chosen)
    proposals = _proposals(db, cycle, baseline, resolver)
    totals = summarize(proposals)
    number = (db.scalar(select(func.max(BudgetScenario.scenario_no)).where(
        BudgetScenario.cycle_id == cycle.id)) or 0) + 1
    override_ids = {t: v.id for t, v in chosen.items()}
    scenario = BudgetScenario(
        cycle_id=cycle.id, scenario_no=number, name=name.strip()[:100],
        note=(note or "").strip()[:1000] or None, baseline_id=baseline.id,
        cr_method=cycle.cr_method, effective_date=cycle.effective_date, currency=cycle.currency,
        overrides=override_ids or None, analysis_only=bool(chosen),
        matrix_versions=_versions_used(proposals), totals=totals,
        included_count=totals["included"], excluded_count=totals["excluded"],
        total_current_salary=Decimal(totals["total_current_salary"]),
        total_increment=Decimal(totals["total_increment"]),
        total_increment_exact=Decimal(totals["total_increment_exact"]),
        inputs_hash=_inputs_hash(cycle, baseline, proposals, override_ids),
        calculated_by_user_id=principal.user_id,
        lines=[_line(p) for p in proposals])
    db.add(scenario)
    db.flush()
    _audit(db, actor, ("budget_scenario", scenario.id), "budget_scenario.calculate",
           f"Calculated scenario {number} '{scenario.name}' of {cycle.code}: "
           f"{totals['included']} included, {totals['excluded']} excluded",
           changes={"cycle_id": cycle.id, "scenario_no": number, "baseline_id": baseline.id,
                    "analysis_only": scenario.analysis_only, "overrides": override_ids,
                    "matrix_versions": [v["version_id"] for v in scenario.matrix_versions],
                    "included": totals["included"], "excluded": totals["excluded"],
                    "total_increment": totals["total_increment"],
                    "inputs_sha256": scenario.inputs_hash})
    return scenario


def _line(p: calc.Proposal) -> BudgetScenarioLine:
    row = p.row
    return BudgetScenarioLine(
        employee_id=p.employee_id, status=p.status, exclusion_code=p.code,
        exclusion_reason=(p.reason or "")[:500] or None, plant_id=p.plant_id,
        department_id=p.department_id, annual_result_id=p.annual.id if p.annual else None,
        annual_score=p.annual.final_score if p.annual else None,
        baseline_row_id=row.id if row else None,
        current_salary=row.current_salary if row else None,
        reference_salary=row.reference_salary if row else None, compa_ratio=p.compa_ratio,
        performance_rating=p.rating, base_increment_percent=p.base_percent,
        cr_multiplier=p.multiplier if p.status == BudgetLineStatus.INCLUDED else None,
        increment_percent=p.percent, increment_amount=p.amount,
        increment_amount_exact=(p.amount_exact.quantize(Decimal("0.000001"))
                                if p.amount_exact is not None else None),
        new_salary=p.new_salary,
        kra_version_id=p.versions[calc.KRA].id if calc.KRA in p.versions else None,
        increment_version_id=(p.versions[calc.INCREMENT].id if calc.INCREMENT in p.versions
                              else None),
        cr_version_id=p.versions[calc.CR_IMPACT].id if calc.CR_IMPACT in p.versions else None,
        trace=rules.jsonable(p.trace))


def preview(db: Session, principal: Principal, cycle_id: int, employee_id: int, *,
            baseline_id: int | None = None,
            overrides: dict[str, int] | None = None) -> calc.Proposal:
    """One employee's proposal as it would be calculated now; nothing is saved."""
    _require(principal, Permission.COMPENSATION_READ,
             "Compensation previews are for compensation roles with company-wide access.")
    cycle = get_cycle(db, principal, cycle_id)
    baseline = _baseline_for(db, cycle, baseline_id)
    resolver = calc.Resolver(db, cycle.effective_date, _override_versions(db, principal, overrides))
    found = _proposals(db, cycle, baseline, resolver, [employee_id])
    if not found:
        raise NotFoundError("Employee in this cycle", employee_id)
    return found[0]


def get_scenario(db: Session, principal: Principal, scenario_id: int) -> BudgetScenario:
    _require_read(principal)
    scenario = db.scalars(select(BudgetScenario).where(BudgetScenario.id == scenario_id)
                          .options(joinedload(BudgetScenario.cycle))).unique().one_or_none()
    if scenario is None:
        raise NotFoundError("Budget scenario", scenario_id)
    return scenario


def scenarios(db: Session, cycle_id: int) -> list[BudgetScenario]:
    return list(db.scalars(select(BudgetScenario).where(BudgetScenario.cycle_id == cycle_id)
                           .order_by(BudgetScenario.scenario_no.desc())))


def visible_lines(db: Session, principal: Principal,
                  scenario: BudgetScenario) -> list[BudgetScenarioLine] | None:
    """Employee-level lines for compensation readers, within their scope;
    None for budget readers without employee-level access."""
    scope = principal.scope_for(Permission.COMPENSATION_READ)
    if scope.is_empty:
        return None
    lines = db.scalars(select(BudgetScenarioLine).where(
        BudgetScenarioLine.scenario_id == scenario.id)
        .options(joinedload(BudgetScenarioLine.employee))
        .order_by(BudgetScenarioLine.id)).unique().all()
    return [line for line in lines if scope.is_global or (
        line.plant_id is not None and scope.allows_unit(line.plant_id, line.department_id))]


def variance(total: Decimal, decision: BudgetDecision | None) -> dict[str, Any] | None:
    """The approved budget against the calculated requirement."""
    if decision is None:
        return None
    difference = decision.approved_amount - total
    percent = ((difference / total * HUNDRED).quantize(CENT, rounding=ROUND_HALF_UP)
               if total else None)
    state = "ON_BUDGET" if difference == 0 else ("UNDER_BUDGET" if difference > 0
                                                 else "OVER_BUDGET")
    return {"decision_id": decision.id, "decision_version": decision.version_no,
            "approved_budget": rules.decimal_text(decision.approved_amount),
            "requirement": rules.decimal_text(total), "difference": rules.decimal_text(difference),
            "difference_percent": rules.decimal_text(percent) if percent is not None else None,
            "state": state,
            "unallocated_balance": rules.decimal_text(max(difference, Decimal(0))),
            "overspend": rules.decimal_text(max(-difference, Decimal(0)))}


def stale_reasons(db: Session, scenario: BudgetScenario) -> list[str]:
    """Why a scenario no longer reflects the approved inputs (checked before it
    is submitted or approved)."""
    reasons = []
    annual_ids = [line.annual_result_id for line in scenario.lines if line.annual_result_id]
    changed = db.scalar(select(func.count()).select_from(AnnualResult).where(
        AnnualResult.id.in_(annual_ids or [0]),
        (AnnualResult.status != AnnualResultStatus.PUBLISHED)
        | AnnualResult.recalculation_required))
    if changed:
        reasons.append(f"{changed} annual result(s) it used are no longer the approved, current "
                       "versions; calculate a new scenario.")
    cycle = scenario.cycle
    current = _annual_employees(db, cycle)
    used = {line.employee_id: line.annual_result_id for line in scenario.lines}
    newer = [e for e, r in current.items() if used.get(e) != r.id]
    if newer:
        reasons.append(f"{len(newer)} employee(s) have a newer approved annual result; calculate a "
                       "new scenario.")
    for v in scenario.matrix_versions:
        version = db.get(MatrixVersion, v["version_id"])
        if version is None or version.status != MatrixVersionStatus.PUBLISHED or (
                not matrix_service.in_force(version, scenario.effective_date)):
            reasons.append(f"{v['code']} version {v['version_no']} is no longer the published "
                           "version in force; calculate a new scenario.")
    return reasons


def _locked_scenario(db: Session, scenario_id: int) -> BudgetScenario:
    scenario = db.scalars(select(BudgetScenario).where(BudgetScenario.id == scenario_id)
                          .with_for_update()).one_or_none()
    if scenario is None:
        raise NotFoundError("Budget scenario", scenario_id)
    return scenario


def submit(db: Session, principal: Principal, actor: AuditActor,
           scenario_id: int) -> BudgetScenario:
    _require(principal, Permission.COMPENSATION_MANAGE,
             "Budget scenarios are submitted by an HR Head with company-wide authority.")
    scenario = _locked_scenario(db, scenario_id)
    cycle = _locked_cycle(db, scenario.cycle_id)
    _require_open(cycle)
    if scenario.status != BudgetScenarioStatus.CALCULATED:
        raise ConflictError("Only a calculated scenario can be submitted.")
    if scenario.analysis_only:
        raise ConflictError("This scenario uses explicitly chosen matrix versions for analysis; "
                            "only a scenario calculated with the approved, published versions in "
                            "force can be submitted.")
    if scenario.included_count == 0:
        raise ConflictError("No employee is included in this scenario.")
    reasons = stale_reasons(db, scenario)
    if reasons:
        raise ValidationFailedError([Issue(r, "scenario") for r in reasons])
    if db.scalar(select(func.count()).select_from(BudgetScenario).where(
            BudgetScenario.cycle_id == cycle.id,
            BudgetScenario.status == BudgetScenarioStatus.SUBMITTED)):
        raise ConflictError("Another scenario of this cycle already awaits the CHRO's decision.")
    scenario.status = BudgetScenarioStatus.SUBMITTED
    scenario.submitted_by_user_id = principal.user_id
    scenario.submitted_at = func.now()
    db.flush()
    _audit(db, actor, ("budget_scenario", scenario.id), "budget_scenario.submit",
           f"Submitted scenario {scenario.scenario_no} '{scenario.name}' of {cycle.code} for the "
           "CHRO's decision", changes={"total_increment": scenario.total_increment,
                                       "inputs_sha256": scenario.inputs_hash})
    return scenario


def _decision_checks(db: Session, principal: Principal, scenario_id: int,
                     reason: str) -> tuple[BudgetScenario, CompensationCycle]:
    _require(principal, Permission.BUDGET_APPROVE,
             "The final budget is approved or rejected by the CHRO.")
    scenario = _locked_scenario(db, scenario_id)
    cycle = _locked_cycle(db, scenario.cycle_id)
    _require_open(cycle)
    if scenario.status != BudgetScenarioStatus.SUBMITTED:
        raise ConflictError("Only a submitted scenario awaits a decision.")
    if principal.user_id in (scenario.calculated_by_user_id, scenario.submitted_by_user_id):
        raise PermissionDeniedError("You prepared or submitted this scenario; someone else "
                                    "decides it.")
    if len(reason.strip()) < 10:
        raise ValidationFailedError([Issue("Give the reason for the decision (at least 10 "
                                           "characters).", "reason")])
    return scenario, cycle


def approve(db: Session, principal: Principal, actor: AuditActor, scenario_id: int,
            reason: str) -> BudgetScenario:
    """The CHRO finalizes the budget: this scenario against the current approved budget."""
    scenario, cycle = _decision_checks(db, principal, scenario_id, reason)
    decision = current_decision(db, cycle.id)
    if decision is None:
        raise ConflictError("The budget owner has not recorded the approved budget yet.")
    if decision.recorded_by_user_id == principal.user_id:
        raise PermissionDeniedError("You recorded the approved budget; someone else approves the "
                                    "final budget.")
    reasons = stale_reasons(db, scenario)
    if reasons:
        raise ValidationFailedError([Issue(r, "scenario") for r in reasons])
    result = variance(scenario.total_increment, decision)
    scenario.status = BudgetScenarioStatus.FINALIZED
    scenario.decided_by_user_id = principal.user_id
    scenario.decided_at = func.now()
    scenario.decision_reason = reason.strip()[:1000]
    scenario.budget_decision_id = decision.id
    others = []
    for other in db.scalars(select(BudgetScenario).where(
            BudgetScenario.cycle_id == cycle.id, BudgetScenario.id != scenario.id,
            BudgetScenario.status.in_(OPEN_SCENARIOS))):
        other.status = BudgetScenarioStatus.SUPERSEDED
        others.append(other.scenario_no)
    cycle.status = CompensationCycleStatus.FINALIZED
    cycle.finalized_by_user_id = principal.user_id
    cycle.finalized_at = func.now()
    db.flush()
    _audit(db, actor, ("budget_scenario", scenario.id), "budget_scenario.approve",
           f"Approved scenario {scenario.scenario_no} '{scenario.name}' as the final budget of "
           f"{cycle.code}", reason=scenario.decision_reason,
           changes={"budget_decision_id": decision.id, "variance": result,
                    "superseded_scenarios": others, "inputs_sha256": scenario.inputs_hash})
    return scenario


def reject(db: Session, principal: Principal, actor: AuditActor, scenario_id: int,
           reason: str) -> BudgetScenario:
    scenario, cycle = _decision_checks(db, principal, scenario_id, reason)
    scenario.status = BudgetScenarioStatus.REJECTED
    scenario.decided_by_user_id = principal.user_id
    scenario.decided_at = func.now()
    scenario.decision_reason = reason.strip()[:1000]
    db.flush()
    _audit(db, actor, ("budget_scenario", scenario.id), "budget_scenario.reject",
           f"Rejected scenario {scenario.scenario_no} '{scenario.name}' of {cycle.code}",
           reason=scenario.decision_reason)
    return scenario
