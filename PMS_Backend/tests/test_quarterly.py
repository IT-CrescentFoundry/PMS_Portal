"""Quarterly review, consolidation, normalization and publication (Stage L).

Scenario (tests/conftest.py, review_env): eight Quality employees in TQ1, one
KPI each. Final sheet scores: TST010 5, TST003 5, TST011 4, TST001 4 at P1
and 3 at P2 (weighted 60/40 -> 3.60), TST012 3, TST013 2, TST014 1,
TST002 0. Policy: one cohort for Quality across plants, 20/60/20 of 8 ->
targets 2 / 4 / 2; ratings TOP 5, MIDDLE 3, BOTTOM 1 (synthetic).
"""
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.auth.permissions import build_principal
from app.dependencies import transaction
from app.models import (
    AuditEvent,
    EmployeeQuarterResult,
    KpiSheetComment,
    KpiSheetResult,
    NormalizationRun,
    PmsCycleQuarter,
    ScoreResultStatus,
)
from app.models.enums import QuarterStatus, ScopeType
from app.services import quarterly
from app.services.audit import AuditActor
from tests.conftest import REVIEW_ACTUALS, published_normalization_policy

TIED = {**REVIEW_ACTUALS, ("013", "P1"): (20, 20, 20)}  # TST013 now ties TST014 at 1.00


def messages(resp) -> list[str]:
    return [i["message"] for i in resp.json().get("issues", [])]


def by_code(members: list[dict]) -> dict[str, dict]:
    return {m["employee"]["employee_code"]: m for m in members}


# --- quarter steps -----------------------------------------------------------------------------

def test_quarter_steps_need_a_global_role_and_pass_their_gates(review_env):
    assert review_env.transition("DEPARTMENT_REVIEW", client="hr_p1").status_code == 403
    assert review_env.transition("DEPARTMENT_REVIEW", client="head").status_code == 403
    assert review_env.transition("NORMALIZATION").status_code == 409   # no skipping

    blocked = review_env.transition("DEPARTMENT_REVIEW")
    assert blocked.status_code == 422 and any("not calculated" in m for m in messages(blocked))

    missing = {**REVIEW_ACTUALS, ("014", "P1"): (20, 20, None)}
    review_env.import_all(missing)
    review_env.calculate()
    blocked = review_env.transition("DEPARTMENT_REVIEW")
    assert any("TST014" in m and "missing TKPI-1 2026-09" in m for m in messages(blocked))
    overview = review_env.clients["hr"].get(
        f"/api/kpi/quarters/{review_env.quarter.id}/overview").json()
    assert overview["sheets"] == {"locked": 9, "calculated": 9, "complete": 8, "stale": 0,
                                  "reviewed": 0, "pending_overrides": 0, "published": 0}
    assert overview["next_status"] == "DEPARTMENT_REVIEW" and overview["blockers"]
    # Missing data is never treated as zero.
    row = review_env.db.scalars(select(KpiSheetResult).where(
        KpiSheetResult.sheet_id == review_env.sheets[("014", "P1")])).one()
    assert row.final_score is None and not row.is_complete

    review_env.import_all()
    review_env.calculate()
    body = review_env.advance("DEPARTMENT_REVIEW")
    assert body["quarter"]["status"] == "DEPARTMENT_REVIEW"
    assert body["previous_status"] == "OPEN" and body["next_status"] == "NORMALIZATION"
    event = review_env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "quarter.advance")).one()
    assert event.changes == {"from": "OPEN", "to": "DEPARTMENT_REVIEW"}


def test_department_review_freezes_the_data_until_hr_reopens_collection(review_env):
    review_env.import_all()
    review_env.calculate()
    review_env.advance("DEPARTMENT_REVIEW")
    head = review_env.clients["head"]
    refused = head.post("/api/kpi/data/preview", data={
        "quarter_id": str(review_env.quarter.id), "period": "2026-09"},
        files={"file": ("x.csv", b"Employee Code,KPI,Period,Actual\nTST010,TKPI-1,2026-09,1\n",
                        "text/csv")})
    assert refused.status_code == 422 and "Data collection" in messages(refused)[0]
    assert head.post("/api/kpi/results/calculate",
                     json={"quarter_id": review_env.quarter.id}).status_code == 409
    deviation = head.post("/api/kpi/deviations", json={
        "sheet_id": review_env.sheets[("010", "P1")], "reason": "Change during the review",
        "items": [{"kpi_definition_id": review_env.env.kpis["profit"].id, "weightage": "100",
                   "target_value": "90"}]})
    assert deviation.status_code == 409
    # Review is what this step is for.
    assert head.post(f"/api/kpi/results/{review_env.sheets[('010', 'P1')]}/review"
                     ).status_code == 200
    # Going back needs a reason; then data can change again.
    assert review_env.transition("OPEN").status_code == 422
    back = review_env.transition("OPEN", reason="Plant B resubmits September data")
    assert back.status_code == 200 and back.json()["quarter"]["status"] == "OPEN"
    event = review_env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "quarter.return")).one()
    assert event.reason == "Plant B resubmits September data"
    review_env.import_all()


def test_a_cross_plant_employee_needs_weights_and_is_counted_once(review_env):
    review_env.import_all()
    review_env.calculate()
    review_env.advance("DEPARTMENT_REVIEW")
    review_env.review_all()
    blocked = review_env.transition("NORMALIZATION")
    assert any("TST001" in m and "contribution weights are missing" in m for m in messages(blocked))

    assert review_env.set_weights("60", "30").status_code == 422          # total 90
    assert review_env.set_weights(client="hr_p1").status_code == 403      # P1 only, not P2
    assert review_env.set_weights(client="head").status_code == 403       # no score:publish
    single = review_env.clients["hr"].put(
        f"/api/kpi/quarters/{review_env.quarter.id}/employees/{review_env.employee_id('002')}"
        "/weights", json={"weights": [
            {"assignment_id": review_env.assignment("002", "P2"), "weight": "50"},
            {"assignment_id": review_env.assignment("001", "P2"), "weight": "50"}]})
    assert single.status_code == 409                                     # one scored assignment
    body = review_env.set_weights().json()
    assert body["final_score"] == "3.6" and body["weights_source"] == "CONFIGURED"
    assert {(c["plant"]["code"], c["score"], c["weight"], c["contribution"])
            for c in body["components"]} == {("TST-P1", "4", "60", "2.4"),
                                             ("TST-P2", "3", "40", "1.2")}
    event = review_env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "employee_weights.set")).one()
    assert event.changes["after"] == {str(review_env.assignment("001", "P1")): "60",
                                      str(review_env.assignment("001", "P2")): "40"}

    review_env.advance("NORMALIZATION")
    rows = review_env.db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.cycle_quarter_id == review_env.quarter.id)).all()
    assert len(rows) == 8                                    # nine sheets, eight people
    tst001 = next(r for r in rows if r.employee_id == review_env.employee_id("001"))
    assert tst001.plant_id == review_env.env.org.plants["P1"].id     # attributed to the primary
    assert tst001.final_score == Decimal("3.60")
    run = review_env.runs()[0]
    assert run["population"] == 8 and run["cohort_label"] == "Test Dept Q: all plants"


# --- normalization ------------------------------------------------------------------------------

def test_cohort_is_placed_twenty_sixty_twenty_and_rated_by_the_policy(review_env):
    review_env.to_normalization()
    [summary] = review_env.runs()
    assert [(d["key"], d["target_count"], d["actual_count"], d["actual_percent"])
            for d in summary["distribution"]] == [("TOP", 2, 2, "25"), ("MIDDLE", 4, 4, "50"),
                                                  ("BOTTOM", 2, 2, "25")]
    assert summary["matches_targets"] and summary["status"] == "DRAFT"
    run = review_env.run(summary["id"])
    members = by_code(run["members"])
    assert {c for c, m in members.items() if m["group_key"] == "TOP"} == {"TST010", "TST003"}
    assert {c for c, m in members.items() if m["group_key"] == "BOTTOM"} == {"TST014", "TST002"}
    assert members["TST001"]["group_label"] == "Middle 60%"
    assert members["TST001"]["normalized_rating"] == "3"
    assert members["TST010"]["rank"] == members["TST003"]["rank"] == 1
    assert members["TST011"]["rank"] == 3
    assert any(e["type"] == "rounding" and "20 % of 8 is 1.6" in e["message"]
               for e in run["exception_list"])
    assert run["policy"]["version_id"] == review_env.policy.id
    # Normalization never changes a score.
    assert members["TST001"]["final_score"] == "3.6"


def test_tied_employees_are_placed_by_a_reviewer_and_approved_by_someone_else(review_env):
    review_env.to_normalization(TIED)
    [summary] = review_env.runs()
    assert summary["unresolved"] == 2
    run = review_env.run(summary["id"])
    pending = {c: m for c, m in by_code(run["members"]).items()
               if m["placement"] == "NEEDS_RESOLUTION"}
    assert set(pending) == {"TST013", "TST014"}
    assert {tuple(m["options"]) for m in pending.values()} == {("MIDDLE", "BOTTOM")}
    assert not run["actions"]["can_approve"]
    assert review_env.approve(summary["id"]).status_code == 409

    url = f"/api/kpi/normalization-runs/{summary['id']}/placements"
    hr, head = review_env.clients["hr"], review_env.clients["head"]
    place = {"employee_id": review_env.employee_id("013"), "group": "MIDDLE",
             "reason": "Stronger second half of the quarter"}
    assert head.post(url, json=place).status_code == 403                  # no score:publish
    assert hr.post(url, json={**place, "group": "TOP"}).status_code == 422  # not an option
    assert hr.post(url, json={**place, "reason": "short"}).status_code == 422
    assert hr.post(url, json=place).status_code == 200
    placed = hr.post(url, json={"employee_id": review_env.employee_id("014"), "group": "BOTTOM",
                                "reason": "Missed the claims target twice"}).json()
    members = by_code(placed["members"])
    assert members["TST013"]["placement"] == "TIE_RESOLVED"
    assert members["TST013"]["placed_by"]["username"] == "tst.rv.hr"
    assert members["TST014"]["normalized_rating"] == "1"
    assert placed["unresolved"] == 0

    assert review_env.approve(summary["id"], client="hr").status_code == 403   # placed members
    approved = review_env.approve(summary["id"], client="chro").json()
    assert approved["status"] == "APPROVED" and approved["approved_by"]["username"] == "tst.rv.chro"
    events = review_env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "normalization.place")).all()
    assert [e.reason for e in events] == ["Stronger second half of the quarter",
                                          "Missed the claims target twice"]


def test_nobody_reviews_places_or_approves_their_own_result(review_env, as_role):
    o = review_env.env.org
    _, own_head = as_role("tst.rv.own", [("DEPT_HEAD", [(ScopeType.DEPARTMENT, None,
                                                         o.departments["Q"])])],
                          employee=o.employees["010"])
    _, hr_013 = as_role("tst.rv.hr013", [("HR_HEAD", [(ScopeType.GLOBAL, None, None)])],
                        employee=o.employees["013"])
    _, chro_011 = as_role("tst.rv.chro011", [("CHRO", [(ScopeType.GLOBAL, None, None)])],
                          employee=o.employees["011"])
    review_env.import_all(TIED)
    review_env.calculate()
    review_env.advance("DEPARTMENT_REVIEW")
    own, other = review_env.sheets[("010", "P1")], review_env.sheets[("011", "P1")]
    assert own_head.get(f"/api/kpi/results/{own}").json()["actions"]["can_review"] is False
    assert own_head.get(f"/api/kpi/results/{other}").json()["actions"]["can_review"] is True
    refused = own_head.post(f"/api/kpi/results/{own}/review")
    assert refused.status_code == 403 and "Your own score" in refused.json()["detail"]

    review_env.review_all()
    assert review_env.set_weights().status_code == 200
    review_env.advance("NORMALIZATION")
    run_id = review_env.runs()[0]["id"]
    url = f"/api/kpi/normalization-runs/{run_id}/placements"
    assert hr_013.post(url, json={"employee_id": review_env.employee_id("013"), "group": "MIDDLE",
                                  "reason": "Placing my own result here"}).status_code == 403
    assert hr_013.post(url, json={"employee_id": review_env.employee_id("014"), "group": "BOTTOM",
                                  "reason": "Missed the claims target twice"}).status_code == 200
    assert review_env.clients["hr"].post(url, json={
        "employee_id": review_env.employee_id("013"), "group": "MIDDLE",
        "reason": "Stronger second half of the quarter"}).status_code == 200

    # A cohort member never approves it, even with company-wide authority.
    assert review_env.run(run_id, client="chro")["actions"]["can_approve"] is True
    member = chro_011.get(f"/api/kpi/normalization-runs/{run_id}").json()
    assert member["actions"]["can_approve"] is False
    refused = chro_011.post(f"/api/kpi/normalization-runs/{run_id}/approve", json={})
    assert refused.status_code == 403 and "member of this cohort" in refused.json()["detail"]
    assert review_env.approve(run_id).status_code == 200


def test_small_cohorts_and_eligibility_follow_the_approved_policy(review_env):
    review_env.policy.matrix.is_active = False
    published_normalization_policy(review_env.db, name="Small cohorts", min_cohort_size=10,
                                   small_cohort="REQUIRE_RESOLUTION", small_cohort_group=None,
                                   eligible_designations=["TST-ENG"])
    review_env.to_normalization()
    [summary] = review_env.runs()
    assert summary["small_cohort"] and summary["unresolved"] == 8
    run = review_env.run(summary["id"])
    assert any(e["type"] == "small_cohort" for e in run["exception_list"])
    assert by_code(run["members"])["TST002"]["options"] == ["TOP", "MIDDLE", "BOTTOM"]


def test_employees_outside_the_eligible_population_are_not_normalized(review_env):
    review_env.policy.matrix.is_active = False
    published_normalization_policy(review_env.db, name="Engineers only",
                                   eligible_designations=["OTHER"])
    review_env.to_normalization()
    [summary] = review_env.runs()
    assert summary["eligible"] == 0 and summary["population"] == 8
    run = review_env.run(summary["id"])
    assert {m["placement"] for m in run["members"]} == {"NOT_ELIGIBLE"}
    assert all(m["group_key"] is None and m["normalized_rating"] is None for m in run["members"])
    assert review_env.approve(summary["id"]).status_code == 200


def test_a_unit_without_an_approved_policy_blocks_normalization(review_env):
    review_env.policy.matrix.is_active = False
    review_env.import_all()
    review_env.calculate()
    review_env.advance("DEPARTMENT_REVIEW")
    review_env.review_all()
    review_env.set_weights()
    blocked = review_env.transition("NORMALIZATION")
    assert blocked.status_code == 422
    assert any("no approved normalization policy applies" in m for m in messages(blocked))


def test_cohorts_are_recomputed_only_when_their_inputs_change(review_env):
    review_env.to_normalization()
    run_id = review_env.runs()[0]["id"]
    assert review_env.approve(run_id).status_code == 200
    review_env.transition("DEPARTMENT_REVIEW", reason="Recheck the weights of TST001")
    review_env.advance("NORMALIZATION")                       # nothing changed
    assert review_env.run(run_id)["status"] == "APPROVED"
    review_env.transition("DEPARTMENT_REVIEW", reason="Weights agreed with Plant B")
    assert review_env.set_weights("50", "50").status_code == 200
    review_env.advance("NORMALIZATION")
    run = review_env.run(run_id)
    assert run["status"] == "DRAFT" and run["approved_by"] is None
    assert by_code(run["members"])["TST001"]["final_score"] == "3.5"


def test_cohort_visibility_and_decisions_follow_scope(review_env, as_role):
    review_env.to_normalization()
    run_id = review_env.runs()[0]["id"]
    o = review_env.env.org
    _, p2 = as_role("tst.rv.p2", [("DEPT_HEAD", [(ScopeType.PLANT_DEPARTMENT, o.plants["P2"],
                                                  o.departments["Q"])])])
    assert p2.get(f"/api/kpi/quarters/{review_env.quarter.id}/normalization").json() == []
    assert p2.get(f"/api/kpi/normalization-runs/{run_id}").status_code == 404
    homes = {e["employee"]["employee_code"]
             for e in p2.get(f"/api/kpi/quarters/{review_env.quarter.id}/employees").json()}
    assert homes == {"TST002", "TST003"}                       # TST001's home is P1
    assert review_env.approve(run_id, client="hr_p1").status_code == 404   # spans P2 as well
    assert review_env.approve(run_id, client="head").status_code == 403    # sees, can't decide


# --- publication -----------------------------------------------------------------------------

def test_publication_is_quarter_wide_final_and_needs_a_global_role(review_env):
    review_env.to_normalization()
    run_id = review_env.runs()[0]["id"]
    assert review_env.transition("READY").status_code == 422           # cohort not approved
    assert review_env.approve(run_id).status_code == 200
    review_env.advance("READY")
    assert review_env.publish(client="hr_p1").status_code == 403
    assert review_env.publish(client="head").status_code == 403
    body = review_env.publish().json()
    assert body["quarter"]["status"] == "PUBLISHED"
    assert body["published_by"]["username"] == "tst.rv.chro"
    assert body["sheets"]["published"] == 9

    db = review_env.db
    results = db.scalars(select(KpiSheetResult).where(
        KpiSheetResult.sheet_id.in_(list(review_env.sheets.values())))).all()
    assert {r.status for r in results} == {ScoreResultStatus.PUBLISHED}
    published = {r.sheet_id: r.published_score for r in results}
    assert published[review_env.sheets[("001", "P2")]] == Decimal("3.00")
    employee = review_env.clients["head"].get(
        f"/api/kpi/quarters/{review_env.quarter.id}/employees/{review_env.employee_id('001')}"
    ).json()
    assert employee["status"] == "PUBLISHED" and employee["normalization"]["group_key"] == "MIDDLE"
    assert db.scalars(select(NormalizationRun)).one().status.value == "PUBLISHED"
    event = db.scalars(select(AuditEvent).where(AuditEvent.action == "quarter.publish")).one()
    assert (event.changes["sheets"], event.changes["employees"], event.changes["cohorts"]) == (9, 8, 1)
    # Feedback is optional: none was given.
    assert db.scalars(select(KpiSheetComment)).all() == []


def test_published_results_never_change(review_env):
    review_env.to_published()
    head, hr = review_env.clients["head"], review_env.clients["hr"]
    q = review_env.quarter.id
    sheet = review_env.sheets[("010", "P1")]
    assert review_env.transition("READY", reason="Reopen after publication").status_code == 409
    assert head.post("/api/kpi/results/calculate", json={"quarter_id": q}).status_code == 409
    refused = head.post("/api/kpi/data/preview", data={"quarter_id": str(q), "period": "2026-09"},
                        files={"file": ("x.csv", b"Employee Code,KPI,Period,Actual\n", "text/csv")})
    assert refused.status_code == 422
    assert head.post(f"/api/kpi/results/{sheet}/review").status_code == 409
    assert head.post(f"/api/kpi/results/{sheet}/overrides", json={
        "proposed_score": "4", "reason": "After publication"}).status_code == 409
    assert review_env.set_weights().status_code == 409
    assert head.post(f"/api/kpi/sheets/{sheet}/comments", json={
        "kind": "FEEDBACK", "body": "Late note"}).status_code == 409
    assert head.post("/api/kpi/deviations", json={
        "sheet_id": sheet, "reason": "Change after publication",
        "items": [{"kpi_definition_id": review_env.env.kpis["profit"].id, "weightage": "100",
                   "target_value": "90"}]}).status_code == 409
    _ = hr
    stored = review_env.db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.employee_id == review_env.employee_id("010"))).one()
    assert (stored.final_score, stored.group_key, stored.normalized_rating) == (
        Decimal("5.00"), "TOP", Decimal("5.00"))


def test_publication_rolls_back_with_its_audit_event(review_env, monkeypatch):
    review_env.to_normalization()
    assert review_env.approve(review_env.runs()[0]["id"]).status_code == 200
    review_env.advance("READY")
    chro = review_env.users["chro"]

    def failing(*args, **kwargs):
        raise RuntimeError("audit store unavailable")

    monkeypatch.setattr(quarterly, "record_event", failing)
    db = review_env.db
    with pytest.raises(RuntimeError):
        with transaction(db):
            quarterly.publish(db, build_principal(chro), AuditActor.from_user(chro),
                              review_env.quarter.id)
    quarter = db.get(PmsCycleQuarter, review_env.quarter.id)
    db.refresh(quarter)
    assert quarter.status == QuarterStatus.READY and quarter.published_at is None
    results = db.scalars(select(KpiSheetResult)).all()
    for r in results:
        db.refresh(r)
    assert ScoreResultStatus.PUBLISHED not in {r.status for r in results}


# --- comments, feedback and the employee's view ------------------------------------------------

def test_feedback_is_optional_and_reaches_the_employee(review_env, as_role):
    review_env.import_all()
    review_env.calculate()
    sheet = review_env.sheets[("010", "P1")]
    head = review_env.clients["head"]
    url = f"/api/kpi/sheets/{sheet}/comments"
    assert head.post(url, json={"kind": "REVIEW_COMMENT", "body": "Check the July value"}
                     ).status_code == 201
    assert head.post(url, json={"kind": "FEEDBACK", "body": "Strong quarter on profit"}
                     ).status_code == 201
    assert head.post(url, json={"kind": "FEEDBACK", "body": "   "}).status_code == 422
    assert review_env.clients["plant_head"].post(url, json={
        "kind": "FEEDBACK", "body": "Plant view"}).status_code == 403
    _, me = as_role("tst.rv.me", [("EMPLOYEE", [])],
                    employee=review_env.env.org.employees["010"])
    mine = me.get(url).json()
    assert [c["kind"] for c in mine["comments"]] == ["FEEDBACK"] and not mine["can_comment"]
    assert len(head.get(url).json()["comments"]) == 2
    event = review_env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "kpi_sheet.comment")).all()
    assert len(event) == 2 and "Strong quarter" not in str(event[1].changes)


def test_the_employee_sees_their_outcome_only_after_publication(review_env, as_role):
    _, me = as_role("tst.rv.me2", [("EMPLOYEE", [])],
                    employee=review_env.env.org.employees["010"])
    review_env.to_normalization()
    [mine] = me.get("/api/kpi/my/kpi-sheets").json()
    assert mine["published_score"] is None and mine["outcome"] is None
    assert me.get(f"/api/kpi/results/{review_env.sheets[('010', 'P1')]}").json()["result"] is None
    assert me.get(f"/api/kpi/quarters/{review_env.quarter.id}/overview").status_code == 403
    assert review_env.approve(review_env.runs()[0]["id"]).status_code == 200
    review_env.advance("READY")
    review_env.publish()
    [mine] = me.get("/api/kpi/my/kpi-sheets").json()
    assert mine["published_score"] == "5"
    assert mine["outcome"] == {"final_score": "5", "group_label": "Top 20%",
                               "normalized_rating": "5", "published_at": mine["outcome"]["published_at"]}
    _, other = as_role("tst.rv.other", [("EMPLOYEE", [])],
                       employee=review_env.env.org.employees["011"])
    assert all(s["assignment"]["employee"]["employee_code"] == "TST011"
               for s in other.get("/api/kpi/my/kpi-sheets").json())


def test_sheets_never_published_are_reported_but_not_scored(scoring_env):
    overview = scoring_env.clients["chro"].get(
        f"/api/kpi/quarters/{scoring_env.env.q1.id}/overview").json()
    assert overview["unscorable_sheets"] == 1 and overview["sheets"]["locked"] == 2
