"""Quarterly results: calculation, explanation, review, overrides. Publication
of a whole quarter is tested in test_quarterly.py."""
from sqlalchemy import select, update

from app.models import (
    AuditEvent,
    KpiScoreOverride,
    MatrixVersion,
    ScoreOverrideStatus,
)
from app.models.enums import KpiDirection, ScopeType
from app.services import matrix_rules
from tests.conftest import csv_bytes, import_data, import_quarter, quarter_rows

# profit (SUM, target 100): 105 -> 105 % -> 5   claims (SUM): 0 -> 5
# lower (AVERAGE, target 10): 10 -> 100 % -> 4  => 5*0.4 + 5*0.2 + 4*0.4 = 4.60
FULL = {"TKPI-1": [30, 40, 35], "TKPI-2": [0, 0, 0], "TKPI-3": [9, 10, 11]}


def calculate(env, client=None, sheet_ids=None):
    resp = (client or env.clients["head"]).post("/api/kpi/results/calculate", json={
        "quarter_id": env.env.q1.id, "sheet_ids": sheet_ids})
    assert resp.status_code == 200, resp.text
    return resp.json()


def result(env, client=None, sheet=None):
    resp = (client or env.clients["head"]).get(f"/api/kpi/results/{sheet or env.p1_sheet}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_complete_quarter_is_scored_with_a_full_explanation(scoring_env):
    import_quarter(scoring_env.clients["head"], scoring_env, FULL)
    counts = calculate(scoring_env, sheet_ids=[scoring_env.p1_sheet])
    assert counts == {"calculated": 1, "unchanged": 0, "published": 0, "complete": 1}
    body = result(scoring_env)
    assert body["result"]["final_score"] == "4.6" and body["result"]["is_complete"]
    assert body["result"]["calculated_score"] == "4.6" and body["result"]["status"] == "CALCULATED"
    profit, claims, lower = body["items"]
    assert profit["quarterly_actual"] == "105" and profit["aggregation"] == "SUM"
    assert profit["inputs"] == {"achievement_percent": "105"}
    assert profit["matrix"]["code"] == "TTPOL-A" and profit["matrix"]["version_no"] == 1
    assert profit["rule"]["description"] == "Achievement % is more than 100%"
    assert (profit["score"], profit["contribution"]) == (5, "2")
    assert claims["inputs"] == {"incident_count": "0"} and claims["score"] == 5
    assert lower["quarterly_actual"] == "10" and lower["score"] == 4
    assert lower["rule"]["description"] == "Achievement % is at least 100% and less than 110%"
    assert body["actions"]["can_review"] and not body["actions"]["can_publish"]


def test_zero_scores_are_kept_where_the_matrix_says_so(scoring_env):
    import_quarter(scoring_env.clients["head"], scoring_env, {**FULL, "TKPI-2": [0, 1, 0]})
    calculate(scoring_env)
    claims = result(scoring_env)["items"][1]
    assert claims["inputs"] == {"incident_count": "1"} and claims["score"] == 0
    assert result(scoring_env)["result"]["final_score"] == "3.6"


def test_missing_months_make_the_score_provisional(scoring_env):
    head = scoring_env.clients["head"]
    import_quarter(head, scoring_env, {k: v[:2] + [None] for k, v in FULL.items()})
    calculate(scoring_env)
    body = result(scoring_env)
    assert not body["result"]["is_complete"] and body["result"]["final_score"] is None
    assert body["result"]["calculated_score"] is not None   # provisional sum
    assert body["items"][0]["status"] == "provisional"
    assert body["items"][0]["months_missing"] == ["2026-09"]
    review = head.post(f"/api/kpi/results/{scoring_env.p1_sheet}/review")
    assert review.status_code == 409 and "incomplete" in review.json()["detail"]


def test_new_data_makes_a_result_stale(scoring_env):
    head = scoring_env.clients["head"]
    import_quarter(head, scoring_env, FULL)
    calculate(scoring_env)
    changed = csv_bytes(quarter_rows({"TKPI-1": [60]}, ("2026-09",)))
    assert import_data(head, scoring_env, "confirm", changed, "2026-09",
                       replace_existing=True).status_code == 200
    assert result(scoring_env)["result"]["stale"]
    assert head.post(f"/api/kpi/results/{scoring_env.p1_sheet}/review").status_code == 409
    assert calculate(scoring_env, sheet_ids=[scoring_env.p1_sheet])["calculated"] == 1
    assert not result(scoring_env)["result"]["stale"]
    assert calculate(scoring_env, sheet_ids=[scoring_env.p1_sheet])["unchanged"] == 1


def test_review_rights_and_no_publication_per_sheet(scoring_env, as_role):
    head, hr = scoring_env.clients["head"], scoring_env.clients["hr_head"]
    import_quarter(head, scoring_env, FULL)
    calculate(scoring_env)
    url = f"/api/kpi/results/{scoring_env.p1_sheet}"
    o = scoring_env.env.org
    _, hr_p2 = as_role("tst.res.hrp2", [("HR_HEAD", [(ScopeType.PLANT, o.plants["P2"], None)])])
    assert hr_p2.post(f"{url}/review").status_code == 404           # other plant: not visible
    assert head.post(f"{url}/review").json()["result"]["status"] == "REVIEWED"
    # Scores are published only with the whole quarter, after normalization.
    refused = hr.post(f"{url}/publish")
    assert refused.status_code == 409 and "whole quarter" in refused.json()["detail"]
    assert result(scoring_env)["actions"]["can_publish"] is False


def test_a_later_matrix_version_does_not_change_frozen_items(scoring_env, as_role, db):
    """v2 of policy A takes effect for TQ1's dates, but the locked sheet keeps v1."""
    _, hr_global = as_role("tst.res.hrg", [("HR_HEAD", [(ScopeType.GLOBAL, None, None)])])
    chro = scoring_env.clients["chro"]
    matrix_id = scoring_env.env.versions["A"].matrix_id
    v2 = hr_global.post(f"/api/matrices/{matrix_id}/revisions").json()["id"]
    harsher = matrix_rules.definition_from_bands(
        KpiDirection.HIGHER_IS_BETTER, [{"threshold": 150, "score": 5}], 1, None, None)
    assert hr_global.put(f"/api/matrices/{matrix_id}/versions/{v2}", json={
        "definition": harsher, "effective_from": "2026-07-01", "applicability": [{}]}).status_code == 200
    for who, step in ((hr_global, "submit"), (chro, "approve"), (hr_global, "publish")):
        assert who.post(f"/api/matrices/{matrix_id}/versions/{v2}/{step}", json={}).status_code == 200
    import_quarter(scoring_env.clients["head"], scoring_env, FULL)
    calculate(scoring_env)
    profit = result(scoring_env)["items"][0]
    assert profit["matrix"]["version_no"] == 1 and profit["score"] == 5


def test_an_altered_approved_version_is_refused(scoring_env, db):
    head = scoring_env.clients["head"]
    import_quarter(head, scoring_env, FULL)
    # Simulate an in-place edit of approved content (the application never does this).
    version_id = scoring_env.env.versions["A"].id
    tampered = dict(scoring_env.env.versions["A"].definition)
    tampered["no_match"] = {"mode": "default", "outputs": {"score": 5}}
    db.execute(update(MatrixVersion).where(MatrixVersion.id == version_id)
               .values(definition=tampered))
    db.expire_all()
    calculate(scoring_env)
    profit = result(scoring_env)["items"][0]
    assert profit["status"] == "error" and "no longer matches the content" in profit["message"]
    assert not result(scoring_env)["result"]["is_complete"]
    # Further data for that KPI is refused as well.
    more = import_data(head, scoring_env, "preview", csv_bytes(quarter_rows({"TKPI-1": [1]},
                                                                            ("2026-09",))),
                       "2026-09", replace_existing=True)
    assert any("no longer matches the content" in i["message"] for i in more.json()["issues"])


def test_overrides_need_both_approvals_and_are_voided_by_recalculation(scoring_env, as_role, db):
    head, hr, plant = (scoring_env.clients[k] for k in ("head", "hr_head", "plant_head"))
    import_quarter(head, scoring_env, FULL)
    calculate(scoring_env)
    url = f"/api/kpi/results/{scoring_env.p1_sheet}"
    assert head.post(f"{url}/overrides", json={"proposed_score": "4.75", "reason": "short"}).status_code == 422
    created = head.post(f"{url}/overrides", json={"proposed_score": "4.75",
                                                  "reason": "Exceptional plant commissioning effort"})
    assert created.status_code == 201, created.text
    override = created.json()
    assert override["original_score"] == "4.6" and override["status"] == "PENDING"
    assert head.post(f"{url}/overrides", json={"proposed_score": "4.8",
                                               "reason": "A second pending request"}).status_code == 409
    approve = f"/api/kpi/overrides/{override['id']}/approve"
    assert head.post(approve, json={"as": "HR_HEAD"}).status_code == 403          # requester
    o = scoring_env.env.org
    _, both = as_role("tst.res.both", [("HR_HEAD", [(ScopeType.PLANT, o.plants["P1"], None)]),
                                       ("PLANT_HEAD", [(ScopeType.PLANT, o.plants["P1"], None)])])
    assert both.post(approve, json={"as": "HR_HEAD"}).status_code == 200
    assert both.post(approve, json={"as": "PLANT_HEAD"}).status_code == 403       # same person
    applied = plant.post(approve, json={"as": "PLANT_HEAD"}).json()
    assert applied["status"] == "APPLIED"
    body = result(scoring_env)
    assert body["result"]["override_score"] == "4.75"
    event = db.scalars(select(AuditEvent).where(AuditEvent.action == "kpi_override.apply")).one()
    assert event.reason == "Exceptional plant commissioning effort"
    assert event.changes["original"] == "4.60" and event.changes["revised"] == "4.75"
    # The employee's quarterly score uses the approved override.
    employee = o.employees["001"].id
    detail = head.get(f"/api/kpi/quarters/{scoring_env.env.q1.id}/employees/{employee}").json()
    p1 = next(c for c in detail["components"] if c["sheet_id"] == scoring_env.p1_sheet)
    assert (p1["score"], p1["score_source"]) == ("4.75", "override")
    _ = hr


def test_recalculation_voids_an_applied_override(scoring_env, as_role, db):
    head, hr, plant = (scoring_env.clients[k] for k in ("head", "hr_head", "plant_head"))
    import_quarter(head, scoring_env, FULL)
    calculate(scoring_env)
    override = head.post(f"/api/kpi/results/{scoring_env.p1_sheet}/overrides", json={
        "proposed_score": "4", "reason": "Data quality concern on profit"}).json()
    hr.post(f"/api/kpi/overrides/{override['id']}/approve", json={"as": "HR_HEAD"})
    plant.post(f"/api/kpi/overrides/{override['id']}/approve", json={"as": "PLANT_HEAD"})
    changed = csv_bytes(quarter_rows({"TKPI-1": [60]}, ("2026-09",)))
    import_data(head, scoring_env, "confirm", changed, "2026-09", replace_existing=True)
    calculate(scoring_env)
    stored = db.get(KpiScoreOverride, override["id"])
    db.refresh(stored)
    assert stored.status == ScoreOverrideStatus.VOIDED and stored.voided_at is not None
    assert result(scoring_env)["result"]["override_score"] is None


def test_override_rejection(scoring_env):
    head, plant = scoring_env.clients["head"], scoring_env.clients["plant_head"]
    import_quarter(head, scoring_env, FULL)
    calculate(scoring_env)
    override = head.post(f"/api/kpi/results/{scoring_env.p1_sheet}/overrides", json={
        "proposed_score": "5", "reason": "Requested for the record"}).json()
    rejected = plant.post(f"/api/kpi/overrides/{override['id']}/reject",
                          json={"reason": "Not supported by data"}).json()
    assert rejected["status"] == "REJECTED"
    assert result(scoring_env)["result"]["override_score"] is None


def test_results_are_scope_filtered_and_visible_to_the_employee(scoring_env, as_role):
    import_quarter(scoring_env.clients["head"], scoring_env, FULL)
    calculate(scoring_env)
    o = scoring_env.env.org
    _, me = as_role("tst.res.me", [("EMPLOYEE", [])], employee=o.employees["001"])
    assert me.get(f"/api/kpi/results/{scoring_env.p1_sheet}").status_code == 200
    _, other = as_role("tst.res.other", [("EMPLOYEE", [])], employee=o.employees["002"])
    assert other.get(f"/api/kpi/results/{scoring_env.p1_sheet}").status_code == 404
    _, p2_head = as_role("tst.res.p2", [("DEPT_HEAD", [(ScopeType.PLANT_DEPARTMENT, o.plants["P2"],
                                                         o.departments["Q"])])])
    rows = p2_head.get("/api/kpi/results", params={"quarter_id": scoring_env.env.q1.id}).json()["rows"]
    assert {r["sheet"]["id"] for r in rows} == {scoring_env.p2_sheet}


def test_an_employee_sees_their_own_result_only_once_published(scoring_env, as_role):
    import_quarter(scoring_env.clients["head"], scoring_env, FULL)
    calculate(scoring_env)
    o = scoring_env.env.org
    _, me = as_role("tst.res.me2", [("EMPLOYEE", [])], employee=o.employees["001"])
    body = me.get(f"/api/kpi/results/{scoring_env.p1_sheet}").json()
    assert body["result"] is None and body["items"] == []
