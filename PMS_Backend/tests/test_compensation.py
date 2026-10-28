"""Compensation matrices, compa-ratio, increment proposals and budget finalization (Stage N).

Scenario (tests/conftest.py, comp_env): approved annual results TST010 4.00,
TST001 3.90 (P1 primary, also at P2), TST002 2.25. Synthetic matrices: the
KRA matrix rates them 5, 4 and 3. With the MATRIX_INPUT method and the
synthetic baseline (CR 0.9231, 1.0526, 0.9000):

    TST010  600,000.00 x 12 %  = 72,000.00
    TST001  800,000.00 x 7.5 % = 60,000.00
    TST002  450,000.50 x 5 %   = 22,500.025 -> 22,500.03 (half up)
    TST003  no approved annual result -> excluded
    total 154,500.03 (exact 154,500.025, rounding +0.005)

Every value here is synthetic test data, not company policy.
"""
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.auth.permissions import build_principal
from app.dependencies import transaction
from app.models import (
    AnnualResult,
    AuditEvent,
    BudgetScenario,
    BudgetScenarioStatus,
    CompensationCycle,
    CompensationCycleStatus,
    MatrixVersion,
)
from app.models.enums import ScopeType
from app.services import compensation
from app.services.audit import AuditActor
from tests.conftest import (
    INCREMENT_BASE_TEST_DEFINITION,
    INCREMENT_CR_TEST_DEFINITION,
    KRA_TEST_DEFINITION,
    TEST_BASELINE,
    cr_impact_definition,
    lines_by_code,
    published_type_matrix,
)


def messages(resp) -> list[str]:
    return [i["message"] for i in resp.json().get("issues", [])]


def matrix_input_set(db) -> dict[str, MatrixVersion]:
    """Synthetic KRA and increment matrices in force for 2026."""
    return {"KRA_PERFORMANCE": published_type_matrix(db, "KRA_PERFORMANCE", KRA_TEST_DEFINITION,
                                                     name="Test KRA"),
            "INCREMENT": published_type_matrix(db, "INCREMENT", INCREMENT_CR_TEST_DEFINITION,
                                               name="Test increment",
                                               effective_to=date(2026, 12, 31))}


def prepared(env, method: str = "MATRIX_INPUT", rows=None) -> dict:
    cycle = env.create_cycle(method)
    env.ok(env.baseline(cycle["id"], rows), 201)
    return cycle


# --- matrix configuration ------------------------------------------------------------------

def test_compensation_matrices_follow_the_matrix_approval_workflow(comp_env):
    env = comp_env
    hr, chro, head = env.clients["hr"], env.clients["chro"], env.clients["head"]
    types = {t["code"]: t for t in env.ok(hr.get("/api/matrix-types"))}
    assert types["INCREMENT"]["policy_note"].startswith("Awaiting approved configuration")
    assert "INCREMENT" not in {t["code"] for t in env.ok(head.get("/api/matrix-types"))}
    created = env.ok(hr.post("/api/matrices", json={
        "matrix_type": "INCREMENT", "name": "Synthetic increment", "description": None,
        "attributes": {}, "applicability": [{"plant_id": None, "department_id": None}]}), 201)
    version_id = created["latest_version"]["id"]
    url = f"/api/matrices/{created['id']}/versions/{version_id}"
    saved = env.ok(hr.put(url, json={
        "definition": INCREMENT_CR_TEST_DEFINITION, "effective_from": "2026-04-01",
        "effective_to": None, "applicability": [{"plant_id": None, "department_id": None}],
        "change_summary": "Synthetic test values"}))
    assert saved["check"]["ok"] and saved["check"]["ready_to_submit"]
    preview = env.ok(hr.post(f"{url}/preview", json={"inputs": {"performance_rating": "4",
                                                                "compa_ratio": "1"}}))
    assert preview["outputs"]["increment_percent"] in ("7.5", 7.5)
    env.ok(hr.post(f"{url}/submit"))
    assert hr.post(f"{url}/approve", json={}).status_code == 403      # never the author
    env.ok(chro.post(f"{url}/approve", json={"note": "Synthetic test"}))
    env.ok(hr.post(f"{url}/publish"))
    types = {t["code"]: t for t in env.ok(hr.get("/api/matrix-types"))}
    assert types["INCREMENT"]["policy_note"] is None
    assert head.get(f"/api/matrices/{created['id']}").status_code in (403, 404)


def test_an_unapproved_configuration_never_produces_a_submittable_scenario(comp_env):
    env = comp_env
    cycle = prepared(env)
    detail = env.ok(env.clients["hr"].get(f"/api/compensation/cycles/{cycle['id']}"))
    assert {p["type"]: p["status"] for p in detail["policy"]} == {
        "KRA_PERFORMANCE": "AWAITING_CONFIGURATION", "INCREMENT": "AWAITING_CONFIGURATION"}
    scenario = env.ok(env.scenario(cycle["id"]), 201)
    assert scenario["included_count"] == 0
    assert {line["exclusion_code"] for line in scenario["lines"]} == {
        "NO_KRA_PERFORMANCE", "NO_ANNUAL_RESULT"}
    assert env.clients["hr"].post(
        f"/api/compensation/scenarios/{scenario['id']}/submit").status_code == 409

    # Draft versions may be chosen for analysis, but such a scenario is never submitted.
    versions = matrix_input_set(env.db)
    for v in versions.values():
        v.status = "DRAFT"
    env.db.flush()
    analysis = env.ok(env.scenario(cycle["id"], "What if", overrides={
        t: v.id for t, v in versions.items()}), 201)
    assert analysis["analysis_only"] and analysis["included_count"] == 3
    assert {v["status"] for v in analysis["matrix_versions"]} == {"DRAFT"}
    refused = env.clients["hr"].post(f"/api/compensation/scenarios/{analysis['id']}/submit")
    assert refused.status_code == 409 and "analysis" in refused.json()["detail"]


# --- calculation ---------------------------------------------------------------------------

def test_increment_proposals_are_explainable_and_rounded(comp_env):
    env = comp_env
    versions = matrix_input_set(env.db)
    cycle = prepared(env)
    scenario = env.ok(env.scenario(cycle["id"]), 201)
    lines = lines_by_code(scenario)
    assert {c: (line["status"], line["exclusion_code"]) for c, line in lines.items()} == {
        "TST010": ("INCLUDED", None), "TST001": ("INCLUDED", None),
        "TST002": ("INCLUDED", None), "TST003": ("EXCLUDED", "NO_ANNUAL_RESULT")}
    assert [(lines[c]["compa_ratio"], lines[c]["performance_rating"],
             lines[c]["increment_percent"], lines[c]["increment_amount"])
            for c in ("TST010", "TST001", "TST002")] == [
        ("0.9231", 5, "12", "72000"), ("1.0526", 4, "7.5", "60000"),
        ("0.9", 3, "5", "22500.03")]
    assert lines["TST002"]["increment_amount_exact"] == "22500.025"
    assert lines["TST002"]["new_salary"] == "472500.53"
    # Percentage, amount and resulting salary are distinct values.
    assert lines["TST010"]["current_salary"] == "600000" and lines["TST010"]["new_salary"] == "672000"
    trace = lines["TST001"]["trace"]
    assert [s["type"] for s in trace["steps"]] == ["KRA_PERFORMANCE", "INCREMENT"]
    assert trace["steps"][0]["matrix"]["version_id"] == versions["KRA_PERFORMANCE"].id
    assert trace["steps"][1]["rule"]["label"] == "4 at or above"
    assert trace["compa_ratio"]["rounded"] == "1.0526"
    assert trace["annual"]["final_score"] == "3.9"
    totals = scenario["totals"]
    assert (totals["total_current_salary"], totals["total_increment"],
            totals["total_increment_exact"], totals["rounding_difference"],
            totals["average_increment_percent"]) == ("1850000.5", "154500.03", "154500.025",
                                                     "0.005", "8.35")
    assert totals["excluded_by_reason"] == {"NO_ANNUAL_RESULT": 1}
    assert totals["reconciliation"]["employees_counted_once"]
    assert totals["reconciliation"]["lines_total"] == totals["total_increment"]
    event = env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "budget_scenario.calculate")).one()
    assert "600000" not in str(event.changes)                 # no individual salaries


def test_compa_ratio_boundaries_and_missing_inputs(comp_env):
    env = comp_env
    matrix_input_set(env.db)
    rows = [["TST010", "650000", "650000", "", "Yes", ""],     # CR exactly 1.0000 -> "at or above"
            ["TST001", "200000", "300000", "", "Yes", ""],     # 2/3 -> 0.6667 (half up)
            ["TST002", "450000", "", "", "Yes", ""]]           # no reference: CR unavailable
    cycle = prepared(env, rows=rows)
    lines = lines_by_code(env.ok(env.scenario(cycle["id"]), 201))
    assert (lines["TST010"]["compa_ratio"], lines["TST010"]["increment_percent"]) == ("1", "10")
    assert lines["TST010"]["trace"]["steps"][1]["rule"]["label"] == "5 at or above"
    assert lines["TST001"]["compa_ratio"] == "0.6667"
    assert lines["TST002"]["exclusion_code"] == "MATRIX_INPUT_MISSING"
    assert "Compa-ratio" in lines["TST002"]["exclusion_reason"]


def test_an_explicit_ineligibility_outranks_a_missing_annual_result(comp_env):
    env = comp_env
    matrix_input_set(env.db)
    rows = [["TST010", "600000", "650000", "", "Yes", ""],
            ["TST002", "450000", "500000", "", "No", "On notice"],
            ["TST003", "500000", "500000", "", "No", "Joined after the cut-off"]]
    cycle = prepared(env, rows=rows)
    scenario = env.ok(env.scenario(cycle["id"]), 201)
    lines = lines_by_code(scenario)
    assert {c: (lines[c]["exclusion_code"], lines[c]["exclusion_reason"])
            for c in ("TST002", "TST003")} == {
        "TST002": ("NOT_ELIGIBLE", "On notice"),
        "TST003": ("NOT_ELIGIBLE", "Joined after the cut-off")}
    # TST001 has an approved annual result but no baseline row.
    assert lines["TST001"]["exclusion_code"] == "NOT_IN_BASELINE"
    assert scenario["totals"]["excluded_by_reason"] == {"NOT_ELIGIBLE": 2, "NOT_IN_BASELINE": 1}


def test_the_impact_multiplier_method_needs_its_output(comp_env):
    env = comp_env
    published_type_matrix(env.db, "KRA_PERFORMANCE", KRA_TEST_DEFINITION, name="Test KRA")
    published_type_matrix(env.db, "INCREMENT", INCREMENT_BASE_TEST_DEFINITION, name="Base inc")
    wrong = published_type_matrix(env.db, "CR_IMPACT", cr_impact_definition({
        "key": "factor", "label": "Factor", "role": "output", "data_type": "DECIMAL",
        "unit": None, "description": None, "required": True, "min": "0", "max": None,
        "allowed_values": None, "source": None, "aggregation": None, "round_to": None}),
        name="No multiplier", effective_to=date(2026, 7, 31))
    rows = [["TST010", "600000", "700000", "", "Yes", ""],     # CR 0.8571 -> x1.2
            ["TST001", "800000", "700000", "", "Yes", ""],     # CR 1.1429 -> x0.8
            ["TST002", "450000.50", "500000", "", "Yes", ""]]  # CR 0.9000 -> x1
    cycle = prepared(env, "IMPACT_MULTIPLIER", rows)
    first = env.ok(env.scenario(cycle["id"], "Wrong output", overrides={"CR_IMPACT": wrong.id}),
                   201)
    assert {line["exclusion_code"] for line in first["lines"]} == {"NO_MULTIPLIER_OUTPUT"}
    published_type_matrix(env.db, "CR_IMPACT", cr_impact_definition(), name="Multiplier",
                          effective_from=date(2026, 8, 1))
    lines = lines_by_code(env.ok(env.scenario(cycle["id"], "Multiplier"), 201))
    assert [(lines[c]["base_increment_percent"], lines[c]["cr_multiplier"],
             lines[c]["increment_percent"], lines[c]["increment_amount"])
            for c in ("TST010", "TST001", "TST002")] == [
        ("10", "1.2", "12", "72000"), ("8", "0.8", "6.4", "51200"), ("5", "1", "5", "22500.03")]
    assert [s["type"] for s in lines["TST010"]["trace"]["steps"]] == [
        "KRA_PERFORMANCE", "INCREMENT", "CR_IMPACT"]


def test_a_cross_plant_employee_is_counted_once(comp_env):
    env = comp_env
    matrix_input_set(env.db)
    cycle = env.create_cycle()
    rows = TEST_BASELINE + [["TST001", "1", "", "", "Yes", ""]]
    duplicate = env.ok(env.baseline(cycle["id"], rows, step="preview"))
    assert not duplicate["ready"]
    assert "one row per employee" in duplicate["issues"][0]["message"]
    refused = env.baseline(cycle["id"], rows)
    assert refused.status_code == 422 and "one row per employee" in messages(refused)[0]
    env.ok(env.baseline(cycle["id"]), 201)
    scenario = env.ok(env.scenario(cycle["id"]), 201)
    assert [line["employee"]["employee_code"] for line in scenario["lines"]].count("TST001") == 1
    tst001 = lines_by_code(scenario)["TST001"]
    assert tst001["plant"]["code"] == "TST-P1"                 # the primary assignment
    by_unit = {(u["plant"]["code"] if u["plant"] else None): u
               for u in scenario["totals"]["by_unit"]}
    assert by_unit["TST-P1"]["included"] == 2 and by_unit["TST-P2"]["included"] == 1
    assert sum(Decimal(u["increment"]) for u in by_unit.values()) == Decimal("154500.03")


def test_baseline_import_is_validated_and_kept_out_of_the_audit_amounts(comp_env):
    env = comp_env
    cycle = env.create_cycle()
    bad = env.baseline(cycle["id"], [["TST999", "1000", "", "", "Yes", ""],
                                     ["TST010", "-5", "", "", "Yes", ""],
                                     ["TST001", "1000.555", "", "", "Yes", ""],
                                     ["TST002", "", "", "", "No", ""]], step="preview")
    assert bad.status_code == 200 and not bad.json()["ready"]
    found = [i["message"] for i in bad.json()["issues"]]
    assert any("not in the PMS" in m for m in found)
    assert any("must be above 0" in m for m in found)
    assert any("two decimals" in m for m in found)
    assert any("reason the employee is not eligible" in m for m in found)
    assert env.baseline(cycle["id"], step="preview", client="budget").status_code == 403
    first = env.ok(env.baseline(cycle["id"]), 201)
    second = env.ok(env.baseline(cycle["id"]), 201)
    assert (first["version_no"], second["version_no"]) == (1, 2)
    event = env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "compensation_baseline.import")).first()
    assert event.changes["rows"] == 4 and "800000" not in str(event.changes)
    url = f"/api/compensation/cycles/{cycle['id']}/baselines/{first['id']}"
    assert env.clients["budget"].get(url).status_code == 403
    assert env.clients["head"].get(url).status_code == 403
    rows = env.ok(env.clients["hr"].get(url))["rows"]
    assert rows[0]["current_salary"] == "600000"


# --- budget decisions and finalization ---------------------------------------------------

def test_budget_variance_revision_and_finalization(comp_env):
    env = comp_env
    matrix_input_set(env.db)
    cycle = prepared(env)
    scenario = env.ok(env.scenario(cycle["id"]), 201)
    sid = scenario["id"]
    assert env.decide(cycle["id"], "150000", reason="short").status_code == 422
    env.ok(env.decide(cycle["id"], "150000"), 201)
    over = env.ok(env.clients["chro"].get(f"/api/compensation/scenarios/{sid}"))["variance"]
    assert (over["state"], over["difference"], over["difference_percent"], over["overspend"]) == (
        "OVER_BUDGET", "-4500.03", "-2.91", "4500.03")
    detail = env.ok(env.decide(cycle["id"], "160000", reason="Revised after the board review"),
                    201)
    assert [(d["version_no"], d["status"], d["approved_amount"], d["previous_amount"])
            for d in detail["decisions"]] == [(2, "CURRENT", "160000", "150000"),
                                              (1, "SUPERSEDED", "150000", None)]
    # The budget changes nobody's increment: the scenario is unchanged.
    again = env.ok(env.clients["chro"].get(f"/api/compensation/scenarios/{sid}"))
    assert again["totals"]["total_increment"] == "154500.03"
    assert (again["variance"]["state"], again["variance"]["unallocated_balance"],
            again["variance"]["difference_percent"]) == ("UNDER_BUDGET", "5499.97", "3.56")
    assert env.clients["chro"].post(f"/api/compensation/scenarios/{sid}/approve", json={
        "reason": "Within the approved budget"}).status_code == 409      # not submitted
    env.ok(env.clients["hr"].post(f"/api/compensation/scenarios/{sid}/submit"))
    other = env.ok(env.scenario(cycle["id"], "Alternative"), 201)
    approved = env.ok(env.clients["chro"].post(f"/api/compensation/scenarios/{sid}/approve",
                                               json={"reason": "Within the approved budget"}))
    assert approved["status"] == "FINALIZED" and approved["cycle"]["status"] == "FINALIZED"
    assert approved["variance"]["decision_version"] == 2
    cycle_row = env.db.get(CompensationCycle, cycle["id"])
    env.db.refresh(cycle_row)
    assert cycle_row.status == CompensationCycleStatus.FINALIZED
    assert env.db.get(BudgetScenario, other["id"]).status == BudgetScenarioStatus.SUPERSEDED
    assert env.decide(cycle["id"], "170000").status_code == 409
    assert env.scenario(cycle["id"], "Late").status_code == 409
    event = env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "budget_scenario.approve")).one()
    assert event.changes["variance"]["approved_budget"] == "160000"


def test_separation_of_duties_and_authorization(comp_env, as_role):
    env = comp_env
    matrix_input_set(env.db)
    cycle = prepared(env)
    sid = env.ok(env.scenario(cycle["id"]), 201)["id"]
    assert env.scenario(cycle["id"], client="budget").status_code == 403
    assert env.scenario(cycle["id"], client="chro").status_code == 403
    assert env.decide(cycle["id"], "150000", client="hr").status_code == 403
    assert env.clients["head"].get("/api/compensation/cycles").status_code == 403
    env.ok(env.clients["hr"].post(f"/api/compensation/scenarios/{sid}/submit"))
    _, both = as_role("tst.cp.both", [("BUDGET_USER", [(ScopeType.GLOBAL, None, None)]),
                                      ("CHRO", [(ScopeType.GLOBAL, None, None)])])
    env.ok(both.post(f"/api/compensation/cycles/{cycle['id']}/budget-decisions",
                     json={"amount": "160000", "reason": "Recorded by a dual-role user"}), 201)
    refused = both.post(f"/api/compensation/scenarios/{sid}/approve",
                        json={"reason": "Approving my own budget"})
    assert refused.status_code == 403 and "recorded the approved budget" in refused.json()["detail"]
    assert env.clients["budget"].post(f"/api/compensation/scenarios/{sid}/approve", json={
        "reason": "Budget owner trying to approve"}).status_code == 403
    # The budget owner sees totals, never employee-level amounts or small groups.
    seen = env.ok(env.clients["budget"].get(f"/api/compensation/scenarios/{sid}"))
    assert seen["lines"] is None and seen["totals"]["total_increment"] == "154500.03"
    assert all(u["suppressed"] and u["increment"] is None for u in seen["totals"]["by_unit"])
    admin = env.ok(env.clients["admin"].get(f"/api/compensation/scenarios/{sid}"))
    assert len(admin["lines"]) == 4 and not admin["actions"]["can_approve"]


def test_a_preparer_never_approves_their_scenario(comp_env, as_role):
    env = comp_env
    matrix_input_set(env.db)
    _, both = as_role("tst.cp.hrchro", [("HR_HEAD", [(ScopeType.GLOBAL, None, None)]),
                                           ("CHRO", [(ScopeType.GLOBAL, None, None)])])
    cycle = env.create_cycle()
    env.ok(env.baseline(cycle["id"]), 201)
    sid = env.ok(both.post(f"/api/compensation/cycles/{cycle['id']}/scenarios",
                           json={"name": "Mine"}), 201)["id"]
    env.ok(both.post(f"/api/compensation/scenarios/{sid}/submit"))
    env.ok(env.decide(cycle["id"], "160000"), 201)
    refused = both.post(f"/api/compensation/scenarios/{sid}/approve",
                        json={"reason": "Approving my own scenario"})
    assert refused.status_code == 403 and "prepared or submitted" in refused.json()["detail"]


def test_a_revised_matrix_needs_a_new_scenario_and_history_is_kept(comp_env):
    env = comp_env
    versions = matrix_input_set(env.db)
    cycle = prepared(env)
    first = env.ok(env.scenario(cycle["id"], "Original matrix"), 201)
    # A revision of the increment matrix in force from July: version 1 ends in June.
    old = versions["INCREMENT"]
    old.effective_to = date(2026, 6, 30)
    revised_definition = {**INCREMENT_CR_TEST_DEFINITION, "rules": [
        {**r, "outputs": {"increment_percent": "4"}} if r["label"] == "3" else r
        for r in INCREMENT_CR_TEST_DEFINITION["rules"]]}
    from app.models import MatrixVersionScope, MatrixVersionSource, MatrixVersionStatus
    from app.services import matrix_rules
    revised = MatrixVersion(
        matrix_id=old.matrix_id, version_no=2, status=MatrixVersionStatus.PUBLISHED,
        schema_version=1, definition=revised_definition,
        definition_hash=matrix_rules.definition_hash(revised_definition),
        effective_from=date(2026, 7, 1), effective_to=date(2026, 12, 31),
        source=MatrixVersionSource.SEED, scopes=[MatrixVersionScope(plant_id=None,
                                                                    department_id=None)])
    env.db.add(revised)
    env.db.flush()
    stale = env.clients["hr"].post(f"/api/compensation/scenarios/{first['id']}/submit")
    assert stale.status_code == 422 and "no longer the published version" in messages(stale)[0]
    second = env.ok(env.scenario(cycle["id"], "Revised matrix"), 201)
    assert lines_by_code(second)["TST002"]["increment_percent"] == "4"
    assert second["totals"]["total_increment"] == "150000.02"     # 72,000 + 60,000 + 18,000.02
    # The earlier scenario is unchanged history.
    kept = env.ok(env.clients["hr"].get(f"/api/compensation/scenarios/{first['id']}"))
    assert lines_by_code(kept)["TST002"]["increment_percent"] == "5"
    assert kept["totals"]["total_increment"] == "154500.03"


def test_an_annual_result_under_recalculation_is_excluded(comp_env):
    env = comp_env
    matrix_input_set(env.db)
    cycle = prepared(env)
    row = env.db.scalars(select(AnnualResult).where(
        AnnualResult.employee_id == env.employee_id("TST010"),
        AnnualResult.status == "PUBLISHED")).one()
    row.recalculation_required = True
    env.db.flush()
    lines = lines_by_code(env.ok(env.scenario(cycle["id"]), 201))
    assert lines["TST010"]["exclusion_code"] == "ANNUAL_UNDER_RECALCULATION"


def test_finalization_rolls_back_with_its_audit_event(comp_env, monkeypatch):
    env = comp_env
    matrix_input_set(env.db)
    cycle = prepared(env)
    sid = env.ok(env.scenario(cycle["id"]), 201)["id"]
    env.ok(env.clients["hr"].post(f"/api/compensation/scenarios/{sid}/submit"))
    env.ok(env.decide(cycle["id"], "160000"), 201)

    def failing(*args, **kwargs):
        raise RuntimeError("audit store unavailable")

    monkeypatch.setattr(compensation, "record_event", failing)
    chro = env.users["chro"]
    with pytest.raises(RuntimeError):
        with transaction(env.db):
            compensation.approve(env.db, build_principal(chro), AuditActor.from_user(chro), sid,
                                 "Within the approved budget")
    scenario = env.db.get(BudgetScenario, sid)
    env.db.refresh(scenario)
    assert scenario.status == BudgetScenarioStatus.SUBMITTED
    cycle_row = env.db.get(CompensationCycle, cycle["id"])
    env.db.refresh(cycle_row)
    assert cycle_row.status == CompensationCycleStatus.OPEN
