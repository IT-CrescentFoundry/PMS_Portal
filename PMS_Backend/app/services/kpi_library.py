"""KPI library (shared definitions + applicability) and scoring policies."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.auth.permissions import Permission, Principal
from app.models import (
    KpiApplicability,
    KpiDefinition,
    KpiDirection,
    KpiScoringPolicy,
    PlantDepartment,
)
from app.services import scoring
from app.services.audit import AuditActor, field_changes, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services.scope import AccessScope, department_visible, plant_visible


@dataclass(frozen=True)
class ApplicabilityInput:
    plant_id: int | None
    department_id: int | None


def _norm(text: str) -> str:
    return " ".join(text.split())


# --- applicability rules ----------------------------------------------------------------

def applicability_visible(db: Session, access: AccessScope, a: KpiApplicability | ApplicabilityInput) -> bool:
    if access.is_empty:
        return False
    if a.plant_id is None and a.department_id is None:
        return True  # company-wide KPI
    if a.plant_id is not None and a.department_id is not None:
        return access.allows_unit(a.plant_id, a.department_id)
    if a.department_id is not None:
        return department_visible(db, access, a.department_id)
    return plant_visible(db, access, a.plant_id)  # type: ignore[arg-type]


def applicability_writable(access: AccessScope, a: ApplicabilityInput) -> bool:
    """A writer may only make a KPI applicable where their whole scope reaches."""
    if access.is_global:
        return True
    if a.plant_id is not None and a.department_id is not None:
        return access.allows_unit(a.plant_id, a.department_id)
    if a.department_id is not None:
        return a.department_id in access.department_ids
    if a.plant_id is not None:
        return a.plant_id in access.plant_ids
    return False  # company-wide needs GLOBAL


def applies_to_unit(kpi: KpiDefinition, plant_id: int, department_id: int) -> bool:
    return any(
        (a.plant_id in (None, plant_id)) and (a.department_id in (None, department_id))
        for a in kpi.applicabilities
    )


def kpi_visible(db: Session, access: AccessScope, kpi: KpiDefinition) -> bool:
    return any(applicability_visible(db, access, a) for a in kpi.applicabilities)


# --- scoring policies ---------------------------------------------------------------------

def list_policies(db: Session, include_inactive: bool = False) -> Sequence[KpiScoringPolicy]:
    stmt = select(KpiScoringPolicy).order_by(KpiScoringPolicy.code)
    if not include_inactive:
        stmt = stmt.where(KpiScoringPolicy.is_active)
    return db.scalars(stmt).all()


def get_policy(db: Session, policy_id: int) -> KpiScoringPolicy:
    policy = db.get(KpiScoringPolicy, policy_id)
    if policy is None:
        raise NotFoundError("Scoring policy", policy_id)
    return policy


def _policy_values(values: dict[str, Any]) -> dict[str, Any]:
    direction = KpiDirection(values["direction"])
    bands = [{"threshold": float(b["threshold"]), "score": int(b["score"])} for b in values.get("bands") or []]
    issues = scoring.validate_policy(direction, bands, values.get("fallback_score", 0),
                                     values.get("met_score"), values.get("breached_score"))
    if issues:
        raise ValidationFailedError(issues)
    return {
        "name": _norm(values["name"]),
        "description": values.get("description"),
        "direction": direction,
        "bands": bands,
        "fallback_score": values.get("fallback_score", 0) if direction != KpiDirection.ZERO_TOLERANCE else 0,
        "met_score": values.get("met_score") if direction == KpiDirection.ZERO_TOLERANCE else None,
        "breached_score": values.get("breached_score") if direction == KpiDirection.ZERO_TOLERANCE else None,
    }


def create_policy(db: Session, principal: Principal, actor: AuditActor, values: dict[str, Any]) -> KpiScoringPolicy:
    if not principal.scope_for(Permission.KPI_WRITE).is_global:
        raise PermissionDeniedError("Scoring policies are company-wide; they need company-wide KPI access.")
    data = _policy_values(values)
    if db.scalar(select(KpiScoringPolicy.id).where(KpiScoringPolicy.name == data["name"])):
        raise ConflictError("A scoring policy with this name already exists.")
    policy = KpiScoringPolicy(code="pending", **data)
    db.add(policy)
    db.flush()
    policy.code = f"POL-{policy.id:03d}"
    record_event(db, actor=actor, action="scoring_policy.create", entity_type="scoring_policy",
                 entity_id=policy.id, summary=f"Created scoring policy {policy.code} '{policy.name}'",
                 changes={"direction": data["direction"].value, "bands": data["bands"],
                          "fallback_score": data["fallback_score"]})
    return policy


def update_policy(db: Session, principal: Principal, actor: AuditActor, policy_id: int,
                  values: dict[str, Any]) -> KpiScoringPolicy:
    """Edits affect drafts only: published sheets keep a frozen copy."""
    if not principal.scope_for(Permission.KPI_WRITE).is_global:
        raise PermissionDeniedError("Scoring policies are company-wide; they need company-wide KPI access.")
    policy = get_policy(db, policy_id)
    data = _policy_values(values)
    if data["direction"] != policy.direction:
        raise ConflictError("A policy's direction cannot change; create a new policy instead.")
    clash = db.scalar(select(KpiScoringPolicy.id).where(
        KpiScoringPolicy.name == data["name"], KpiScoringPolicy.id != policy.id))
    if clash:
        raise ConflictError("A scoring policy with this name already exists.")
    fields = ("name", "description", "bands", "fallback_score", "met_score", "breached_score")
    before = {f: getattr(policy, f) for f in fields}
    for f in fields:
        setattr(policy, f, data[f])
    policy.is_active = bool(values.get("is_active", True))
    db.flush()
    record_event(db, actor=actor, action="scoring_policy.update", entity_type="scoring_policy",
                 entity_id=policy.id, summary=f"Updated scoring policy {policy.code}",
                 changes=field_changes(before, {f: getattr(policy, f) for f in fields}, fields))
    return policy


# --- KPI definitions -----------------------------------------------------------------------

def _load(db: Session):
    return select(KpiDefinition).options(
        selectinload(KpiDefinition.applicabilities).selectinload(KpiApplicability.plant),
        selectinload(KpiDefinition.applicabilities).selectinload(KpiApplicability.department),
        selectinload(KpiDefinition.default_scoring_policy),
    )


def list_definitions(
    db: Session,
    principal: Principal,
    *,
    plant_id: int | None = None,
    department_id: int | None = None,
    search: str | None = None,
    include_inactive: bool = False,
) -> list[KpiDefinition]:
    stmt = _load(db).order_by(KpiDefinition.name)
    if not include_inactive:
        stmt = stmt.where(KpiDefinition.is_active)
    term = (search or "").strip()
    if term:
        like = f"%{term.replace('%', r'\%').replace('_', r'\_')}%"
        stmt = stmt.where((KpiDefinition.name.like(like)) | (KpiDefinition.code.like(like)))
    result = []
    for kpi in db.scalars(stmt).all():
        if not kpi_visible(db, principal.org_scope, kpi):
            continue
        if plant_id is not None or department_id is not None:
            matches = any(
                (plant_id is None or a.plant_id in (None, plant_id))
                and (department_id is None or a.department_id in (None, department_id))
                for a in kpi.applicabilities
            )
            if not matches:
                continue
        result.append(kpi)
    return result


def get_definition(db: Session, principal: Principal, kpi_id: int) -> KpiDefinition:
    kpi = db.scalars(_load(db).where(KpiDefinition.id == kpi_id)).one_or_none()
    if kpi is None or not kpi_visible(db, principal.org_scope, kpi):
        raise NotFoundError("KPI", kpi_id)
    return kpi


def _check_applicabilities(db: Session, principal: Principal, scopes: list[ApplicabilityInput]) -> None:
    if not scopes:
        raise ValidationFailedError([Issue("Choose where this KPI applies.", "applicability")])
    keys = {(a.plant_id, a.department_id) for a in scopes}
    if len(keys) != len(scopes):
        raise ValidationFailedError([Issue("The same applicability is listed twice.", "applicability")])
    write_scope = principal.scope_for(Permission.KPI_WRITE)
    for a in scopes:
        if a.plant_id is not None and a.department_id is not None:
            exists = db.scalar(select(func.count()).select_from(PlantDepartment).where(
                PlantDepartment.plant_id == a.plant_id, PlantDepartment.department_id == a.department_id))
            if not exists:
                raise ValidationFailedError([Issue("That department is not set up at that plant.", "applicability")])
        if not applicability_writable(write_scope, a):
            raise PermissionDeniedError("You can only make KPIs applicable within your own scope.")


def _check_policy_direction(db: Session, policy_id: int, direction: KpiDirection) -> KpiScoringPolicy:
    policy = db.get(KpiScoringPolicy, policy_id)
    if policy is None or not policy.is_active:
        raise ValidationFailedError([Issue("Scoring policy not found or inactive.", "default_scoring_policy_id")])
    if policy.direction != direction:
        raise ValidationFailedError([Issue(
            "The scoring policy's direction must match the KPI's direction.", "default_scoring_policy_id")])
    return policy


def create_definition(db: Session, principal: Principal, actor: AuditActor, values: dict[str, Any],
                      scopes: list[ApplicabilityInput]) -> KpiDefinition:
    name = _norm(values["name"])
    direction = KpiDirection(values["direction"])
    _check_applicabilities(db, principal, scopes)
    _check_policy_direction(db, values["default_scoring_policy_id"], direction)
    if db.scalar(select(KpiDefinition.id).where(KpiDefinition.name == name)):
        raise ConflictError("A KPI with this name already exists in the library; reuse it instead.")
    kpi = KpiDefinition(
        code="pending", name=name, description=values.get("description"), unit=_norm(values["unit"]),
        direction=direction, default_scoring_policy_id=values["default_scoring_policy_id"],
        data_source=values.get("data_source"), created_by_user_id=principal.user_id,
        applicabilities=[KpiApplicability(plant_id=a.plant_id, department_id=a.department_id) for a in scopes],
    )
    db.add(kpi)
    db.flush()
    kpi.code = f"KPI-{kpi.id:04d}"
    record_event(db, actor=actor, action="kpi.create", entity_type="kpi", entity_id=kpi.id,
                 summary=f"Added {kpi.code} '{kpi.name}' to the KPI library",
                 changes={"applicability": [{"plant_id": a.plant_id, "department_id": a.department_id} for a in scopes]})
    return get_definition(db, principal, kpi.id)


def update_definition(db: Session, principal: Principal, actor: AuditActor, kpi_id: int,
                      values: dict[str, Any], scopes: list[ApplicabilityInput]) -> KpiDefinition:
    kpi = get_definition(db, principal, kpi_id)
    write_scope = principal.scope_for(Permission.KPI_WRITE)
    current = [ApplicabilityInput(a.plant_id, a.department_id) for a in kpi.applicabilities]
    if not all(applicability_writable(write_scope, a) for a in current):
        raise PermissionDeniedError("This KPI is shared beyond your scope; ask HR to change it.")
    _check_applicabilities(db, principal, scopes)
    if KpiDirection(values["direction"]) != kpi.direction:
        raise ConflictError("A KPI's direction cannot change; add a new KPI instead.")
    _check_policy_direction(db, values["default_scoring_policy_id"], kpi.direction)
    name = _norm(values["name"])
    if db.scalar(select(KpiDefinition.id).where(KpiDefinition.name == name, KpiDefinition.id != kpi.id)):
        raise ConflictError("A KPI with this name already exists in the library.")
    fields = ("name", "description", "unit", "default_scoring_policy_id", "data_source", "is_active")
    before = {f: getattr(kpi, f) for f in fields}
    kpi.name, kpi.description, kpi.unit = name, values.get("description"), _norm(values["unit"])
    kpi.default_scoring_policy_id = values["default_scoring_policy_id"]
    kpi.data_source, kpi.is_active = values.get("data_source"), bool(values.get("is_active", True))
    old_keys = sorted((a.plant_id or 0, a.department_id or 0) for a in current)
    new_keys = sorted((a.plant_id or 0, a.department_id or 0) for a in scopes)
    if old_keys != new_keys:
        kpi.applicabilities.clear()
        db.flush()
        kpi.applicabilities.extend(KpiApplicability(plant_id=a.plant_id, department_id=a.department_id) for a in scopes)
    db.flush()
    changes = field_changes(before, {f: getattr(kpi, f) for f in fields}, fields)
    if old_keys != new_keys:
        changes["applicability"] = {"from": old_keys, "to": new_keys}
    record_event(db, actor=actor, action="kpi.update", entity_type="kpi", entity_id=kpi.id,
                 summary=f"Updated {kpi.code} '{kpi.name}'", changes=changes)
    db.expire(kpi)
    return get_definition(db, principal, kpi.id)
