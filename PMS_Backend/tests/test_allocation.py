"""Budget distribution and department allocation approval (Stage O).

Scenario (finalized company budget 160,000.00 for the synthetic Stage N
cycle; every value here is synthetic test data, not company policy):

    P1/Q  TST010  600,000.00 x 12 %  = 72,000.00
          TST001  800,000.00 x 7.5 % = 60,000.00   (P1 primary, also works at P2)
    P2/Q  TST002  450,000.50 x 5 %   = 22,500.03
          TST003  no approved annual result -> excluded (primary unit P2/Q)
    recommended total 154,500.03

Clients: hr (HR Head), chro, admin, budget (budget owner), head (Quality, all
plants), head_p1 / head_p2 (Department Heads of one unit each).
"""
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.auth.permissions import build_principal
from app.dependencies import transaction
from app.models import (
    AllocationProposal,
    AllocationStatus,
    AnnualResult,
    AuditEvent,
    BudgetDistribution,
    BudgetScenario,
    DistributionStatus,
)
from app.models.enums import ScopeType
from app.services import allocation
from app.services.audit import AuditActor
from tests.conftest import (
    INCREMENT_CR_TEST_DEFINITION,
    KRA_TEST_DEFINITION,
    published_type_matrix,
)


def D(value) -> Decimal:  # noqa: N802
    return Decimal(str(value))


@dataclass
class AllocEnv:
    comp: object
    cycle: dict
    scenario_id: int

    @property
    def c(self):
        return self.comp.clients

    @property
    def db(self):
        return self.comp.db

    def ok(self, resp, code: int = 200):
        return self.comp.ok(resp, code)

    def unit(self, plant: str, dept: str = "Q") -> dict:
        org = self.comp.annual.env.org
        return {"plant_id": org.plants[plant].id, "department_id": org.departments[dept].id}

    def plant_id(self, plant: str) -> int:
        return self.comp.annual.env.org.plants[plant].id

    def dept_id(self, dept: str) -> int:
        return self.comp.annual.env.org.departments[dept].id

    def employee_id(self, code: str) -> int:
        return self.comp.annual.employee_id(code)

    # distribution -------------------------------------------------------------------------------
    def draft(self, reason: str | None = None, client: str = "budget"):
        return self.c[client].post(f"/api/allocations/cycles/{self.cycle['id']}/distributions",
                                   json={"revision_reason": reason})

    def plant(self, plant: str, method: str, value: str, units=()) -> dict:
        return {"plant_id": self.plant_id(plant), "method": method, "value": value,
                "units": [{"department_id": self.dept_id(d), "method": m, "value": v}
                          for d, m, v in units]}

    def save(self, distribution_id: int, plants: list, mixed: bool = False,
             client: str = "budget"):
        return self.c[client].put(f"/api/allocations/distributions/{distribution_id}",
                                  json={"allow_mixed_methods": mixed, "plants": plants})

    def publish(self, distribution_id: int, client: str = "budget"):
        return self.c[client].post(f"/api/allocations/distributions/{distribution_id}/publish")

    def distribute(self, plants: list, mixed: bool = False, reason: str | None = None) -> dict:
        d = self.ok(self.draft(reason), 201)
        self.ok(self.save(d["id"], plants, mixed))
        return self.ok(self.publish(d["id"]))

    def standard(self, p2q: str = "16000") -> dict:
        """P1 137,000 (P1/Q 132,000, P1/M 0); P2 = p2q (all to P2/Q)."""
        return self.distribute([
            self.plant("P1", "AMOUNT", "137000", [("Q", "AMOUNT", "132000"), ("M", "AMOUNT", "0")]),
            self.plant("P2", "AMOUNT", p2q, [("Q", "AMOUNT", p2q)])])

    # proposals ---------------------------------------------------------------------------------
    def start(self, plant: str, client: str = "head", dept: str = "Q"):
        return self.c[client].post(f"/api/allocations/cycles/{self.cycle['id']}/proposals",
                                   json=self.unit(plant, dept))

    def save_lines(self, pid: int, lines: list[tuple[str, str, str | None]], client="head"):
        return self.c[client].put(f"/api/allocations/proposals/{pid}", json={"lines": [
            {"employee_id": self.employee_id(code), "proposed_percent": pct, "reason": reason}
            for code, pct, reason in lines]})

    def act(self, pid: int, action: str, client: str, reason: str | None = None):
        body = None
        if action in ("return", "approve", "reject"):
            body = {"reason": reason or "Reviewed against the unit budget"}
        elif action == "forward":
            body = {"note": reason}
        return self.c[client].post(f"/api/allocations/proposals/{pid}/{action}", json=body)

    def through(self, pid: int, head: str = "head") -> dict:
        self.ok(self.act(pid, "submit", head))
        self.ok(self.act(pid, "forward", "admin"))
        return self.ok(self.act(pid, "approve", "chro"))

    def overview(self, client: str = "chro", **params) -> dict:
        return self.ok(self.c[client].get(f"/api/allocations/cycles/{self.cycle['id']}",
                                          params=params))

    def set_policy(self, mode: str, inc=None, dec=None, client: str = "hr"):
        return self.c[client].put(f"/api/allocations/cycles/{self.cycle['id']}/policy", json={
            "mode": mode, "max_increase_points": inc, "max_decrease_points": dec})


@pytest.fixture
def alloc_env(comp_env, as_role) -> AllocEnv:
    env = comp_env
    published_type_matrix(env.db, "KRA_PERFORMANCE", KRA_TEST_DEFINITION, name="Test KRA")
    published_type_matrix(env.db, "INCREMENT", INCREMENT_CR_TEST_DEFINITION,
                          name="Test increment", effective_to=date(2026, 12, 31))
    cycle = env.create_cycle("MATRIX_INPUT")
    env.ok(env.baseline(cycle["id"]), 201)
    sid = env.ok(env.scenario(cycle["id"]), 201)["id"]
    env.ok(env.clients["hr"].post(f"/api/compensation/scenarios/{sid}/submit"))
    env.ok(env.decide(cycle["id"], "160000"), 201)
    env.ok(env.clients["chro"].post(f"/api/compensation/scenarios/{sid}/approve",
                                    json={"reason": "Within the approved company budget"}))
    org = env.annual.env.org
    for key, plant in (("head_p1", "P1"), ("head_p2", "P2")):
        env.users[key], env.clients[key] = as_role(f"tst.al.{key}", [
            ("DEPT_HEAD", [(ScopeType.PLANT_DEPARTMENT, org.plants[plant], org.departments["Q"])])])
    return AllocEnv(env, cycle, sid)


def issues(resp) -> list[str]:
    return [i["message"] for i in resp.json().get("issues", [])]


# --- distribution --------------------------------------------------------------------------------

def test_distribution_by_percentage_and_amount_with_explicit_residuals(alloc_env):
    env = alloc_env
    draft = env.ok(env.draft(), 201)
    assert (draft["version_no"], draft["status"], D(draft["budget_amount"])) == (
        1, "DRAFT", D("160000"))
    plants = [env.plant("P1", "PERCENT", "70", [("Q", "PERCENT", "33.3333"),
                                                ("M", "PERCENT", "66.6667")]),
              env.plant("P2", "AMOUNT", "48000", [("Q", "AMOUNT", "40000")])]
    refused = env.save(draft["id"], plants)
    assert refused.status_code == 422
    assert any("different methods" in m for m in issues(refused))
    saved = env.ok(env.save(draft["id"], plants, mixed=True))
    p1 = next(p for p in saved["plants"] if p["plant"]["code"] == "TST-P1")
    # 112,000 x 33.3333 % = 37,333.296 -> 37,333.29 (rounded down); x 66.6667 % = 74,666.704
    assert [(u["department"]["code"], D(u["amount"]), D(u["amount_exact"])) for u in p1["units"]] \
        == [("TST-Q", D("37333.29"), D("37333.296")), ("TST-M", D("74666.70"), D("74666.704"))]
    assert (D(p1["amount"]), D(p1["units_total"]), D(p1["unallocated"]),
            D(p1["rounding_residual"])) == (D("112000"), D("111999.99"), D("0.01"), D("0.01"))
    t = saved["totals"]
    assert (D(t["plants_total"]), D(t["unallocated"]), D(t["units_total"]),
            D(t["plants_unallocated"])) == (D("160000"), D("0"), D("151999.99"), D("8000.01"))
    published = env.ok(env.publish(draft["id"]))
    assert published["status"] == "PUBLISHED"
    event = env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "budget_distribution.publish")).all()[-1]
    assert len(event.changes["units_changed"]) == 3


def test_distribution_validation_and_duplicate_prevention(alloc_env):
    env = alloc_env
    draft = env.ok(env.draft(), 201)
    cases = {
        "over the company budget": [env.plant("P1", "AMOUNT", "100000"),
                                    env.plant("P2", "AMOUNT", "60000.01")],
        "units over their plant": [env.plant("P1", "AMOUNT", "100", [("Q", "AMOUNT", "100.01")])],
        "duplicate plant": [env.plant("P1", "AMOUNT", "1"), env.plant("P1", "AMOUNT", "1")],
        "duplicate unit": [env.plant("P1", "AMOUNT", "10", [("Q", "AMOUNT", "1"),
                                                            ("Q", "AMOUNT", "1")])],
        "unmapped unit": [env.plant("P2", "AMOUNT", "10", [("M", "AMOUNT", "1")])],
        "zero percent": [env.plant("P1", "PERCENT", "0")],
        "too many decimals": [env.plant("P1", "AMOUNT", "1.001")],
    }
    for label, plants in cases.items():
        assert env.save(draft["id"], plants).status_code == 422, label
    assert env.publish(draft["id"]).status_code == 422  # nothing allocated yet
    assert env.draft().status_code == 409  # one draft at a time
    assert env.draft(client="hr").status_code == 403  # only the budget owner distributes
    env.ok(env.save(draft["id"], [env.plant("P1", "AMOUNT", "160000",
                                            [("Q", "AMOUNT", "160000")])]))
    env.ok(env.publish(draft["id"]))
    assert env.draft().status_code == 422  # a revision needs a reason
    second = env.ok(env.draft("Plant 2 needs a share of the budget"), 201)
    assert second["version_no"] == 2 and second["plants"][0]["units"][0]["amount"] == "160000"
    # The database itself allows only one published version per cycle.
    with pytest.raises(IntegrityError):
        with env.db.begin_nested():
            row = env.db.get(BudgetDistribution, second["id"])
            row.status = DistributionStatus.PUBLISHED
            env.db.flush()


# --- proposals -----------------------------------------------------------------------------------

def test_cross_plant_employee_counted_once_and_scope(alloc_env):
    env = alloc_env
    env.standard()
    p1 = env.ok(env.start("P1", "head_p1"), 201)
    p2 = env.ok(env.start("P2", "head_p2"), 201)
    assert sorted(x["employee"]["employee_code"] for x in p1["lines"]) == ["TST001", "TST010"]
    # TST001 also works at P2 but is attributed to the primary unit only.
    assert [x["employee"]["employee_code"] for x in p2["lines"]] == ["TST002"]
    assert [(x["employee"]["employee_code"], x["code"]) for x in p2["excluded"]] == [
        ("TST003", "NO_ANNUAL_RESULT")]
    assert (D(p1["recommended_total"]), D(p1["unit_budget"])) == (D("132000"), D("132000"))
    assert env.start("P2", "head_p1").status_code == 403
    assert env.c["head_p1"].get(f"/api/allocations/proposals/{p2['id']}").status_code == 404
    assert env.start("P1", "head_p1").status_code == 409  # one open version per unit
    rec = env.overview()["summary"]["reconciliation"]
    assert rec["every_included_employee_in_one_unit"] is True
    assert D(rec["units_recommended_total"]) == D(rec["scenario_recommended_total"]) == \
        D("154500.03")


def test_discretion_policy_reasons_limits_and_own_line(alloc_env, as_role):
    env = alloc_env
    env.standard()
    pid = env.ok(env.start("P1"), 201)["id"]
    refused = env.save_lines(pid, [("TST010", "10", "Lower to fit the plan")])
    assert refused.status_code == 422 and "recommendation only" in issues(refused)[0]
    assert env.set_policy("WITH_REASON", client="budget").status_code == 403
    assert env.set_policy("WITH_REASON", inc="1").status_code == 422
    env.ok(env.set_policy("WITH_REASON"))
    assert "reason" in issues(env.save_lines(pid, [("TST010", "10", None)]))[0]
    saved = env.ok(env.save_lines(pid, [("TST010", "10", "Promotion already granted mid-year")]))
    line = next(x for x in saved["lines"] if x["employee"]["employee_code"] == "TST010")
    assert (line["recommended_percent"], D(line["recommended_amount"]), line["proposed_percent"],
            D(line["proposed_amount"]), D(line["difference"]), D(line["new_salary"])) == (
        "12", D("72000"), "10", D("60000"), D("-12000"), D("660000"))
    assert (saved["changed_count"], D(saved["proposed_total"]),
            D(saved["recommended_total"])) == (1, D("120000"), D("132000"))
    # The audit trail records percentages, never amounts.
    event = env.db.scalars(select(AuditEvent).where(
        AuditEvent.action == "allocation_proposal.save")).all()[-1]
    assert event.changes["lines"][0]["after"] == "10" and "60000" not in str(event.changes)
    env.ok(env.set_policy("WITHIN_LIMITS", inc="1", dec="2"))
    limited = env.save_lines(pid, [("TST010", "9", "Lower to fit the plan")])
    assert limited.status_code == 422 and "10 % to 13 %" in issues(limited)[0]
    env.ok(env.save_lines(pid, [("TST010", "10", "Lower to fit the plan")]))
    # A preparer can't change their own increment.
    org = env.comp.annual.env.org
    _user, client = as_role("tst.al.self", [("DEPT_HEAD", [(
        ScopeType.PLANT_DEPARTMENT, org.plants["P2"], org.departments["Q"])])],
        employee=org.employees["002"])
    env.c["self"] = client
    own = env.ok(env.start("P2", "self"), 201)
    assert own["lines"][0]["own"] is True
    refused = env.save_lines(own["id"], [("TST002", "6", "Exceptional contribution")], "self")
    assert refused.status_code == 422 and "your own increment" in issues(refused)[0]


def test_over_budget_submission_is_blocked_until_the_distribution_is_revised(alloc_env):
    env = alloc_env
    env.standard(p2q="16000")
    pid = env.ok(env.start("P2"), 201)["id"]
    blocked = env.act(pid, "submit", "head")
    assert blocked.status_code == 422
    assert "exceeds the unit's distributed budget of 16000 by 6500.03" in issues(blocked)[0]
    draft = env.ok(env.draft("Plant 2 Quality budget raised"), 201)
    env.ok(env.save(draft["id"], [
        env.plant("P1", "AMOUNT", "137000", [("Q", "AMOUNT", "132000"), ("M", "AMOUNT", "0")]),
        env.plant("P2", "AMOUNT", "23000", [("Q", "AMOUNT", "23000")])]))
    env.ok(env.publish(draft["id"]))
    stale = env.ok(env.c["head"].get(f"/api/allocations/proposals/{pid}"))
    assert stale["stale_reasons"] == ["The unit's distributed budget changed from 16000 to 23000."]
    assert stale["actions"]["can_refresh"] and not stale["actions"]["can_submit"]
    assert env.act(pid, "submit", "head").status_code == 422
    refreshed = env.ok(env.act(pid, "refresh", "head"))
    assert (D(refreshed["unit_budget"]), refreshed["stale_reasons"]) == (D("23000"), [])
    submitted = env.ok(env.act(pid, "submit", "head"))
    assert (submitted["status"], D(submitted["remaining_budget"])) == ("ADMIN_REVIEW",
                                                                       D("499.97"))


def test_review_approval_versions_and_separation_of_duties(alloc_env, as_role):
    env = alloc_env
    env.standard(p2q="23000")
    org = env.comp.annual.env.org
    pid = env.ok(env.start("P1"), 201)["id"]
    env.ok(env.act(pid, "submit", "head"))
    assert env.act(pid, "forward", "chro").status_code == 403
    assert env.act(pid, "approve", "chro").status_code == 409  # awaits the Admin first
    returned = env.ok(env.act(pid, "return", "admin", "Add the mid-year promotion context"))
    assert returned["status"] == "RETURNED"
    mine = env.ok(env.c["head"].get(f"/api/allocations/proposals/{pid}"))
    assert mine["actions"]["can_start_next"] and mine["decision_reason"].startswith("Add the")
    v2 = env.ok(env.start("P1"), 201)
    assert (v2["version_no"], v2["status"]) == (2, "DRAFT")
    env.ok(env.act(v2["id"], "submit", "head"))
    env.ok(env.act(v2["id"], "forward", "admin", "Checked against the unit budget"))
    assert env.act(v2["id"], "approve", "admin").status_code == 403
    assert env.act(v2["id"], "approve", "chro", "short").status_code == 422
    # The CHRO may not decide a proposal containing their own increment.
    _u, env.c["chro_self"] = as_role("tst.al.chro_self", [("CHRO", [(ScopeType.GLOBAL, None,
                                                                      None)])],
                                     employee=org.employees["010"])
    assert env.act(v2["id"], "approve", "chro_self").status_code == 403
    approved = env.ok(env.act(v2["id"], "approve", "chro", "Matches the matrix recommendation"))
    assert approved["status"] == "APPROVED"
    # A later approved version supersedes it; both are kept.
    v3 = env.ok(env.start("P1"), 201)
    env.through(v3["id"])
    statuses = [(v["version_no"], v["status"]) for v in env.ok(
        env.c["chro"].get(f"/api/allocations/proposals/{v3['id']}"))["versions"]]
    assert statuses == [(3, "APPROVED"), (2, "SUPERSEDED"), (1, "RETURNED")]
    history = env.ok(env.c["chro"].get(f"/api/allocations/proposals/{v3['id']}"))["history"]
    assert {"allocation_proposal.approve", "allocation_proposal.forward",
            "allocation_proposal.return"} <= {h["action"] for h in history}
    # One person holding Admin and CHRO can't both forward and decide.
    _u, env.c["dual"] = as_role("tst.al.dual", [("ADMIN", [(ScopeType.GLOBAL, None, None)]),
                                                ("CHRO", [(ScopeType.GLOBAL, None, None)])])
    p2 = env.ok(env.start("P2"), 201)["id"]
    env.ok(env.act(p2, "submit", "head"))
    env.ok(env.act(p2, "forward", "dual"))
    assert env.act(p2, "approve", "dual").status_code == 403
    rejected = env.ok(env.act(p2, "reject", "chro", "Hold until the audit is complete"))
    assert rejected["status"] == "REJECTED"
    # A preparer who is also an Admin can't review their own submission.
    _u, env.c["head_admin"] = as_role("tst.al.head_admin", [
        ("DEPT_HEAD", [(ScopeType.PLANT_DEPARTMENT, org.plants["P2"], org.departments["Q"])]),
        ("ADMIN", [(ScopeType.GLOBAL, None, None)])])
    p2b = env.ok(env.start("P2", "head_admin"), 201)["id"]
    env.ok(env.act(p2b, "submit", "head_admin"))
    assert env.act(p2b, "forward", "head_admin").status_code == 403


def test_budget_only_visibility_and_small_group_suppression(alloc_env, as_role):
    env = alloc_env
    env.standard(p2q="23000")
    pid = env.ok(env.start("P1"), 201)["id"]
    budget = env.overview("budget")
    assert D(budget["summary"]["budget"]) == D("160000")
    units = {(u["plant"]["code"], u["department"]["code"]): u for u in budget["units"]}
    p1q = units[("TST-P1", "TST-Q")]
    assert (D(p1q["distributed"]), p1q["recommended"], p1q["suppressed"]) == (
        D("132000"), None, True)
    assert budget["excluded"] == [] and budget["actions"]["can_read_employees"] is False
    seen = env.ok(env.c["budget"].get(f"/api/allocations/proposals/{pid}"))
    assert (seen["lines"], seen["proposed_total"], seen["suppressed"]) == (None, None, True)
    assert env.c["budget"].get(
        f"/api/allocations/cycles/{env.cycle['id']}/employees").status_code == 403
    # A Department Head sees only their unit, with its employee lines.
    head = env.overview("head_p1")
    assert head["summary"] is None
    assert [(u["plant"]["code"], u["department"]["code"]) for u in head["units"]] == [
        ("TST-P1", "TST-Q")]
    assert D(head["units"][0]["recommended"]) == D("132000")
    report = env.ok(env.c["head_p1"].get(f"/api/allocations/cycles/{env.cycle['id']}/employees"))
    assert sorted(x["employee"]["employee_code"] for x in report) == ["TST001", "TST010"]
    # Users without budget or allocation access see nothing.
    _u, env.c["nobody"] = as_role("tst.al.nobody", [("HR", [(ScopeType.GLOBAL, None, None)])])
    assert env.c["nobody"].get("/api/allocations/cycles").status_code == 403


def test_stale_after_annual_change_and_explicit_budget_revision(alloc_env):
    env = alloc_env
    env.standard(p2q="23000")
    pid = env.ok(env.start("P1"), 201)["id"]
    env.through(pid)
    # A quarter correction flags TST010's annual result for recalculation.
    result = env.db.scalars(select(AnnualResult).where(
        AnnualResult.employee_id == env.employee_id("TST010"),
        AnnualResult.status == "PUBLISHED")).one()
    result.recalculation_required = True
    env.db.flush()
    p1q = next(u for u in env.overview()["units"] if u["plant"]["code"] == "TST-P1"
               and u["department"]["code"] == "TST-Q")
    assert "the CHRO must revise the company budget" in p1q["approved_proposal"][
        "stale_reasons"][0]
    v2 = env.ok(env.start("P1"), 201)["id"]
    assert env.act(v2, "submit", "head").status_code == 422
    # Only the CHRO reopens the budget, explicitly and with a reason.
    cycle_path = f"/api/compensation/cycles/{env.cycle['id']}"
    assert env.c["hr"].post(f"{cycle_path}/reopen", json={"reason": "Annual results changed"}
                            ).status_code == 403
    reopened = env.ok(env.c["chro"].post(f"{cycle_path}/reopen",
                                         json={"reason": "Quarter correction changed TST010"}))
    assert (reopened["status"], reopened["revision_no"]) == ("OPEN", 1)
    assert env.start("P2").status_code == 409
    assert "being revised" in env.draft("Not while revising").json()["detail"]
    # The revision: the result is approved again, a new scenario approved.
    result.recalculation_required = False
    env.db.flush()
    sid2 = env.ok(env.comp.scenario(env.cycle["id"], name="Revised"), 201)["id"]
    env.ok(env.c["hr"].post(f"/api/compensation/scenarios/{sid2}/submit"))
    env.ok(env.c["chro"].post(f"/api/compensation/scenarios/{sid2}/approve",
                              json={"reason": "Revised budget after the correction"}))
    old = env.db.get(BudgetScenario, env.scenario_id)
    env.db.refresh(old)
    assert old.status == "SUPERSEDED"  # kept as history
    approved = env.ok(env.c["chro"].get(f"/api/allocations/proposals/{pid}"))
    assert approved["status"] == "APPROVED"
    assert "The company budget was revised after this version was prepared." in approved[
        "stale_reasons"]
    # The published distribution must be republished for the revised budget.
    overview = env.overview()
    assert overview["distribution"]["status"] == "PUBLISHED"
    published = env.ok(env.c["budget"].get(
        f"/api/allocations/distributions/{overview['distribution']['id']}"))
    assert published["stale_reasons"] and published["actions"]["can_start_revision"]
    draft = env.ok(env.draft("Republish for the revised budget"), 201)
    env.ok(env.publish(draft["id"]))
    refreshed = env.ok(env.act(v2, "refresh", "head"))
    assert refreshed["stale_reasons"] == [] and refreshed["scenario_id"] == sid2
    env.through(v2)
    assert env.db.scalars(select(AllocationProposal.status).where(
        AllocationProposal.id == pid)).one() == AllocationStatus.SUPERSEDED


def test_approval_rolls_back_with_its_audit_event(alloc_env, monkeypatch):
    env = alloc_env
    env.standard(p2q="23000")
    pid = env.ok(env.start("P1"), 201)["id"]
    env.ok(env.act(pid, "submit", "head"))
    env.ok(env.act(pid, "forward", "admin"))

    def failing(*args, **kwargs):
        raise RuntimeError("audit store unavailable")

    monkeypatch.setattr(allocation, "record_event", failing)
    chro = env.comp.users["chro"]
    with pytest.raises(RuntimeError):
        with transaction(env.db):
            allocation.approve_proposal(env.db, build_principal(chro),
                                        AuditActor.from_user(chro), pid,
                                        "Matches the matrix recommendation")
    proposal = env.db.get(AllocationProposal, pid)
    env.db.refresh(proposal)
    assert proposal.status == AllocationStatus.CHRO_REVIEW and proposal.decided_by_user_id is None


def test_final_report_reconciles_approved_allocations(alloc_env):
    env = alloc_env
    env.standard(p2q="23000")
    for plant in ("P1", "P2"):
        env.through(env.ok(env.start(plant), 201)["id"])
    summary = env.overview()["summary"]
    assert (D(summary["approved_total"]), D(summary["proposed_total"]),
            D(summary["recommended_total"])) == (D("154500.03"), D("154500.03"),
                                                 D("154500.03"))
    assert (D(summary["distributed_to_plants"]), D(summary["distributed_to_units"]),
            D(summary["unallocated_company"]), D(summary["unallocated_plants"])) == (
        D("160000"), D("155000"), D("0"), D("5000"))
    assert summary["by_status"] == {"APPROVED": 2, "NOT_STARTED": 1}
    assert summary["excluded_by_reason"] == {"NO_ANNUAL_RESULT": 1}
    rec = summary["reconciliation"]
    assert rec["no_employee_in_two_approved_proposals"] and rec["approved_within_unit_budgets"]
    approved_only = env.overview(status="APPROVED")["units"]
    assert len(approved_only) == 2
