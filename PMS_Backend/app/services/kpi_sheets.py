"""Quarterly KPI sheets, quarter locking and approved deviations.

Rules (docs/database-design.md, "JD and KPI management"):
  * One sheet per employee ASSIGNMENT and quarter; weightages must total
    exactly 100.00 % to publish.
  * A quarter starts scoring by an explicit, audited action (company-wide
    scope). Published sheets then LOCK; nothing in that quarter changes
    except through a deviation approved by an HR Head AND a Plant Head (two
    different people, neither the requester), applied atomically.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, joinedload, object_session, selectinload

from app.auth.permissions import Permission, Principal
from app.models import (
    DeviationStatus,
    Employee,
    EmployeeAssignment,
    JobDescription,
    KpiDefinition,
    KpiDeviation,
    KpiDirection,
    KpiScoringPolicy,
    KpiSheet,
    KpiSheetItem,
    KpiSheetResult,
    KpiSheetStatus,
    MatrixVersion,
    PlantDepartment,
    PmsCycleQuarter,
    QuarterStatus,
    ScoreResultStatus,
)
from app.services import kpi_scoring
from app.services.audit import AuditActor, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services.kpi_library import applies_to_unit
from app.services.scope import AccessScope

HUNDRED = Decimal("100.00")
CENT = Decimal("0.01")
TARGET_PLACES = Decimal("0.0001")
RECOMMENDED_RANGE = (3, 5)
LARGE_SET = 8


# --- items --------------------------------------------------------------------------------

@dataclass
class ItemInput:
    kpi_definition_id: int
    weightage: Decimal
    target_value: Decimal | None = None
    target_note: str | None = None
    unit: str | None = None
    scoring_policy_id: int | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "kpi_definition_id": self.kpi_definition_id,
            "weightage": _weight_text(self.weightage),
            "target_value": _target_text(self.target_value),
            "target_note": self.target_note,
            "unit": self.unit,
            "scoring_policy_id": self.scoring_policy_id,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ItemInput:
        return cls(
            kpi_definition_id=data["kpi_definition_id"],
            weightage=Decimal(data["weightage"]),
            target_value=None if data.get("target_value") is None else Decimal(data["target_value"]),
            target_note=data.get("target_note"),
            unit=data.get("unit"),
            scoring_policy_id=data.get("scoring_policy_id"),
        )


def _weight_text(value: Decimal) -> str:
    return str(value.quantize(CENT))


def _target_text(value: Decimal | None) -> str | None:
    # Same precision as the column, so stored and requested values compare as text.
    return None if value is None else str(value.quantize(TARGET_PLACES))


def to_weightage(value: Any) -> Decimal:
    """Two-decimal percentage; more precision is refused rather than rounded."""
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError("Weightage must be a number.") from None
    if number != number.quantize(CENT):
        raise ValueError("Weightage can have at most two decimal places.")
    return number.quantize(CENT, rounding=ROUND_HALF_UP)


def weight_total(weights: list[Decimal]) -> Decimal:
    return sum(weights, Decimal("0")).quantize(CENT)


@dataclass
class SheetCheck:
    issues: list[Issue] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    total: Decimal = Decimal("0.00")


@dataclass
class ResolvedItem:
    item: ItemInput
    kpi: KpiDefinition
    policy: KpiScoringPolicy
    # The approved matrix version that will govern the item (publication only).
    version: MatrixVersion | None = None


# Directions whose matrices compare the actual with a positive target.
TARGETED = (KpiDirection.HIGHER_IS_BETTER, KpiDirection.LOWER_IS_BETTER, KpiDirection.TARGET_RANGE)


def check_items(db: Session, assignment: EmployeeAssignment, items: list[ItemInput], *,
                for_publish: bool, quarter: PmsCycleQuarter | None = None
                ) -> tuple[SheetCheck, list[ResolvedItem]]:
    """Validate items for one assignment. Totals must be 100 % when publishing,
    and (given the quarter) every item needs an approved matrix version in
    force and a defined measurement."""
    check = SheetCheck()
    resolved: list[ResolvedItem] = []
    unit = assignment.plant_department
    seen: set[int] = set()
    for n, item in enumerate(items, 1):
        label = f"KPI {n}"
        kpi = db.scalars(select(KpiDefinition).where(KpiDefinition.id == item.kpi_definition_id)
                         .options(selectinload(KpiDefinition.applicabilities))).one_or_none()
        if kpi is None or not kpi.is_active:
            check.issues.append(Issue(f"{label}: KPI not found in the library or inactive.", "kpi_definition_id"))
            continue
        label = f"'{kpi.name}'"
        if item.kpi_definition_id in seen:
            check.issues.append(Issue(f"{label} is listed more than once.", "kpi_definition_id"))
        seen.add(item.kpi_definition_id)
        if not applies_to_unit(kpi, unit.plant_id, unit.department_id):
            check.issues.append(Issue(f"{label} does not apply to this plant and department.", "kpi_definition_id"))
        if not (Decimal("0") < item.weightage <= HUNDRED):
            check.issues.append(Issue(f"{label}: weightage must be more than 0 and at most 100.", "weightage"))
        policy_id = item.scoring_policy_id or kpi.default_scoring_policy_id
        policy = db.get(KpiScoringPolicy, policy_id)
        if policy is None or not policy.is_active:
            check.issues.append(Issue(f"{label}: scoring policy not found or inactive.", "scoring_policy_id"))
            continue
        if policy.direction != kpi.direction:
            check.issues.append(Issue(f"{label}: the scoring policy's direction does not match the KPI.", "scoring_policy_id"))
        if kpi.direction == KpiDirection.ZERO_TOLERANCE:
            if item.target_value not in (None, Decimal("0")):
                check.issues.append(Issue(f"{label}: a zero-tolerance KPI has a target of 0.", "target_value"))
        elif kpi.direction in TARGETED and (item.target_value is None or item.target_value <= 0):
            check.issues.append(Issue(f"{label}: enter a quarterly target greater than 0.", "target_value"))
        entry = ResolvedItem(item, kpi, policy)
        if for_publish and quarter is not None:
            problem = kpi_scoring.measurement_problem(kpi)
            if problem:
                check.issues.append(Issue(problem, "kpi_definition_id"))
            version, issue = kpi_scoring.resolve_version(db, policy, unit, quarter, label)
            if issue:
                check.issues.append(issue)
            elif version is not None:
                target = (Decimal("0") if kpi.direction == KpiDirection.ZERO_TOLERANCE
                          else item.target_value)
                problem = kpi_scoring.version_problem(version, target, label)
                if problem:
                    check.issues.append(Issue(problem, "target_value"))
                entry.version = version
        resolved.append(entry)

    check.total = weight_total([i.weightage for i in items])
    if items and check.total != HUNDRED:
        message = f"Weightages total {check.total} %; they must total exactly 100 %."
        if for_publish:
            check.issues.append(Issue(message, "weightage"))
        else:
            check.warnings.append(message)  # drafts may be incomplete
    if for_publish and not items:
        check.issues.append(Issue("Add at least one KPI before publishing.", "items"))
    low, high = RECOMMENDED_RANGE
    if items and not low <= len(items) <= high:
        check.warnings.append(
            f"{len(items)} KPIs: 3 to 5 are recommended"
            + (" (more than 8 is unusual)." if len(items) > LARGE_SET else ".")
        )
    return check, resolved


def _write_items(sheet: KpiSheet, resolved: list[ResolvedItem], *, freeze: bool) -> None:
    """Replace the items. With freeze, bind each to its approved matrix
    version and the KPI's measurement semantics (publication, deviations)."""
    sheet.items.clear()
    # Delete the old rows first: the unit of work would otherwise insert the
    # new rows before deleting the old ones and hit uq_kpi_sheet_items_kpi.
    object_session(sheet).flush()
    for order, entry in enumerate(resolved, 1):
        item, kpi, policy, version = entry.item, entry.kpi, entry.policy, entry.version
        if freeze and version is None:  # check_items reports this; never freeze without one
            raise ValidationFailedError([Issue(f"'{kpi.name}' has no approved scoring version.",
                                               "scoring_policy_id")])
        unit = (item.unit or kpi.unit).strip()[:30]
        sheet.items.append(KpiSheetItem(
            kpi_definition_id=kpi.id,
            sort_order=order,
            weightage=item.weightage,
            target_value=Decimal("0") if kpi.direction == KpiDirection.ZERO_TOLERANCE else item.target_value,
            target_note=(item.target_note or "").strip()[:255] or None,
            unit=unit,
            scoring_policy_id=policy.id,
            scoring_snapshot=kpi_scoring.scoring_snapshot(version, policy) if freeze else None,
            matrix_version_id=version.id if freeze else None,
            measurement_snapshot=kpi_scoring.measurement_snapshot(kpi, unit) if freeze else None,
        ))


def items_json(sheet: KpiSheet) -> list[dict[str, Any]]:
    return [
        {
            "kpi_definition_id": i.kpi_definition_id,
            "kpi": i.kpi_definition.name if i.kpi_definition else None,
            "weightage": _weight_text(i.weightage),
            "target_value": _target_text(i.target_value),
            "target_note": i.target_note,
            "unit": i.unit,
            "scoring_policy_id": i.scoring_policy_id,
            "matrix_version_id": i.matrix_version_id,
        }
        for i in sheet.items
    ]


# --- loading and access ---------------------------------------------------------------------

def _sheet_query():
    return select(KpiSheet).options(
        joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.employee),
        joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.designation),
        joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.plant_department)
        .joinedload(PlantDepartment.plant),
        joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.plant_department)
        .joinedload(PlantDepartment.department),
        joinedload(KpiSheet.quarter),
        joinedload(KpiSheet.job_description),
        selectinload(KpiSheet.items).joinedload(KpiSheetItem.kpi_definition),
        selectinload(KpiSheet.items).joinedload(KpiSheetItem.scoring_policy),
        selectinload(KpiSheet.items).joinedload(KpiSheetItem.matrix_version)
        .joinedload(MatrixVersion.matrix),
    )


def _unit(sheet_or_assignment: KpiSheet | EmployeeAssignment) -> PlantDepartment:
    assignment = sheet_or_assignment.assignment if isinstance(sheet_or_assignment, KpiSheet) else sheet_or_assignment
    return assignment.plant_department


def _allows(scope: AccessScope, obj: KpiSheet | EmployeeAssignment) -> bool:
    unit = _unit(obj)
    return scope.allows_unit(unit.plant_id, unit.department_id)


def get_sheet(db: Session, principal: Principal, sheet_id: int) -> KpiSheet:
    sheet = db.scalars(_sheet_query().where(KpiSheet.id == sheet_id)).unique().one_or_none()
    if sheet is None:
        raise NotFoundError("KPI sheet", sheet_id)
    own = principal.can_read_self and sheet.assignment.employee_id == principal.employee_id
    if not own and not _allows(principal.org_scope, sheet):
        raise NotFoundError("KPI sheet", sheet_id)
    return sheet


def _require_write(principal: Principal, obj: KpiSheet | EmployeeAssignment) -> None:
    if not _allows(principal.scope_for(Permission.KPI_WRITE), obj):
        raise PermissionDeniedError("You cannot change KPI sheets for this plant and department.")


def _require_quarter_open_for_config(quarter: PmsCycleQuarter) -> None:
    if quarter.status != QuarterStatus.DRAFT:
        raise ConflictError(
            "Quarterly scoring has started for this quarter; changes need an approved deviation."
        )


# Quarter phases (Stage L): what may still change in each status.
QUARTER_LABELS = {
    QuarterStatus.DRAFT: "KPI setup",
    QuarterStatus.OPEN: "data collection",
    QuarterStatus.DEPARTMENT_REVIEW: "department review",
    QuarterStatus.NORMALIZATION: "normalization",
    QuarterStatus.READY: "ready for publication",
    QuarterStatus.PUBLISHED: "published and locked",
    QuarterStatus.CLOSED: "closed",
}
# Monthly data, calculation (sheets published or locked).
COLLECTION_STATUSES = (QuarterStatus.DRAFT, QuarterStatus.OPEN)
# Department review, score overrides, contribution weights, comments.
REVIEW_STATUSES = (QuarterStatus.OPEN, QuarterStatus.DEPARTMENT_REVIEW)


def require_collection(quarter: PmsCycleQuarter) -> None:
    if quarter.status not in COLLECTION_STATUSES:
        raise ConflictError(
            f"Data collection for {quarter.name} is closed ({QUARTER_LABELS[quarter.status]}). "
            "A correction needs the quarter returned to data collection by HR.")


def require_review(quarter: PmsCycleQuarter, status: QuarterStatus | None = None) -> None:
    """`status` is the phase of the results concerned when they belong to a
    correction of the published quarter (app/services/versions.py)."""
    status = status or quarter.status
    if status not in REVIEW_STATUSES:
        raise ConflictError(
            f"{quarter.name} is not open for department review "
            f"({QUARTER_LABELS.get(status, status.value.lower())}).")


def _require_scores_unpublished(db: Session, sheet: KpiSheet) -> None:
    published = db.scalar(select(KpiSheetResult.id).where(
        KpiSheetResult.sheet_id == sheet.id, KpiSheetResult.status == ScoreResultStatus.PUBLISHED))
    if published:
        raise ConflictError("The quarter's scores for this sheet are published; its KPIs can no "
                            "longer change.")


def get_quarter(db: Session, quarter_id: int) -> PmsCycleQuarter:
    quarter = db.get(PmsCycleQuarter, quarter_id)
    if quarter is None:
        raise NotFoundError("Quarter", quarter_id)
    return quarter


def assignment_in_quarter(quarter: PmsCycleQuarter):
    """SQL condition: the assignment overlaps the quarter's dates."""
    return and_(
        EmployeeAssignment.effective_from <= quarter.end_date,
        or_(EmployeeAssignment.effective_to.is_(None), EmployeeAssignment.effective_to >= quarter.start_date),
    )


def overlaps(assignment: EmployeeAssignment, quarter: PmsCycleQuarter) -> bool:
    return assignment.effective_from <= quarter.end_date and (
        assignment.effective_to is None or assignment.effective_to >= quarter.start_date
    )


# --- listing --------------------------------------------------------------------------------

@dataclass
class SheetRow:
    assignment: EmployeeAssignment
    sheet: KpiSheet | None


def list_sheet_rows(db: Session, principal: Principal, quarter_id: int, *, plant_id: int | None = None,
                    department_id: int | None = None, search: str | None = None) -> tuple[PmsCycleQuarter, list[SheetRow]]:
    quarter = get_quarter(db, quarter_id)
    stmt = (
        select(EmployeeAssignment)
        .join(EmployeeAssignment.plant_department)
        .join(EmployeeAssignment.employee)
        .where(assignment_in_quarter(quarter), principal.org_scope.unit_condition(), Employee.is_active)
        .options(
            joinedload(EmployeeAssignment.employee),
            joinedload(EmployeeAssignment.designation),
            joinedload(EmployeeAssignment.plant_department).joinedload(PlantDepartment.plant),
            joinedload(EmployeeAssignment.plant_department).joinedload(PlantDepartment.department),
        )
        .order_by(Employee.employee_code, EmployeeAssignment.id)
    )
    if plant_id is not None:
        stmt = stmt.where(PlantDepartment.plant_id == plant_id)
    if department_id is not None:
        stmt = stmt.where(PlantDepartment.department_id == department_id)
    term = (search or "").strip()
    if term:
        like = f"%{term.replace('%', r'\%').replace('_', r'\_')}%"
        stmt = stmt.where(or_(Employee.employee_code.like(like), Employee.full_name.like(like)))
    assignments = db.scalars(stmt).unique().all()
    sheets = {
        s.employee_assignment_id: s
        for s in db.scalars(
            select(KpiSheet).where(KpiSheet.cycle_quarter_id == quarter.id,
                                   KpiSheet.employee_assignment_id.in_([a.id for a in assignments] or [0]))
            .options(selectinload(KpiSheet.items))
        ).all()
    }
    return quarter, [SheetRow(a, sheets.get(a.id)) for a in assignments]


# --- sheet lifecycle --------------------------------------------------------------------------

def _audit(db: Session, actor: AuditActor, sheet: KpiSheet, action: str, summary: str, *,
           changes: dict[str, Any] | None = None, reason: str | None = None) -> None:
    unit = _unit(sheet)
    record_event(db, actor=actor, action=action, entity_type="kpi_sheet", entity_id=sheet.id,
                 summary=summary, changes=changes, reason=reason,
                 plant_id=unit.plant_id, department_id=unit.department_id)


def _label(sheet: KpiSheet) -> str:
    return f"{sheet.assignment.employee.employee_code} · {sheet.quarter.name}"


def create_sheet(db: Session, principal: Principal, actor: AuditActor, *, assignment_id: int,
                 quarter_id: int, job_description_id: int | None = None) -> KpiSheet:
    assignment = db.scalars(select(EmployeeAssignment).where(EmployeeAssignment.id == assignment_id)
                            .options(joinedload(EmployeeAssignment.plant_department))).one_or_none()
    if assignment is None or not _allows(principal.org_scope, assignment):
        raise NotFoundError("Employee assignment", assignment_id)
    _require_write(principal, assignment)
    quarter = get_quarter(db, quarter_id)
    _require_quarter_open_for_config(quarter)
    if not overlaps(assignment, quarter):
        raise ValidationFailedError([Issue("This assignment is not active during the quarter.", "quarter_id")])
    _check_jd(db, assignment, job_description_id)
    if db.scalar(select(KpiSheet.id).where(KpiSheet.employee_assignment_id == assignment_id,
                                           KpiSheet.cycle_quarter_id == quarter_id)):
        raise ConflictError("A KPI sheet already exists for this assignment and quarter.")
    sheet = KpiSheet(employee_assignment_id=assignment_id, cycle_quarter_id=quarter_id,
                     job_description_id=job_description_id, created_by_user_id=principal.user_id)
    db.add(sheet)
    db.flush()
    sheet = get_sheet(db, principal, sheet.id)
    _audit(db, actor, sheet, "kpi_sheet.create", f"Created KPI sheet {_label(sheet)}")
    return sheet


def _check_jd(db: Session, assignment: EmployeeAssignment, jd_id: int | None) -> None:
    if jd_id is None:
        return
    jd = db.get(JobDescription, jd_id)
    unit = assignment.plant_department
    if jd is None or jd.department_id != unit.department_id or jd.plant_id not in (None, unit.plant_id):
        raise ValidationFailedError([Issue("The JD must belong to this assignment's department and plant.",
                                           "job_description_id")])


def replace_items(db: Session, principal: Principal, actor: AuditActor, sheet_id: int,
                  items: list[ItemInput], *, notes: str | None = None,
                  job_description_id: int | None = None, source: str = "edit",
                  source_file: str | None = None) -> tuple[KpiSheet, SheetCheck]:
    sheet = get_sheet(db, principal, sheet_id)
    _require_write(principal, sheet)
    _require_quarter_open_for_config(sheet.quarter)
    if sheet.status != KpiSheetStatus.DRAFT:
        raise ConflictError("Only a draft sheet can be edited; reopen it first.")
    _check_jd(db, sheet.assignment, job_description_id)
    check, resolved = check_items(db, sheet.assignment, items, for_publish=False)
    if check.issues:
        raise ValidationFailedError(check.issues)
    before = items_json(sheet)
    _write_items(sheet, resolved, freeze=False)
    sheet.notes = (notes or "").strip()[:1000] or None
    sheet.job_description_id = job_description_id
    db.flush()
    db.expire(sheet)
    sheet = get_sheet(db, principal, sheet.id)
    changes: dict[str, Any] = {"items": {"from": before, "to": items_json(sheet)}}
    if source_file:
        changes["file"] = source_file[:255]
    _audit(db, actor, sheet, "kpi_sheet.upload" if source == "upload" else "kpi_sheet.update",
           f"{'Uploaded' if source == 'upload' else 'Edited'} KPIs for {_label(sheet)}", changes=changes)
    return sheet, check


def publish(db: Session, principal: Principal, actor: AuditActor, sheet_id: int) -> KpiSheet:
    sheet = get_sheet(db, principal, sheet_id)
    _require_write(principal, sheet)
    _require_quarter_open_for_config(sheet.quarter)
    if sheet.status != KpiSheetStatus.DRAFT:
        raise ConflictError("Only a draft sheet can be published.")
    items = [ItemInput(i.kpi_definition_id, i.weightage, i.target_value, i.target_note, i.unit,
                       i.scoring_policy_id) for i in sheet.items]
    check, resolved = check_items(db, sheet.assignment, items, for_publish=True,
                                  quarter=sheet.quarter)
    if check.issues:
        raise ValidationFailedError(check.issues)
    _write_items(sheet, resolved, freeze=True)  # bind the approved matrix versions
    sheet.status = KpiSheetStatus.PUBLISHED
    sheet.published_by_user_id = principal.user_id
    sheet.published_at = func.now()
    db.flush()
    db.expire(sheet)
    sheet = get_sheet(db, principal, sheet.id)
    _audit(db, actor, sheet, "kpi_sheet.publish", f"Published KPI sheet {_label(sheet)}",
           changes={"items": items_json(sheet), "total": str(check.total)})
    return sheet


def reopen(db: Session, principal: Principal, actor: AuditActor, sheet_id: int, reason: str) -> KpiSheet:
    sheet = get_sheet(db, principal, sheet_id)
    _require_write(principal, sheet)
    _require_quarter_open_for_config(sheet.quarter)
    if sheet.status != KpiSheetStatus.PUBLISHED:
        raise ConflictError("Only a published sheet can be reopened.")
    if not reason.strip():
        raise ValidationFailedError([Issue("Give a reason for reopening.", "reason")])
    sheet.status = KpiSheetStatus.DRAFT
    sheet.published_by_user_id = None
    sheet.published_at = None
    for item in sheet.items:  # the next publication binds versions afresh
        item.scoring_snapshot = None
        item.matrix_version_id = None
        item.measurement_snapshot = None
    db.flush()
    _audit(db, actor, sheet, "kpi_sheet.reopen", f"Reopened KPI sheet {_label(sheet)}", reason=reason)
    return sheet


def copy_to_quarter(db: Session, principal: Principal, actor: AuditActor, sheet_id: int,
                    target_quarter_id: int) -> KpiSheet:
    source = get_sheet(db, principal, sheet_id)
    _require_write(principal, source)
    target = get_quarter(db, target_quarter_id)
    _require_quarter_open_for_config(target)
    if target.id == source.cycle_quarter_id:
        raise ValidationFailedError([Issue("Choose a different quarter.", "target_quarter_id")])
    if not overlaps(source.assignment, target):
        raise ValidationFailedError([Issue("The assignment is not active in that quarter.", "target_quarter_id")])
    if db.scalar(select(KpiSheet.id).where(KpiSheet.employee_assignment_id == source.employee_assignment_id,
                                           KpiSheet.cycle_quarter_id == target.id)):
        raise ConflictError("A KPI sheet already exists for that quarter.")
    items = [ItemInput(i.kpi_definition_id, i.weightage, i.target_value, i.target_note, i.unit,
                       i.scoring_policy_id) for i in source.items]
    _check, resolved = check_items(db, source.assignment, items, for_publish=False)
    if _check.issues:
        raise ValidationFailedError(_check.issues)
    sheet = KpiSheet(employee_assignment_id=source.employee_assignment_id, cycle_quarter_id=target.id,
                     job_description_id=source.job_description_id, notes=source.notes,
                     created_by_user_id=principal.user_id)
    db.add(sheet)
    db.flush()
    _write_items(sheet, resolved, freeze=False)
    db.flush()
    sheet = get_sheet(db, principal, sheet.id)
    _audit(db, actor, sheet, "kpi_sheet.copy",
           f"Copied KPIs from {source.quarter.name} to {_label(sheet)}",
           changes={"source_sheet_id": source.id})
    return sheet


# --- quarters ---------------------------------------------------------------------------------

def start_scoring(db: Session, principal: Principal, actor: AuditActor, quarter_id: int) -> dict[str, int]:
    if not principal.scope_for(Permission.QUARTER_START).is_global:
        raise PermissionDeniedError("Starting quarterly scoring needs company-wide HR authority.")
    quarter = get_quarter(db, quarter_id)
    if quarter.status != QuarterStatus.DRAFT:
        raise ConflictError("Scoring has already started for this quarter.")
    sheets = db.scalars(select(KpiSheet).where(KpiSheet.cycle_quarter_id == quarter.id)).all()
    locked = 0
    for sheet in sheets:
        if sheet.status == KpiSheetStatus.PUBLISHED:
            sheet.status = KpiSheetStatus.LOCKED
            sheet.locked_at = func.now()
            locked += 1
    quarter.status = QuarterStatus.OPEN
    db.flush()
    unpublished = len(sheets) - locked
    record_event(db, actor=actor, action="quarter.start_scoring", entity_type="cycle_quarter",
                 entity_id=quarter.id, summary=f"Started quarterly scoring for {quarter.name}",
                 changes={"locked_sheets": locked, "unpublished_sheets": unpublished})
    return {"locked_sheets": locked, "unpublished_sheets": unpublished}


# --- deviations --------------------------------------------------------------------------------

def _deviation_query():
    return select(KpiDeviation).options(
        joinedload(KpiDeviation.sheet).joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.employee),
        joinedload(KpiDeviation.sheet).joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.plant_department)
        .joinedload(PlantDepartment.plant),
        joinedload(KpiDeviation.sheet).joinedload(KpiSheet.assignment).joinedload(EmployeeAssignment.plant_department)
        .joinedload(PlantDepartment.department),
        joinedload(KpiDeviation.sheet).joinedload(KpiSheet.quarter),
    )


def get_deviation(db: Session, principal: Principal, deviation_id: int) -> KpiDeviation:
    deviation = db.scalars(_deviation_query().where(KpiDeviation.id == deviation_id)).unique().one_or_none()
    if deviation is None or not _allows(principal.org_scope, deviation.sheet):
        raise NotFoundError("Deviation", deviation_id)
    return deviation


def list_deviations(db: Session, principal: Principal, *, status: DeviationStatus | None = None) -> list[KpiDeviation]:
    stmt = _deviation_query().order_by(KpiDeviation.id.desc())
    if status is not None:
        stmt = stmt.where(KpiDeviation.status == status)
    return [d for d in db.scalars(stmt).unique().all() if _allows(principal.org_scope, d.sheet)]


def request_deviation(db: Session, principal: Principal, actor: AuditActor, sheet_id: int,
                      reason: str, items: list[ItemInput]) -> KpiDeviation:
    sheet = get_sheet(db, principal, sheet_id)
    _require_write(principal, sheet)
    if sheet.quarter.status == QuarterStatus.DRAFT:
        raise ConflictError("Scoring has not started for this quarter; edit the sheet directly.")
    if sheet.quarter.status != QuarterStatus.OPEN:
        require_collection(sheet.quarter)
    _require_scores_unpublished(db, sheet)
    if len(reason.strip()) < 10:
        raise ValidationFailedError([Issue("Explain the reason for the deviation (at least 10 characters).", "reason")])
    check, _resolved = check_items(db, sheet.assignment, items, for_publish=True,
                                   quarter=sheet.quarter)
    if check.issues:
        raise ValidationFailedError(check.issues)
    if db.scalar(select(KpiDeviation.id).where(KpiDeviation.sheet_id == sheet.id,
                                               KpiDeviation.status == DeviationStatus.PENDING)):
        raise ConflictError("A deviation for this sheet is already awaiting approval.")
    deviation = KpiDeviation(sheet_id=sheet.id, reason=reason.strip()[:1000], original_items=items_json(sheet),
                             proposed_items=[i.as_json() for i in items], requested_by_user_id=principal.user_id)
    db.add(deviation)
    db.flush()
    _audit(db, actor, sheet, "kpi_deviation.request", f"Requested a deviation for {_label(sheet)}",
           reason=reason, changes={"deviation_id": deviation.id, "original": deviation.original_items,
                                   "proposed": deviation.proposed_items})
    return get_deviation(db, principal, deviation.id)


APPROVER_SIDES = {
    "HR_HEAD": (Permission.DEVIATION_APPROVE_HR, "hr_approved_by_user_id", "hr_approved_at"),
    "PLANT_HEAD": (Permission.DEVIATION_APPROVE_PLANT, "plant_approved_by_user_id", "plant_approved_at"),
}


def approve_deviation(db: Session, principal: Principal, actor: AuditActor, deviation_id: int,
                      side: str) -> KpiDeviation:
    deviation = get_deviation(db, principal, deviation_id)
    if side not in APPROVER_SIDES:
        raise ValidationFailedError([Issue("Approve as HR_HEAD or PLANT_HEAD.", "as")])
    permission, by_field, at_field = APPROVER_SIDES[side]
    if not _allows(principal.scope_for(permission), deviation.sheet):
        raise PermissionDeniedError(f"You cannot approve as {side.replace('_', ' ').title()} for this plant.")
    if deviation.status != DeviationStatus.PENDING:
        raise ConflictError("This deviation is no longer awaiting approval.")
    if principal.user_id == deviation.requested_by_user_id:
        raise PermissionDeniedError("The requester cannot approve their own deviation.")
    other = "plant_approved_by_user_id" if side == "HR_HEAD" else "hr_approved_by_user_id"
    if getattr(deviation, by_field) is not None:
        raise ConflictError("This approval has already been given.")
    if getattr(deviation, other) == principal.user_id:
        raise PermissionDeniedError("The two approvals must come from two different people.")
    setattr(deviation, by_field, principal.user_id)
    setattr(deviation, at_field, func.now())
    db.flush()
    sheet = deviation.sheet
    _audit(db, actor, sheet, "kpi_deviation.approve",
           f"Approved deviation {deviation.id} as {side.replace('_', ' ').title()} for {_label(sheet)}",
           changes={"deviation_id": deviation.id, "side": side})
    if deviation.hr_approved_by_user_id and deviation.plant_approved_by_user_id:
        _apply(db, actor, deviation)
    return get_deviation(db, principal, deviation.id)


def _apply(db: Session, actor: AuditActor, deviation: KpiDeviation) -> None:
    """Apply in the SAME transaction as the final approval."""
    sheet = deviation.sheet
    if sheet.quarter.status != QuarterStatus.OPEN:
        require_collection(sheet.quarter)
    _require_scores_unpublished(db, sheet)
    items = [ItemInput.from_json(i) for i in deviation.proposed_items]
    check, resolved = check_items(db, sheet.assignment, items, for_publish=True,
                                  quarter=sheet.quarter)
    if check.issues:  # e.g. a KPI was deactivated since the request
        raise ValidationFailedError(check.issues)
    _write_items(sheet, resolved, freeze=True)
    sheet.status = KpiSheetStatus.LOCKED
    sheet.locked_at = func.now()
    deviation.status = DeviationStatus.APPLIED
    deviation.applied_at = func.now()
    db.flush()
    db.refresh(deviation)
    _audit(db, actor, sheet, "kpi_deviation.apply", f"Applied approved deviation {deviation.id} to {_label(sheet)}",
           reason=deviation.reason,
           changes={
               "deviation_id": deviation.id,
               "original": deviation.original_items,
               "revised": deviation.proposed_items,
               "requested_by_user_id": deviation.requested_by_user_id,
               "hr_approved_by_user_id": deviation.hr_approved_by_user_id,
               "hr_approved_at": deviation.hr_approved_at,
               "plant_approved_by_user_id": deviation.plant_approved_by_user_id,
               "plant_approved_at": deviation.plant_approved_at,
           })


def reject_deviation(db: Session, principal: Principal, actor: AuditActor, deviation_id: int,
                     reason: str) -> KpiDeviation:
    deviation = get_deviation(db, principal, deviation_id)
    can_review = any(_allows(principal.scope_for(p), deviation.sheet)
                     for p in (Permission.DEVIATION_APPROVE_HR, Permission.DEVIATION_APPROVE_PLANT))
    if not can_review:
        raise PermissionDeniedError("Only an HR Head or Plant Head for this plant can reject.")
    if deviation.status != DeviationStatus.PENDING:
        raise ConflictError("This deviation is no longer awaiting approval.")
    if not reason.strip():
        raise ValidationFailedError([Issue("Give a reason for rejecting.", "reason")])
    deviation.status = DeviationStatus.REJECTED
    deviation.rejected_by_user_id = principal.user_id
    deviation.rejected_at = func.now()
    deviation.rejection_reason = reason.strip()[:1000]
    db.flush()
    _audit(db, actor, deviation.sheet, "kpi_deviation.reject",
           f"Rejected deviation {deviation.id} for {_label(deviation.sheet)}", reason=reason,
           changes={"deviation_id": deviation.id})
    return get_deviation(db, principal, deviation.id)
