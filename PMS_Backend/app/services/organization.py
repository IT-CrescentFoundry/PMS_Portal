"""Plants, departments and plant-department units, filtered by access.

Every function takes the caller's AccessScope as a required argument (no
default), so a forgotten argument fails loudly instead of granting access.
"""
from collections.abc import Sequence

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, joinedload

from app.models import Department, Plant, PlantDepartment
from app.schemas.organization import DepartmentRef, OrgUnitRead, PlantRef
from app.services.errors import NotFoundError
from app.services.scope import AccessScope, department_visible, plant_visible, unit_conditions


def list_plants(
    db: Session, *, access: AccessScope, include_inactive: bool = False
) -> Sequence[Plant]:
    """Plants granted directly, or where the caller can see at least one unit."""
    stmt = select(Plant).order_by(Plant.code)
    if not include_inactive:
        stmt = stmt.where(Plant.is_active)
    if not access.is_global:
        has_visible_unit = (
            select(PlantDepartment.id)
            .where(PlantDepartment.plant_id == Plant.id, access.unit_condition())
            .exists()
        )
        stmt = stmt.where(or_(Plant.id.in_(sorted(access.plant_ids)), has_visible_unit))
    return db.scalars(stmt).all()


def get_plant(db: Session, plant_id: int, *, access: AccessScope) -> Plant:
    plant = db.get(Plant, plant_id)
    if plant is None or not plant_visible(db, access, plant_id):
        raise NotFoundError("Plant", plant_id)
    return plant


def list_departments(
    db: Session,
    *,
    access: AccessScope,
    include_inactive: bool = False,
    plant_id: int | None = None,
) -> Sequence[Department]:
    """Visible departments, or only those the caller can see at `plant_id`."""
    stmt = select(Department).order_by(Department.code)
    if not include_inactive:
        stmt = stmt.where(Department.is_active)
    if plant_id is not None:
        get_plant(db, plant_id, access=access)  # 404 for unknown/out-of-scope plant
        stmt = stmt.join(PlantDepartment).where(
            PlantDepartment.plant_id == plant_id, access.unit_condition()
        )
        if not include_inactive:
            stmt = stmt.where(PlantDepartment.is_active)
    elif not access.is_global:
        has_visible_unit = (
            select(PlantDepartment.id)
            .where(PlantDepartment.department_id == Department.id, access.unit_condition())
            .exists()
        )
        stmt = stmt.where(
            or_(Department.id.in_(sorted(access.department_ids)), has_visible_unit)
        )
    return db.scalars(stmt).all()


def get_department(db: Session, department_id: int, *, access: AccessScope) -> Department:
    department = db.get(Department, department_id)
    if department is None or not department_visible(db, access, department_id):
        raise NotFoundError("Department", department_id)
    return department


def list_units(
    db: Session,
    *,
    access: AccessScope,
    plant_id: int | None = None,
    department_id: int | None = None,
    include_inactive: bool = False,
) -> Sequence[PlantDepartment]:
    """Units in (requested scope ∩ access), ordered by plant then department."""
    stmt = (
        select(PlantDepartment)
        .join(PlantDepartment.plant)
        .join(PlantDepartment.department)
        .where(*unit_conditions(plant_id, department_id), access.unit_condition())
        .options(joinedload(PlantDepartment.plant), joinedload(PlantDepartment.department))
        .order_by(Plant.code, Department.code)
    )
    if not include_inactive:
        stmt = stmt.where(PlantDepartment.is_active)
    return db.scalars(stmt).all()


def to_unit_read(unit: PlantDepartment) -> OrgUnitRead:
    return OrgUnitRead(
        plant_department_id=unit.id,
        plant=PlantRef.model_validate(unit.plant),
        department=DepartmentRef.model_validate(unit.department),
        is_active=unit.is_active,
    )
