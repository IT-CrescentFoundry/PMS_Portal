"""KPI library: shared definitions, plant/department applicability and scope."""
import pytest

from app.models.enums import ScopeType

GLOBAL, PLANT, DEPARTMENT, UNIT = (ScopeType.GLOBAL, ScopeType.PLANT, ScopeType.DEPARTMENT,
                                   ScopeType.PLANT_DEPARTMENT)


def kpi_body(env, name="Test scrap rate", scopes=None, direction="LOWER_IS_BETTER", policy="B"):
    return {"name": name, "unit": "%", "direction": direction,
            "default_scoring_policy_id": env.policies[policy].id,
            "applicability": scopes if scopes is not None else []}


@pytest.fixture
def heads(as_role, kpi_env):
    o = kpi_env.org
    return {
        "qa_all": as_role("tst.lib.qa", [("DEPT_HEAD", [(DEPARTMENT, None, o.departments["Q"])])]),
        "qa_p2": as_role("tst.lib.qap2", [("DEPT_HEAD", [(UNIT, o.plants["P2"], o.departments["Q"])])]),
        "admin": as_role("tst.lib.admin", [("ADMIN", [(GLOBAL, None, None)])]),
        "budget": as_role("tst.lib.budget", [("BUDGET_USER", [(GLOBAL, None, None)])]),
    }


def names(client, **params):
    resp = client.get("/api/kpi/library", params=params)
    assert resp.status_code == 200, resp.text
    return sorted(k["name"] for k in resp.json())


def test_visibility_follows_applicability_and_scope(heads, kpi_env):
    # Quality at P2: company-wide + Quality-wide KPIs, not P1-only or Maintenance ones.
    assert names(heads["qa_p2"][1]) == ["Test claims", "Test inventory days", "Test profit"]
    assert names(heads["qa_all"][1]) == ["Test claims", "Test inventory days", "Test profit", "Test yield P1"]


def test_unit_filter_returns_kpis_usable_there(heads, kpi_env):
    o = kpi_env.org
    usable_p1_m = names(heads["admin"][1], plant_id=o.plants["P1"].id, department_id=o.departments["M"].id)
    assert usable_p1_m == ["Test maintenance", "Test profit"]


def test_department_head_creates_kpi_within_scope(heads, kpi_env):
    o = kpi_env.org
    client = heads["qa_all"][1]
    resp = client.post("/api/kpi/library", json=kpi_body(kpi_env, scopes=[{"department_id": o.departments["Q"].id}]))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["code"].startswith("KPI-") and body["applicability"][0]["label"] == "Test Dept Q: all plants"


@pytest.mark.parametrize("who, scopes, expected", [
    ("qa_p2", "dept_all_plants", 403),   # a P2-only head cannot reach other plants
    ("qa_all", "company", 403),          # company-wide needs GLOBAL
    ("qa_all", "maint_unit", 403),       # another department
    ("admin", "company", 201),
])
def test_applicability_must_be_within_the_writers_scope(heads, kpi_env, who, scopes, expected):
    o = kpi_env.org
    options = {
        "dept_all_plants": [{"department_id": o.departments["Q"].id}],
        "company": [{}],
        "maint_unit": [{"plant_id": o.plants["P1"].id, "department_id": o.departments["M"].id}],
    }
    resp = heads[who][1].post("/api/kpi/library", json=kpi_body(kpi_env, name=f"Test {who} {scopes}",
                                                                scopes=options[scopes]))
    assert resp.status_code == expected, resp.text


def test_duplicates_and_mismatches_are_refused(heads, kpi_env):
    o = kpi_env.org
    admin = heads["admin"][1]
    dup = admin.post("/api/kpi/library", json=kpi_body(kpi_env, name=" test   PROFIT ", scopes=[{}]))
    assert dup.status_code == 409                                   # same meaning: reuse it
    wrong = admin.post("/api/kpi/library", json=kpi_body(kpi_env, name="Test X", scopes=[{}], policy="A"))
    assert wrong.status_code == 422                                  # lower-is-better KPI, higher policy
    missing_unit = admin.post("/api/kpi/library", json=kpi_body(
        kpi_env, name="Test Y", scopes=[{"plant_id": o.plants["P2"].id, "department_id": o.departments["M"].id}]))
    assert missing_unit.status_code == 422                           # M does not exist at P2
    none = admin.post("/api/kpi/library", json=kpi_body(kpi_env, name="Test Z", scopes=[]))
    assert none.status_code == 422


def test_read_only_roles_cannot_create(heads, kpi_env):
    resp = heads["budget"][1].post("/api/kpi/library", json=kpi_body(kpi_env, name="Test B", scopes=[{}]))
    assert resp.status_code == 403
