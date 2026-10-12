from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.dependencies import get_db
from app.schemas.organization import (
    DepartmentDetail,
    DepartmentRead,
    PlantDetail,
    PlantRead,
)
from app.services import organization as org

router = APIRouter(prefix="/api", tags=["organization"])

DbSession = Annotated[Session, Depends(get_db)]
IncludeInactive = Annotated[
    bool, Query(description="Also return deactivated records.")
]


@router.get("/plants", response_model=list[PlantRead])
def list_plants(db: DbSession, include_inactive: IncludeInactive = False):
    return org.list_plants(db, include_inactive)


@router.get("/plants/{plant_id}", response_model=PlantDetail)
def get_plant(db: DbSession, plant_id: int, include_inactive: IncludeInactive = False):
    """A plant with the departments (units) that exist at it."""
    plant = org.get_plant(db, plant_id)
    units = org.list_units(db, plant_id=plant_id, include_inactive=include_inactive)
    return PlantDetail(
        **PlantRead.model_validate(plant).model_dump(),
        units=[org.to_unit_read(u) for u in units],
    )


@router.get("/departments", response_model=list[DepartmentRead])
def list_departments(
    db: DbSession,
    include_inactive: IncludeInactive = False,
    plant_id: Annotated[
        int | None, Query(description="Only departments that exist at this plant.")
    ] = None,
):
    return org.list_departments(db, include_inactive, plant_id)


@router.get("/departments/{department_id}", response_model=DepartmentDetail)
def get_department(
    db: DbSession, department_id: int, include_inactive: IncludeInactive = False
):
    """A shared department with every plant where it exists."""
    department = org.get_department(db, department_id)
    units = org.list_units(
        db, department_id=department_id, include_inactive=include_inactive
    )
    return DepartmentDetail(
        **DepartmentRead.model_validate(department).model_dump(),
        units=[org.to_unit_read(u) for u in units],
    )
