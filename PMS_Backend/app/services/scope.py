"""Shared organizational-scope rules used by listings and reports.

Two kinds of scope meet here:

* The REQUESTED scope (plant_id, department_id), where None means "all":
    (A,    QA)   -> "Quality — Plant A"
    (None, QA)   -> "Quality — All Plants"
    (A,    None) -> "All Departments — Plant A"
* The caller's ACCESS scope (AccessScope): which plant-department units they
  may see at all, built from their role grants (app.auth.permissions).

Both are filters over plant_departments, so no department is duplicated, and
every query applies requested ∩ access.
"""
from dataclasses import dataclass
from datetime import date

from sqlalchemy import ColumnElement, and_, exists, false, or_, select, true, tuple_
from sqlalchemy.orm import Session

from app.models import Department, EmployeeAssignment, Plant, PlantDepartment
from app.services.errors import NotFoundError


@dataclass(frozen=True)
class AccessScope:
    """The plant-department units a caller may see: the union of their grants.

    GLOBAL            is_global
    PLANT             plant_ids        every department at that plant
    DEPARTMENT        department_ids   that department at every plant,
                                       including plants mapped in the future
    PLANT_DEPARTMENT  unit_keys        exactly one (plant_id, department_id)

    The empty scope grants nothing (deny by default).
    """

    is_global: bool = False
    plant_ids: frozenset[int] = frozenset()
    department_ids: frozenset[int] = frozenset()
    unit_keys: frozenset[tuple[int, int]] = frozenset()

    @property
    def is_empty(self) -> bool:
        return not (self.is_global or self.plant_ids or self.department_ids or self.unit_keys)

    def unit_condition(self) -> ColumnElement[bool]:
        """WHERE condition on PlantDepartment: unit is inside this access."""
        if self.is_global:
            return true()
        parts: list[ColumnElement[bool]] = []
        if self.plant_ids:
            parts.append(PlantDepartment.plant_id.in_(sorted(self.plant_ids)))
        if self.department_ids:
            parts.append(PlantDepartment.department_id.in_(sorted(self.department_ids)))
        if self.unit_keys:
            # Matched as a PAIR: Quality at Plant B never grants Quality at A.
            parts.append(
                tuple_(PlantDepartment.plant_id, PlantDepartment.department_id).in_(
                    sorted(self.unit_keys)
                )
            )
        return or_(*parts) if parts else false()

    def allows_unit(self, plant_id: int, department_id: int) -> bool:
        """Python twin of unit_condition() for already-loaded rows."""
        return (
            self.is_global
            or plant_id in self.plant_ids
            or department_id in self.department_ids
            or (plant_id, department_id) in self.unit_keys
        )


def plant_visible(db: Session, access: AccessScope, plant_id: int) -> bool:
    """A plant is visible if granted directly or if any accessible unit is there."""
    if access.is_global or plant_id in access.plant_ids:
        return True
    return bool(
        db.scalar(
            select(
                exists().where(PlantDepartment.plant_id == plant_id, access.unit_condition())
            )
        )
    )


def department_visible(db: Session, access: AccessScope, department_id: int) -> bool:
    if access.is_global or department_id in access.department_ids:
        return True
    return bool(
        db.scalar(
            select(
                exists().where(
                    PlantDepartment.department_id == department_id, access.unit_condition()
                )
            )
        )
    )


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
    db: Session, plant_id: int | None, department_id: int | None, access: AccessScope
) -> str:
    """Validate the requested plant/department and describe the scope.

    Unknown ids and ids outside the caller's access raise the same
    NotFoundError, so a 404 never reveals that an inaccessible record exists.
    """
    plant_name = "All Plants"
    department_name = "All Departments"
    if plant_id is not None:
        plant = db.get(Plant, plant_id)
        if plant is None or not plant_visible(db, access, plant_id):
            raise NotFoundError("Plant", plant_id)
        plant_name = plant.name
    if department_id is not None:
        department = db.get(Department, department_id)
        if department is None or not department_visible(db, access, department_id):
            raise NotFoundError("Department", department_id)
        department_name = department.name
    return f"{department_name} — {plant_name}"
