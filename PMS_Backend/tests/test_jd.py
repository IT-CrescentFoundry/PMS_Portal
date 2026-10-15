"""Job descriptions: role-specific uniqueness, fields, sign-off workflow, scope, audit."""
import pytest
from sqlalchemy import select

from app.models import AuditEvent
from app.models.enums import ScopeType

GLOBAL, PLANT, DEPARTMENT = ScopeType.GLOBAL, ScopeType.PLANT, ScopeType.DEPARTMENT

CONTENT = {
    "format_no": "HR-F-01",
    "rev_issue_no": "01",
    "effective_date": "2026-10-08",
    "vacancies": 1,
    "vacancy_type": "NEW",
    "nature_of_job": "PERMANENT",
    "hiring_reason": "Synthetic reason",
    "min_qualification": "B.Tech",
    "work_experience": "10+ years",
    "languages": "English",
    "reports_to": "Synthetic manager role",
    "supervises": "5",
    "hr_remarks": "Synthetic role summary.",
    "responsibilities": [{"heading": "Inspection", "points": ["Oversee inspection", "Approve FAI"]}],
    "technical_competencies": [{"name": "GD&T interpretation", "level": 5}],
    "behavioural_competencies": [{"name": "Attention to detail", "level": 4}],
}


@pytest.fixture
def people(as_role, org):
    p1, q = org.plants["P1"], org.departments["Q"]
    return {
        "author": as_role("tst.jd.author", [("DEPT_HEAD", [(DEPARTMENT, None, q)])]),
        "hr": as_role("tst.jd.hr", [("HR", [(PLANT, p1, None)])]),
        "planthead": as_role("tst.jd.ph", [("PLANT_HEAD", [(PLANT, p1, None)])]),
        "chro": as_role("tst.jd.chro", [("CHRO", [(GLOBAL, None, None)])]),
        "p2_head": as_role("tst.jd.p2", [("DEPT_HEAD", [(ScopeType.PLANT_DEPARTMENT, org.plants["P2"], q)])]),
    }


def create(client, org, title="Quality Engineer — Inspection", plant="P1", **extra):
    body = {"title": title, "department_id": org.departments["Q"].id,
            "plant_id": org.plants[plant].id if plant else None, **CONTENT, **extra}
    return client.post("/api/jds", json=body)


def open_version(detail):
    return detail["open_version"]["id"]


def test_create_jd_with_all_current_format_fields(people, org):
    resp = create(people["author"][1], org)
    assert resp.status_code == 201, resp.text
    jd = resp.json()
    assert jd["code"].startswith("JD-") and jd["open_version"]["status"] == "DRAFT"
    version = people["author"][1].get(f"/api/jds/{jd['id']}/versions/{open_version(jd)}").json()
    assert version["vacancy_type"] == "NEW" and version["technical_competencies"][0]["level"] == 5
    assert version["responsibilities"][0]["points"] == ["Oversee inspection", "Approve FAI"]


def test_role_title_is_unique_per_department_and_plant(people, org):
    client = people["author"][1]
    assert create(client, org).status_code == 201
    assert create(client, org).status_code == 409                              # same role, same plant
    assert create(client, org, plant="P2").status_code == 201                  # same title, other plant
    assert create(client, org, title="Quality Engineer — Machining").status_code == 201  # other role


def test_several_roles_may_share_a_designation(people, org):
    client = people["author"][1]
    for title in ("Quality Engineer — Inspection", "Quality Engineer — Supplier quality"):
        assert create(client, org, title=title, designation_id=org.designation.id).status_code == 201


@pytest.mark.parametrize("field, value", [
    ("technical_competencies", [{"name": "x", "level": 6}]),
    ("vacancy_type", "SOMETIMES"),
    ("responsibilities", [{"heading": "", "points": ["a"]}]),
    ("unexpected_field", "x"),
])
def test_field_validation(people, org, field, value):
    assert create(people["author"][1], org, **{field: value}).status_code == 422


def test_available_budget_is_filled_by_hr_only(people, org):
    assert create(people["author"][1], org, available_budget="12 LPA").status_code == 403
    assert create(people["hr"][1], org, title="HR-filled role", available_budget="12 LPA").status_code == 201


def test_three_step_sign_off_and_supersession(people, org, db):
    author, ph, chro = people["author"][1], people["planthead"][1], people["chro"][1]
    jd = create(author, org).json()
    base = f"/api/jds/{jd['id']}/versions/{open_version(jd)}"

    assert chro.post(f"{base}/approve").status_code == 409          # must be authorised first
    assert ph.post(f"{base}/authorise").status_code == 409          # must be proposed first
    assert author.post(f"{base}/propose").json()["status"] == "PROPOSED"
    assert author.put(base, json=CONTENT).status_code == 409        # no edits under review
    assert author.post(f"{base}/authorise").status_code == 403      # DEPT_HEAD cannot authorise
    assert ph.post(f"{base}/authorise").json()["status"] == "AUTHORISED"
    approved = chro.post(f"{base}/approve").json()
    assert approved["status"] == "APPROVED"
    assert approved["proposed_by"]["username"] == "tst.jd.author"
    assert approved["authorised_by"]["username"] == "tst.jd.ph"
    assert approved["approved_by"]["username"] == "tst.jd.chro"

    revision = author.post(f"/api/jds/{jd['id']}/revisions")
    assert revision.status_code == 201 and revision.json()["version_no"] == 2
    v2 = f"/api/jds/{jd['id']}/versions/{revision.json()['id']}"
    for client, step in ((author, "propose"), (ph, "authorise"), (chro, "approve")):
        assert client.post(f"{v2}/{step}").status_code == 200
    detail = author.get(f"/api/jds/{jd['id']}").json()
    assert {v["version_no"]: v["status"] for v in detail["versions"]} == {2: "APPROVED", 1: "SUPERSEDED"}

    actions = db.scalars(select(AuditEvent.action).where(AuditEvent.entity_type == "job_description",
                                                         AuditEvent.entity_id == str(jd["id"]))).all()
    assert actions.count("jd.approve") == 2 and "jd.create" in actions and "jd.revise" in actions


def test_signatories_must_differ(as_role, org):
    p1, q = org.plants["P1"], org.departments["Q"]
    _, both = as_role("tst.jd.both", [("DEPT_HEAD", [(DEPARTMENT, None, q)]), ("PLANT_HEAD", [(PLANT, p1, None)])])
    jd = create(both, org).json()
    base = f"/api/jds/{jd['id']}/versions/{open_version(jd)}"
    both.post(f"{base}/propose")
    assert both.post(f"{base}/authorise").status_code == 403


def test_return_to_draft_needs_a_reviewer_and_reason(people, org):
    author, ph = people["author"][1], people["planthead"][1]
    jd = create(author, org).json()
    base = f"/api/jds/{jd['id']}/versions/{open_version(jd)}"
    author.post(f"{base}/propose")
    assert author.post(f"{base}/return", json={"reason": "x"}).status_code == 403
    returned = ph.post(f"{base}/return", json={"reason": "Add machining scope"}).json()
    assert returned["status"] == "DRAFT" and returned["returned_reason"] == "Add machining scope"
    assert author.put(base, json=CONTENT).status_code == 200


def test_designations_are_listed_for_org_readers_only(people, org, as_role):
    codes = [d["code"] for d in people["author"][1].get("/api/designations").json()]
    assert org.designation.code in codes
    _, employee = as_role("tst.jd.emp", [("EMPLOYEE", [])], employee=org.employees["001"])
    assert employee.get("/api/designations").status_code == 403


def test_jds_are_scope_filtered(people, org):
    jd = create(people["author"][1], org).json()           # Quality at P1
    p2_head = people["p2_head"][1]                          # Quality at P2 only
    assert p2_head.get(f"/api/jds/{jd['id']}").status_code == 404
    assert all(j["id"] != jd["id"] for j in p2_head.get("/api/jds").json())
    assert create(p2_head, org, plant="P1", title="Sneaky").status_code == 403
