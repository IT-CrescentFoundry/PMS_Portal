from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import AuditActorDep, CurrentPrincipal, OrgScope, get_current_user
from app.dependencies import get_db, transaction
from app.models import JDVersionStatus, JobDescription, JobDescriptionVersion, User
from app.schemas.employee import DesignationRef
from app.schemas.jd import (
    JDContent,
    JDCreate,
    JDDetail,
    JDSummary,
    JDUpdate,
    JDVersionRead,
    JDVersionSummary,
    ReasonRequest,
    UserRef,
)
from app.schemas.organization import DepartmentRef, PlantRef
from app.services import jd as svc

router = APIRouter(prefix="/api/jds", tags=["job descriptions"], dependencies=[Depends(get_current_user)])
DbSession = Annotated[Session, Depends(get_db)]


def _user_refs(db: Session, ids: set[int | None]) -> dict[int, UserRef]:
    wanted = {i for i in ids if i}
    if not wanted:
        return {}
    return {u.id: UserRef(id=u.id, username=u.username)
            for u in db.scalars(select(User).where(User.id.in_(wanted)))}


def _summary(jd: JobDescription) -> dict:
    approved = next((v for v in jd.versions if v.status == JDVersionStatus.APPROVED), None)
    open_ = next((v for v in jd.versions if v.status in svc.OPEN_STATUSES), None)
    return dict(
        id=jd.id, code=jd.code, title=jd.title,
        department=DepartmentRef.model_validate(jd.department),
        plant=PlantRef.model_validate(jd.plant) if jd.plant else None,
        designation=DesignationRef.model_validate(jd.designation) if jd.designation else None,
        is_active=jd.is_active,
        approved_version=JDVersionSummary.model_validate(approved) if approved else None,
        open_version=JDVersionSummary.model_validate(open_) if open_ else None,
        updated_at=max([jd.updated_at, *(v.updated_at for v in jd.versions)]),
    )


def _detail(jd: JobDescription) -> JDDetail:
    return JDDetail(**_summary(jd), versions=[JDVersionSummary.model_validate(v) for v in
                                              sorted(jd.versions, key=lambda v: v.version_no, reverse=True)])


def _version(db: Session, v: JobDescriptionVersion) -> JDVersionRead:
    users = _user_refs(db, {v.created_by_user_id, v.proposed_by_user_id, v.authorised_by_user_id,
                            v.approved_by_user_id})
    content = {f: getattr(v, f) for f in JDContent.model_fields}
    return JDVersionRead(
        **content,
        id=v.id, job_description_id=v.job_description_id, version_no=v.version_no, status=v.status,
        created_at=v.created_at, updated_at=v.updated_at,
        created_by=users.get(v.created_by_user_id), proposed_by=users.get(v.proposed_by_user_id),
        proposed_at=v.proposed_at, authorised_by=users.get(v.authorised_by_user_id),
        authorised_at=v.authorised_at, approved_by=users.get(v.approved_by_user_id),
        approved_at=v.approved_at, returned_reason=v.returned_reason,
    )


@router.get("", response_model=list[JDSummary])
def list_jds(
    db: DbSession,
    principal: CurrentPrincipal,
    _scope: OrgScope,
    department_id: int | None = None,
    plant_id: int | None = None,
    search: Annotated[str | None, Query(max_length=100)] = None,
    include_inactive: bool = False,
):
    jds = svc.list_jds(db, principal, department_id=department_id, plant_id=plant_id,
                       search=search, include_inactive=include_inactive)
    return [JDSummary(**_summary(jd)) for jd in jds]


@router.post("", response_model=JDDetail, status_code=status.HTTP_201_CREATED)
def create_jd(body: JDCreate, db: DbSession, principal: CurrentPrincipal, _scope: OrgScope,
              actor: AuditActorDep):
    with transaction(db):
        jd = svc.create_jd(db, principal, actor, title=body.title, department_id=body.department_id,
                           plant_id=body.plant_id, designation_id=body.designation_id,
                           content=body.content())
    return _detail(svc.get_jd(db, principal, jd.id))


@router.get("/{jd_id}", response_model=JDDetail)
def get_jd(jd_id: int, db: DbSession, principal: CurrentPrincipal, _scope: OrgScope):
    return _detail(svc.get_jd(db, principal, jd_id))


@router.get("/{jd_id}/versions/{version_id}", response_model=JDVersionRead)
def get_version(jd_id: int, version_id: int, db: DbSession, principal: CurrentPrincipal, _scope: OrgScope):
    return _version(db, svc.get_version(db, principal, jd_id, version_id))


@router.put("/{jd_id}/versions/{version_id}", response_model=JDVersionRead)
def update_version(jd_id: int, version_id: int, body: JDUpdate, db: DbSession,
                   principal: CurrentPrincipal, _scope: OrgScope, actor: AuditActorDep):
    with transaction(db):
        version = svc.update_draft(db, principal, actor, jd_id, version_id, content=body.content(),
                                   title=body.title, designation_id=body.designation_id)
    return _version(db, version)


def _step(name: str):
    action = {"propose": svc.propose, "authorise": svc.authorise, "approve": svc.approve}[name]

    def endpoint(jd_id: int, version_id: int, db: DbSession, principal: CurrentPrincipal,
                 _scope: OrgScope, actor: AuditActorDep):
        with transaction(db):
            version = action(db, principal, actor, jd_id, version_id)
        return _version(db, version)

    endpoint.__name__ = f"{name}_version"
    endpoint.__doc__ = f"Sign-off step: {name} this version."
    return endpoint


for _name in ("propose", "authorise", "approve"):
    router.add_api_route(f"/{{jd_id}}/versions/{{version_id}}/{_name}", _step(_name), methods=["POST"],
                         response_model=JDVersionRead)


@router.post("/{jd_id}/versions/{version_id}/return", response_model=JDVersionRead)
def return_version(jd_id: int, version_id: int, body: ReasonRequest, db: DbSession,
                   principal: CurrentPrincipal, _scope: OrgScope, actor: AuditActorDep):
    """Send a version under review back to draft, with a reason."""
    with transaction(db):
        version = svc.return_to_draft(db, principal, actor, jd_id, version_id, body.reason)
    return _version(db, version)


@router.post("/{jd_id}/revisions", response_model=JDVersionRead, status_code=status.HTTP_201_CREATED)
def new_revision(jd_id: int, db: DbSession, principal: CurrentPrincipal, _scope: OrgScope,
                 actor: AuditActorDep):
    """Start a new draft version from the approved one."""
    with transaction(db):
        version = svc.new_revision(db, principal, actor, jd_id)
    return _version(db, version)
