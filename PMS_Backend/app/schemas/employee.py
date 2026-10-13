from datetime import date

from app.schemas.organization import DepartmentRef, ORMModel, PlantRef


class DesignationRef(ORMModel):
    id: int
    code: str
    name: str


class EmployeeRef(ORMModel):
    id: int
    employee_code: str
    full_name: str


class AssignmentRead(ORMModel):
    id: int
    plant_department_id: int
    plant: PlantRef
    department: DepartmentRef
    designation: DesignationRef
    reporting_manager: EmployeeRef | None
    is_primary: bool
    effective_from: date
    effective_to: date | None
    is_current: bool  # relative to the response's as_of date


class EmployeeSummary(ORMModel):
    id: int
    employee_code: str
    full_name: str
    email: str | None
    is_active: bool
    # True when a current primary assignment exists anywhere, even if it is
    # outside the caller's access (then primary_assignment is null).
    has_primary_assignment: bool
    # Current primary assignment (where this person is counted for headcount),
    # shown only when it is inside the caller's access.
    primary_assignment: AssignmentRead | None
    # Current assignments inside both the requested plant/department filter
    # and the caller's access.
    matching_assignments: list[AssignmentRead]


class EmployeeListResponse(ORMModel):
    items: list[EmployeeSummary]
    total: int  # unique employees matching the filter
    limit: int
    offset: int
    as_of: date


class EmployeeDetail(ORMModel):
    id: int
    employee_code: str
    full_name: str
    email: str | None
    date_of_joining: date | None
    date_of_exit: date | None
    is_active: bool
    as_of: date
    # See EmployeeSummary.has_primary_assignment.
    has_primary_assignment: bool
    # Both lists contain only assignments inside the caller's access (the
    # employee's own record shows everything).
    current_assignments: list[AssignmentRead]
    assignment_history: list[AssignmentRead]  # oldest first
