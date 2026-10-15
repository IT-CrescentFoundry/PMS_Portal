"""Quarterly KPI sheets: weightages, quarter versions, locking, scope, deviations, audit."""
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.auth.permissions import build_principal
from app.dependencies import transaction
from app.models import AuditEvent, KpiSheetItem
from app.models.enums import ScopeType
from app.services import audit as audit_service
from app.services import kpi_sheets
from app.services.kpi_sheets import ItemInput

GLOBAL, PLANT, DEPARTMENT, UNIT = (ScopeType.GLOBAL, ScopeType.PLANT, ScopeType.DEPARTMENT,
                                   ScopeType.PLANT_DEPARTMENT)


@pytest.fixture
def team(as_role, kpi_env):
    o = kpi_env.org
    p1, p2, q = o.plants["P1"], o.plants["P2"], o.departments["Q"]
    return {
        "qa_head": as_role("tst.sh.qa", [("DEPT_HEAD", [(DEPARTMENT, None, q)])]),
        "qa_p2": as_role("tst.sh.qap2", [("DEPT_HEAD", [(UNIT, p2, q)])]),
        "hr_head_p1": as_role("tst.sh.hrh", [("HR_HEAD", [(PLANT, p1, None)])]),
        "plant_head_p1": as_role("tst.sh.ph", [("PLANT_HEAD", [(PLANT, p1, None)])]),
        "plant_head_p2": as_role("tst.sh.ph2", [("PLANT_HEAD", [(PLANT, p2, None)])]),
        "chro": as_role("tst.sh.chro", [("CHRO", [(GLOBAL, None, None)])]),
        "self": as_role("tst.sh.self", [("EMPLOYEE", [])], employee=o.employees["001"]),
    }


def items(env, *weights, kpis=("profit", "lower", "claims", "yield_p1")):
    out = []
    for key, weight in zip(kpis, weights):
        target = None if key == "claims" else 10
        out.append({"kpi_definition_id": env.kpis[key].id, "weightage": weight, "target_value": target})
    return out


def new_sheet(client, env, db, employee="001", unit=("P1", "Q"), quarter=None):
    resp = client.post("/api/kpi/sheets", json={"assignment_id": env.assignment_id(db, employee, unit),
                                                "quarter_id": (quarter or env.q1).id})
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.parametrize("weights, publishable", [
    ((40, 30, 30), True),
    ((33.34, 33.33, 33.33), True),
    ((33.33, 33.33, 33.33), False),       # 99.99 %
    ((50, 50.01), False),                 # 100.01 %
    ((20, 20, 20, 20), False),            # 80 %
])
def test_publish_requires_exactly_100_percent(team, kpi_env, db, weights, publishable):
    client = team["qa_head"][1]
    sheet = new_sheet(client, kpi_env, db)
    saved = client.put(f"/api/kpi/sheets/{sheet['id']}", json={"items": items(kpi_env, *weights)})
    assert saved.status_code == 200, saved.text
    resp = client.post(f"/api/kpi/sheets/{sheet['id']}/publish")
    assert (resp.status_code == 200) is publishable, resp.text
    if not publishable:
        assert "must total exactly 100" in resp.json()["issues"][0]["message"]


def test_more_than_two_decimals_are_rejected(team, kpi_env, db):
    client = team["qa_head"][1]
    sheet = new_sheet(client, kpi_env, db)
    resp = client.put(f"/api/kpi/sheets/{sheet['id']}", json={"items": items(kpi_env, 33.333, 66.667)})
    assert resp.status_code == 422


def test_item_rules(team, kpi_env, db):
    client = team["qa_head"][1]
    sheet = new_sheet(client, kpi_env, db, employee="002", unit=("P2", "Q"))
    url = f"/api/kpi/sheets/{sheet['id']}"
    # A KPI applicable only to P1/Q cannot be used at P2/Q.
    resp = client.put(url, json={"items": items(kpi_env, 100, kpis=("yield_p1",))})
    assert resp.status_code == 422 and "does not apply" in resp.json()["issues"][0]["message"]
    # Duplicate KPI on one sheet.
    dup = [items(kpi_env, 50)[0], items(kpi_env, 50)[0]]
    assert client.put(url, json={"items": dup}).status_code == 422
    # Zero-tolerance target must be 0; measured KPIs need a positive target.
    bad = [{"kpi_definition_id": kpi_env.kpis["claims"].id, "weightage": 50, "target_value": 3},
           {"kpi_definition_id": kpi_env.kpis["profit"].id, "weightage": 50, "target_value": 0}]
    messages = [i["message"] for i in client.put(url, json={"items": bad}).json()["issues"]]
    assert any("zero-tolerance" in m for m in messages) and any("greater than 0" in m for m in messages)


def test_kpi_count_outside_guidance_is_only_a_warning(team, kpi_env, db):
    client = team["qa_head"][1]
    sheet = new_sheet(client, kpi_env, db)
    saved = client.put(f"/api/kpi/sheets/{sheet['id']}", json={"items": items(kpi_env, 60, 40)}).json()
    assert any("3 to 5 are recommended" in w for w in saved["warnings"])
    assert client.post(f"/api/kpi/sheets/{sheet['id']}/publish").status_code == 200


def test_multi_plant_employee_has_one_sheet_per_assignment(team, kpi_env, db):
    client = team["qa_head"][1]
    a = new_sheet(client, kpi_env, db, unit=("P1", "Q"))
    b = new_sheet(client, kpi_env, db, unit=("P2", "Q"))
    assert a["assignment"]["employee"]["id"] == b["assignment"]["employee"]["id"]
    assert (a["assignment"]["plant"]["code"], b["assignment"]["plant"]["code"]) == ("TST-P1", "TST-P2")
    dup = client.post("/api/kpi/sheets", json={"assignment_id": a["assignment"]["id"],
                                               "quarter_id": kpi_env.q1.id})
    assert dup.status_code == 409


def test_quarter_versions_are_independent(team, kpi_env, db):
    client = team["qa_head"][1]
    q1 = new_sheet(client, kpi_env, db)
    client.put(f"/api/kpi/sheets/{q1['id']}", json={"items": items(kpi_env, 50, 50)})
    copied = client.post(f"/api/kpi/sheets/{q1['id']}/copy", json={"target_quarter_id": kpi_env.q2.id})
    assert copied.status_code == 201
    q2 = copied.json()
    client.put(f"/api/kpi/sheets/{q2['id']}", json={"items": items(kpi_env, 100)})
    assert len(client.get(f"/api/kpi/sheets/{q1['id']}").json()["items"]) == 2   # Q1 untouched


def test_start_scoring_locks_the_quarter(team, kpi_env, db):
    head = team["qa_head"][1]
    published = new_sheet(head, kpi_env, db)
    head.put(f"/api/kpi/sheets/{published['id']}", json={"items": items(kpi_env, 50, 50)})
    head.post(f"/api/kpi/sheets/{published['id']}/publish")
    draft = new_sheet(head, kpi_env, db, employee="002", unit=("P2", "Q"))

    assert team["hr_head_p1"][1].post(f"/api/kpi/quarters/{kpi_env.q1.id}/start-scoring").status_code == 403
    started = team["chro"][1].post(f"/api/kpi/quarters/{kpi_env.q1.id}/start-scoring")
    assert started.status_code == 200
    assert (started.json()["locked_sheets"], started.json()["unpublished_sheets"]) == (1, 1)
    assert head.get(f"/api/kpi/sheets/{published['id']}").json()["status"] == "LOCKED"

    # No ordinary change of any kind once scoring has started.
    assert head.put(f"/api/kpi/sheets/{draft['id']}", json={"items": items(kpi_env, 100)}).status_code == 409
    assert head.post(f"/api/kpi/sheets/{draft['id']}/publish").status_code == 409
    assert head.post(f"/api/kpi/sheets/{published['id']}/reopen", json={"reason": "x"}).status_code == 409
    assert head.post("/api/kpi/sheets", json={
        "assignment_id": kpi_env.assignment_id(db, "003", ("P2", "Q")), "quarter_id": kpi_env.q1.id,
    }).status_code == 409
    assert team["chro"][1].post(f"/api/kpi/quarters/{kpi_env.q1.id}/start-scoring").status_code == 409


def test_reopen_before_start_is_allowed_and_audited(team, kpi_env, db):
    head = team["qa_head"][1]
    sheet = new_sheet(head, kpi_env, db)
    head.put(f"/api/kpi/sheets/{sheet['id']}", json={"items": items(kpi_env, 100)})
    head.post(f"/api/kpi/sheets/{sheet['id']}/publish")
    reopened = head.post(f"/api/kpi/sheets/{sheet['id']}/reopen", json={"reason": "Target revised"})
    assert reopened.json()["status"] == "DRAFT"
    reason = db.scalar(select(AuditEvent.reason).where(AuditEvent.action == "kpi_sheet.reopen"))
    assert reason == "Target revised"


def test_cross_plant_scope_bypass_is_blocked(team, kpi_env, db):
    sheet_p1 = new_sheet(team["qa_head"][1], kpi_env, db)            # Quality at P1
    p2_head = team["qa_p2"][1]
    assert p2_head.get(f"/api/kpi/sheets/{sheet_p1['id']}").status_code == 404
    assert p2_head.put(f"/api/kpi/sheets/{sheet_p1['id']}", json={"items": []}).status_code == 404
    assert p2_head.post("/api/kpi/sheets", json={
        "assignment_id": kpi_env.assignment_id(db, "001", ("P1", "Q")), "quarter_id": kpi_env.q1.id,
    }).status_code == 404
    rows = p2_head.get("/api/kpi/sheets", params={"quarter_id": kpi_env.q1.id}).json()["rows"]
    assert {r["assignment"]["plant"]["code"] for r in rows} == {"TST-P2"}


def test_employee_sees_only_own_sheet(team, kpi_env, db):
    head = team["qa_head"][1]
    own = new_sheet(head, kpi_env, db)                                # TST001 at P1/Q
    other = new_sheet(head, kpi_env, db, employee="002", unit=("P2", "Q"))
    me = team["self"][1]
    assert me.get(f"/api/kpi/sheets/{own['id']}").status_code == 200
    assert me.get(f"/api/kpi/sheets/{other['id']}").status_code == 404
    assert me.put(f"/api/kpi/sheets/{own['id']}", json={"items": []}).status_code == 403


def test_audit_is_atomic_with_the_change(team, kpi_env, db, monkeypatch):
    head_user, head = team["qa_head"]
    sheet = new_sheet(head, kpi_env, db)
    principal = build_principal(head_user)
    actor = audit_service.AuditActor.from_user(head_user)

    def failing_audit(*args, **kwargs):
        raise RuntimeError("audit store unavailable")

    monkeypatch.setattr(kpi_sheets, "record_event", failing_audit)
    with pytest.raises(RuntimeError):
        with transaction(db):
            kpi_sheets.replace_items(db, principal, actor, sheet["id"],
                                     [ItemInput(kpi_env.kpis["profit"].id, Decimal("100"), Decimal("5"))])
    # The audit failed, so the item change was rolled back with it.
    assert db.scalar(select(func.count()).select_from(KpiSheetItem)
                     .where(KpiSheetItem.sheet_id == sheet["id"])) == 0


# --- deviations ------------------------------------------------------------------------------

@pytest.fixture
def locked_sheet(team, kpi_env, db):
    head = team["qa_head"][1]
    sheet = new_sheet(head, kpi_env, db)                              # TST001 at P1/Q
    head.put(f"/api/kpi/sheets/{sheet['id']}", json={"items": items(kpi_env, 50, 50)})
    head.post(f"/api/kpi/sheets/{sheet['id']}/publish")
    team["chro"][1].post(f"/api/kpi/quarters/{kpi_env.q1.id}/start-scoring")
    return sheet


def request(team, kpi_env, sheet, weights=(30, 70)):
    return team["qa_head"][1].post("/api/kpi/deviations", json={
        "sheet_id": sheet["id"], "reason": "Customer requirement changed mid-quarter",
        "items": items(kpi_env, *weights)})


def test_deviation_needs_both_approvals_and_applies_atomically(team, kpi_env, db, locked_sheet):
    created = request(team, kpi_env, locked_sheet)
    assert created.status_code == 201, created.text
    dev = created.json()
    assert dev["status"] == "PENDING" and dev["original_items"][0]["weightage"] == "50.00"
    assert request(team, kpi_env, locked_sheet).status_code == 409              # one pending at a time

    after_hr = team["hr_head_p1"][1].post(f"/api/kpi/deviations/{dev['id']}/approve", json={"as": "HR_HEAD"})
    assert after_hr.json()["status"] == "PENDING"
    sheet_now = team["qa_head"][1].get(f"/api/kpi/sheets/{locked_sheet['id']}").json()
    assert [i["weightage"] for i in sheet_now["items"]] == [50.0, 50.0]          # not applied yet

    done = team["plant_head_p1"][1].post(f"/api/kpi/deviations/{dev['id']}/approve", json={"as": "PLANT_HEAD"})
    assert done.json()["status"] == "APPLIED" and done.json()["applied_at"]
    sheet_now = team["qa_head"][1].get(f"/api/kpi/sheets/{locked_sheet['id']}").json()
    assert [i["weightage"] for i in sheet_now["items"]] == [30.0, 70.0]
    assert sheet_now["status"] == "LOCKED" and all(i["frozen"] for i in sheet_now["items"])

    applied = db.scalars(select(AuditEvent).where(AuditEvent.action == "kpi_deviation.apply")).one()
    assert applied.reason == "Customer requirement changed mid-quarter"
    assert applied.changes["original"][0]["weightage"] == "50.00"
    assert applied.changes["revised"][0]["weightage"] == "30.00"
    assert applied.changes["hr_approved_by_user_id"] == team["hr_head_p1"][0].id
    assert applied.changes["plant_approved_by_user_id"] == team["plant_head_p1"][0].id
    assert applied.changes["hr_approved_at"] and applied.changes["plant_approved_at"]


def test_deviation_approval_rules(team, kpi_env, db, locked_sheet, as_role):
    dev = request(team, kpi_env, locked_sheet).json()
    url = f"/api/kpi/deviations/{dev['id']}/approve"
    o = kpi_env.org
    # The requester cannot approve; the wrong side is refused; another plant cannot even see it.
    assert team["qa_head"][1].post(url, json={"as": "HR_HEAD"}).status_code == 403
    assert team["plant_head_p1"][1].post(url, json={"as": "HR_HEAD"}).status_code == 403
    assert team["plant_head_p2"][1].post(url, json={"as": "PLANT_HEAD"}).status_code == 404
    # One person holding both roles still counts once.
    _, both = as_role("tst.sh.both", [("HR_HEAD", [(PLANT, o.plants["P1"], None)]),
                                      ("PLANT_HEAD", [(PLANT, o.plants["P1"], None)])])
    assert both.post(url, json={"as": "HR_HEAD"}).status_code == 200
    assert both.post(url, json={"as": "PLANT_HEAD"}).status_code == 403
    # The CHRO may approve as HR Head, but the HR side is already approved.
    assert team["chro"][1].post(url, json={"as": "HR_HEAD"}).status_code == 409


def test_deviation_rejection_and_preconditions(team, kpi_env, db, locked_sheet):
    dev = request(team, kpi_env, locked_sheet).json()
    rejected = team["plant_head_p1"][1].post(f"/api/kpi/deviations/{dev['id']}/reject",
                                             json={"reason": "Not justified"})
    assert rejected.json()["status"] == "REJECTED"
    assert team["hr_head_p1"][1].post(f"/api/kpi/deviations/{dev['id']}/approve",
                                      json={"as": "HR_HEAD"}).status_code == 409
    # Proposed items must still total 100 %.
    assert request(team, kpi_env, locked_sheet, weights=(30, 60)).status_code == 422
    # Before scoring starts, edit the sheet instead of requesting a deviation.
    fresh = new_sheet(team["qa_head"][1], kpi_env, db, quarter=kpi_env.q2)
    assert team["qa_head"][1].post("/api/kpi/deviations", json={
        "sheet_id": fresh["id"], "reason": "Not needed before start", "items": items(kpi_env, 100)}).status_code == 409


def test_database_enforces_distinct_approvers(db, kpi_env, team, locked_sheet):
    from sqlalchemy.exc import DBAPIError

    from app.models import KpiDeviation

    user_id = team["hr_head_p1"][0].id
    with pytest.raises(DBAPIError) as exc_info:
        with db.begin_nested():
            db.add(KpiDeviation(sheet_id=locked_sheet["id"], reason="direct insert", original_items=[],
                                proposed_items=[], requested_by_user_id=team["qa_head"][0].id,
                                hr_approved_by_user_id=user_id, plant_approved_by_user_id=user_id))
            db.flush()
    assert exc_info.value.orig.args[0] == 3819  # CHECK constraint violated


def test_new_roles_keep_organization_reads_within_scope(team):
    plants = team["plant_head_p1"][1].get("/api/plants").json()
    assert [p["code"] for p in plants] == ["TST-P1"]
    hr_plants = team["hr_head_p1"][1].get("/api/plants").json()
    assert [p["code"] for p in hr_plants] == ["TST-P1"]
