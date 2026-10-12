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
    # Current primary assignment: where this person is counted for headcount.
    primary_assignment: AssignmentRead | None
    # Current assignments that fall inside the requested plant/department
    # filter (all current assignments when no filter is given).
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
    current_assignments: list[AssignmentRead]
    assignment_history: list[AssignmentRead]  # every assignment, oldest first
