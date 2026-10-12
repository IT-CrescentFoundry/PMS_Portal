from datetime import date

from app.schemas.organization import DepartmentRef, ORMModel, PlantRef


class ReportScope(ORMModel):
    """Reporting scope. A NULL plant_id means "all plants"; a NULL
    department_id means "all departments"."""

    plant_id: int | None
    department_id: int | None
    label: str  # e.g. "Quality — Plant A", "Quality — All Plants"


class UnitHeadcount(ORMModel):
    plant_department_id: int
    plant: PlantRef
    department: DepartmentRef
    headcount: int  # unique employees whose primary assignment is this unit
    supporting: int  # unique employees here only via a secondary assignment


class HeadcountResponse(ORMModel):
    scope: ReportScope
    as_of: date
    # Unique employees attributed to the scope by primary assignment.
    # Always equals the sum of by_unit[].headcount (no double counting).
    headcount: int
    # Unique employees with a secondary assignment in scope whose primary
    # assignment is outside the scope (shown, but never added to headcount).
    supporting_employees: int
    # Data-quality flag: employees with a current assignment in scope but
    # no current primary assignment anywhere. Not silently dropped.
    employees_without_primary: int
    by_unit: list[UnitHeadcount]
