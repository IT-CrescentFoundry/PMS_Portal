"""Publishing binds every KPI to the approved matrix version and measurement in force."""
import pytest
from sqlalchemy import select

from app.models import KpiSheetItem
from app.models.enums import KpiDirection, ScopeType
from app.services import matrix_rules

GLOBAL, DEPARTMENT = ScopeType.GLOBAL, ScopeType.DEPARTMENT


@pytest.fixture
def team(as_role, kpi_env):
    q = kpi_env.org.departments["Q"]
    return {
        "head": as_role("tst.ks.qa", [("DEPT_HEAD", [(DEPARTMENT, None, q)])]),
        "hr_head": as_role("tst.ks.hrh", [("HR_HEAD", [(GLOBAL, None, None)])]),
        "chro": as_role("tst.ks.chro", [("CHRO", [(GLOBAL, None, None)])]),
    }


def sheet(client, env, db, items, quarter=None, employee="001", unit=("P1", "Q")):
    created = client.post("/api/kpi/sheets", json={
        "assignment_id": env.assignment_id(db, employee, unit),
        "quarter_id": (quarter or env.q1).id}).json()
    saved = client.put(f"/api/kpi/sheets/{created['id']}", json={"items": items})
    assert saved.status_code == 200, saved.text
    return created["id"]


def profit(env, weight="100"):
    return {"kpi_definition_id": env.kpis["profit"].id, "weightage": weight, "target_value": "100"}


def publish_version(team, matrix_id, definition, effective_from):
    hr, chro = team["hr_head"][1], team["chro"][1]
    version = hr.post(f"/api/matrices/{matrix_id}/revisions").json()["id"]
    assert hr.put(f"/api/matrices/{matrix_id}/versions/{version}", json={
        "definition": definition, "effective_from": effective_from,
        "applicability": [{}]}).status_code == 200
    for who, step in ((hr, "submit"), (chro, "approve"), (hr, "publish")):
        assert who.post(f"/api/matrices/{matrix_id}/versions/{version}/{step}",
                        json={}).status_code == 200
    return version


def test_publication_binds_the_version_and_measurement(team, kpi_env, db):
    head = team["head"][1]
    sheet_id = sheet(head, kpi_env, db, [
        profit(kpi_env, "60"),
        {"kpi_definition_id": kpi_env.kpis["claims"].id, "weightage": "40"}])
    body = head.post(f"/api/kpi/sheets/{sheet_id}/publish").json()
    first, second = body["items"]
    assert first["matrix_version"]["id"] == kpi_env.versions["A"].id
    assert first["matrix_version"]["matrix_code"] == "TTPOL-A" and first["frozen"]
    assert first["measurement"]["aggregation"] == "SUM"
    assert second["matrix_version"]["id"] == kpi_env.versions["Z"].id
    item = db.scalars(select(KpiSheetItem).where(KpiSheetItem.sheet_id == sheet_id)
                      .order_by(KpiSheetItem.sort_order)).first()
    assert item.scoring_snapshot["definition_hash"] == kpi_env.versions["A"].definition_hash


def test_each_quarter_uses_the_version_in_force_on_its_start_date(team, kpi_env, db):
    harsher = matrix_rules.definition_from_bands(
        KpiDirection.HIGHER_IS_BETTER, [{"threshold": 120, "score": 5}], 1, None, None)
    v2 = publish_version(team, kpi_env.versions["A"].matrix_id, harsher, "2026-10-01")
    head = team["head"][1]
    tq1 = sheet(head, kpi_env, db, [profit(kpi_env)])
    tq2 = sheet(head, kpi_env, db, [profit(kpi_env)], quarter=kpi_env.q2)
    assert head.post(f"/api/kpi/sheets/{tq1}/publish").json()["items"][0]["matrix_version"]["version_no"] == 1
    assert head.post(f"/api/kpi/sheets/{tq2}/publish").json()["items"][0]["matrix_version"]["id"] == v2


def test_without_an_approved_version_publication_is_blocked(team, kpi_env, db):
    hr = team["hr_head"][1]
    created = hr.post("/api/kpi/policies", json={
        "name": "Draft-only policy", "direction": "HIGHER_IS_BETTER",
        "bands": [{"threshold": 100, "score": 5}], "fallback_score": 1}).json()
    kpi = hr.post("/api/kpi/library", json={
        "name": "Test draft-scored KPI", "unit": "%", "direction": "HIGHER_IS_BETTER",
        "default_scoring_policy_id": created["id"], "applicability": [{}],
        "reporting_frequency": "MONTHLY", "aggregation": "AVERAGE"}).json()
    head = team["head"][1]
    sheet_id = sheet(head, kpi_env, db, [
        {"kpi_definition_id": kpi["id"], "weightage": "100", "target_value": "100"}])
    blocked = head.post(f"/api/kpi/sheets/{sheet_id}/publish")
    assert blocked.status_code == 422
    assert "no approved and published version" in blocked.json()["issues"][0]["message"]


def test_an_undefined_measurement_blocks_publication(team, kpi_env, db):
    kpi_env.kpis["profit"].aggregation = None
    db.flush()
    head = team["head"][1]
    sheet_id = sheet(head, kpi_env, db, [profit(kpi_env)])
    blocked = head.post(f"/api/kpi/sheets/{sheet_id}/publish")
    assert blocked.status_code == 422
    assert "monthly values combine into the quarter" in blocked.json()["issues"][0]["message"]


def test_reopening_releases_the_binding_until_the_next_publication(team, kpi_env, db):
    head = team["head"][1]
    sheet_id = sheet(head, kpi_env, db, [profit(kpi_env)])
    head.post(f"/api/kpi/sheets/{sheet_id}/publish")
    reopened = head.post(f"/api/kpi/sheets/{sheet_id}/reopen", json={"reason": "Target revised"}).json()
    assert reopened["items"][0]["matrix_version"] is None and not reopened["items"][0]["frozen"]


def test_an_applied_deviation_binds_new_items(team, kpi_env, db, as_role):
    head, chro = team["head"][1], team["chro"][1]
    sheet_id = sheet(head, kpi_env, db, [profit(kpi_env)])
    head.post(f"/api/kpi/sheets/{sheet_id}/publish")
    chro.post(f"/api/kpi/quarters/{kpi_env.q1.id}/start-scoring")
    o = kpi_env.org
    _, hr_p1 = as_role("tst.ks.hrp1", [("HR_HEAD", [(ScopeType.PLANT, o.plants["P1"], None)])])
    _, ph_p1 = as_role("tst.ks.php1", [("PLANT_HEAD", [(ScopeType.PLANT, o.plants["P1"], None)])])
    deviation = head.post("/api/kpi/deviations", json={
        "sheet_id": sheet_id, "reason": "Add the claims KPI after a customer audit",
        "items": [profit(kpi_env, "70"),
                  {"kpi_definition_id": kpi_env.kpis["claims"].id, "weightage": "30"}]}).json()
    hr_p1.post(f"/api/kpi/deviations/{deviation['id']}/approve", json={"as": "HR_HEAD"})
    ph_p1.post(f"/api/kpi/deviations/{deviation['id']}/approve", json={"as": "PLANT_HEAD"})
    items = head.get(f"/api/kpi/sheets/{sheet_id}").json()["items"]
    assert [i["matrix_version"]["id"] for i in items] == [kpi_env.versions["A"].id,
                                                          kpi_env.versions["Z"].id]
