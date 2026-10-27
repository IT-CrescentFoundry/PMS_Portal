"""Controlled corrections of published quarters (Stage M).

Scenario: tests/conftest.py, annual_env. In TA1, TST010's April profit (105,
score 5) is corrected to 85 (score 3); TST010, TST001 and TST002 form one
small Quality cohort (all MIDDLE).
"""
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.auth.permissions import build_principal
from app.dependencies import transaction
from app.models import (
    AssignmentScoreWeight,
    AuditEvent,
    CorrectionStatus,
    EmployeeQuarterResult,
    KpiSheetResult,
    NormalizationRun,
    QuarterCorrection,
)
from app.models.enums import ScopeType
from app.services import corrections
from app.services.audit import AuditActor


def messages(resp) -> list[str]:
    return [i["message"] for i in resp.json().get("issues", [])]


def value_body(env, n: int = 1, emp: str = "010", plant: str = "P1", period: str = "2026-04",
               actual: str = "85", reason: str = "The April profit was keyed with a typo") -> dict:
    return {"reason": reason, "values": [{
        "sheet_id": env.sheets[(n, emp, plant)], "kpi_definition_id": env.env.kpis["profit"].id,
        "period": period, "actual": actual}]}


def request(env, body: dict, n: int = 1, client: str = "hr"):
    return env.clients[client].post(f"/api/kpi/quarters/{env.quarter(n).id}/corrections",
                                    json=body)


def get(env, correction_id: int, client: str = "hr") -> dict:
    return env.ok(env.clients[client].get(f"/api/kpi/corrections/{correction_id}"))


def move(env, correction_id: int, to: str, reason: str | None = None):
    return env.clients["hr"].post(f"/api/kpi/corrections/{correction_id}/transition",
                                  json={"to": to, "reason": reason})


def approve(env, correction_id: int, client: str = "chro"):
    return env.clients[client].post(f"/api/kpi/corrections/{correction_id}/approve",
                                    json={"reason": "Verified against the April MIS report"})


def complete(env, correction_id: int) -> dict:
    """Review, renormalize, approve and publish an approved correction."""
    for s in get(env, correction_id)["sheets"]:
        env.ok(env.clients["head"].post(f"/api/kpi/results/{s['sheet_id']}/review"))
    env.ok(move(env, correction_id, "NORMALIZATION"))
    for cohort in get(env, correction_id)["cohorts"]:
        env.ok(env.clients["chro"].post(f"/api/kpi/normalization-runs/{cohort['run_id']}/approve",
                                        json={}))
    env.ok(move(env, correction_id, "READY"))
    return env.ok(env.clients["chro"].post(f"/api/kpi/corrections/{correction_id}/publish"))


def rows(db, model, **where):
    stmt = select(model)
    for k, v in where.items():
        stmt = stmt.where(getattr(model, k) == v)
    found = db.scalars(stmt.order_by(model.id)).all()
    for r in found:
        db.refresh(r)
    return found


# --- requests ----------------------------------------------------------------------------------

def test_an_hr_head_requests_a_correction_of_a_published_quarter(annual_env):
    env = annual_env
    env.publish_quarter(1)
    body = value_body(env)
    assert request(env, body, client="chro").status_code == 403   # the CHRO decides only
    assert request(env, body, client="head").status_code == 403   # no correction authority
    assert request(env, body, client="hr_p2").status_code == 403  # a P1 sheet, outside P2
    # A quarter still in its review steps is corrected there, not this way.
    assert env.clients["hr"].post(f"/api/kpi/quarters/{env.quarter(2).id}/corrections",
                                  json=body).status_code == 409
    outside = request(env, value_body(env, period="2026-05"))
    assert outside.status_code == 422 and "outside the months" in messages(outside)[0]
    unchanged = request(env, value_body(env, actual="105"))
    assert unchanged.status_code == 422 and "unchanged" in messages(unchanged)[0]
    assert request(env, value_body(env, reason="typo")).status_code == 422

    preview = env.ok(env.clients["hr"].post(
        f"/api/kpi/quarters/{env.quarter(1).id}/corrections/preview", json=body))
    assert [(s["before"], s["after"]) for s in preview["sheets"]] == [("5", "3")]
    assert [(e["employee"], e["before"], e["after"]) for e in preview["employees"]] == [
        ("TST010 Test Person 010", "5", "3")]
    affected = preview["affected"]
    assert [e["employee_code"] for e in affected["employees"]] == ["TST010"]
    assert {e["employee_code"] for e in affected["dependents"]} == {"TST001", "TST002"}
    assert [c["members"] for c in affected["cohorts"]] == [3]

    created = env.ok(request(env, body), 201)
    assert created["status"] == "REQUESTED" and created["base_version"] == 1
    assert created["version_no"] is None
    [change] = created["changes"]
    assert (change["kpi_code"], change["period"], change["before_actual"],
            change["after_actual"]) == ("TKPI-1", "2026-04", "105", "85")
    assert [h["action"] for h in created["history"]] == ["quarter_correction.request"]
    assert request(env, body).status_code == 409                   # one open correction
    # Nothing changes before the CHRO decides.
    sheet = env.sheets[(1, "010", "P1")]
    assert [(r.version_no, r.status.value) for r in rows(env.db, KpiSheetResult, sheet_id=sheet)] \
        == [(1, "PUBLISHED")]
    assert env.ok(env.clients["hr"].get(f"/api/kpi/quarters/{env.quarter(1).id}/overview")
                  )["open_correction"]["id"] == created["id"]


def test_the_chro_decides_and_never_their_own_request(annual_env, as_role):
    env = annual_env
    env.publish_quarter(1)
    _, both = as_role("tst.cr.both", [("HR_HEAD", [(ScopeType.GLOBAL, None, None)]),
                                      ("CHRO", [(ScopeType.GLOBAL, None, None)])])
    created = env.ok(both.post(f"/api/kpi/quarters/{env.quarter(1).id}/corrections",
                               json=value_body(env)), 201)
    url = f"/api/kpi/corrections/{created['id']}"
    own = both.post(f"{url}/approve", json={"reason": "Approving my own correction"})
    assert own.status_code == 403
    assert get(env, created["id"], "chro")["actions"]["can_decide"] is True
    assert get(env, created["id"])["actions"]["can_decide"] is False
    assert approve(env, created["id"], client="hr").status_code == 403
    assert env.clients["chro"].post(f"{url}/reject", json={"reason": "no"}).status_code == 422
    rejected = env.ok(env.clients["chro"].post(f"{url}/reject", json={
        "reason": "The April figure matches the signed MIS report"}))
    assert rejected["status"] == "REJECTED" and rejected["decided_by"]["username"] == "tst.an.chro"
    assert approve(env, created["id"]).status_code == 409
    assert rows(env.db, KpiSheetResult, sheet_id=env.sheets[(1, "010", "P1")])[0].version_no == 1
    # A rejected correction leaves the quarter open to a new request.
    assert request(env, value_body(env)).status_code == 201


# --- the corrected version -----------------------------------------------------------------

def test_an_approved_correction_is_a_new_version_reviewed_before_it_is_current(annual_env, as_role):
    env = annual_env
    env.publish_quarter(1)
    _, employee = as_role("tst.cr.self", [("EMPLOYEE", [])],
                          employee=env.env.org.employees["010"])
    created = env.ok(request(env, value_body(env)), 201)
    cid = created["id"]
    approved = env.ok(approve(env, cid))
    assert approved["status"] == "DEPARTMENT_REVIEW" and approved["version_no"] == 2
    assert approve(env, cid).status_code == 409                    # decided once
    assert [e["employee_code"] for e in approved["affected"]["employees"]] == ["TST010"]

    sheet = env.sheets[(1, "010", "P1")]
    v1, v2 = rows(env.db, KpiSheetResult, sheet_id=sheet)
    assert (v1.version_no, v1.status.value, v1.published_score) == (1, "PUBLISHED", Decimal("5.00"))
    assert (v2.version_no, v2.status.value, v2.final_score) == (2, "CALCULATED", Decimal("3.00"))
    assert v2.explanation["items"][0]["monthly"][0]["correction_id"] == cid
    # Reviewers see the corrected version; the employee still sees the published one.
    working = env.ok(env.clients["head"].get(f"/api/kpi/results/{sheet}"))
    assert working["result"]["version_no"] == 2 and working["actions"]["can_review"] is True
    assert [v["status"] for v in working["versions"]] == ["PUBLISHED", "CALCULATED"]
    own = env.ok(employee.get(f"/api/kpi/results/{sheet}"))
    assert own["result"]["version_no"] == 1 and own["result"]["published_score"] == "5"
    assert own["versions"] == []

    blocked = move(env, cid, "NORMALIZATION")
    assert blocked.status_code == 422 and any("not reviewed" in m for m in messages(blocked))
    assert env.clients["chro"].post(f"/api/kpi/corrections/{cid}/publish").status_code == 409
    env.ok(env.clients["head"].post(f"/api/kpi/results/{sheet}/review"))
    env.ok(move(env, cid, "NORMALIZATION"))
    draft = rows(env.db, EmployeeQuarterResult, cycle_quarter_id=env.quarter(1).id, version_no=2)
    assert len(draft) == 3                                         # the whole cohort
    assert {r.employee_id: str(r.final_score) for r in draft} == {
        env.employee_id("010"): "3.00", env.employee_id("001"): "3.60",
        env.employee_id("002"): "4.00"}
    blocked = move(env, cid, "READY")
    assert blocked.status_code == 422 and any("awaits approval" in m for m in messages(blocked))
    back = move(env, cid, "DEPARTMENT_REVIEW")
    assert back.status_code == 422                                 # a reason is needed
    env.ok(move(env, cid, "DEPARTMENT_REVIEW", reason="Recheck the reviewed corrected sheet"))
    env.ok(move(env, cid, "NORMALIZATION"))
    for cohort in get(env, cid)["cohorts"]:
        env.ok(env.clients["chro"].post(f"/api/kpi/normalization-runs/{cohort['run_id']}/approve",
                                        json={}))
    env.ok(move(env, cid, "READY"))
    published = env.ok(env.clients["chro"].post(f"/api/kpi/corrections/{cid}/publish"))
    assert published["status"] == "PUBLISHED"
    assert env.clients["chro"].post(f"/api/kpi/corrections/{cid}/publish").status_code == 409

    # Every version stays; the corrected one is current.
    v1, v2 = rows(env.db, KpiSheetResult, sheet_id=sheet)
    assert (v1.status.value, v1.published_score) == ("SUPERSEDED", Decimal("5.00"))
    assert (v2.status.value, v2.published_score) == ("PUBLISHED", Decimal("3.00"))
    statuses = {(r.employee_id, r.version_no): r.status.value for r in rows(
        env.db, EmployeeQuarterResult, cycle_quarter_id=env.quarter(1).id)}
    assert set(statuses.values()) == {"SUPERSEDED", "PUBLISHED"}
    assert statuses[(env.employee_id("010"), 1)] == "SUPERSEDED"
    assert statuses[(env.employee_id("010"), 2)] == "PUBLISHED"
    assert [r.status.value for r in rows(env.db, NormalizationRun,
                                         cycle_quarter_id=env.quarter(1).id)] == [
        "SUPERSEDED", "PUBLISHED"]
    versions = env.ok(env.clients["hr"].get(f"/api/kpi/quarters/{env.quarter(1).id}/versions"))
    assert [(v["version_no"], v["current"], v["correction_id"]) for v in versions] == [
        (1, False, None), (2, True, cid)]
    assert env.ok(employee.get(f"/api/kpi/results/{sheet}"))["result"]["published_score"] == "3"
    own_sheets = env.ok(employee.get("/api/kpi/my/kpi-sheets"))
    assert own_sheets[0]["published_score"] == "3" and own_sheets[0]["outcome"]["final_score"] == "3"
    assert [h["action"] for h in reversed(published["history"])] == [
        "quarter_correction.request", "quarter_correction.approve", "quarter_correction.advance",
        "quarter_correction.return", "quarter_correction.advance", "quarter_correction.advance",
        "quarter_correction.publish"]
    event = env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "quarter_correction.publish")).one()
    assert event.changes["superseded"]["sheet_results"] == [v1.id]
    # The quarter can be corrected again, from version 2.
    again = env.ok(request(env, value_body(env, actual="95",
                                           reason="Second look at April: 95 is right")), 201)
    assert again["base_version"] == 2 and again["changes"][0]["before_actual"] == "85"


def test_contribution_weights_are_corrected_without_editing_the_stored_weights(annual_env):
    env = annual_env
    env.publish_quarter(1)
    p1 = env.env.assignment_id(env.db, "001", ("P1", "Q"))
    p2 = env.env.assignment_id(env.db, "001", ("P2", "Q"))
    body = {"reason": "Plant B support was half of the quarter's work",
            "weights": [{"employee_id": env.employee_id("001"), "weights": [
                {"assignment_id": p1, "weight": "50"}, {"assignment_id": p2, "weight": "50"}]}]}
    total = {**body, "weights": [{**body["weights"][0], "weights": [
        {"assignment_id": p1, "weight": "50"}, {"assignment_id": p2, "weight": "40"}]}]}
    assert request(env, total).status_code == 422
    created = env.ok(request(env, body), 201)
    assert created["preview"]["employees"][0]["before"] == "3.6"
    assert created["preview"]["employees"][0]["after"] == "3.5"   # 4 x 50 % + 3 x 50 %
    env.ok(approve(env, created["id"]))
    detail = get(env, created["id"])
    assert detail["sheets"] == [] and detail["changes"][0]["after_weights"][0]["weight"] == "50"
    complete(env, created["id"])
    row = env.db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.employee_id == env.employee_id("001"),
        EmployeeQuarterResult.status == "PUBLISHED")).one()
    assert (row.version_no, row.final_score) == (2, Decimal("3.50"))
    assert [c["weight"] for c in row.components] == ["50", "50"]
    stored = {w.employee_assignment_id: w.weight for w in env.db.scalars(
        select(AssignmentScoreWeight).where(
            AssignmentScoreWeight.cycle_quarter_id == env.quarter(1).id))}
    assert stored == {p1: Decimal("60.00"), p2: Decimal("40.00")}  # the overlay, not an edit


def test_corrections_follow_scope(annual_env):
    env = annual_env
    env.publish_quarter(1)
    created = env.ok(request(env, value_body(env)), 201)
    url = f"/api/kpi/corrections/{created['id']}"
    assert env.clients["hr_p2"].get(url).status_code == 404       # a P1 correction
    assert env.ok(env.clients["hr_p2"].get("/api/kpi/corrections")) == []
    head = env.ok(env.clients["head"].get(url))                    # Quality covers P1
    assert head["actions"] == {"can_decide": False, "can_advance": False, "can_return": False,
                               "can_publish": False}
    assert env.clients["head"].post(f"{url}/approve", json={
        "reason": "Department head approving"}).status_code == 403


def test_an_approval_rolls_back_with_its_audit_event(annual_env, monkeypatch):
    env = annual_env
    env.publish_all()
    env.calculate()
    created = env.ok(request(env, value_body(env)), 201)

    def failing(*args, **kwargs):
        raise RuntimeError("audit store unavailable")

    monkeypatch.setattr(corrections, "record_event", failing)
    chro = env.users["chro"]
    with pytest.raises(RuntimeError):
        with transaction(env.db):
            corrections.approve(env.db, build_principal(chro), AuditActor.from_user(chro),
                                created["id"], "Verified against the April MIS report")
    correction = env.db.get(QuarterCorrection, created["id"])
    env.db.refresh(correction)
    assert correction.status == CorrectionStatus.REQUESTED and correction.version_no is None
    assert [r.version_no for r in rows(env.db, KpiSheetResult,
                                       sheet_id=env.sheets[(1, "010", "P1")])] == [1]
    assert not any(r["draft"]["recalculation_required"] for r in env.rows().values())


# --- annual results depending on a corrected quarter ----------------------------------------

def test_annual_results_follow_a_correction_only_once_it_is_published(annual_env, as_role):
    env = annual_env
    env.publish_all()
    env.calculate()
    for row in env.rows("chro").values():
        env.ok(env.clients["chro"].post(f"/api/annual/results/{row['draft']['id']}/finalize",
                                        json={}))
    _, employee = as_role("tst.cr.self", [("EMPLOYEE", [])],
                          employee=env.env.org.employees["010"])
    assert env.ok(employee.get("/api/annual/my"))[0]["final_score"] == "4"

    # TA2: TST010's May profit 95 (score 4) is corrected to 105 (score 5).
    created = env.ok(request(env, value_body(env, n=2, period="2026-05", actual="105",
                                             reason="May profit excluded a late invoice"), n=2),
                     201)
    approved = env.ok(approve(env, created["id"]))
    flagged = approved["affected"]["annual_results_flagged"]
    assert len(flagged) == 3                                     # the employee and the cohort
    row = env.rows()["TST010"]
    assert row["published"]["recalculation_required"] is True
    assert any("being corrected" in i for i in row["issues"])
    mine = env.ok(employee.get("/api/annual/my"))[0]
    assert mine["final_score"] == "4" and mine["notice"]            # never silently current
    # Until the corrected version is published the annual result can't change.
    assert env.calculate() == {"calculated": 0, "unchanged": 3, "incomplete": 0}

    complete(env, created["id"])
    assert env.calculate() == {"calculated": 3, "unchanged": 0, "incomplete": 0}
    row = env.rows()["TST010"]
    assert (row["draft"]["version_no"], row["draft"]["calculated_score"]) == (2, "4.25")
    assert (row["published"]["version_no"], row["published"]["final_score"]) == (1, "4")
    assert env.ok(employee.get("/api/annual/my"))[0]["final_score"] == "4"  # until approved
    detail = env.ok(env.clients["chro"].post(
        f"/api/annual/results/{row['draft']['id']}/finalize", json={}))
    assert [(v["version_no"], v["status"]) for v in detail["versions"]] == [
        (2, "PUBLISHED"), (1, "SUPERSEDED")]
    v2, v1 = detail["versions"]
    assert v2["previous_id"] == v1["id"]
    assert [s["version_no"] for s in v1["sources"]] == [1, 1, 1, 1]
    assert [s["version_no"] for s in v2["sources"]] == [1, 2, 1, 1]
    mine = env.ok(employee.get("/api/annual/my"))[0]
    assert (mine["final_score"], mine["version_no"], mine["notice"]) == ("4.25", 2, None)
    # A cohort member whose score did not change still gets a version to approve.
    tst001 = env.rows()["TST001"]
    assert (tst001["draft"]["calculated_score"], tst001["published"]["final_score"]) == ("3.9",
                                                                                         "3.9")
