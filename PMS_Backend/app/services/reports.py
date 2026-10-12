from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import EmployeeAssignment, PlantDepartment
from app.schemas.organization import DepartmentRef, PlantRef
from app.schemas.reports import HeadcountResponse, ReportScope, UnitHeadcount
from app.services.organization import list_units
from app.services.scope import current_on, resolve_scope_label, unit_conditions


def headcount(
    db: Session, *, as_of: date, plant_id: int | None = None, department_id: int | None = None
) -> HeadcountResponse:
    """Headcount for a scope, counting every person exactly once.

    Approved rule (docs/database-design.md): each employee is attributed to
    their primary assignment. Secondary assignments are reported as
    "supporting" and never add to headcount, so per-unit headcounts always
    sum to the scope total.
    """
    label = resolve_scope_label(db, plant_id, department_id)

    # (employee_id, plant_department_id, is_primary, effective_from) in scope.
    rows = db.execute(
        select(
            EmployeeAssignment.employee_id,
            EmployeeAssignment.plant_department_id,
            EmployeeAssignment.is_primary,
            EmployeeAssignment.effective_from,
        )
        .join(EmployeeAssignment.plant_department)
        .where(current_on(as_of), *unit_conditions(plant_id, department_id))
    ).all()

    # Attribute each employee to exactly one unit: their current primary.
    # If overlapping primaries ever slip through validation, the most recent
    # one wins so the person is still counted once.
    attributed: dict[int, tuple[date, int]] = {}
    for emp_id, unit_id, is_primary, start in rows:
        if is_primary and (emp_id not in attributed or start > attributed[emp_id][0]):
            attributed[emp_id] = (start, unit_id)
    unit_of = {emp_id: unit_id for emp_id, (_, unit_id) in attributed.items()}

    employees_in_scope = {r.employee_id for r in rows}
    not_attributed_here = employees_in_scope - unit_of.keys()

    # Of those, who has a current primary somewhere outside the scope?
    has_primary_elsewhere: set[int] = set()
    if not_attributed_here:
        has_primary_elsewhere = set(
            db.scalars(
                select(EmployeeAssignment.employee_id).where(
                    EmployeeAssignment.employee_id.in_(not_attributed_here),
                    EmployeeAssignment.is_primary,
                    current_on(as_of),
                )
            ).all()
        )

    headcount_by_unit: dict[int, int] = defaultdict(int)
    for unit_id in unit_of.values():
        headcount_by_unit[unit_id] += 1
    supporting_by_unit: dict[int, set[int]] = defaultdict(set)
    for emp_id, unit_id, is_primary, _ in rows:
        if not is_primary and unit_of.get(emp_id) != unit_id:
            supporting_by_unit[unit_id].add(emp_id)

    # Every active unit in scope (zeros included), plus any inactive unit
    # that still has current assignments.
    units = {u.id: u for u in list_units(db, plant_id, department_id)}
    extra_ids = {r.plant_department_id for r in rows} - units.keys()
    if extra_ids:
        for u in list_units(db, plant_id, department_id, include_inactive=True):
            if u.id in extra_ids:
                units[u.id] = u

    by_unit = [
        UnitHeadcount(
            plant_department_id=u.id,
            plant=PlantRef.model_validate(u.plant),
            department=DepartmentRef.model_validate(u.department),
            headcount=headcount_by_unit[u.id],
            supporting=len(supporting_by_unit[u.id]),
        )
        for u in sorted(units.values(), key=lambda u: (u.plant.code, u.department.code))
    ]

    return HeadcountResponse(
        scope=ReportScope(plant_id=plant_id, department_id=department_id, label=label),
        as_of=as_of,
        headcount=len(unit_of),
        supporting_employees=len(not_attributed_here & has_primary_elsewhere),
        employees_without_primary=len(not_attributed_here - has_primary_elsewhere),
        by_unit=by_unit,
    )
