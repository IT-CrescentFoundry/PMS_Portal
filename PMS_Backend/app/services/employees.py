from collections import defaultdict
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.models import Department, Employee, EmployeeAssignment, Plant, PlantDepartment
from app.schemas.employee import (
    AssignmentRead,
    DesignationRef,
    EmployeeDetail,
    EmployeeListResponse,
    EmployeeRef,
    EmployeeSummary,
)
from app.schemas.organization import DepartmentRef, PlantRef
from app.services.errors import NotFoundError
from app.services.scope import (
    current_on,
    in_scope,
    is_current,
    resolve_scope_label,
    unit_conditions,
)

# Eager-load everything AssignmentRead needs, avoiding N+1 queries.
_ASSIGNMENT_LOAD = (
    joinedload(EmployeeAssignment.plant_department).joinedload(PlantDepartment.plant),
    joinedload(EmployeeAssignment.plant_department).joinedload(PlantDepartment.department),
    joinedload(EmployeeAssignment.designation),
    joinedload(EmployeeAssignment.reporting_manager),
)


def to_assignment_read(assignment: EmployeeAssignment, as_of: date) -> AssignmentRead:
    unit = assignment.plant_department
    manager = assignment.reporting_manager
    return AssignmentRead(
        id=assignment.id,
        plant_department_id=unit.id,
        plant=PlantRef.model_validate(unit.plant),
        department=DepartmentRef.model_validate(unit.department),
        designation=DesignationRef.model_validate(assignment.designation),
        reporting_manager=EmployeeRef.model_validate(manager) if manager else None,
        is_primary=assignment.is_primary,
        effective_from=assignment.effective_from,
        effective_to=assignment.effective_to,
        is_current=is_current(assignment, as_of),
    )


def list_employees(
    db: Session,
    *,
    as_of: date,
    plant_id: int | None = None,
    department_id: int | None = None,
    primary_only: bool = False,
    include_inactive: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> EmployeeListResponse:
    """Unique employees with a current assignment in the scope.

    Each person appears once, however many assignments they hold in scope.
    primary_only=True keeps only employees whose *primary* assignment is in
    scope, i.e. exactly the people counted in that scope's headcount.
    """
    resolve_scope_label(db, plant_id, department_id)  # 404 for unknown ids

    stmt = select(Employee)
    if not include_inactive:
        stmt = stmt.where(Employee.is_active)
    if plant_id is not None or department_id is not None or primary_only:
        in_scope_ids = (
            select(EmployeeAssignment.employee_id)
            .join(EmployeeAssignment.plant_department)
            .where(current_on(as_of), *unit_conditions(plant_id, department_id))
        )
        if primary_only:
            in_scope_ids = in_scope_ids.where(EmployeeAssignment.is_primary)
        stmt = stmt.where(Employee.id.in_(in_scope_ids))

    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    employees = db.scalars(
        stmt.order_by(Employee.employee_code).limit(limit).offset(offset)
    ).all()

    # One query for the current assignments of the whole page.
    by_employee: dict[int, list[EmployeeAssignment]] = defaultdict(list)
    if employees:
        assignments = db.scalars(
            select(EmployeeAssignment)
            .join(EmployeeAssignment.plant_department)
            .join(PlantDepartment.plant)
            .join(PlantDepartment.department)
            .where(
                EmployeeAssignment.employee_id.in_([e.id for e in employees]),
                current_on(as_of),
            )
            .options(*_ASSIGNMENT_LOAD)
            .order_by(EmployeeAssignment.is_primary.desc(), Plant.code, Department.code)
        ).all()
        for a in assignments:
            by_employee[a.employee_id].append(a)

    items = []
    for emp in employees:
        current = by_employee[emp.id]
        primary = next((a for a in current if a.is_primary), None)
        matching = [
            a
            for a in current
            if in_scope(a.plant_department, plant_id, department_id)
            and (a.is_primary or not primary_only)
        ]
        items.append(
            EmployeeSummary(
                id=emp.id,
                employee_code=emp.employee_code,
                full_name=emp.full_name,
                email=emp.email,
                is_active=emp.is_active,
                primary_assignment=to_assignment_read(primary, as_of) if primary else None,
                matching_assignments=[to_assignment_read(a, as_of) for a in matching],
            )
        )

    return EmployeeListResponse(
        items=items, total=total or 0, limit=limit, offset=offset, as_of=as_of
    )


def get_employee(db: Session, employee_id: int, as_of: date) -> EmployeeDetail:
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise NotFoundError("Employee", employee_id)

    history = db.scalars(
        select(EmployeeAssignment)
        .where(EmployeeAssignment.employee_id == employee_id)
        .options(*_ASSIGNMENT_LOAD)
        .order_by(EmployeeAssignment.effective_from, EmployeeAssignment.id)
    ).all()
    history_read = [to_assignment_read(a, as_of) for a in history]

    return EmployeeDetail(
        id=employee.id,
        employee_code=employee.employee_code,
        full_name=employee.full_name,
        email=employee.email,
        date_of_joining=employee.date_of_joining,
        date_of_exit=employee.date_of_exit,
        is_active=employee.is_active,
        as_of=as_of,
        current_assignments=[a for a in history_read if a.is_current],
        assignment_history=history_read,
    )
