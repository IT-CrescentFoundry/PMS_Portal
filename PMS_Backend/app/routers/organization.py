from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.dependencies import OrgScope, get_current_user
from app.dependencies import get_db
from app.schemas.organization import (
    DepartmentDetail,
    DepartmentRead,
    PlantDetail,
    PlantRead,
)
from app.services import organization as org

# Router-level dependency: every endpoint here requires authentication, even
# if a future endpoint forgets to declare its scope dependency.
router = APIRouter(
    prefix="/api", tags=["organization"], dependencies=[Depends(get_current_user)]
)

DbSession = Annotated[Session, Depends(get_db)]
IncludeInactive = Annotated[
    bool, Query(description="Also return deactivated records.")
]


@router.get("/plants", response_model=list[PlantRead])
def list_plants(db: DbSession, scope: OrgScope, include_inactive: IncludeInactive = False):
    """Plants the caller can see."""
    return org.list_plants(db, access=scope, include_inactive=include_inactive)


@router.get("/plants/{plant_id}", response_model=PlantDetail)
def get_plant(
    db: DbSession, scope: OrgScope, plant_id: int, include_inactive: IncludeInactive = False
):
    """A plant with the departments (units) at it that the caller can see."""
    plant = org.get_plant(db, plant_id, access=scope)
    units = org.list_units(
        db, access=scope, plant_id=plant_id, include_inactive=include_inactive
    )
    return PlantDetail(
        **PlantRead.model_validate(plant).model_dump(),
        units=[org.to_unit_read(u) for u in units],
    )


@router.get("/departments", response_model=list[DepartmentRead])
def list_departments(
    db: DbSession,
    scope: OrgScope,
    include_inactive: IncludeInactive = False,
    plant_id: Annotated[
        int | None, Query(description="Only departments that exist at this plant.")
    ] = None,
):
    return org.list_departments(
        db, access=scope, include_inactive=include_inactive, plant_id=plant_id
    )


@router.get("/departments/{department_id}", response_model=DepartmentDetail)
def get_department(
    db: DbSession,
    scope: OrgScope,
    department_id: int,
    include_inactive: IncludeInactive = False,
):
    """A shared department with every plant where the caller can see it."""
    department = org.get_department(db, department_id, access=scope)
    units = org.list_units(
        db, access=scope, department_id=department_id, include_inactive=include_inactive
    )
    return DepartmentDetail(
        **DepartmentRead.model_validate(department).model_dump(),
        units=[org.to_unit_read(u) for u in units],
    )
