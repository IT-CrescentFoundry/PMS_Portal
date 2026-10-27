"""Annual performance results, annual score deviations and CHRO approval (Stage M).

Scenario (tests/conftest.py, annual_env): cycle TST-AN with four one-month
quarters. Quarterly scores: TST010 5, 4, 5, 2 -> 4.00; TST001 (P1 60 % /
P2 40 %) 3.6, 3.4, 5.0, 3.6 -> 3.90; TST002 4, 2, 2, 1 -> 2.25.
"""
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import (
    AnnualDeviationStatus,
    AnnualResult,
    AnnualResultStatus,
    AnnualScoreDeviation,
    AuditEvent,
    EmployeeQuarterResult,
)
from app.auth.permissions import build_principal
from app.dependencies import transaction
from app.models.enums import ScopeType
from app.services import annual
from app.services.audit import AuditActor
from tests.conftest import ANNUAL_ACTUALS


def messages(resp) -> list[str]:
    return [i["message"] for i in resp.json().get("issues", [])]


# --- the calculation ----------------------------------------------------------------------------

def test_the_default_rule_is_an_exact_equal_average_rounded_half_up():
    rule = annual.DEFAULT_RULE
    d = Decimal
    # 14.50 / 4 = 3.625 -> 3.63 (half up; banker's rounding would give 3.62)
    assert annual.annual_score({1: d("3.62"), 2: d("3.63"), 3: d("3.62"), 4: d("3.63")},
                               rule) == (d("3.625"), d("3.63"))
    assert annual.annual_score({1: d("3.61"), 2: d("3.61"), 3: d("3.61"), 4: d("3.62")},
                               rule) == (d("3.6125"), d("3.61"))
    assert annual.annual_score({1: d(5), 2: d(0), 3: d(0), 4: d(0)}, rule)[1] == d("1.25")
    # A missing quarter is never treated as zero.
    with pytest.raises(ValueError, match="Q3"):
        annual.annual_score({1: d(5), 2: d(5), 4: d(5)}, rule)
    weighted = {**rule, "quarter_weights": {"1": "33.33", "2": "33.33", "3": "33.34", "4": "0"}}
    assert annual.annual_score({1: d(5), 2: d(4), 3: d(5)}, weighted) == (d("4.6667"), d("4.67"))


def test_four_published_quarters_give_a_reproducible_annual_result(annual_env):
    annual_env.publish_all()
    assert annual_env.calculate() == {"calculated": 3, "unchanged": 0, "incomplete": 0}
    rows = annual_env.rows()
    assert {c: (r["draft"]["calculated_score"], r["draft"]["final_score"])
            for c, r in rows.items()} == {"TST010": ("4", "4"), "TST001": ("3.9", "3.9"),
                                           "TST002": ("2.25", "2.25")}
    assert all(r["complete"] and not r["issues"] and r["published"] is None
               for r in rows.values())
    assert [q["score"] for q in rows["TST001"]["quarters"]] == ["3.6", "3.4", "5", "3.6"]

    detail = annual_env.detail("TST001")
    [version] = detail["versions"]
    assert version["status"] == "CALCULATED" and version["version_no"] == 1
    assert version["calculated_exact"] == "3.9" and version["rule_version"] == 1
    assert version["rule"]["quarter_weights"] == {"1": "25", "2": "25", "3": "25", "4": "25"}
    # Every source: the published quarterly result row and version, its scores
    # and the scoring and normalization policies behind it.
    sources = version["sources"]
    assert [(s["quarter_number"], s["version_no"], s["final_score"], s["weight"])
            for s in sources] == [(1, 1, "3.6", "25"), (2, 1, "3.4", "25"), (3, 1, "5", "25"),
                                  (4, 1, "3.6", "25")]
    published_rows = {r.id for r in annual_env.db.scalars(select(EmployeeQuarterResult).where(
        EmployeeQuarterResult.employee_id == annual_env.employee_id("001")))}
    assert {s["employee_result_id"] for s in sources} == published_rows
    first = sources[0]
    assert [(c["score"], c["weight"]) for c in first["components"]] == [("4", "60"), ("3", "40")]
    assert all(k["matrix_version_id"] == annual_env.env.versions["A"].id
               for s in first["scoring"] for k in s["kpis"])
    assert first["normalization"]["matrix_version_id"] == annual_env.policy.id
    assert first["normalization"]["group_key"] == "MIDDLE"
    event = annual_env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "annual_result.calculate",
        AuditEvent.entity_id == str(version["id"]))).one()
    assert event.changes["calculated_score"] == "3.90"

    # Deterministic: the same sources and rule give the same result.
    assert annual_env.calculate() == {"calculated": 0, "unchanged": 3, "incomplete": 0}
    row = annual_env.db.get(AnnualResult, version["id"])
    standing = annual._standings(annual_env.db, annual_env.cycle,
                                 [annual_env.employee_id("001")])[0]
    assert standing.inputs_hash() == row.inputs_hash
    assert standing.calculation() == (row.calculated_exact, row.calculated_score)


def test_missing_and_unpublished_quarters_block_the_annual_result(annual_env):
    annual_env.publish_quarter(1)
    annual_env.publish_quarter(2, {k: v for k, v in ANNUAL_ACTUALS[2].items()
                                   if k[0] != "002"})        # TST002 has no Q2 sheet
    annual_env.publish_quarter(3)
    rows = annual_env.rows()
    assert not rows["TST010"]["complete"]
    assert rows["TST010"]["issues"] == ["TA4 is not published yet (KPI setup)"]
    assert "TA2: no published result for this employee" in rows["TST002"]["issues"]
    assert annual_env.calculate() == {"calculated": 0, "unchanged": 0, "incomplete": 3}
    assert annual_env.db.scalars(select(AnnualResult)).all() == []
    assert rows["TST010"]["actions"]["can_calculate"] is False

    annual_env.publish_quarter(4)
    assert annual_env.calculate() == {"calculated": 2, "unchanged": 0, "incomplete": 1}
    assert annual_env.rows()["TST002"]["draft"] is None


def test_a_cross_plant_employee_is_one_annual_result(annual_env):
    annual_env.publish_all()
    annual_env.calculate()
    rows = annual_env.ok(annual_env.clients["hr"].get(
        f"/api/annual/cycles/{annual_env.cycle.id}/employees"))
    assert [r["employee"]["employee_code"] for r in rows].count("TST001") == 1
    tst001 = next(r for r in rows if r["employee"]["employee_code"] == "TST001")
    assert tst001["home_plant"]["code"] == "TST-P1"            # the primary assignment
    assert len(annual_env.db.scalars(select(AnnualResult).where(
        AnnualResult.employee_id == annual_env.employee_id("001"))).all()) == 1


def test_the_rule_is_configured_by_the_chro_until_a_result_is_approved(annual_env):
    url = f"/api/annual/cycles/{annual_env.cycle.id}/rule"
    weights = {"weights": [{"quarter_number": 1, "weight": "33.33"},
                           {"quarter_number": 2, "weight": "33.33"},
                           {"quarter_number": 3, "weight": "33.34"},
                           {"quarter_number": 4, "weight": "0"}]}
    assert annual_env.clients["hr"].put(url, json=weights).status_code == 403
    bad = annual_env.clients["chro"].put(url, json={"weights": [
        {"quarter_number": n, "weight": "20"} for n in (1, 2, 3, 4)]})
    assert bad.status_code == 422 and "total exactly 100" in messages(bad)[0]
    cycle = annual_env.ok(annual_env.clients["chro"].put(url, json=weights))
    assert cycle["rule"]["version"] == 2 and cycle["rule"]["quarter_weights"]["4"] == "0"

    for n in (1, 2, 3):
        annual_env.publish_quarter(n)
    # Q4 has weight 0: not required.
    assert annual_env.calculate()["calculated"] == 3
    rows = annual_env.rows()
    assert rows["TST010"]["draft"]["calculated_exact"] == "4.6667"
    assert rows["TST010"]["draft"]["calculated_score"] == "4.67"
    annual_env.ok(annual_env.clients["chro"].post(
        f"/api/annual/results/{rows['TST010']['draft']['id']}/finalize", json={}))
    assert annual_env.clients["chro"].put(url, json=weights).status_code == 409


# --- deviations ----------------------------------------------------------------------------------

def _request(env, client: str, result: dict, proposed: str = "4.2",
             reason: str = "Exceptional plant start-up support", original: str | None = None):
    return env.clients[client].post(f"/api/annual/results/{result['id']}/deviations", json={
        "original_score": original or result["calculated_score"], "proposed_score": proposed,
        "reason": reason})


def test_an_admin_requests_and_the_chro_decides_annual_deviations(annual_env):
    annual_env.publish_all()
    annual_env.calculate()
    draft = annual_env.rows()["TST001"]["draft"]
    assert _request(annual_env, "hr", draft).status_code == 403     # HR Head: not an Admin
    assert _request(annual_env, "chro", draft).status_code == 403   # the CHRO decides only
    assert _request(annual_env, "admin", draft, original="3.8").status_code == 409  # stale
    short = _request(annual_env, "admin", draft, reason="short")
    assert short.status_code == 422
    same = _request(annual_env, "admin", draft, proposed="3.9")
    assert same.status_code == 422
    deviation = annual_env.ok(_request(annual_env, "admin", draft), 201)
    assert deviation["status"] == "PENDING" and deviation["original_score"] == "3.9"
    assert _request(annual_env, "admin", draft).status_code == 409  # one pending at a time

    # Pending: nothing changes, and the result can't be approved yet.
    row = annual_env.rows()["TST001"]
    assert row["draft"]["final_score"] == "3.9" and row["pending_deviation"]["id"] == deviation["id"]
    assert row["actions"]["can_finalize"] is False
    blocked = annual_env.clients["chro"].post(f"/api/annual/results/{draft['id']}/finalize",
                                              json={})
    assert blocked.status_code == 422

    url = f"/api/annual/deviations/{deviation['id']}"
    assert annual_env.clients["admin"].post(f"{url}/approve", json={
        "reason": "Agreed with the plant"}).status_code == 403          # no annual:approve
    assert annual_env.clients["chro"].post(f"{url}/approve", json={"reason": "ok"}).status_code \
        == 422                                                            # reason too short
    approved = annual_env.ok(annual_env.clients["chro"].post(f"{url}/approve", json={
        "reason": "Plant start-up support confirmed by the plant head"}))
    assert approved["status"] == "APPROVED" and approved["decided_by"]["username"] == "tst.an.chro"
    row = annual_env.rows()["TST001"]
    assert (row["draft"]["calculated_score"], row["draft"]["adjusted_score"],
            row["draft"]["final_score"]) == ("3.9", "4.2", "4.2")
    event = annual_env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "annual_deviation.approve")).one()
    assert event.reason == "Plant start-up support confirmed by the plant head"
    assert event.changes["original"] == "3.90" and event.changes["final_after"] == "4.20"
    assert event.changes["requested_by_user_id"] == annual_env.users["admin"].id
    assert event.changes["decided_by_user_id"] == annual_env.users["chro"].id
    # One adjustment per calculated version.
    assert _request(annual_env, "admin", row["draft"], proposed="4.4").status_code == 409


def test_a_requester_never_decides_and_a_rejection_changes_nothing(annual_env, as_role):
    annual_env.publish_all()
    annual_env.calculate()
    _, both = as_role("tst.an.both", [("ADMIN", [(ScopeType.GLOBAL, None, None)]),
                                      ("CHRO", [(ScopeType.GLOBAL, None, None)])])
    draft = annual_env.rows()["TST002"]["draft"]
    deviation = annual_env.ok(both.post(f"/api/annual/results/{draft['id']}/deviations", json={
        "original_score": "2.25", "proposed_score": "2.5", "reason": "Requested with both roles"}),
        201)
    url = f"/api/annual/deviations/{deviation['id']}"
    refused = both.post(f"{url}/approve", json={"reason": "Approving my own request"})
    assert refused.status_code == 403
    rejected = annual_env.ok(annual_env.clients["chro"].post(f"{url}/reject", json={
        "reason": "No evidence of the claimed support"}))
    assert rejected["status"] == "REJECTED"
    row = annual_env.rows()["TST002"]["draft"]
    assert (row["final_score"], row["adjusted_score"]) == ("2.25", None)
    assert annual_env.clients["chro"].post(f"{url}/approve", json={
        "reason": "Changed my mind about it"}).status_code == 409


def test_the_chro_approves_annual_results_and_the_employee_sees_them(annual_env, as_role):
    annual_env.publish_all()
    annual_env.calculate()
    _, employee = as_role("tst.an.self", [("EMPLOYEE", [])],
                          employee=annual_env.env.org.employees["010"])
    assert annual_env.ok(employee.get("/api/annual/my")) == []
    assert employee.get(f"/api/annual/cycles/{annual_env.cycle.id}/employees").status_code == 403
    draft = annual_env.rows()["TST010"]["draft"]
    url = f"/api/annual/results/{draft['id']}/finalize"
    assert annual_env.clients["hr"].post(url, json={}).status_code == 403
    assert annual_env.clients["admin"].post(url, json={}).status_code == 403
    detail = annual_env.ok(annual_env.clients["chro"].post(url, json={"note": "Year closed"}))
    assert detail["published"]["status"] == "PUBLISHED" and detail["draft"] is None
    assert detail["published"]["published_by"]["username"] == "tst.an.chro"
    assert annual_env.clients["chro"].post(url, json={}).status_code == 409   # not twice
    mine = annual_env.ok(employee.get("/api/annual/my"))
    assert [(m["cycle_code"], m["final_score"], m["notice"]) for m in mine] == [
        ("TST-AN", "4", None)]
    assert [q["score"] for q in mine[0]["quarters"]] == ["5", "4", "5", "2"]


def test_nobody_approves_their_own_annual_result(annual_env, as_role):
    annual_env.publish_all()
    annual_env.calculate()
    _, chro_010 = as_role("tst.an.chro010", [("CHRO", [(ScopeType.GLOBAL, None, None)])],
                          employee=annual_env.env.org.employees["010"])
    draft = annual_env.rows()["TST010"]["draft"]
    assert annual_env.rows("chro")["TST010"]["actions"]["can_finalize"] is True
    refused = chro_010.post(f"/api/annual/results/{draft['id']}/finalize", json={})
    assert refused.status_code == 403 and "own annual result" in refused.json()["detail"]


def test_annual_results_follow_scope(annual_env, as_role):
    annual_env.publish_all()
    annual_env.calculate()
    # HR at P2 sees TST002 (home P2), not TST001 (home P1, also at P2) or TST010.
    assert set(annual_env.rows("hr_reader")) == {"TST002"}
    assert annual_env.clients["hr_reader"].get(
        f"/api/annual/cycles/{annual_env.cycle.id}/employees/"
        f"{annual_env.employee_id('010')}").status_code == 404
    assert annual_env.rows("hr_reader")["TST002"]["actions"]["can_calculate"] is False
    # A department head has no annual access at all.
    head = annual_env.clients["head"]
    assert head.get(f"/api/annual/cycles/{annual_env.cycle.id}/employees").status_code == 403
    assert head.get("/api/annual/cycles").status_code == 403
    # An HR Head of P2 calculates only what they cover.
    resp = annual_env.clients["hr_p2"].post(
        f"/api/annual/cycles/{annual_env.cycle.id}/calculate",
        json={"employee_ids": [annual_env.employee_id("010")]})
    assert resp.status_code == 404


def test_a_deviation_decision_rolls_back_with_its_audit_event(annual_env, monkeypatch):
    annual_env.publish_all()
    annual_env.calculate()
    draft = annual_env.rows()["TST010"]["draft"]
    deviation = annual_env.ok(_request(annual_env, "admin", draft, proposed="4.1"), 201)

    def broken(*args, **kwargs):
        raise RuntimeError("audit store unavailable")

    monkeypatch.setattr(annual, "record_event", broken)
    chro = annual_env.users["chro"]
    db = annual_env.db
    with pytest.raises(RuntimeError):
        with transaction(db):
            annual.decide_deviation(db, build_principal(chro), AuditActor.from_user(chro),
                                    deviation["id"], approve=True,
                                    reason="Approved during an outage")
    d = annual_env.db.get(AnnualScoreDeviation, deviation["id"])
    annual_env.db.refresh(d)
    assert d.status == AnnualDeviationStatus.PENDING
    row = annual_env.db.get(AnnualResult, draft["id"])
    annual_env.db.refresh(row)
    assert row.final_score == Decimal("4.00") and row.adjusted_score is None
    assert row.status == AnnualResultStatus.CALCULATED
