"""Shared organizational-scope rules used by listings and reports.

A scope is (plant_id, department_id), where None means "all":
  (A,    QA)   -> "Quality — Plant A"
  (None, QA)   -> "Quality — All Plants"
  (A,    None) -> "All Departments — Plant A"
Scopes are filters over plant_departments, so no department is duplicated.
"""
from datetime import date

from sqlalchemy import ColumnElement, and_, or_
from sqlalchemy.orm import Session

from app.models import Department, EmployeeAssignment, Plant, PlantDepartment
from app.services.errors import NotFoundError


def current_on(as_of: date) -> ColumnElement[bool]:
    """Assignment is in effect on `as_of` (effective_to is inclusive)."""
    return and_(
        EmployeeAssignment.effective_from <= as_of,
        or_(
            EmployeeAssignment.effective_to.is_(None),
            EmployeeAssignment.effective_to >= as_of,
        ),
    )


def is_current(assignment: EmployeeAssignment, as_of: date) -> bool:
    """Python twin of current_on() for already-loaded rows."""
    return assignment.effective_from <= as_of and (
        assignment.effective_to is None or assignment.effective_to >= as_of
    )


def unit_conditions(
    plant_id: int | None, department_id: int | None
) -> list[ColumnElement[bool]]:
    """WHERE conditions on PlantDepartment for the given scope."""
    conditions = []
    if plant_id is not None:
        conditions.append(PlantDepartment.plant_id == plant_id)
    if department_id is not None:
        conditions.append(PlantDepartment.department_id == department_id)
    return conditions


def in_scope(unit: PlantDepartment, plant_id: int | None, department_id: int | None) -> bool:
    """Python twin of unit_conditions() for already-loaded rows."""
    return (plant_id is None or unit.plant_id == plant_id) and (
        department_id is None or unit.department_id == department_id
    )


def resolve_scope_label(
    db: Session, plant_id: int | None, department_id: int | None
) -> str:
    """Validate that the scope's plant/department exist and describe it."""
    plant_name = "All Plants"
    department_name = "All Departments"
    if plant_id is not None:
        plant = db.get(Plant, plant_id)
        if plant is None:
            raise NotFoundError("Plant", plant_id)
        plant_name = plant.name
    if department_id is not None:
        department = db.get(Department, department_id)
        if department is None:
            raise NotFoundError("Department", department_id)
        department_name = department.name
    return f"{department_name} — {plant_name}"
