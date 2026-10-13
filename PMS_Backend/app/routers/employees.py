from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.dependencies import CurrentPrincipal, OrgScope, get_current_user
from app.dependencies import get_db
from app.schemas.employee import EmployeeDetail, EmployeeListResponse
from app.services import employees as svc

router = APIRouter(
    prefix="/api/employees", tags=["employees"], dependencies=[Depends(get_current_user)]
)

DbSession = Annotated[Session, Depends(get_db)]
AsOf = Annotated[
    date | None,
    Query(description="Evaluate assignments on this date (default: today)."),
]


@router.get("", response_model=EmployeeListResponse)
def list_employees(
    db: DbSession,
    scope: OrgScope,
    plant_id: Annotated[int | None, Query(description="Omit for all plants.")] = None,
    department_id: Annotated[
        int | None, Query(description="Omit for all departments.")
    ] = None,
    primary_only: Annotated[
        bool,
        Query(description="Only employees whose primary assignment is in scope."),
    ] = False,
    include_inactive: bool = False,
    search: Annotated[
        str | None,
        Query(max_length=100, description="Employee code or name contains (case-insensitive)."),
    ] = None,
    as_of: AsOf = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    return svc.list_employees(
        db,
        access=scope,
        as_of=as_of or date.today(),
        plant_id=plant_id,
        department_id=department_id,
        primary_only=primary_only,
        include_inactive=include_inactive,
        search=search,
        limit=limit,
        offset=offset,
    )


@router.get("/{employee_id}", response_model=EmployeeDetail)
def get_employee(
    db: DbSession, principal: CurrentPrincipal, employee_id: int, as_of: AsOf = None
):
    """One employee: in-scope assignments, or the full record for oneself."""
    if principal.org_scope.is_empty and not principal.can_read_self:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to employee records.",
        )
    return svc.get_employee(
        db,
        employee_id,
        as_of or date.today(),
        access=principal.org_scope,
        self_employee_id=principal.employee_id if principal.can_read_self else None,
    )
