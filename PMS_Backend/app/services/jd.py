"""Job descriptions: role-specific JDs with versioned content and the
three-step sign-off of the current JD format (Proposed by HOD/HR ->
Authorised by Plant Head -> Approved by CHRO).

Every function that changes data records an audit event in the caller's
transaction; the router commits once.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.auth.permissions import Permission, Principal
from app.models import (
    Department,
    Designation,
    JDVersionStatus,
    JobDescription,
    JobDescriptionVersion,
    Plant,
    PlantDepartment,
)
from app.services.audit import AuditActor, field_changes, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services.scope import AccessScope, department_visible

OPEN_STATUSES = (JDVersionStatus.DRAFT, JDVersionStatus.PROPOSED, JDVersionStatus.AUTHORISED)

# Version fields copied by "new revision" and editable in DRAFT.
CONTENT_FIELDS = (
    "format_no",
    "rev_issue_no",
    "effective_date",
    "vacancies",
    "vacancy_type",
    "nature_of_job",
    "hiring_reason",
    "replacement_of",
    "proposed_ctc",
    "available_budget",
    "min_qualification",
    "age_band_gender",
    "work_experience",
    "languages",
    "reports_to",
    "supervises",
    "hr_remarks",
    "responsibilities",
    "technical_competencies",
    "behavioural_competencies",
)


# --- visibility and permission ------------------------------------------------------

def _covers(db: Session, scope: AccessScope, jd: JobDescription) -> bool:
    """A plant-specific JD needs its unit; an all-plants JD needs the department."""
    if jd.plant_id is not None:
        return scope.allows_unit(jd.plant_id, jd.department_id)
    return department_visible(db, scope, jd.department_id)


def _can_write_all_plants(scope: AccessScope, department_id: int) -> bool:
    return scope.is_global or department_id in scope.department_ids


def _require(db: Session, principal: Principal, permission: Permission, jd: JobDescription) -> None:
    scope = principal.scope_for(permission)
    allowed = (
        _covers(db, scope, jd)
        if jd.plant_id is not None or permission != Permission.JD_WRITE
        else _can_write_all_plants(scope, jd.department_id)
    )
    if not allowed:
        raise PermissionDeniedError("You are not authorised for this step on this JD.")


def get_jd(db: Session, principal: Principal, jd_id: int) -> JobDescription:
    jd = db.scalars(
        select(JobDescription)
        .where(JobDescription.id == jd_id)
        .options(
            joinedload(JobDescription.department),
            joinedload(JobDescription.plant),
            joinedload(JobDescription.designation),
            selectinload(JobDescription.versions),
        )
    ).one_or_none()
    if jd is None or not _covers(db, principal.org_scope, jd):
        raise NotFoundError("Job description", jd_id)
    return jd


def get_version(db: Session, principal: Principal, jd_id: int, version_id: int) -> JobDescriptionVersion:
    jd = get_jd(db, principal, jd_id)
    version = next((v for v in jd.versions if v.id == version_id), None)
    if version is None:
        raise NotFoundError("JD version", version_id)
    return version


def list_jds(
    db: Session,
    principal: Principal,
    *,
    department_id: int | None = None,
    plant_id: int | None = None,
    search: str | None = None,
    include_inactive: bool = False,
) -> Sequence[JobDescription]:
    stmt = (
        select(JobDescription)
        .options(
            joinedload(JobDescription.department),
            joinedload(JobDescription.plant),
            joinedload(JobDescription.designation),
            selectinload(JobDescription.versions),
        )
        .order_by(JobDescription.title)
    )
    if not include_inactive:
        stmt = stmt.where(JobDescription.is_active)
    if department_id is not None:
        stmt = stmt.where(JobDescription.department_id == department_id)
    if plant_id is not None:
        # Plant filter includes all-plants JDs of departments at that plant.
        stmt = stmt.where(or_(JobDescription.plant_id == plant_id, JobDescription.plant_id.is_(None)))
    term = (search or "").strip()
    if term:
        like = f"%{term.replace('%', r'\%').replace('_', r'\_')}%"
        stmt = stmt.where(or_(JobDescription.title.like(like), JobDescription.code.like(like)))
    jds = db.scalars(stmt).unique().all()
    visible = [jd for jd in jds if _covers(db, principal.org_scope, jd)]
    if plant_id is not None:
        units = set(
            db.scalars(select(PlantDepartment.department_id).where(PlantDepartment.plant_id == plant_id))
        )
        visible = [jd for jd in visible if jd.plant_id is not None or jd.department_id in units]
    return visible


# --- content validation ---------------------------------------------------------------

def _validate_content(content: dict[str, Any], *, for_proposal: bool) -> list[Issue]:
    issues: list[Issue] = []
    sections = content.get("responsibilities") or []
    for i, section in enumerate(sections, 1):
        if not str(section.get("heading", "")).strip():
            issues.append(Issue(f"Responsibility section {i} needs a heading.", "responsibilities"))
        if not [p for p in section.get("points", []) if str(p).strip()]:
            issues.append(Issue(f"Responsibility section {i} needs at least one point.", "responsibilities"))
    for kind in ("technical_competencies", "behavioural_competencies"):
        for i, item in enumerate(content.get(kind) or [], 1):
            if not str(item.get("name", "")).strip():
                issues.append(Issue(f"{kind.split('_')[0].title()} competency {i} needs a description.", kind))
            if item.get("level") not in (1, 2, 3, 4, 5):
                issues.append(Issue(f"{kind.split('_')[0].title()} competency {i}: required level must be 1 to 5.", kind))
    if for_proposal:
        if not sections:
            issues.append(Issue("Add at least one responsibility section before proposing.", "responsibilities"))
        if not content.get("technical_competencies") and not content.get("behavioural_competencies"):
            issues.append(Issue("Add the required competencies before proposing.", "technical_competencies"))
    return issues


def _content_of(version: JobDescriptionVersion) -> dict[str, Any]:
    return {field: getattr(version, field) for field in CONTENT_FIELDS}


def _json_safe(values: dict[str, Any]) -> dict[str, Any]:
    return {k: (v.value if hasattr(v, "value") else v) for k, v in values.items()}


def _check_budget(principal: Principal, old: str | None, new: str | None) -> None:
    if (new or None) != (old or None) and not principal.is_hr:
        raise PermissionDeniedError('"Available budget for the department" is filled by HR only.')


# --- create / edit ----------------------------------------------------------------------

def create_jd(
    db: Session,
    principal: Principal,
    actor: AuditActor,
    *,
    title: str,
    department_id: int,
    plant_id: int | None,
    designation_id: int | None,
    content: dict[str, Any],
) -> JobDescription:
    title = " ".join(title.split())
    if db.get(Department, department_id) is None:
        raise ValidationFailedError([Issue("Department not found.", "department_id")])
    if plant_id is not None:
        if db.get(Plant, plant_id) is None:
            raise ValidationFailedError([Issue("Plant not found.", "plant_id")])
        exists = db.scalar(
            select(func.count()).select_from(PlantDepartment).where(
                PlantDepartment.plant_id == plant_id, PlantDepartment.department_id == department_id
            )
        )
        if not exists:
            raise ValidationFailedError([Issue("This department is not set up at that plant.", "plant_id")])
    if designation_id is not None and db.get(Designation, designation_id) is None:
        raise ValidationFailedError([Issue("Designation not found.", "designation_id")])

    jd = JobDescription(title=title, department_id=department_id, plant_id=plant_id,
                        designation_id=designation_id, code="pending", created_by_user_id=principal.user_id)
    _require(db, principal, Permission.JD_WRITE, jd)
    duplicate = db.scalar(
        select(JobDescription.id).where(
            JobDescription.department_id == department_id,
            JobDescription.plant_key == (plant_id or 0),
            JobDescription.title == title,
        )
    )
    if duplicate:
        raise ConflictError("A JD with this role title already exists for this department and plant.")
    _check_budget(principal, None, content.get("available_budget"))
    issues = _validate_content(content, for_proposal=False)
    if issues:
        raise ValidationFailedError(issues)

    db.add(jd)
    db.flush()
    jd.code = f"JD-{jd.id:05d}"
    version = JobDescriptionVersion(
        job_description_id=jd.id, version_no=1, status=JDVersionStatus.DRAFT,
        created_by_user_id=principal.user_id, **content,
    )
    db.add(version)
    db.flush()
    record_event(
        db, actor=actor, action="jd.create", entity_type="job_description", entity_id=jd.id,
        summary=f"Created JD {jd.code} '{jd.title}' (draft version 1)",
        plant_id=plant_id, department_id=department_id,
    )
    db.refresh(jd)
    return jd


def update_draft(
    db: Session,
    principal: Principal,
    actor: AuditActor,
    jd_id: int,
    version_id: int,
    *,
    content: dict[str, Any],
    title: str | None = None,
    designation_id: int | None = None,
) -> JobDescriptionVersion:
    version = get_version(db, principal, jd_id, version_id)
    jd = version.job_description
    _require(db, principal, Permission.JD_WRITE, jd)
    if version.status != JDVersionStatus.DRAFT:
        raise ConflictError("Only a draft version can be edited.")
    _check_budget(principal, version.available_budget, content.get("available_budget"))
    issues = _validate_content(content, for_proposal=False)
    if issues:
        raise ValidationFailedError(issues)

    before = _json_safe(_content_of(version))
    identity_changes: dict[str, Any] = {}
    ever_approved = any(v.status in (JDVersionStatus.APPROVED, JDVersionStatus.SUPERSEDED) for v in jd.versions)
    if title is not None and " ".join(title.split()) != jd.title:
        if ever_approved:
            raise ConflictError("The role title cannot change after a version has been approved.")
        new_title = " ".join(title.split())
        clash = db.scalar(
            select(JobDescription.id).where(
                JobDescription.department_id == jd.department_id,
                JobDescription.plant_key == (jd.plant_id or 0),
                JobDescription.title == new_title,
                JobDescription.id != jd.id,
            )
        )
        if clash:
            raise ConflictError("A JD with this role title already exists for this department and plant.")
        identity_changes["title"] = {"from": jd.title, "to": new_title}
        jd.title = new_title
    if designation_id != jd.designation_id:
        if designation_id is not None and db.get(Designation, designation_id) is None:
            raise ValidationFailedError([Issue("Designation not found.", "designation_id")])
        identity_changes["designation_id"] = {"from": jd.designation_id, "to": designation_id}
        jd.designation_id = designation_id
    for field, value in content.items():
        setattr(version, field, value)
    db.flush()
    changes = field_changes(before, _json_safe(_content_of(version)), CONTENT_FIELDS) | identity_changes
    record_event(
        db, actor=actor, action="jd.update", entity_type="job_description", entity_id=jd.id,
        summary=f"Edited draft version {version.version_no} of {jd.code}",
        changes={k: v for k, v in changes.items() if k != "available_budget"} | (
            {"available_budget": "changed"} if "available_budget" in changes else {}
        ),
        plant_id=jd.plant_id, department_id=jd.department_id,
    )
    return version


# --- sign-off workflow ------------------------------------------------------------------

def _audit_step(db: Session, actor: AuditActor, jd: JobDescription, version: JobDescriptionVersion,
                action: str, summary: str, reason: str | None = None) -> None:
    record_event(
        db, actor=actor, action=action, entity_type="job_description", entity_id=jd.id,
        summary=summary, reason=reason, plant_id=jd.plant_id, department_id=jd.department_id,
        changes={"version_no": version.version_no, "status": version.status.value},
    )


def propose(db: Session, principal: Principal, actor: AuditActor, jd_id: int, version_id: int) -> JobDescriptionVersion:
    version = get_version(db, principal, jd_id, version_id)
    jd = version.job_description
    _require(db, principal, Permission.JD_WRITE, jd)
    if version.status != JDVersionStatus.DRAFT:
        raise ConflictError("Only a draft can be proposed.")
    issues = _validate_content(_content_of(version), for_proposal=True)
    if issues:
        raise ValidationFailedError(issues)
    version.status = JDVersionStatus.PROPOSED
    version.proposed_by_user_id = principal.user_id
    version.proposed_at = func.now()
    version.returned_reason = None
    db.flush()
    _audit_step(db, actor, jd, version, "jd.propose", f"Proposed version {version.version_no} of {jd.code}")
    return version


def authorise(db: Session, principal: Principal, actor: AuditActor, jd_id: int, version_id: int) -> JobDescriptionVersion:
    version = get_version(db, principal, jd_id, version_id)
    jd = version.job_description
    _require(db, principal, Permission.JD_AUTHORISE, jd)
    if version.status != JDVersionStatus.PROPOSED:
        raise ConflictError("Only a proposed version can be authorised.")
    if version.proposed_by_user_id == principal.user_id:
        raise PermissionDeniedError("The person who proposed a JD cannot also authorise it.")
    version.status = JDVersionStatus.AUTHORISED
    version.authorised_by_user_id = principal.user_id
    version.authorised_at = func.now()
    db.flush()
    _audit_step(db, actor, jd, version, "jd.authorise", f"Authorised version {version.version_no} of {jd.code}")
    return version


def approve(db: Session, principal: Principal, actor: AuditActor, jd_id: int, version_id: int) -> JobDescriptionVersion:
    version = get_version(db, principal, jd_id, version_id)
    jd = version.job_description
    _require(db, principal, Permission.JD_APPROVE, jd)
    if version.status != JDVersionStatus.AUTHORISED:
        raise ConflictError("Only an authorised version can be approved.")
    if principal.user_id in (version.proposed_by_user_id, version.authorised_by_user_id):
        raise PermissionDeniedError("The final approver must be a different person from earlier signatories.")
    for other in jd.versions:
        if other.status == JDVersionStatus.APPROVED:
            other.status = JDVersionStatus.SUPERSEDED
    db.flush()  # release the one-approved-version key before approving this one
    version.status = JDVersionStatus.APPROVED
    version.approved_by_user_id = principal.user_id
    version.approved_at = func.now()
    db.flush()
    _audit_step(db, actor, jd, version, "jd.approve", f"Approved version {version.version_no} of {jd.code}")
    return version


def return_to_draft(db: Session, principal: Principal, actor: AuditActor, jd_id: int, version_id: int,
                    reason: str) -> JobDescriptionVersion:
    version = get_version(db, principal, jd_id, version_id)
    jd = version.job_description
    if version.status == JDVersionStatus.PROPOSED:
        permissions = (Permission.JD_AUTHORISE, Permission.JD_APPROVE)
    elif version.status == JDVersionStatus.AUTHORISED:
        permissions = (Permission.JD_APPROVE,)
    else:
        raise ConflictError("Only a version under review can be returned.")
    if not any(_covers(db, principal.scope_for(p), jd) for p in permissions):
        raise PermissionDeniedError("Only a reviewer of this step can return the JD.")
    if not reason.strip():
        raise ValidationFailedError([Issue("Give a reason for returning the JD.", "reason")])
    version.status = JDVersionStatus.DRAFT
    for field in ("proposed_by_user_id", "proposed_at", "authorised_by_user_id", "authorised_at"):
        setattr(version, field, None)
    version.returned_reason = reason.strip()[:1000]
    db.flush()
    _audit_step(db, actor, jd, version, "jd.return", f"Returned version {version.version_no} of {jd.code} to draft",
                reason=reason)
    return version


def new_revision(db: Session, principal: Principal, actor: AuditActor, jd_id: int) -> JobDescriptionVersion:
    jd = get_jd(db, principal, jd_id)
    _require(db, principal, Permission.JD_WRITE, jd)
    if any(v.status in OPEN_STATUSES for v in jd.versions):
        raise ConflictError("Finish or return the open version before starting a new revision.")
    approved = next((v for v in jd.versions if v.status == JDVersionStatus.APPROVED), None)
    if approved is None:
        raise ConflictError("A new revision starts from the approved version.")
    version = JobDescriptionVersion(
        job_description_id=jd.id,
        version_no=max(v.version_no for v in jd.versions) + 1,
        status=JDVersionStatus.DRAFT,
        created_by_user_id=principal.user_id,
        **_content_of(approved),
    )
    db.add(version)
    db.flush()
    _audit_step(db, actor, jd, version, "jd.revise",
                f"Started version {version.version_no} of {jd.code} from version {approved.version_no}")
    return version
