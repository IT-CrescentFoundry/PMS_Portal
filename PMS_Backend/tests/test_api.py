"""Read-only API behaviour, using the synthetic `org` fixture (see conftest)."""
AS_OF = "2026-08-01"


def headcount(client, org, dept=None, plant=None, as_of=AS_OF):
    params = {"as_of": as_of}
    if dept:
        params["department_id"] = org.departments[dept].id
    if plant:
        params["plant_id"] = org.plants[plant].id
    resp = client.get("/api/reports/headcount", params=params)
    assert resp.status_code == 200
    return resp.json()


def codes(items):
    return [e["employee_code"] for e in items]


# --- organization ---------------------------------------------------------

def test_plant_detail_lists_its_departments(client, org):
    body = client.get(f"/api/plants/{org.plants['P1'].id}").json()
    assert body["code"] == "TST-P1"
    assert sorted(u["department"]["code"] for u in body["units"]) == ["TST-M", "TST-Q"]


def test_shared_department_lists_every_plant(client, org):
    body = client.get(f"/api/departments/{org.departments['Q'].id}").json()
    assert sorted(u["plant"]["code"] for u in body["units"]) == ["TST-P1", "TST-P2"]


def test_departments_filtered_by_plant(client, org):
    body = client.get("/api/departments", params={"plant_id": org.plants["P2"].id}).json()
    assert [d["code"] for d in body] == ["TST-Q"]


# --- headcount: each person counted once ----------------------------------

def test_department_at_one_plant(client, org):
    body = headcount(client, org, "Q", "P2")
    assert body["scope"]["label"] == "Test Dept Q — Test Plant P2"
    assert body["headcount"] == 2            # TST002 + TST003 (after transfer)
    assert body["supporting_employees"] == 1  # TST001 (primary is at P1)


def test_department_across_all_plants_counts_multi_plant_employee_once(client, org):
    body = headcount(client, org, "Q")
    assert body["scope"]["label"] == "Test Dept Q — All Plants"
    assert body["headcount"] == 3  # TST001, TST002, TST003 — not 4
    assert body["supporting_employees"] == 0
    assert sum(u["headcount"] for u in body["by_unit"]) == body["headcount"]


def test_transfer_moves_headcount_by_date(client, org):
    before = headcount(client, org, "M", as_of="2026-06-15")
    after = headcount(client, org, "M", as_of=AS_OF)
    assert before["headcount"] == 1 and after["headcount"] == 0


def test_employee_without_primary_is_flagged_not_dropped(client, org):
    body = headcount(client, org, "M")
    assert body["employees_without_primary"] == 1  # TST004
    assert body["headcount"] == 0


# --- employee listings ------------------------------------------------------

def test_employee_listed_once_in_all_plants_scope(client, org):
    body = client.get("/api/employees", params={
        "department_id": org.departments["Q"].id, "as_of": AS_OF}).json()
    assert codes(body["items"]) == ["TST001", "TST002", "TST003"]
    assert body["total"] == 3
    tst001 = body["items"][0]
    assert len(tst001["matching_assignments"]) == 2  # both plants, one identity
    assert tst001["primary_assignment"]["plant"]["code"] == "TST-P1"


def test_primary_only_matches_headcount(client, org):
    params = {"department_id": org.departments["Q"].id, "plant_id": org.plants["P2"].id, "as_of": AS_OF}
    everyone = client.get("/api/employees", params=params).json()
    primary = client.get("/api/employees", params={**params, "primary_only": True}).json()
    assert codes(everyone["items"]) == ["TST001", "TST002", "TST003"]
    assert codes(primary["items"]) == ["TST002", "TST003"]


def test_employee_detail_keeps_assignment_history(client, org):
    emp_id = org.employees["003"].id
    body = client.get(f"/api/employees/{emp_id}", params={"as_of": AS_OF}).json()
    history = body["assignment_history"]
    assert [(a["department"]["code"], a["is_current"]) for a in history] == [
        ("TST-M", False), ("TST-Q", True)]
    assert len(body["current_assignments"]) == 1


# --- errors and validation --------------------------------------------------

def test_unknown_ids_return_404(client):
    assert client.get("/api/plants/999999").status_code == 404
    assert client.get("/api/departments/999999").status_code == 404
    assert client.get("/api/employees/999999").json() == {"detail": "Employee 999999 not found"}
    assert client.get("/api/reports/headcount", params={"plant_id": 999999}).status_code == 404


def test_invalid_query_parameters_return_422(client):
    assert client.get("/api/employees", params={"limit": 0}).status_code == 422
    assert client.get("/api/employees", params={"as_of": "not-a-date"}).status_code == 422
