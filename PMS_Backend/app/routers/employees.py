from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.dependencies import get_db
from app.schemas.employee import EmployeeDetail, EmployeeListResponse
from app.services import employees as svc

router = APIRouter(prefix="/api/employees", tags=["employees"])

DbSession = Annotated[Session, Depends(get_db)]
AsOf = Annotated[
    date | None,
    Query(description="Evaluate assignments on this date (default: today)."),
]


@router.get("", response_model=EmployeeListResponse)
def list_employees(
    db: DbSession,
    plant_id: Annotated[int | None, Query(description="Omit for all plants.")] = None,
    department_id: Annotated[
        int | None, Query(description="Omit for all departments.")
    ] = None,
    primary_only: Annotated[
        bool,
        Query(description="Only employees whose primary assignment is in scope."),
    ] = False,
    include_inactive: bool = False,
    as_of: AsOf = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    return svc.list_employees(
        db,
        as_of=as_of or date.today(),
        plant_id=plant_id,
        department_id=department_id,
        primary_only=primary_only,
        include_inactive=include_inactive,
        limit=limit,
        offset=offset,
    )


@router.get("/{employee_id}", response_model=EmployeeDetail)
def get_employee(db: DbSession, employee_id: int, as_of: AsOf = None):
    """One employee with current assignments and full assignment history."""
    return svc.get_employee(db, employee_id, as_of or date.today())
