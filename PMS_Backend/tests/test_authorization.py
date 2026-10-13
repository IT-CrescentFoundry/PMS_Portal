"""Role + scope enforcement on every organizational endpoint.

Uses the synthetic `org` fixture (see conftest), evaluated on AS_OF:
  units P1/Q, P2/Q, P1/M
  TST001 primary P1/Q + secondary P2/Q    TST002 primary P2/Q
  TST003 P1/M until 2026-06-30, then P2/Q TST004 secondary-only P1/M
"""
from datetime import date

import pytest

from app.models import Employee, Plant, PlantDepartment
from app.models.enums import ScopeType
from tests.conftest import add_assignment

AS_OF = "2026-08-01"
GLOBAL, PLANT, DEPARTMENT, UNIT = (
    ScopeType.GLOBAL,
    ScopeType.PLANT,
    ScopeType.DEPARTMENT,
    ScopeType.PLANT_DEPARTMENT,
)


@pytest.fixture
def as_user(make_user, client_for):
    """Signed-in client for a new user with the given role grants."""

    def _as(username, roles, employee=None):
        return client_for(make_user(username, roles=roles, employee=employee))

    return _as


def plant_codes(client):
    resp = client.get("/api/plants")
    assert resp.status_code == 200
    return [p["code"] for p in resp.json()]


def employee_codes(client, **params):
    resp = client.get("/api/employees", params={"as_of": AS_OF, **params})
    assert resp.status_code == 200, resp.text
    return [e["employee_code"] for e in resp.json()["items"]]


def employee(client, org, code, **params):
    return client.get(
        f"/api/employees/{org.employees[code].id}", params={"as_of": AS_OF, **params}
    )


def headcount(client, **params):
    return client.get("/api/reports/headcount", params={"as_of": AS_OF, **params})


def units_of(body):
    return [(u["plant"]["code"], u["department"]["code"]) for u in body["units"]]


# --- GLOBAL -------------------------------------------------------------------

def test_global_scope_sees_everything(as_user, org):
    client = as_user("tst.chro", [("CHRO", [(GLOBAL, None, None)])])
    assert plant_codes(client) == ["TST-P1", "TST-P2"]
    assert employee_codes(client) == ["TST001", "TST002", "TST003", "TST004"]
    body = headcount(client).json()
    assert body["scope"]["access_limited"] is False
    assert body["headcount"] == 3


# --- PLANT ----------------------------------------------------------------------

@pytest.fixture
def plant_p1(as_user, org):
    return as_user("tst.hr.p1", [("HR", [(PLANT, org.plants["P1"], None)])])


def test_plant_scope_lists_only_its_plant_and_departments(plant_p1, org):
    assert plant_codes(plant_p1) == ["TST-P1"]
    assert [d["code"] for d in plant_p1.get("/api/departments").json()] == ["TST-M", "TST-Q"]
    detail = plant_p1.get(f"/api/plants/{org.plants['P1'].id}").json()
    assert units_of(detail) == [("TST-P1", "TST-M"), ("TST-P1", "TST-Q")]


def test_plant_scope_cannot_open_other_plant_by_id(plant_p1, org):
    resp = plant_p1.get(f"/api/plants/{org.plants['P2'].id}")
    assert resp.status_code == 404
    # Indistinguishable from a plant that does not exist.
    assert resp.json() == {"detail": f"Plant {org.plants['P2'].id} not found"}


def test_plant_scope_shared_department_shows_only_own_plant(plant_p1, org):
    """Quality exists at P1 and P2; a P1 user sees Quality only at P1."""
    detail = plant_p1.get(f"/api/departments/{org.departments['Q'].id}").json()
    assert units_of(detail) == [("TST-P1", "TST-Q")]


def test_plant_scope_employee_list_and_history(plant_p1, org):
    assert employee_codes(plant_p1) == ["TST001", "TST004"]
    # Before the transfer TST003 was at P1, so a past date lists them.
    assert "TST003" in employee_codes(plant_p1, as_of="2026-06-15")

    tst001 = plant_p1.get("/api/employees", params={"as_of": AS_OF}).json()["items"][0]
    assert [a["plant"]["code"] for a in tst001["matching_assignments"]] == ["TST-P1"]


def test_plant_scope_sees_only_in_scope_history_of_transferred_employee(plant_p1, org):
    body = employee(plant_p1, org, "003").json()
    assert [a["plant"]["code"] for a in body["assignment_history"]] == ["TST-P1"]
    assert body["current_assignments"] == []  # now works at P2, outside access
    assert body["has_primary_assignment"] is True


def test_plant_scope_cannot_open_out_of_scope_employee(plant_p1, org):
    assert employee(plant_p1, org, "002").status_code == 404


@pytest.mark.parametrize("path", ["/api/employees", "/api/reports/headcount", "/api/departments"])
def test_plant_scope_query_parameter_bypass_is_blocked(plant_p1, org, path):
    resp = plant_p1.get(path, params={"plant_id": org.plants["P2"].id, "as_of": AS_OF})
    assert resp.status_code == 404


def test_plant_scope_headcount_is_limited_to_access(plant_p1, org):
    body = headcount(plant_p1, department_id=org.departments["Q"].id).json()
    assert body["scope"]["access_limited"] is True
    assert [(u["plant"]["code"], u["headcount"]) for u in body["by_unit"]] == [("TST-P1", 1)]
    assert body["headcount"] == 1


# --- DEPARTMENT (one department across all plants) -------------------------------

@pytest.fixture
def quality_head(as_user, org):
    return as_user(
        "tst.qa.head", [("DEPT_HEAD", [(DEPARTMENT, None, org.departments["Q"])])]
    )


def test_department_scope_spans_plants_but_not_other_departments(quality_head, org):
    assert plant_codes(quality_head) == ["TST-P1", "TST-P2"]
    assert [d["code"] for d in quality_head.get("/api/departments").json()] == ["TST-Q"]
    # Mixed-scope result: P1 also has Maintenance, which must be filtered out.
    detail = quality_head.get(f"/api/plants/{org.plants['P1'].id}").json()
    assert units_of(detail) == [("TST-P1", "TST-Q")]
    assert quality_head.get(f"/api/departments/{org.departments['M'].id}").status_code == 404


def test_department_scope_counts_cross_plant_employee_once(quality_head, org):
    assert employee_codes(quality_head) == ["TST001", "TST002", "TST003"]
    body = headcount(quality_head, department_id=org.departments["Q"].id).json()
    assert body["scope"]["access_limited"] is False
    assert body["headcount"] == 3
    assert sum(u["headcount"] for u in body["by_unit"]) == 3


def test_department_scope_blocks_other_department_parameter(quality_head, org):
    other = {"department_id": org.departments["M"].id}
    for path in ("/api/employees", "/api/reports/headcount"):
        assert quality_head.get(path, params=other).status_code == 404, path
    assert employee(quality_head, org, "004").status_code == 404  # only at P1/M


def test_department_scope_includes_future_plant_mappings(quality_head, org, db):
    """A plant opened later is covered without changing the user's scopes."""
    p3 = Plant(code="TST-P3", name="Test Plant P3")
    db.add(p3)
    db.flush()
    org.plants["P3"] = p3
    for dept in ("Q", "M"):
        org.units[("P3", dept)] = PlantDepartment(
            plant_id=p3.id, department_id=org.departments[dept].id
        )
    new_hire = Employee(employee_code="TST005", full_name="Test Person 005")
    db.add_all([*[org.units[("P3", d)] for d in ("Q", "M")], new_hire])
    db.flush()
    org.employees["005"] = new_hire
    add_assignment(db, org, "005", ("P3", "Q"), is_primary=True, effective_from=date(2026, 7, 1))

    assert plant_codes(quality_head) == ["TST-P1", "TST-P2", "TST-P3"]
    detail = quality_head.get(f"/api/plants/{p3.id}").json()
    assert units_of(detail) == [("TST-P3", "TST-Q")]  # not P3/M
    assert "TST005" in employee_codes(quality_head)


# --- PLANT_DEPARTMENT (one department at one plant) ------------------------------

@pytest.fixture
def quality_p2(as_user, org):
    return as_user(
        "tst.qa.p2",
        [("DEPT_HEAD", [(UNIT, org.plants["P2"], org.departments["Q"])])],
    )


def test_unit_scope_does_not_extend_to_same_department_at_other_plant(quality_p2, org):
    assert plant_codes(quality_p2) == ["TST-P2"]
    assert quality_p2.get(f"/api/plants/{org.plants['P1'].id}").status_code == 404
    detail = quality_p2.get(f"/api/departments/{org.departments['Q'].id}").json()
    assert units_of(detail) == [("TST-P2", "TST-Q")]


@pytest.mark.parametrize(
    "params",
    [
        lambda o: {"plant_id": o.plants["P1"].id},
        lambda o: {"department_id": o.departments["M"].id},
        lambda o: {"plant_id": o.plants["P1"].id, "department_id": o.departments["Q"].id},
    ],
)
def test_unit_scope_query_parameter_bypass_is_blocked(quality_p2, org, params):
    for path in ("/api/employees", "/api/reports/headcount", "/api/departments"):
        if path == "/api/departments" and "plant_id" not in params(org):
            continue
        assert quality_p2.get(path, params=params(org)).status_code == 404, path


def test_unit_scope_shows_supporting_employee_without_leaking_primary(quality_p2, org):
    resp = quality_p2.get("/api/employees", params={"as_of": AS_OF}).json()
    assert [e["employee_code"] for e in resp["items"]] == ["TST001", "TST002", "TST003"]
    tst001 = resp["items"][0]
    assert tst001["has_primary_assignment"] is True
    assert tst001["primary_assignment"] is None  # primary is at P1, outside access
    assert [(a["plant"]["code"], a["is_primary"]) for a in tst001["matching_assignments"]] == [
        ("TST-P2", False)
    ]


def test_unit_scope_employee_detail_keeps_identity_but_hides_other_plant(quality_p2, org):
    body = employee(quality_p2, org, "001").json()
    assert body["employee_code"] == "TST001"
    assert [(a["plant"]["code"], a["is_primary"]) for a in body["assignment_history"]] == [
        ("TST-P2", False)
    ]


def test_unit_scope_headcount_preserves_primary_vs_supporting(quality_p2, org):
    body = headcount(quality_p2, department_id=org.departments["Q"].id).json()
    assert body["scope"]["access_limited"] is True
    assert body["headcount"] == 2  # TST002, TST003
    assert body["supporting_employees"] == 1  # TST001
    assert [(u["plant"]["code"], u["department"]["code"]) for u in body["by_unit"]] == [
        ("TST-P2", "TST-Q")
    ]


# --- no effective scope ------------------------------------------------------------

ORG_PATHS = ["/api/plants", "/api/departments", "/api/employees", "/api/reports/headcount"]


@pytest.mark.parametrize(
    "roles",
    [
        [],  # no roles at all
        [("DEPT_HEAD", [])],  # role granted without any scope rows
        [("EMPLOYEE", [(GLOBAL, None, None)])],  # misconfigured: EMPLOYEE can't widen access
        [("UNKNOWN_ROLE", [(GLOBAL, None, None)])],  # unknown role codes grant nothing
    ],
    ids=["no-roles", "role-without-scope", "employee-with-global-scope", "unknown-role"],
)
def test_users_without_effective_scope_get_403(as_user, org, roles):
    client = as_user("tst.noscope", roles)
    for path in ORG_PATHS:
        resp = client.get(path)
        assert resp.status_code == 403, path
    assert client.get(f"/api/plants/{org.plants['P1'].id}").status_code == 403
    assert employee(client, org, "001").status_code == 403
    assert client.get("/api/auth/me").status_code == 200  # still authenticated


# --- self-service ------------------------------------------------------------------

def test_employee_can_read_only_own_record(as_user, org):
    client = as_user("tst.self", [("EMPLOYEE", [])], employee=org.employees["001"])
    own = employee(client, org, "001")
    assert own.status_code == 200
    # Own record shows every assignment, at both plants.
    assert [a["plant"]["code"] for a in own.json()["assignment_history"]] == [
        "TST-P1",
        "TST-P2",
    ]
    assert employee(client, org, "002").status_code == 404
    for path in ORG_PATHS:
        assert client.get(path).status_code == 403, path


# --- multiple roles: union of scopes ---------------------------------------------------

def test_multi_role_user_gets_union_of_scopes(as_user, org):
    client = as_user(
        "tst.multi",
        [
            ("DEPT_HEAD", [(UNIT, org.plants["P1"], org.departments["M"])]),
            ("HR", [(PLANT, org.plants["P2"], None)]),
            ("EMPLOYEE", []),
        ],
        employee=org.employees["004"],
    )
    assert plant_codes(client) == ["TST-P1", "TST-P2"]
    p1 = client.get(f"/api/plants/{org.plants['P1'].id}").json()
    assert units_of(p1) == [("TST-P1", "TST-M")]  # not P1/Q
    assert employee_codes(client) == ["TST001", "TST002", "TST003", "TST004"]
    tst001 = client.get("/api/employees", params={"as_of": AS_OF}).json()["items"][0]
    assert tst001["primary_assignment"] is None  # P1/Q is not in the union
    assert [a["plant"]["code"] for a in tst001["matching_assignments"]] == ["TST-P2"]
