from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.models import Department, Plant, PlantDepartment
from app.schemas.organization import DepartmentRef, OrgUnitRead, PlantRef
from app.services.errors import NotFoundError
from app.services.scope import unit_conditions


def list_plants(db: Session, include_inactive: bool = False) -> Sequence[Plant]:
    stmt = select(Plant).order_by(Plant.code)
    if not include_inactive:
        stmt = stmt.where(Plant.is_active)
    return db.scalars(stmt).all()


def get_plant(db: Session, plant_id: int) -> Plant:
    plant = db.get(Plant, plant_id)
    if plant is None:
        raise NotFoundError("Plant", plant_id)
    return plant


def list_departments(
    db: Session, include_inactive: bool = False, plant_id: int | None = None
) -> Sequence[Department]:
    """All departments, or only those that exist at `plant_id`."""
    stmt = select(Department).order_by(Department.code)
    if not include_inactive:
        stmt = stmt.where(Department.is_active)
    if plant_id is not None:
        get_plant(db, plant_id)  # 404 for an unknown plant
        stmt = stmt.join(PlantDepartment).where(PlantDepartment.plant_id == plant_id)
        if not include_inactive:
            stmt = stmt.where(PlantDepartment.is_active)
    return db.scalars(stmt).all()


def get_department(db: Session, department_id: int) -> Department:
    department = db.get(Department, department_id)
    if department is None:
        raise NotFoundError("Department", department_id)
    return department


def list_units(
    db: Session,
    plant_id: int | None = None,
    department_id: int | None = None,
    include_inactive: bool = False,
) -> Sequence[PlantDepartment]:
    """Plant-department units within a scope, ordered by plant then department."""
    stmt = (
        select(PlantDepartment)
        .join(PlantDepartment.plant)
        .join(PlantDepartment.department)
        .where(*unit_conditions(plant_id, department_id))
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
