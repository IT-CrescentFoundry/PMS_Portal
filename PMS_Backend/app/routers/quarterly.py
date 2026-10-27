"""Quarterly review, consolidation, normalization and publication API (Stage L)."""
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import AuditActorDep, CurrentPrincipal, get_current_user
from app.auth.permissions import Principal
from app.dependencies import get_db, transaction
from app.models import (
    Department,
    EmployeeQuarterResult,
    KpiSheetComment,
    KpiSheetResult,
    MatrixVersion,
    NormalizationRun,
    Plant,
    SheetCommentKind,
    User,
)
from app.routers.kpi import _assignment, _quarter, item_read
from app.schemas.employee import EmployeeRef
from app.schemas.jd import ReasonRequest, UserRef
from app.schemas.organization import DepartmentRef, PlantRef
from app.schemas.quarterly import (
    CohortProgress,
    CommentCreate,
    CommentList,
    CommentRead,
    ComponentRead,
    EmployeeProgress,
    EmployeeResultRead,
    GroupDistribution,
    MemberRead,
    EmployeeVersionRead,
    NormalizationOutcome,
    OpenCorrection,
    OwnOutcome,
    OwnSheet,
    PlacementRequest,
    PolicyVersionRef,
    QuarterActions,
    QuarterOverview,
    RunActionsRead,
    RunApprove,
    RunRead,
    RunSummary,
    SheetProgress,
    TransitionRequest,
    WeightsWrite,
)
from app.auth.permissions import Permission
from app.services import kpi_sheets, normalization, quarterly, sheet_comments
from app.services import matrix_rules as rules
from app.services import normalization_policy as policy
from app.services.kpi_results import get_sheet

router = APIRouter(prefix="/api/kpi", tags=["quarterly review"],
                   dependencies=[Depends(get_current_user)])
DbSession = Annotated[Session, Depends(get_db)]


def _text(value: Any) -> str | None:
    return None if value is None else rules.decimal_text(value)


def _users(db: Session, ids: set[int | None]) -> dict[int, UserRef]:
    wanted = sorted(i for i in ids if i)
    if not wanted:
        return {}
    return {u.id: UserRef(id=u.id, username=u.username)
            for u in db.scalars(select(User).where(User.id.in_(wanted)))}


def _places(db: Session, plant_ids: set[int], department_ids: set[int]):
    plants = {p.id: PlantRef.model_validate(p) for p in db.scalars(
        select(Plant).where(Plant.id.in_(sorted(plant_ids) or [0])))}
    departments = {d.id: DepartmentRef.model_validate(d) for d in db.scalars(
        select(Department).where(Department.id.in_(sorted(department_ids) or [0])))}
    return plants, departments


# --- quarter ---------------------------------------------------------------------------------

def _overview(db: Session, principal: Principal, quarter_id: int) -> QuarterOverview:
    ov = quarterly.overview(db, principal, quarter_id)
    q = ov.quarter
    publisher = _users(db, {q.published_by_user_id}).get(q.published_by_user_id or 0)
    c = ov.open_correction
    return QuarterOverview(
        quarter=_quarter(q), next_status=ov.next_status, previous_status=ov.previous_status,
        sheets=SheetProgress(**ov.sheets), employees=EmployeeProgress(**ov.employees),
        cohorts=CohortProgress(**ov.cohorts), unscorable_sheets=ov.unscorable_sheets,
        blockers=ov.blockers, feedback_enabled=q.feedback_enabled, published_at=q.published_at,
        published_by=publisher,
        actions=QuarterActions(
            can_advance=ov.can_advance, can_return=ov.can_return, can_publish=ov.can_publish,
            can_request_correction=ov.published_version is not None and c is None
            and not principal.scope_for(Permission.QUARTER_CORRECTION_REQUEST).is_empty),
        published_version=ov.published_version,
        open_correction=OpenCorrection(id=c.id, status=c.status.value, version_no=c.version_no)
        if c else None)


@router.get("/quarters/{quarter_id}/overview", response_model=QuarterOverview)
def quarter_overview(quarter_id: int, db: DbSession, principal: CurrentPrincipal):
    """Progress through the quarter's review steps, within the caller's access;
    company-wide blockers of the next step for those who take it."""
    return _overview(db, principal, quarter_id)


@router.post("/quarters/{quarter_id}/transition", response_model=QuarterOverview)
def transition(quarter_id: int, body: TransitionRequest, db: DbSession,
               principal: CurrentPrincipal, actor: AuditActorDep):
    """One step forward (gated) or back (with a reason): GLOBAL quarter:start."""
    with transaction(db):
        quarterly.transition(db, principal, actor, quarter_id, body.to, body.reason)
    return _overview(db, principal, quarter_id)


@router.post("/quarters/{quarter_id}/publish", response_model=QuarterOverview)
def publish(quarter_id: int, db: DbSession, principal: CurrentPrincipal, actor: AuditActorDep):
    """Publish every result of a quarter ready for publication: GLOBAL score:publish."""
    with transaction(db):
        quarterly.publish(db, principal, actor, quarter_id)
    return _overview(db, principal, quarter_id)


# --- employee results ------------------------------------------------------------------------

def _run_labels(db: Session, run_ids: set[int]) -> dict[int, tuple[str, policy.Settings | None,
                                                               NormalizationRun]]:
    found = {}
    for run_id in run_ids:
        run = db.get(NormalizationRun, run_id)
        view = normalization._view(db, run)
        found[run_id] = (view.label, view.settings, run)
    return found


def _employee_reads(db: Session, principal: Principal,
                    views: list[quarterly.EmployeeView]) -> list[EmployeeResultRead]:
    rows = [v.row for v in views if v.row is not None]
    plant_ids = {u[0] for v in views for u in v.units} | {v.home[0] for v in views if v.home}
    dept_ids = {u[1] for v in views for u in v.units} | {v.home[1] for v in views if v.home}
    plants, departments = _places(db, plant_ids, dept_ids)
    runs = _run_labels(db, {r.normalization_run_id for r in rows if r.normalization_run_id})
    users = _users(db, {r.placed_by_user_id for r in rows})
    result_ids = [c.get("result_id") for r in rows for c in r.components if c.get("result_id")]
    statuses = {r.id: r.status for r in db.scalars(select(KpiSheetResult).where(
        KpiSheetResult.id.in_(result_ids or [0])))}
    scope = principal.org_scope
    reads = []
    for v in views:
        home = v.home
        if v.row is not None:
            row = v.row
            components = [ComponentRead(
                assignment_id=c["assignment_id"], sheet_id=c["sheet_id"],
                plant=plants[c["plant_id"]], department=departments[c["department_id"]],
                is_primary=c["is_primary"], result_status=statuses.get(c.get("result_id")),
                score=c["score"], score_source=c["score_source"], weight=c["weight"],
                contribution=c["contribution"], problems=[],
                can_open_sheet=scope.allows_unit(c["plant_id"], c["department_id"]))
                for c in row.components]
            outcome = None
            if row.normalization_run_id:
                label, settings, run = runs[row.normalization_run_id]
                outcome = NormalizationOutcome(
                    run_id=run.id, cohort_label=label, run_status=run.status, rank=row.rank,
                    group_key=row.group_key,
                    group_label=settings.label(row.group_key) if settings and row.group_key else None,
                    placement=row.placement, placement_reason=row.placement_reason,
                    placed_by=users.get(row.placed_by_user_id or 0),
                    normalized_rating=_text(row.normalized_rating),
                    rating_explanation=row.rating_explanation)
            reads.append(EmployeeResultRead(
                employee=EmployeeRef.model_validate(v.employee), quarter_id=v.quarter.id,
                status=row.status.value, home_plant=plants[row.plant_id],
                home_department=departments[row.department_id], weights_source=row.weights_source,
                calculated_score=_text(row.calculated_score), final_score=_text(row.final_score),
                ready=True, issues=[], components=components, normalization=outcome,
                can_set_weights=False, version_no=row.version_no))
            continue
        c = v.consolidation
        components = []
        for comp in c.components:
            unit = comp.assignment.plant_department
            r = comp.view.result
            components.append(ComponentRead(
                assignment_id=comp.assignment.id, sheet_id=comp.view.sheet.id,
                plant=plants[unit.plant_id], department=departments[unit.department_id],
                is_primary=comp.assignment.is_primary, result_status=r.status if r else None,
                score=_text(comp.score), score_source=comp.score_source,
                weight=_text(comp.weight), contribution=_text(comp.contribution),
                problems=quarterly.sheet_problems(comp.view, for_review=True),
                can_open_sheet=scope.allows_unit(unit.plant_id, unit.department_id)))
        reads.append(EmployeeResultRead(
            employee=EmployeeRef.model_validate(v.employee), quarter_id=v.quarter.id, status="LIVE",
            home_plant=plants[home[0]] if home else None,
            home_department=departments[home[1]] if home else None,
            weights_source=c.weights_source, calculated_score=_text(c.calculated),
            final_score=_text(c.final), ready=c.ready, issues=c.issues(), components=components,
            normalization=None, can_set_weights=quarterly.can_set_weights(principal, v)))
    return reads


@router.get("/quarters/{quarter_id}/employees", response_model=list[EmployeeResultRead])
def employee_results(quarter_id: int, db: DbSession, principal: CurrentPrincipal,
                     plant_id: int | None = None, department_id: int | None = None,
                     search: Annotated[str | None, Query(max_length=100)] = None):
    """Consolidated employee results: live before normalization, frozen after."""
    views = quarterly.employee_views(db, principal, quarter_id)
    if plant_id is not None:
        views = [v for v in views if v.home and v.home[0] == plant_id]
    if department_id is not None:
        views = [v for v in views if v.home and v.home[1] == department_id]
    term = (search or "").strip().lower()
    if term:
        views = [v for v in views if term in v.employee.employee_code.lower()
                 or term in v.employee.full_name.lower()]
    return _employee_reads(db, principal, views)


@router.get("/quarters/{quarter_id}/employees/{employee_id}", response_model=EmployeeResultRead)
def employee_result(quarter_id: int, employee_id: int, db: DbSession, principal: CurrentPrincipal):
    view = quarterly.get_employee_view(db, principal, quarter_id, employee_id)
    read = _employee_reads(db, principal, [view])[0]
    rows = db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.cycle_quarter_id == quarter_id,
        EmployeeQuarterResult.employee_id == employee_id)
        .order_by(EmployeeQuarterResult.version_no)).all()
    read.versions = [EmployeeVersionRead(
        version_no=r.version_no, status=r.status.value, final_score=_text(r.final_score),
        group_key=r.group_key, normalized_rating=_text(r.normalized_rating),
        published_at=r.published_at) for r in rows]
    return read


@router.put("/quarters/{quarter_id}/employees/{employee_id}/weights",
            response_model=EmployeeResultRead)
def set_weights(quarter_id: int, employee_id: int, body: WeightsWrite, db: DbSession,
                principal: CurrentPrincipal, actor: AuditActorDep):
    """Contribution weights of a cross-plant employee's scored assignments (total 100 %)."""
    with transaction(db):
        quarterly.set_weights(db, principal, actor, quarter_id, employee_id,
                              [(w.assignment_id, w.weight) for w in body.weights])
    view = quarterly.get_employee_view(db, principal, quarter_id, employee_id)
    return _employee_reads(db, principal, [view])[0]


# --- normalization ---------------------------------------------------------------------------

def _summary_fields(db: Session, view: normalization.RunView) -> dict[str, Any]:
    run = view.run
    version: MatrixVersion = run.matrix_version
    users = _users(db, {run.approved_by_user_id})
    distribution = normalization.describe_targets(view)
    return dict(
        id=run.id, status=run.status, version_no=run.version_no, cohort_label=view.label,
        cohort_level=run.cohort_level,
        policy=PolicyVersionRef(matrix_id=version.matrix_id, code=version.matrix.code,
                                name=version.matrix.name, version_id=version.id,
                                version_no=version.version_no),
        population=run.population, eligible=run.eligible, small_cohort=run.small_cohort,
        distribution=[GroupDistribution(**d) for d in distribution],
        matches_targets=all(d["actual_count"] == d["target_count"] for d in distribution),
        unresolved=len(view.unresolved), rating_errors=len(view.rating_errors),
        exceptions=len(run.exceptions or []), approved_by=users.get(run.approved_by_user_id or 0),
        approved_at=run.approved_at)


def _run_read(db: Session, principal: Principal, view: normalization.RunView) -> RunRead:
    members = view.members
    plants, departments = _places(db, {m.plant_id for m in members},
                                  {m.department_id for m in members})
    users = _users(db, {m.placed_by_user_id for m in members})
    actions = normalization.actions(principal, view)
    settings = view.settings
    return RunRead(
        **_summary_fields(db, view), quarter=_quarter(view.run.quarter),
        settings=policy.settings_json(settings) if settings else None,
        policy_problem=view.problem, exception_list=view.run.exceptions or [],
        members=[MemberRead(
            employee=EmployeeRef.model_validate(m.employee), home_plant=plants[m.plant_id],
            home_department=departments[m.department_id], final_score=_text(m.final_score),
            calculated_score=_text(m.calculated_score), rank=m.rank, group_key=m.group_key,
            group_label=settings.label(m.group_key) if settings and m.group_key else None,
            placement=m.placement, options=m.placement_options,
            placement_reason=m.placement_reason, placed_by=users.get(m.placed_by_user_id or 0),
            normalized_rating=_text(m.normalized_rating), rating_explanation=m.rating_explanation)
            for m in members],
        approval_note=view.run.approval_note, computed_at=view.run.computed_at,
        actions=RunActionsRead(can_place=actions.can_place, can_approve=actions.can_approve,
                               can_reopen=actions.can_reopen))


@router.get("/quarters/{quarter_id}/normalization", response_model=list[RunSummary])
def normalization_runs(quarter_id: int, db: DbSession, principal: CurrentPrincipal):
    """The quarter's cohorts the caller may see, with target and actual group sizes."""
    return [RunSummary(**_summary_fields(db, v))
            for v in normalization.list_runs(db, principal, quarter_id)]


@router.get("/normalization-runs/{run_id}", response_model=RunRead)
def normalization_run(run_id: int, db: DbSession, principal: CurrentPrincipal):
    return _run_read(db, principal, normalization.get_run(db, principal, run_id))


@router.post("/normalization-runs/{run_id}/placements", response_model=RunRead)
def place(run_id: int, body: PlacementRequest, db: DbSession, principal: CurrentPrincipal,
          actor: AuditActorDep):
    """Place a tied employee, or a member of a small cohort, with a reason."""
    with transaction(db):
        normalization.place_member(db, principal, actor, run_id, body.employee_id, body.group,
                                   body.reason)
    return _run_read(db, principal, normalization.get_run(db, principal, run_id))


@router.post("/normalization-runs/{run_id}/approve", response_model=RunRead)
def approve(run_id: int, body: RunApprove, db: DbSession, principal: CurrentPrincipal,
            actor: AuditActorDep):
    """HR Head or CHRO covering every member, who placed none of them."""
    with transaction(db):
        normalization.approve_run(db, principal, actor, run_id, body.note)
    return _run_read(db, principal, normalization.get_run(db, principal, run_id))


@router.post("/normalization-runs/{run_id}/reopen", response_model=RunRead)
def reopen(run_id: int, body: ReasonRequest, db: DbSession, principal: CurrentPrincipal,
           actor: AuditActorDep):
    with transaction(db):
        normalization.reopen_run(db, principal, actor, run_id, body.reason)
    return _run_read(db, principal, normalization.get_run(db, principal, run_id))


# --- comments and the employee's own sheets ------------------------------------------------

def _comments(db: Session, comments: list[KpiSheetComment]) -> list[CommentRead]:
    users = _users(db, {c.author_user_id for c in comments})
    return [CommentRead(id=c.id, kind=c.kind, body=c.body, author=users.get(c.author_user_id),
                        created_at=c.created_at) for c in comments]


@router.get("/sheets/{sheet_id}/comments", response_model=CommentList)
def list_comments(sheet_id: int, db: DbSession, principal: CurrentPrincipal):
    """Review comments (org readers) and feedback (also the employee)."""
    comments = sheet_comments.list_comments(db, principal, sheet_id)
    sheet = get_sheet(db, principal, sheet_id)
    return CommentList(comments=_comments(db, comments),
                       can_comment=sheet_comments.can_comment(principal, sheet))


@router.post("/sheets/{sheet_id}/comments", response_model=CommentRead,
             status_code=status.HTTP_201_CREATED)
def add_comment(sheet_id: int, body: CommentCreate, db: DbSession, principal: CurrentPrincipal,
                actor: AuditActorDep):
    """Optional: never required for review, normalization or publication."""
    with transaction(db):
        comment = sheet_comments.add_comment(db, principal, actor, sheet_id, body.kind, body.body)
        read = _comments(db, [comment])[0]
    return read


@router.get("/my/kpi-sheets", response_model=list[OwnSheet])
def my_sheets(db: DbSession, principal: CurrentPrincipal):
    """The caller's own KPI sheets; scores and outcomes once published."""
    found = quarterly.own_sheets(db, principal)
    feedback: dict[int, list[KpiSheetComment]] = {}
    for c in db.scalars(select(KpiSheetComment).where(
            KpiSheetComment.sheet_id.in_([o.sheet.id for o in found] or [0]),
            KpiSheetComment.kind == SheetCommentKind.FEEDBACK).order_by(KpiSheetComment.id)):
        feedback.setdefault(c.sheet_id, []).append(c)
    labels = _run_labels(db, {o.employee_result.normalization_run_id for o in found
                              if o.employee_result and o.employee_result.normalization_run_id})
    reads = []
    for o in found:
        row: EmployeeQuarterResult | None = o.employee_result
        outcome = None
        if row is not None:
            settings = labels[row.normalization_run_id][1] if row.normalization_run_id else None
            outcome = OwnOutcome(
                final_score=_text(row.final_score),
                group_label=settings.label(row.group_key) if settings and row.group_key else None,
                normalized_rating=_text(row.normalized_rating), published_at=row.published_at)
        reads.append(OwnSheet(
            id=o.sheet.id, status=o.sheet.status, quarter=_quarter(o.sheet.quarter),
            assignment=_assignment(o.sheet.assignment),
            items=[item_read(i) for i in o.sheet.items],
            total=float(kpi_sheets.weight_total([i.weightage for i in o.sheet.items])),
            published_score=_text(o.published_score), published_at=o.published_at,
            outcome=outcome, feedback=_comments(db, feedback.get(o.sheet.id, []))))
    return reads
