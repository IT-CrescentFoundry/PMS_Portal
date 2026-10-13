from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.dependencies import OrgScope, get_current_user
from app.dependencies import get_db
from app.schemas.reports import HeadcountResponse
from app.services import reports as svc

router = APIRouter(
    prefix="/api/reports", tags=["reports"], dependencies=[Depends(get_current_user)]
)


@router.get("/headcount", response_model=HeadcountResponse)
def headcount(
    db: Annotated[Session, Depends(get_db)],
    scope: OrgScope,
    plant_id: Annotated[int | None, Query(description="Omit for all plants.")] = None,
    department_id: Annotated[
        int | None, Query(description="Omit for all departments.")
    ] = None,
    as_of: Annotated[date | None, Query(description="Default: today.")] = None,
):
    """Headcount where each employee counts once, by primary assignment,
    limited to the caller's access.

    department_id + plant_id -> e.g. "Quality — Plant A"
    department_id only       -> e.g. "Quality — All Plants"
    """
    return svc.headcount(
        db,
        access=scope,
        as_of=as_of or date.today(),
        plant_id=plant_id,
        department_id=department_id,
    )
