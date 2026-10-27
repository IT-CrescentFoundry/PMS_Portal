"""Normalization cohorts of a quarter (Stage L).

When a quarter enters NORMALIZATION, each employee's frozen quarterly score
(employee_quarter_results) is placed in the cohort of their attribution unit
under the normalization policy in force on the quarter's start date
(a NORMALIZATION matrix version: CHRO-approved, versioned, hash-verified).
Within a cohort, app/services/normalization_policy.py ranks and places the
eligible employees; the policy's decision table then gives each placed
employee a normalized rating.

Runs are versioned with the quarter's results (app/services/versions.py):
the functions taking a quarter work on version 1; a correction of the
published quarter renormalizes the cohorts it affects as runs of its own
version (app/services/corrections.py). Each run's review step is its
version's phase.

Tied employees and small cohorts are placed by the policy's explicit rule, or
by an authorized reviewer with a reason. A cohort is approved by an HR Head
or the CHRO whose scope covers every member, and who placed none of them.
Nothing here changes a score: normalization adds a group and a rating.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.auth.permissions import Permission, Principal
from app.models import (
    CohortLevel,
    EmployeeAssignment,
    EmployeeQuarterResult,
    MatrixVersion,
    NormalizationPlacement,
    NormalizationRun,
    NormalizationRunStatus,
    PmsCycleQuarter,
    QuarterStatus,
)
from app.services import matrix_service, versions
from app.services import matrix_rules as rules
from app.services import normalization_policy as policy
from app.services.audit import AuditActor, record_event
from app.services.errors import (
    ConflictError,
    Issue,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.services.kpi_sheets import get_quarter
from app.services.matrix_types import NORMALIZATION

CENT = Decimal("0.01")
MANUAL = (NormalizationPlacement.TIE_RESOLVED, NormalizationPlacement.SMALL_COHORT_RESOLVED)
PLACEABLE = (NormalizationPlacement.NEEDS_RESOLUTION, *MANUAL)
ACTIVE = (NormalizationRunStatus.DRAFT, NormalizationRunStatus.APPROVED,
          NormalizationRunStatus.PUBLISHED)


def policy_for(db: Session, quarter: PmsCycleQuarter, plant_id: int,
               department_id: int) -> MatrixVersion | None:
    """The normalization policy version in force for a unit on the quarter's start."""
    return matrix_service.resolve_by_type(db, NORMALIZATION.code, quarter.start_date, plant_id,
                                          department_id)


def frozen_policy(version: MatrixVersion) -> tuple[rules.Definition, policy.Settings]:
    """An approved policy version's rules and settings, verified against its hash."""
    definition = matrix_service.frozen_definition(version)
    report = rules.Report()
    settings = policy.parse_settings((version.definition or {}).get("settings"), report)
    if settings is None:
        raise matrix_service.IntegrityProblem(
            f"The settings of normalization policy version {version.id} cannot be read: "
            f"{report.errors[0].message}")
    return definition, settings


def clear_outcome(row: EmployeeQuarterResult) -> None:
    row.normalization_run_id = None
    row.rank = None
    row.group_key = None
    row.placement = None
    row.placement_options = None
    row.placement_reason = None
    row.placed_by_user_id = None
    row.placed_at = None
    row.normalized_rating = None
    row.rating_explanation = None


def rate(definition: rules.Definition, row: EmployeeQuarterResult) -> None:
    """The normalized rating from the policy's decision table, or why there is none."""
    if row.group_key is None:
        row.normalized_rating = None
        row.rating_explanation = None
        return
    inputs: dict[str, Any] = {"group": row.group_key}
    if definition.field("score") is not None:
        inputs["score"] = row.final_score
    try:
        evaluation = rules.evaluate(definition, inputs)
    except rules.EvaluationError as exc:
        row.normalized_rating = None
        row.rating_explanation = {"error": str(exc)}
        return
    value = evaluation.outputs.get("rating")
    row.normalized_rating = (None if value is None
                             else Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP))
    row.rating_explanation = evaluation.as_dict(definition)


# --- planning --------------------------------------------------------------------------------

@dataclass
class CohortPlan:
    key: str
    version: MatrixVersion
    definition: rules.Definition
    settings: policy.Settings
    level: CohortLevel
    plant_id: int | None
    department_id: int | None
    rows: list[EmployeeQuarterResult] = field(default_factory=list)

    def eligible(self, row: EmployeeQuarterResult) -> bool:
        codes = self.settings.eligible_designations
        return not codes or row.primary_assignment.designation.code in codes

    def candidates(self) -> list[policy.Candidate]:
        exact = self.settings.rank_by == "EXACT_SCORE"
        return [policy.Candidate(r.employee_id, r.calculated_score if exact else r.final_score,
                                 self.eligible(r)) for r in self.rows]

    def digest(self) -> str:
        data = {"version": self.version.id, "policy_sha256": self.version.definition_hash,
                "members": sorted([c.employee_id, rules.decimal_text(c.score), c.eligible]
                                  for c in self.candidates())}
        return hashlib.sha256(rules.canonical_json(data).encode("utf-8")).hexdigest()


def _rows(db: Session, quarter: PmsCycleQuarter) -> list[EmployeeQuarterResult]:
    return db.scalars(
        select(EmployeeQuarterResult)
        .where(EmployeeQuarterResult.cycle_quarter_id == quarter.id,
               EmployeeQuarterResult.version_no == 1)
        .options(joinedload(EmployeeQuarterResult.employee),
                 joinedload(EmployeeQuarterResult.primary_assignment)
                 .joinedload(EmployeeAssignment.designation))
        .order_by(EmployeeQuarterResult.employee_id)).unique().all()


def plan(db: Session, quarter: PmsCycleQuarter) -> dict[str, CohortPlan]:
    """Which cohort each frozen employee result belongs to, under which policy."""
    cohorts: dict[str, CohortPlan] = {}
    frozen: dict[int, tuple[rules.Definition, policy.Settings]] = {}
    for row in _rows(db, quarter):
        version = policy_for(db, quarter, row.plant_id, row.department_id)
        if version is None:
            raise ConflictError(f"No approved normalization policy applies to "
                                f"{row.employee.employee_code}'s home unit.")
        if version.id not in frozen:
            frozen[version.id] = frozen_policy(version)
        definition, settings = frozen[version.id]
        level = settings.cohort_level
        plant = row.plant_id if level in (CohortLevel.PLANT, CohortLevel.PLANT_DEPARTMENT) else None
        dept = (row.department_id if level in (CohortLevel.DEPARTMENT, CohortLevel.PLANT_DEPARTMENT)
                else None)
        key = f"{version.id}:{level.value}:{plant or '*'}:{dept or '*'}"
        cohort = cohorts.setdefault(key, CohortPlan(key, version, definition, settings, level,
                                                    plant, dept))
        cohort.rows.append(row)
    return cohorts


def compute(db: Session, principal: Principal, quarter: PmsCycleQuarter) -> int:
    """(Re)build the quarter's cohorts. A cohort whose members, scores and
    policy are unchanged keeps its placements and approval."""
    cohorts = plan(db, quarter)
    existing = {r.cohort_key: r for r in db.scalars(select(NormalizationRun).where(
        NormalizationRun.cycle_quarter_id == quarter.id, NormalizationRun.version_no == 1))}
    place_cohorts(db, principal, quarter, cohorts, existing, version_no=1)
    for key, run in existing.items():
        if key not in cohorts and run.status != NormalizationRunStatus.PUBLISHED:
            run.status = NormalizationRunStatus.DISCARDED
    db.flush()
    return len(cohorts)


def place_cohorts(db: Session, principal: Principal, quarter: PmsCycleQuarter,
                  cohorts: dict[str, CohortPlan], existing: dict[str, NormalizationRun], *,
                  version_no: int) -> None:
    """Create or refresh one run per cohort of `version_no` and place its
    members. A run whose inputs are unchanged keeps its placements and
    approval."""
    for key, cohort in cohorts.items():
        digest = cohort.digest()
        run = existing.get(key)
        if (run is not None and run.status in (NormalizationRunStatus.DRAFT,
                                               NormalizationRunStatus.APPROVED)
                and run.inputs_hash == digest
                and all(r.normalization_run_id == run.id for r in cohort.rows)):
            continue
        outcome = policy.place(cohort.settings, cohort.candidates())
        if run is None:
            run = NormalizationRun(cycle_quarter_id=quarter.id, matrix_version_id=cohort.version.id,
                                   cohort_level=cohort.level, plant_id=cohort.plant_id,
                                   department_id=cohort.department_id, cohort_key=key,
                                   version_no=version_no, population=0, eligible=0, targets={},
                                   exceptions=[], inputs_hash=digest)
            db.add(run)
            db.flush()
        run.status = NormalizationRunStatus.DRAFT
        run.matrix_version_id = cohort.version.id
        run.approved_by_user_id = None
        run.approved_at = None
        run.approval_note = None
        run.population = len(cohort.rows)
        run.eligible = sum(1 for c in cohort.candidates() if c.eligible)
        run.small_cohort = outcome.small_cohort
        run.targets = outcome.targets
        run.exceptions = outcome.exceptions
        run.inputs_hash = digest
        run.computed_by_user_id = principal.user_id
        run.computed_at = func.now()
        by_employee = {r.employee_id: r for r in cohort.rows}
        for placed in outcome.placed:
            row = by_employee[placed.employee_id]
            clear_outcome(row)
            row.normalization_run_id = run.id
            row.rank = placed.rank
            row.group_key = placed.group
            row.placement = placed.placement
            row.placement_options = placed.options
            rate(cohort.definition, row)
    db.flush()


# --- viewing ---------------------------------------------------------------------------------

@dataclass
class RunView:
    run: NormalizationRun
    members: list[EmployeeQuarterResult]
    definition: rules.Definition | None
    settings: policy.Settings | None
    problem: str | None  # the policy could not be read
    phase: QuarterStatus  # the review step of the run's version

    @property
    def label(self) -> str:
        r = self.run
        match r.cohort_level:
            case CohortLevel.COMPANY:
                return "Whole company"
            case CohortLevel.PLANT:
                return f"{r.plant.name}: all departments"
            case CohortLevel.DEPARTMENT:
                return f"{r.department.name}: all plants"
        return f"{r.department.name} — {r.plant.name}"

    @property
    def actual(self) -> dict[str, int]:
        keys = self.settings.keys if self.settings else sorted(self.run.targets)
        return {k: sum(1 for m in self.members if m.group_key == k) for k in keys}

    @property
    def unresolved(self) -> list[EmployeeQuarterResult]:
        return [m for m in self.members if m.placement == NormalizationPlacement.NEEDS_RESOLUTION]

    @property
    def rating_errors(self) -> list[EmployeeQuarterResult]:
        return [m for m in self.members if m.group_key is not None and m.normalized_rating is None]

    @property
    def placers(self) -> set[int]:
        return {m.placed_by_user_id for m in self.members if m.placed_by_user_id}

    @property
    def units(self) -> list[tuple[int, int]]:
        return [(m.plant_id, m.department_id) for m in self.members]


def _view(db: Session, run: NormalizationRun) -> RunView:
    members = db.scalars(
        select(EmployeeQuarterResult).where(EmployeeQuarterResult.normalization_run_id == run.id)
        .options(joinedload(EmployeeQuarterResult.employee),
                 joinedload(EmployeeQuarterResult.primary_assignment)
                 .joinedload(EmployeeAssignment.designation))).unique().all()
    members = sorted(members, key=lambda m: (m.rank is None, m.rank or 0, m.employee.employee_code))
    try:
        definition, settings = frozen_policy(run.matrix_version)
        problem = None
    except (matrix_service.IntegrityProblem, rules.EvaluationError) as exc:
        definition, settings, problem = None, None, str(exc)
    return RunView(run, members, definition, settings, problem,
                   versions.phase(db, run.quarter, run.version_no))


def _visible(principal: Principal, view: RunView) -> bool:
    return bool(view.members) and all(principal.org_scope.allows_unit(*u) for u in view.units)


def _covers(principal: Principal, view: RunView) -> bool:
    scope = principal.scope_for(Permission.SCORE_PUBLISH)
    return bool(view.members) and all(scope.allows_unit(*u) for u in view.units)


def _run_query():
    return select(NormalizationRun).options(
        joinedload(NormalizationRun.quarter), joinedload(NormalizationRun.plant),
        joinedload(NormalizationRun.department),
        joinedload(NormalizationRun.matrix_version).joinedload(MatrixVersion.matrix))


def list_runs(db: Session, principal: Principal, quarter_id: int) -> list[RunView]:
    if principal.org_scope.is_empty:
        raise PermissionDeniedError("You do not have access to organizational data.")
    quarter = get_quarter(db, quarter_id)
    runs = db.scalars(_run_query().where(NormalizationRun.cycle_quarter_id == quarter.id,
                                         NormalizationRun.status.in_(ACTIVE))
                      .order_by(NormalizationRun.id)).unique().all()
    # The working run of each cohort: a correction's version when it has one.
    views = [_view(db, r) for r in versions.latest(runs, lambda r: r.cohort_key).values()]
    return sorted((v for v in views if _visible(principal, v)), key=lambda v: v.label)


def get_run(db: Session, principal: Principal, run_id: int) -> RunView:
    run = db.scalars(_run_query().where(NormalizationRun.id == run_id)).unique().one_or_none()
    if run is None or run.status == NormalizationRunStatus.DISCARDED:
        raise NotFoundError("Normalization cohort", run_id)
    view = _view(db, run)
    if not _visible(principal, view):
        raise NotFoundError("Normalization cohort", run_id)
    return view


def cohort_counts(db: Session, principal: Principal, quarter: PmsCycleQuarter) -> dict[str, int]:
    views = list_runs(db, principal, quarter.id)
    return {
        "total": len(views),
        "approved": sum(1 for v in views if v.run.status in (NormalizationRunStatus.APPROVED,
                                                             NormalizationRunStatus.PUBLISHED)),
        "unresolved": sum(len(v.unresolved) for v in views),
    }


@dataclass
class RunActions:
    can_place: bool
    can_approve: bool
    can_reopen: bool


def actions(principal: Principal, view: RunView) -> RunActions:
    in_review = view.phase == QuarterStatus.NORMALIZATION
    covers = _covers(principal, view)
    draft = view.run.status == NormalizationRunStatus.DRAFT
    member = _is_member(principal, view)
    return RunActions(
        can_place=in_review and draft and covers
        and any(m.placement in PLACEABLE and m.employee_id != principal.employee_id
                for m in view.members),
        can_approve=in_review and draft and covers and view.problem is None
        and not view.unresolved and not view.rating_errors
        and principal.user_id not in view.placers and not member,
        can_reopen=in_review and covers and view.run.status == NormalizationRunStatus.APPROVED,
    )


def _is_member(principal: Principal, view: RunView) -> bool:
    return principal.employee_id is not None and any(
        m.employee_id == principal.employee_id for m in view.members)


def approval_blockers(db: Session, quarter: PmsCycleQuarter) -> list[str]:
    """What stops the quarter's cohorts from being final (company-wide)."""
    blockers = []
    try:
        expected = plan(db, quarter)
    except (ConflictError, matrix_service.IntegrityProblem) as exc:
        return [str(exc)]
    runs = db.scalars(_run_query().where(NormalizationRun.cycle_quarter_id == quarter.id,
                                         NormalizationRun.version_no == 1,
                                         NormalizationRun.status.in_(ACTIVE))).unique().all()
    by_key = {r.cohort_key: r for r in runs}
    for key, cohort in expected.items():
        run = by_key.get(key)
        if run is None or run.inputs_hash != cohort.digest() or any(
                row.normalization_run_id != run.id for row in cohort.rows):
            blockers.append(f"A normalization cohort is out of date ({len(cohort.rows)} "
                            "employees); return the quarter to department review and back to "
                            "recompute it.")
            continue
        view = _view(db, run)
        if view.problem:
            blockers.append(f"{view.label}: {view.problem}")
        if view.unresolved:
            blockers.append(f"{view.label}: {len(view.unresolved)} employee(s) still need to be "
                            "placed by a reviewer.")
        if view.rating_errors:
            blockers.append(f"{view.label}: the policy gives no rating to "
                            f"{len(view.rating_errors)} employee(s).")
        if run.status == NormalizationRunStatus.DRAFT:
            blockers.append(f"{view.label}: awaits approval.")
    return blockers


# --- reviewer actions ----------------------------------------------------------------------

def _require_reviewable(principal: Principal, view: RunView) -> None:
    if view.phase != QuarterStatus.NORMALIZATION:
        raise ConflictError("Cohorts can change only while the quarter is in normalization.")
    if not _covers(principal, view):
        raise PermissionDeniedError("Normalization decisions need HR Head or CHRO authority over "
                                    "every employee of the cohort.")


def _audit(db: Session, actor: AuditActor, view: RunView, action: str, summary: str, *,
           reason: str | None = None, changes: dict[str, Any] | None = None) -> None:
    record_event(db, actor=actor, action=action, entity_type="normalization_run",
                 entity_id=view.run.id, summary=summary, reason=reason, changes=changes,
                 plant_id=view.run.plant_id, department_id=view.run.department_id)


def place_member(db: Session, principal: Principal, actor: AuditActor, run_id: int,
                 employee_id: int, group: str, reason: str) -> RunView:
    view = get_run(db, principal, run_id)
    _require_reviewable(principal, view)
    if view.run.status != NormalizationRunStatus.DRAFT:
        raise ConflictError("Reopen the approved cohort before changing a placement.")
    row = next((m for m in view.members if m.employee_id == employee_id), None)
    if row is None:
        raise NotFoundError("Cohort member", employee_id)
    if employee_id == principal.employee_id:
        raise PermissionDeniedError("You cannot place yourself; another authorized reviewer "
                                    "does.")
    if row.placement not in PLACEABLE:
        raise ConflictError("Only employees tied at a group boundary, or everyone in a small "
                            "cohort, are placed by a reviewer; the others follow the ranking.")
    options = row.placement_options or []
    if group not in options:
        raise ValidationFailedError([Issue(f"Choose one of: {', '.join(options)}.", "group")])
    if len(reason.strip()) < 10:
        raise ValidationFailedError([Issue("Explain the placement (at least 10 characters).",
                                           "reason")])
    if view.definition is None:
        raise ConflictError(view.problem or "The normalization policy cannot be read.")
    previous = row.group_key
    row.group_key = group
    row.placement = (NormalizationPlacement.SMALL_COHORT_RESOLVED if view.run.small_cohort
                     else NormalizationPlacement.TIE_RESOLVED)
    row.placement_reason = reason.strip()[:500]
    row.placed_by_user_id = principal.user_id
    row.placed_at = func.now()
    rate(view.definition, row)
    db.flush()
    _audit(db, actor, view, "normalization.place",
           f"Placed {row.employee.employee_code} in {view.settings.label(group)} ({view.label})",
           reason=row.placement_reason,
           changes={"employee_id": employee_id, "from": previous, "to": group,
                    "normalized_rating": row.normalized_rating})
    return get_run(db, principal, run_id)


def approve_run(db: Session, principal: Principal, actor: AuditActor, run_id: int,
                note: str | None) -> RunView:
    view = get_run(db, principal, run_id)
    _require_reviewable(principal, view)
    if view.run.status != NormalizationRunStatus.DRAFT:
        raise ConflictError("Only a cohort awaiting approval can be approved.")
    if view.problem:
        raise ConflictError(view.problem)
    if view.unresolved:
        raise ConflictError(f"{len(view.unresolved)} employee(s) still need to be placed.")
    if view.rating_errors:
        raise ConflictError("The policy gives no rating to some employees; it must be corrected "
                            "and the cohort recomputed.")
    if principal.user_id in view.placers:
        raise PermissionDeniedError("You placed employees in this cohort; a different HR Head or "
                                    "the CHRO must approve it.")
    if _is_member(principal, view):
        raise PermissionDeniedError("You are a member of this cohort; a different HR Head or the "
                                    "CHRO must approve it.")
    view.run.status = NormalizationRunStatus.APPROVED
    view.run.approved_by_user_id = principal.user_id
    view.run.approved_at = func.now()
    view.run.approval_note = (note or "").strip()[:1000] or None
    db.flush()
    _audit(db, actor, view, "normalization.approve", f"Approved the cohort {view.label}",
           changes={"targets": view.run.targets, "actual": view.actual,
                    "population": view.run.population, "inputs_sha256": view.run.inputs_hash})
    return get_run(db, principal, run_id)


def reopen_run(db: Session, principal: Principal, actor: AuditActor, run_id: int,
               reason: str) -> RunView:
    view = get_run(db, principal, run_id)
    _require_reviewable(principal, view)
    if view.run.status != NormalizationRunStatus.APPROVED:
        raise ConflictError("Only an approved cohort can be reopened.")
    if len(reason.strip()) < 10:
        raise ValidationFailedError([Issue("Explain why the cohort is reopened (at least 10 "
                                           "characters).", "reason")])
    view.run.status = NormalizationRunStatus.DRAFT
    view.run.approved_by_user_id = None
    view.run.approved_at = None
    view.run.approval_note = None
    db.flush()
    _audit(db, actor, view, "normalization.reopen", f"Reopened the cohort {view.label}",
           reason=reason.strip())
    return get_run(db, principal, run_id)


def publish_runs(db: Session, quarter: PmsCycleQuarter, version_no: int = 1) -> list[NormalizationRun]:
    runs = db.scalars(select(NormalizationRun).where(
        NormalizationRun.cycle_quarter_id == quarter.id,
        NormalizationRun.version_no == version_no,
        NormalizationRun.status == NormalizationRunStatus.APPROVED)
        .order_by(NormalizationRun.id)).all()
    for run in runs:
        run.status = NormalizationRunStatus.PUBLISHED
        run.published_at = func.now()
    return list(runs)


def describe_targets(view: RunView) -> list[dict[str, Any]]:
    """Per group: target and actual count and share, so the outcome can be
    checked against the intended distribution."""
    eligible = view.run.eligible or 0
    groups = view.settings.groups if view.settings else ()
    actual = view.actual
    rows = []
    for g in groups:
        count = actual.get(g.key, 0)
        rows.append({
            "key": g.key, "label": g.label, "target_percent": rules.decimal_text(g.percent),
            "target_count": int(view.run.targets.get(g.key, 0)), "actual_count": count,
            "actual_percent": rules.decimal_text(
                (Decimal(count) * 100 / eligible).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))
            if eligible else None,
        })
    return rows


def matches_targets(view: RunView) -> bool:
    return all(r["actual_count"] == r["target_count"] for r in describe_targets(view))

