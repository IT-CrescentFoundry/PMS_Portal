"""KPI library (shared definitions + applicability) and scoring policies.

Since Stage K a scoring policy is the handle KPIs refer to; its rule is a
versioned KPI-scoring matrix (app/services/matrix_service.py) that the CHRO
approves. The policy endpoints kept from Stage J create and revise those
matrices from threshold bands.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.auth.permissions import Permission, Principal
from app.models import (
    KpiAggregation,
    KpiApplicability,
    KpiDefinition,
    KpiDirection,
    KpiScoringPolicy,
    Matrix,
    MatrixVersion,
    MatrixVersionStatus,
    PlantDepartment,
    ReportingFrequency,
)
from app.services import clock, matrix_rules, scoring
from app.services.audit import AuditActor, field_changes, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services import matrix_service
from app.services.applicability import (
    ApplicabilityInput,
    applicability_visible,
    applicability_writable,
)
from app.services.matrix_types import Source
from app.services.scope import AccessScope

__all__ = ["ApplicabilityInput", "applicability_visible", "applicability_writable"]


def _norm(text: str) -> str:
    return " ".join(text.split())


# --- applicability rules ----------------------------------------------------------------

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


def _require_policy_author(principal: Principal) -> None:
    if not principal.scope_for(Permission.MATRIX_WRITE).is_global:
        raise PermissionDeniedError("Scoring policies are company-wide matrix configurations; "
                                    "they need an HR Head with company-wide scope.")


def _band_draft(data: dict[str, Any], summary: str) -> matrix_service.DraftContent:
    definition = matrix_rules.definition_from_bands(
        data["direction"], data["bands"], data["fallback_score"], data["met_score"],
        data["breached_score"])
    return matrix_service.DraftContent(definition=definition, effective_from=None,
                                       effective_to=None,
                                       applicability=[ApplicabilityInput(None, None)],
                                       change_summary=summary)


def create_policy(db: Session, principal: Principal, actor: AuditActor, values: dict[str, Any]) -> KpiScoringPolicy:
    """Bands -> a new KPI-scoring matrix whose version 1 is a DRAFT: it scores
    nothing until submitted, approved by the CHRO and published."""
    _require_policy_author(principal)
    data = _policy_values(values)
    matrix = matrix_service.create_matrix(
        db, principal, actor, matrix_type="KPI_SCORING", name=data["name"],
        description=data["description"], attributes={"direction": data["direction"].value},
        applicability=[ApplicabilityInput(None, None)])
    matrix_service.save_draft(db, principal, actor, matrix, matrix_service.latest_version(matrix),
                              _band_draft(data, "Created from scoring bands."))
    policy = matrix_service.policy_for(db, matrix)
    assert policy is not None
    return policy


def update_policy(db: Session, principal: Principal, actor: AuditActor, policy_id: int,
                  values: dict[str, Any]) -> KpiScoringPolicy:
    """Bands -> the policy matrix's open draft, or a new draft revision.
    Approved and published versions never change in place."""
    _require_policy_author(principal)
    policy = get_policy(db, policy_id)
    data = _policy_values(values)
    if data["direction"] != policy.direction:
        raise ConflictError("A policy's direction cannot change; create a new policy instead.")
    if policy.matrix_id is None:
        raise ConflictError("This policy predates versioned matrices; configure a new KPI "
                            "scoring matrix instead.")
    matrix = matrix_service.get_matrix(db, principal, policy.matrix_id)
    if data["name"] != matrix.name or data["description"] != matrix.description:
        matrix_service.update_matrix(db, principal, actor, matrix.id, name=data["name"],
                                     description=data["description"])
    version = matrix_service.open_version(matrix)
    if version is not None and version.status != MatrixVersionStatus.DRAFT:
        raise ConflictError("A version of this policy is awaiting CHRO approval.")
    if version is None:
        version = matrix_service.revise(db, principal, actor, matrix)
        matrix = matrix_service.get_matrix(db, principal, matrix.id)
        version = next(v for v in matrix.versions if v.id == version.id)
    matrix_service.save_draft(db, principal, actor, matrix, version,
                              _band_draft(data, "Updated from scoring bands."))
    policy.is_active = bool(values.get("is_active", True))
    db.flush()
    return policy


def policy_matrix(db: Session, policy: KpiScoringPolicy) -> Matrix | None:
    if policy.matrix_id is None:
        return None
    return db.scalars(select(Matrix).where(Matrix.id == policy.matrix_id)
                      .options(selectinload(Matrix.versions).selectinload(MatrixVersion.scopes))
                      ).one_or_none()


def preview_policy(db: Session, policy: KpiScoringPolicy, *, achievement: Any = None,
                   actual: Any = None) -> dict[str, Any]:
    """Score for an achievement % (or an actual), using the version in force
    today, else the latest version (a draft is labelled as such)."""
    matrix = policy_matrix(db, policy)
    if matrix is None:  # Stage J policy without a matrix: its frozen bands
        return {"score": scoring.evaluate(scoring.snapshot(policy), achievement=achievement,
                                          actual=actual),
                "matrix_version_id": None, "version_no": None, "status": None}
    version = (matrix_service.version_in_force(matrix, clock.today())
               or matrix_service.latest_version(matrix))
    definition, _report = matrix_rules.analyse(matrix_service.spec_for(matrix.matrix_type),
                                               version.definition, matrix.attributes)
    inputs: dict[str, Any] = {}
    for f in definition.inputs:
        if f.source == Source.PERCENT_OF_TARGET and achievement is not None:
            inputs[f.key] = str(achievement)
        elif f.source == Source.ACTUAL and actual is not None:
            inputs[f.key] = str(actual)
    try:
        _definition, evaluation = matrix_service.evaluate_version(matrix, version, inputs)
    except matrix_rules.EvaluationError as exc:
        raise ValueError(str(exc)) from None
    return {"score": int(evaluation.outputs["score"]), "matrix_version_id": version.id,
            "version_no": version.version_no, "status": version.status.value}


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


def _measurement(values: dict[str, Any]) -> dict[str, Any]:
    """How the KPI is measured; publication requires it (see kpi_scoring)."""
    aggregation = values.get("aggregation")
    frequency = values.get("reporting_frequency")
    return {
        "aggregation": KpiAggregation(aggregation) if aggregation else None,
        "reporting_frequency": ReportingFrequency(frequency) if frequency else None,
        "measurement_method": (values.get("measurement_method") or "").strip()[:500] or None,
    }


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
        **_measurement(values),
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
    fields = ("name", "description", "unit", "default_scoring_policy_id", "data_source", "is_active",
              "aggregation", "reporting_frequency", "measurement_method")
    before = {f: getattr(kpi, f) for f in fields}
    kpi.name, kpi.description, kpi.unit = name, values.get("description"), _norm(values["unit"])
    kpi.default_scoring_policy_id = values["default_scoring_policy_id"]
    kpi.data_source, kpi.is_active = values.get("data_source"), bool(values.get("is_active", True))
    # Affects later publications only: published items keep a frozen copy.
    for key, value in _measurement(values).items():
        setattr(kpi, key, value)
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
