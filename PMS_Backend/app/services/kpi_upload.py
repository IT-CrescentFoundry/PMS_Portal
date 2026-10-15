"""Department Head KPI upload (.xlsx): preview, then confirm.

Preview parses and validates without writing. Confirm re-parses the same
file, re-validates and writes every affected sheet as DRAFT in ONE
transaction, refusing if any problem remains. Publishing the uploaded sheets
is a separate review step.

The file is untrusted input: size, type and row count are limited, and
openpyxl parses it through defusedxml.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from io import BytesIO
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils.exceptions import InvalidFileException
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload
from zipfile import BadZipFile

from app.auth.permissions import Permission, Principal
from app.models import (
    Department,
    Employee,
    EmployeeAssignment,
    KpiScoringPolicy,
    KpiSheet,
    KpiSheetStatus,
    Plant,
    PlantDepartment,
    QuarterStatus,
)
from app.services import kpi_sheets
from app.services.audit import AuditActor
from app.services.errors import Issue, PermissionDeniedError, ValidationFailedError
from app.services.kpi_library import list_definitions
from app.services.kpi_sheets import ItemInput, check_items, to_weightage

MAX_BYTES = 1_000_000
MAX_ROWS = 1000
MAX_TARGET = Decimal("1e14")  # Numeric(18, 4)
FLOAT_NOISE = Decimal("0.000001")
SHEET_NAME = "KPIs"

# Template columns: (canonical key, header text, required)
COLUMNS = [
    ("employee_code", "Employee Code", True),
    ("plant_code", "Plant Code", False),
    ("department_code", "Department Code", False),
    ("kpi", "KPI", True),
    ("weightage", "Weightage %", True),
    ("target", "Target per Quarter", False),
    ("unit", "Unit", False),
    ("scoring_policy", "Scoring Policy", False),
    ("target_note", "Target Note", False),
]
ALIASES = {
    "employeecode": "employee_code", "empcode": "employee_code", "employeeno": "employee_code",
    "plantcode": "plant_code", "plant": "plant_code",
    "departmentcode": "department_code", "deptcode": "department_code", "department": "department_code",
    "kpi": "kpi", "kra": "kpi", "kpiname": "kpi", "kpicode": "kpi", "kra/kpi": "kpi",
    "weightage": "weightage", "weightage%": "weightage", "weight": "weightage",
    "targetperquarter": "target", "target": "target", "quarterlytarget": "target",
    "unit": "unit", "scoringpolicy": "scoring_policy", "policy": "scoring_policy",
    "targetnote": "target_note", "note": "target_note",
}


def _key(header: Any) -> str:
    # "Employee Code *" (the template marks required columns) -> "employeecode"
    return re.sub(r"[\s_\-()*]", "", str(header or "")).lower()


def _norm(text: Any) -> str:
    return " ".join(str(text).split()).casefold() if text is not None else ""


@dataclass
class RawRow:
    row: int
    values: dict[str, Any]
    weightage_is_percent_format: bool = False


@dataclass
class PreviewItem:
    row: int
    kpi_id: int
    kpi_name: str
    weightage: Decimal
    target_value: Decimal | None
    unit: str | None
    scoring_policy: str | None
    target_note: str | None


@dataclass
class PreviewSheet:
    assignment: EmployeeAssignment
    existing: KpiSheet | None
    items: list[PreviewItem] = field(default_factory=list)
    first_row: int = 0

    @property
    def total(self) -> Decimal:
        return kpi_sheets.weight_total([i.weightage for i in self.items])

    def inputs(self) -> list[ItemInput]:
        return [ItemInput(i.kpi_id, i.weightage, i.target_value, i.target_note, i.unit, None)
                for i in self.items]


@dataclass
class UploadResult:
    sheets: list[PreviewSheet]
    issues: list[Issue]
    row_count: int
    policy_overrides: dict[tuple[int, int], int] = field(default_factory=dict)


# --- parsing ----------------------------------------------------------------------------

def read_rows(data: bytes) -> list[RawRow]:
    if not data:
        raise ValidationFailedError([Issue("The file is empty.")])
    if len(data) > MAX_BYTES:
        raise ValidationFailedError([Issue("The file is larger than 1 MB.")])
    if not data.startswith(b"PK\x03\x04"):
        raise ValidationFailedError([Issue("Upload an Excel workbook (.xlsx).")])
    try:
        wb = load_workbook(BytesIO(data), read_only=True, data_only=True)
    except (InvalidFileException, BadZipFile, KeyError, OSError, ValueError):
        raise ValidationFailedError([Issue("The file could not be read as an Excel workbook (.xlsx).")]) from None
    try:
        ws = wb[SHEET_NAME] if SHEET_NAME in wb.sheetnames else wb.worksheets[0]
        # Read-only mode yields EmptyCell objects without coordinates, so rows
        # and columns are numbered by position.
        rows_iter = enumerate(ws.iter_rows(), start=1)
        columns: dict[int, str] = {}
        for _header_row, row in rows_iter:
            headers = [(col, ALIASES.get(_key(c.value))) for col, c in enumerate(row, 1) if c.value is not None]
            if headers:
                columns = {col: key for col, key in headers if key}
                break
        missing = [header for key, header, required in COLUMNS if required and key not in columns.values()]
        if missing:
            raise ValidationFailedError([Issue(
                f"Missing column(s): {', '.join(missing)}. Download the template for the expected layout.")])
        rows: list[RawRow] = []
        for row_number, row in rows_iter:
            values: dict[str, Any] = {}
            percent_format = False
            for col, cell in enumerate(row, 1):
                key = columns.get(col)
                if key is None or cell.value is None or (isinstance(cell.value, str) and not cell.value.strip()):
                    continue
                values[key] = cell.value.strip() if isinstance(cell.value, str) else cell.value
                if key == "weightage":
                    percent_format = "%" in str(getattr(cell, "number_format", "") or "")
            if not values:
                continue
            if len(rows) >= MAX_ROWS:
                raise ValidationFailedError([Issue(f"The file has more than {MAX_ROWS} rows.")])
            rows.append(RawRow(row_number, values, percent_format))
    finally:
        wb.close()
    if not rows:
        raise ValidationFailedError([Issue("The file has no KPI rows below the header.")])
    return rows


def _number(value: Any) -> Decimal:
    if isinstance(value, bool):
        raise ValueError
    if isinstance(value, (int, float, Decimal)):
        number = Decimal(str(value))
    else:
        number = Decimal(str(value).replace(",", "").strip())
    if not number.is_finite():  # "nan", "inf" typed into a cell
        raise ValueError
    return number


def _target(value: Any) -> Decimal:
    number = _number(value)
    if number < 0 or number >= MAX_TARGET:
        raise ValueError("Target per Quarter must be 0 or more and below 100 trillion.")
    # Column precision; the preview shows the rounded value before anything is saved.
    return number.quantize(kpi_sheets.TARGET_PLACES, rounding=ROUND_HALF_UP)


def _weightage(raw: RawRow) -> Decimal:
    value = raw.values["weightage"]
    if isinstance(value, str) and value.strip().endswith("%"):
        return to_weightage(_number(value.strip()[:-1]))
    number = _number(value)
    if raw.weightage_is_percent_format:  # Excel stores 20 % as 0.2
        number *= 100
    if isinstance(value, float):
        # Drop binary noise from formulas (=0.1+0.2 -> 30.000000000000004);
        # a genuine third decimal such as 33.333 is still refused.
        number = number.quantize(FLOAT_NOISE, rounding=ROUND_HALF_UP)
    return to_weightage(number.normalize())


# --- validation -----------------------------------------------------------------------------

def validate(db: Session, principal: Principal, quarter_id: int, rows: list[RawRow]) -> UploadResult:
    if Permission.KPI_WRITE not in principal.permissions:
        raise PermissionDeniedError("You cannot upload KPI sheets.")
    quarter = kpi_sheets.get_quarter(db, quarter_id)
    issues: list[Issue] = []
    if quarter.status != QuarterStatus.DRAFT:
        issues.append(Issue(f"Scoring has started for {quarter.name}; KPIs can only change by approved deviation."))
    write_scope = principal.scope_for(Permission.KPI_WRITE)

    kpis = {}
    for kpi in list_definitions(db, principal):
        kpis[_norm(kpi.name)] = kpi
        kpis[_norm(kpi.code)] = kpi
    policies = {}
    for policy in db.scalars(select(KpiScoringPolicy).where(KpiScoringPolicy.is_active)).all():
        policies[_norm(policy.name)] = policy
        policies[_norm(policy.code)] = policy
    plants = {_norm(p.code): p for p in db.scalars(select(Plant)).all()}
    departments = {_norm(d.code): d for d in db.scalars(select(Department)).all()}

    sheets: dict[int, PreviewSheet] = {}
    policy_overrides: dict[tuple[int, int], int] = {}
    employees: dict[str, Employee | None] = {}

    for raw in rows:
        v, r = raw.values, raw.row
        code = str(v.get("employee_code", "")).strip()
        if not code:
            issues.append(Issue("Employee Code is required.", "employee_code", r))
            continue
        if code not in employees:
            employees[code] = db.scalars(select(Employee).where(Employee.employee_code == code)).one_or_none()
        employee = employees[code]
        if employee is None or not employee.is_active:
            issues.append(Issue(f"Employee {code} not found or inactive.", "employee_code", r))
            continue

        stmt = (select(EmployeeAssignment).join(EmployeeAssignment.plant_department)
                .where(EmployeeAssignment.employee_id == employee.id, kpi_sheets.assignment_in_quarter(quarter),
                       write_scope.unit_condition())
                .options(joinedload(EmployeeAssignment.plant_department).joinedload(PlantDepartment.plant),
                         joinedload(EmployeeAssignment.plant_department).joinedload(PlantDepartment.department),
                         joinedload(EmployeeAssignment.employee)))
        if v.get("plant_code"):
            plant = plants.get(_norm(v["plant_code"]))
            if plant is None:
                issues.append(Issue(f"Plant code '{v['plant_code']}' not found.", "plant_code", r))
                continue
            stmt = stmt.where(PlantDepartment.plant_id == plant.id)
        if v.get("department_code"):
            dept = departments.get(_norm(v["department_code"]))
            if dept is None:
                issues.append(Issue(f"Department code '{v['department_code']}' not found.", "department_code", r))
                continue
            stmt = stmt.where(PlantDepartment.department_id == dept.id)
        assignments = db.scalars(stmt).unique().all()
        if not assignments:
            issues.append(Issue(f"{code} has no assignment in your scope during {quarter.name}.", "employee_code", r))
            continue
        if len(assignments) > 1:
            issues.append(Issue(f"{code} works in more than one unit; fill in Plant Code and Department Code.",
                                "plant_code", r))
            continue
        assignment = assignments[0]

        kpi = kpis.get(_norm(v.get("kpi", "")))
        if kpi is None:
            issues.append(Issue(f"KPI '{v.get('kpi', '')}' is not in the KPI library (add it there first).", "kpi", r))
            continue
        try:
            weightage = _weightage(raw)
        except (ValueError, InvalidOperation, KeyError) as exc:
            message = str(exc) if isinstance(exc, ValueError) and str(exc) else "Weightage must be a number."
            issues.append(Issue(message, "weightage", r))
            continue
        target = None
        if v.get("target") is not None:
            try:
                target = _target(v["target"])
            except (ValueError, InvalidOperation) as exc:
                message = str(exc) if isinstance(exc, ValueError) and str(exc) else "Target per Quarter must be a number."
                issues.append(Issue(message, "target", r))
                continue
        policy_id = None
        if v.get("scoring_policy"):
            policy = policies.get(_norm(v["scoring_policy"]))
            if policy is None:
                issues.append(Issue(f"Scoring policy '{v['scoring_policy']}' not found.", "scoring_policy", r))
                continue
            policy_id = policy.id

        sheet = sheets.get(assignment.id)
        if sheet is None:
            existing = db.scalars(select(KpiSheet).where(KpiSheet.employee_assignment_id == assignment.id,
                                                         KpiSheet.cycle_quarter_id == quarter.id)).one_or_none()
            sheet = sheets[assignment.id] = PreviewSheet(assignment, existing, first_row=r)
            if existing is not None and existing.status != KpiSheetStatus.DRAFT:
                issues.append(Issue(f"{code}'s sheet for {quarter.name} is {existing.status.value.lower()}; "
                                    "reopen it before uploading.", "employee_code", r))
        if any(i.kpi_id == kpi.id for i in sheet.items):
            issues.append(Issue(f"'{kpi.name}' appears more than once for {code}.", "kpi", r))
            continue
        if policy_id is not None:
            policy_overrides[(assignment.id, kpi.id)] = policy_id
        sheet.items.append(PreviewItem(r, kpi.id, kpi.name, weightage, target, v.get("unit"),
                                       v.get("scoring_policy"), v.get("target_note")))

    # Whole-sheet rules (applicability, policies, targets, 100 % total).
    for sheet in sheets.values():
        inputs = sheet.inputs()
        for item in inputs:
            item.scoring_policy_id = policy_overrides.get((sheet.assignment.id, item.kpi_definition_id))
        check, _resolved = check_items(db, sheet.assignment, inputs, for_publish=True)
        code = sheet.assignment.employee.employee_code
        for issue in check.issues:
            issues.append(Issue(f"{code}: {issue.message}", issue.field, sheet.first_row))

    issues.sort(key=lambda i: (i.row or 0))
    return UploadResult(list(sheets.values()), issues, len(rows), policy_overrides)


def confirm(db: Session, principal: Principal, actor: AuditActor, quarter_id: int, rows: list[RawRow],
            filename: str) -> dict[str, int]:
    result = validate(db, principal, quarter_id, rows)
    if result.issues:
        raise ValidationFailedError(result.issues)
    created = updated = items = 0
    for preview in result.sheets:
        sheet = preview.existing
        if sheet is None:
            sheet = kpi_sheets.create_sheet(db, principal, actor, assignment_id=preview.assignment.id,
                                            quarter_id=quarter_id)
            created += 1
        else:
            updated += 1
        inputs = preview.inputs()
        for item in inputs:
            item.scoring_policy_id = result.policy_overrides.get((preview.assignment.id, item.kpi_definition_id))
        kpi_sheets.replace_items(db, principal, actor, sheet.id, inputs,
                                 notes=sheet.notes, job_description_id=sheet.job_description_id, source="upload",
                                 source_file=filename)
        items += len(inputs)
    return {"sheets_created": created, "sheets_updated": updated, "items": items, "rows": result.row_count}


# --- template -----------------------------------------------------------------------------------

def template(db: Session, principal: Principal) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET_NAME
    bold = Font(bold=True)
    fill = PatternFill("solid", fgColor="DBE7F5")
    for col, (_key_, header, required) in enumerate(COLUMNS, 1):
        cell = ws.cell(row=1, column=col, value=header + (" *" if required else ""))
        cell.font, cell.fill = bold, fill
        ws.column_dimensions[cell.column_letter].width = max(16, len(header) + 4)
    ws.freeze_panes = "A2"

    guide = wb.create_sheet("Instructions")
    lines = [
        "How to fill in the KPIs sheet",
        "One row per KPI per employee. Columns marked * are required.",
        "Employee Code: as in the PMS (format the column as Text if codes have leading zeros). Plant Code "
        "and Department Code are needed only if the employee works in more than one unit.",
        "KPI: the KPI's name or code exactly as in the KPI library (see the 'KPI Library' sheet).",
        "Weightage %: e.g. 20 or 20%. Each employee's weightages must total exactly 100.",
        "Target per Quarter: a number greater than 0 (leave blank for zero-tolerance KPIs).",
        "Unit and Scoring Policy: optional; the KPI library defaults are used when blank.",
        "Uploaded KPIs are saved as DRAFT and must be reviewed and published in the PMS.",
    ]
    for i, line in enumerate(lines, 1):
        guide.cell(row=i, column=1, value=line).font = bold if i == 1 else Font()
    guide.column_dimensions["A"].width = 110

    library = wb.create_sheet("KPI Library")
    for col, header in enumerate(["Code", "KPI", "Unit", "Direction", "Default Scoring Policy"], 1):
        library.cell(row=1, column=col, value=header).font = bold
    for row, kpi in enumerate(list_definitions(db, principal), 2):
        for col, value in enumerate([kpi.code, kpi.name, kpi.unit, kpi.direction.value,
                                     kpi.default_scoring_policy.code], 1):
            library.cell(row=row, column=col, value=value)
    for letter, width in zip("ABCDE", (12, 45, 12, 20, 22)):
        library.column_dimensions[letter].width = width

    policies = wb.create_sheet("Scoring Policies")
    for col, header in enumerate(["Code", "Name", "Direction"], 1):
        policies.cell(row=1, column=col, value=header).font = bold
    for row, policy in enumerate(db.scalars(select(KpiScoringPolicy).where(KpiScoringPolicy.is_active)
                                            .order_by(KpiScoringPolicy.code)), 2):
        for col, value in enumerate([policy.code, policy.name, policy.direction.value], 1):
            policies.cell(row=row, column=col, value=value)

    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue()
