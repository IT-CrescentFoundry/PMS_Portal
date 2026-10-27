"""Annual performance results and annual score deviations API (Stage M)."""
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.dependencies import AuditActorDep, CurrentPrincipal, get_current_user
from app.auth.permissions import Permission, Principal
from app.dependencies import get_db, transaction
from app.models import (
    AnnualDeviationStatus,
    AnnualResult,
    AnnualResultStatus,
    AnnualScoreDeviation,
    AuditEvent,
    Department,
    Plant,
    PmsCycle,
    User,
)
from app.routers.kpi import _quarter
from app.schemas.annual import (
    AnnualActions,
    AnnualCalculated,
    AnnualCycleRead,
    AnnualDetail,
    AnnualQuarterRead,
    AnnualRow,
    AnnualRuleRead,
    AnnualVersionBrief,
    AnnualVersionRead,
    AuditEntry,
    CalculateAnnual,
    DecisionRequest,
    DeviationBrief,
    DeviationCreate,
    DeviationRead,
    FinalizeRequest,
    OwnAnnualQuarter,
    OwnAnnualRead,
    RuleWrite,
)
from app.schemas.employee import EmployeeRef
from app.schemas.jd import UserRef
from app.schemas.organization import DepartmentRef, PlantRef
from app.services import annual, audit
from app.services import matrix_rules as rules

router = APIRouter(prefix="/api/annual", tags=["annual results"],
                   dependencies=[Depends(get_current_user)])
DbSession = Annotated[Session, Depends(get_db)]


def _num(value: Any) -> str | None:
    return None if value is None else rules.decimal_text(value)


def _users(db: Session, ids: set[int | None]) -> dict[int, UserRef]:
    wanted = sorted(i for i in ids if i)
    if not wanted:
        return {}
    return {u.id: UserRef(id=u.id, username=u.username)
            for u in db.scalars(select(User).where(User.id.in_(wanted)))}


def audit_entries(events: list[AuditEvent]) -> list[AuditEntry]:
    return [AuditEntry(id=e.id, action=e.action, summary=e.summary, reason=e.reason,
                       actor=e.actor_username, occurred_at=e.occurred_at) for e in events]


# --- cycles and the annual rule --------------------------------------------------------------

def _rule_read(rule: dict[str, Any]) -> AnnualRuleRead:
    return AnnualRuleRead(code=rule["code"], version=int(rule["version"]),
                          quarter_weights=rule["quarter_weights"],
                          decimals=int(rule["decimals"]), rounding=rule["rounding"],
                          description=rule["description"], sha256=annual.rule_hash(rule))


def _cycle_read(db: Session, principal: Principal, cycle: PmsCycle) -> AnnualCycleRead:
    approved = db.scalar(select(func.count()).select_from(AnnualResult).where(
        AnnualResult.cycle_id == cycle.id,
        AnnualResult.status.in_((AnnualResultStatus.PUBLISHED, AnnualResultStatus.SUPERSEDED))))
    return AnnualCycleRead(
        id=cycle.id, code=cycle.code, name=cycle.name, start_date=cycle.start_date,
        end_date=cycle.end_date, status=cycle.status,
        quarters=[_quarter(q, cycle) for q in cycle.quarters],
        rule=_rule_read(annual.rule_of(cycle)),
        can_set_rule=principal.scope_for(Permission.ANNUAL_APPROVE).is_global and not approved)


@router.get("/cycles", response_model=list[AnnualCycleRead])
def list_cycles(db: DbSession, principal: CurrentPrincipal):
    """PMS cycles with their quarters and annual rule (annual:read)."""
    return [_cycle_read(db, principal, c) for c in annual.list_cycles(db, principal)]


@router.put("/cycles/{cycle_id}/rule", response_model=AnnualCycleRead)
def set_rule(cycle_id: int, body: RuleWrite, db: DbSession, principal: CurrentPrincipal,
             actor: AuditActorDep):
    """Quarter weights of the annual score (GLOBAL annual:approve), before any
    annual result of the cycle is approved."""
    with transaction(db):
        annual.set_rule(db, principal, actor, cycle_id,
                        {w.quarter_number: w.weight for w in body.weights})
    return _cycle_read(db, principal, annual.get_cycle(db, cycle_id))


# --- employees ----------------------------------------------------------------------------------

def _brief(v: AnnualResult, users: dict[int, UserRef]) -> AnnualVersionBrief:
    return AnnualVersionBrief(
        id=v.id, version_no=v.version_no, status=v.status,
        calculated_exact=rules.decimal_text(v.calculated_exact),
        calculated_score=rules.decimal_text(v.calculated_score),
        adjusted_score=_num(v.adjusted_score), final_score=rules.decimal_text(v.final_score),
        recalculation_required=v.recalculation_required,
        recalculation_reason=v.recalculation_reason,
        calculated_by=users.get(v.calculated_by_user_id or 0), calculated_at=v.calculated_at,
        published_by=users.get(v.published_by_user_id or 0), published_at=v.published_at,
        approval_note=v.approval_note, previous_id=v.previous_id, superseded_at=v.superseded_at,
        rule_version=(v.rule or {}).get("version"), rule_sha256=v.rule_sha256)


def _deviation_read(d: AnnualScoreDeviation, st: annual.Standing, principal: Principal,
                    users: dict[int, UserRef]) -> DeviationRead:
    can_decide = (d.status == AnnualDeviationStatus.PENDING and st.pending is not None
                  and st.pending.id == d.id
                  and annual.actions(principal, st).can_decide_deviation)
    return DeviationRead(
        id=d.id, status=d.status, annual_result_id=d.annual_result_id,
        version_no=d.result.version_no, cycle_id=st.cycle.id, cycle_name=st.cycle.name,
        employee=EmployeeRef.model_validate(st.employee),
        original_score=rules.decimal_text(d.original_score),
        proposed_score=rules.decimal_text(d.proposed_score), reason=d.reason,
        requested_by=users.get(d.requested_by_user_id), requested_at=d.requested_at,
        decided_by=users.get(d.decided_by_user_id or 0), decided_at=d.decided_at,
        decision_reason=d.decision_reason, voided_at=d.voided_at, can_decide=can_decide)


def _user_ids(standings: list[annual.Standing]) -> set[int | None]:
    ids: set[int | None] = set()
    for st in standings:
        for v in st.versions:
            ids |= {v.calculated_by_user_id, v.published_by_user_id}
        for d in st.deviations:
            ids |= {d.requested_by_user_id, d.decided_by_user_id}
    return ids


def _rows(db: Session, principal: Principal, standings: list[annual.Standing],
          detail: bool = False) -> list[AnnualRow]:
    plants = {p.id: PlantRef.model_validate(p) for p in db.scalars(select(Plant).where(
        Plant.id.in_(sorted({st.home[0] for st in standings if st.home}) or [0])))}
    departments = {d.id: DepartmentRef.model_validate(d) for d in db.scalars(
        select(Department).where(Department.id.in_(
            sorted({st.home[1] for st in standings if st.home}) or [0])))}
    users = _users(db, _user_ids(standings))
    found: list[AnnualRow] = []
    for st in standings:
        a = annual.actions(principal, st)
        pending = st.pending
        base = dict(
            employee=EmployeeRef.model_validate(st.employee), cycle_id=st.cycle.id,
            home_plant=plants.get(st.home[0]) if st.home else None,
            home_department=departments.get(st.home[1]) if st.home else None,
            quarters=[AnnualQuarterRead(
                quarter_id=s.quarter.id, quarter_number=s.quarter.quarter_number,
                name=s.quarter.name, status=s.quarter.status,
                weight=rules.decimal_text(s.weight), required=s.required,
                published=s.row is not None, score=_num(s.row.final_score) if s.row else None,
                version_no=s.row.version_no if s.row else None,
                employee_result_id=s.row.id if s.row else None,
                correction_ids=[c.id for c in s.corrections]) for s in st.sources],
            complete=st.complete, issues=st.issues(),
            draft=_brief(st.draft, users) if st.draft else None,
            published=_brief(st.published, users) if st.published else None,
            pending_deviation=DeviationBrief(
                id=pending.id, status=pending.status,
                original_score=rules.decimal_text(pending.original_score),
                proposed_score=rules.decimal_text(pending.proposed_score),
                requested_by=users.get(pending.requested_by_user_id),
                requested_at=pending.requested_at) if pending else None,
            actions=AnnualActions(can_calculate=a.can_calculate,
                                  can_request_deviation=a.can_request_deviation,
                                  can_decide_deviation=a.can_decide_deviation,
                                  can_finalize=a.can_finalize))
        if not detail:
            found.append(AnnualRow(**base))
            continue
        events = (audit.history(db, "annual_result", [v.id for v in st.versions])
                  + audit.history(db, "annual_deviation", [d.id for d in st.deviations]))
        found.append(AnnualDetail(
            **base,
            versions=[AnnualVersionRead(**_brief(v, users).model_dump(), sources=v.sources,
                                        rule=v.rule) for v in reversed(st.versions)],
            deviations=[_deviation_read(d, st, principal, users) for d in reversed(st.deviations)],
            finalize_blockers=annual.finalize_blockers(st, st.draft) if st.draft else [],
            history=audit_entries(sorted(events, key=lambda e: e.id, reverse=True))))
    return found


@router.get("/cycles/{cycle_id}/employees", response_model=list[AnnualRow])
def employees(cycle_id: int, db: DbSession, principal: CurrentPrincipal,
              plant_id: int | None = None, department_id: int | None = None,
              search: Annotated[str | None, Query(max_length=100)] = None):
    """Every employee with results in the cycle, within the caller's annual:read
    scope: the four quarters, the calculated and approved versions, warnings."""
    found = annual.standings(db, principal, cycle_id)
    if plant_id is not None:
        found = [st for st in found if st.home and st.home[0] == plant_id]
    if department_id is not None:
        found = [st for st in found if st.home and st.home[1] == department_id]
    term = (search or "").strip().lower()
    if term:
        found = [st for st in found if term in st.employee.employee_code.lower()
                 or term in st.employee.full_name.lower()]
    return _rows(db, principal, found)


@router.post("/cycles/{cycle_id}/calculate", response_model=AnnualCalculated)
def calculate(cycle_id: int, body: CalculateAnnual, db: DbSession, principal: CurrentPrincipal,
              actor: AuditActorDep):
    """Calculate annual results from the published quarters (score:publish)."""
    with transaction(db):
        counts = annual.calculate(db, principal, actor, cycle_id, body.employee_ids)
    return AnnualCalculated(**counts)


def _detail(db: Session, principal: Principal, cycle_id: int, employee_id: int) -> AnnualDetail:
    return _rows(db, principal, [annual.get_standing(db, principal, cycle_id, employee_id)],
                 detail=True)[0]


@router.get("/cycles/{cycle_id}/employees/{employee_id}", response_model=AnnualDetail)
def employee(cycle_id: int, employee_id: int, db: DbSession, principal: CurrentPrincipal):
    return _detail(db, principal, cycle_id, employee_id)


@router.post("/results/{result_id}/finalize", response_model=AnnualDetail)
def finalize(result_id: int, body: FinalizeRequest, db: DbSession, principal: CurrentPrincipal,
             actor: AuditActorDep):
    """The CHRO approves a calculated version: it becomes the published result."""
    with transaction(db):
        row = annual.finalize(db, principal, actor, result_id, body.note)
        cycle_id, employee_id = row.cycle_id, row.employee_id
    return _detail(db, principal, cycle_id, employee_id)


# --- deviations ----------------------------------------------------------------------------------

def _deviation(db: Session, principal: Principal, deviation_id: int) -> DeviationRead:
    d = annual.get_deviation(db, principal, deviation_id)
    st = annual.get_standing(db, principal, d.result.cycle_id, d.result.employee_id)
    return _deviation_read(d, st, principal, _users(db, _user_ids([st])))


@router.post("/results/{result_id}/deviations", response_model=DeviationRead,
             status_code=status.HTTP_201_CREATED)
def request_deviation(result_id: int, body: DeviationCreate, db: DbSession,
                      principal: CurrentPrincipal, actor: AuditActorDep):
    """An Admin requests an adjustment of a calculated annual score."""
    with transaction(db):
        d = annual.request_deviation(db, principal, actor, result_id,
                                     original_score=body.original_score,
                                     proposed_score=body.proposed_score, reason=body.reason)
        deviation_id = d.id
    return _deviation(db, principal, deviation_id)


@router.get("/deviations", response_model=list[DeviationRead])
def list_deviations(db: DbSession, principal: CurrentPrincipal,
                    status_filter: Annotated[AnnualDeviationStatus | None,
                                             Query(alias="status")] = None,
                    cycle_id: int | None = None):
    pairs = annual.list_deviations(db, principal, status=status_filter, cycle_id=cycle_id)
    users = _users(db, _user_ids([st for _, st in pairs]))
    return [_deviation_read(d, st, principal, users) for d, st in pairs]


@router.get("/deviations/{deviation_id}", response_model=DeviationRead)
def get_deviation(deviation_id: int, db: DbSession, principal: CurrentPrincipal):
    return _deviation(db, principal, deviation_id)


@router.post("/deviations/{deviation_id}/approve", response_model=DeviationRead)
def approve_deviation(deviation_id: int, body: DecisionRequest, db: DbSession,
                      principal: CurrentPrincipal, actor: AuditActorDep):
    """The CHRO approves: the adjusted score applies, the calculated one is kept."""
    with transaction(db):
        annual.decide_deviation(db, principal, actor, deviation_id, approve=True,
                                reason=body.reason)
    return _deviation(db, principal, deviation_id)


@router.post("/deviations/{deviation_id}/reject", response_model=DeviationRead)
def reject_deviation(deviation_id: int, body: DecisionRequest, db: DbSession,
                     principal: CurrentPrincipal, actor: AuditActorDep):
    with transaction(db):
        annual.decide_deviation(db, principal, actor, deviation_id, approve=False,
                                reason=body.reason)
    return _deviation(db, principal, deviation_id)


# --- the employee's own results -------------------------------------------------------------

@router.get("/my", response_model=list[OwnAnnualRead])
def my_results(db: DbSession, principal: CurrentPrincipal):
    """The caller's own approved annual results (self:read)."""
    return [OwnAnnualRead(
        cycle_id=o.cycle.id, cycle_code=o.cycle.code, cycle_name=o.cycle.name,
        version_no=o.result.version_no, final_score=rules.decimal_text(o.result.final_score),
        published_at=o.result.published_at,
        quarters=[OwnAnnualQuarter(quarter_number=s["quarter_number"], name=s["quarter_name"],
                                   score=s["final_score"]) for s in o.result.sources],
        notice=o.notice) for o in annual.my_results(db, principal)]
