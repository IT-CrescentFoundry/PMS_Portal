"""Matrix configurations: HR Head authoring, CHRO approval, versions, scope, audit."""
from dataclasses import replace
from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError

from app.auth.permissions import build_principal
from app.dependencies import transaction
from app.models import AuditEvent, MatrixVersion, MatrixVersionStatus
from app.models.enums import KpiDirection, ScopeType
from app.services import matrix_rules, matrix_service, matrix_types
from app.services.audit import AuditActor
from app.services.matrix_types import DataType, FieldSpec, Source

GLOBAL, PLANT, DEPARTMENT = ScopeType.GLOBAL, ScopeType.PLANT, ScopeType.DEPARTMENT
VALID = matrix_rules.definition_from_bands(
    KpiDirection.HIGHER_IS_BETTER, [{"threshold": 100, "score": 5}, {"threshold": 90, "score": 4}],
    1, None, None)


@pytest.fixture
def people(as_role, org):
    p1, q = org.plants["P1"], org.departments["Q"]
    return {
        "hr_head": as_role("tst.mx.hrh", [("HR_HEAD", [(GLOBAL, None, None)])]),
        "hr_head_p1": as_role("tst.mx.hrh1", [("HR_HEAD", [(PLANT, p1, None)])]),
        "chro": as_role("tst.mx.chro", [("CHRO", [(GLOBAL, None, None)])]),
        "dual": as_role("tst.mx.dual", [("HR_HEAD", [(GLOBAL, None, None)]),
                                        ("CHRO", [(GLOBAL, None, None)])]),
        "dept_head": as_role("tst.mx.dh", [("DEPT_HEAD", [(DEPARTMENT, None, q)])]),
        "admin": as_role("tst.mx.admin", [("ADMIN", [(GLOBAL, None, None)])]),
        "employee": as_role("tst.mx.emp", [("EMPLOYEE", [])], employee=org.employees["001"]),
    }


def create(client, name="Test scoring matrix", matrix_type="KPI_SCORING", scopes=None, **attrs):
    return client.post("/api/matrices", json={
        "matrix_type": matrix_type, "name": name,
        "attributes": attrs or ({"direction": "HIGHER_IS_BETTER"} if matrix_type == "KPI_SCORING" else {}),
        "applicability": scopes if scopes is not None else [{}]})


def save(client, matrix, version_id, definition=VALID, effective_from="2026-04-01", scopes=None,
         effective_to=None):
    return client.put(f"/api/matrices/{matrix['id']}/versions/{version_id}", json={
        "definition": definition, "effective_from": effective_from, "effective_to": effective_to,
        "applicability": scopes if scopes is not None else [{}]})


def step(client, matrix, version_id, name, body=None):
    return client.post(f"/api/matrices/{matrix['id']}/versions/{version_id}/{name}",
                       json=body if body is not None else {})


def published(people, name="Test scoring matrix", definition=VALID, effective_from="2026-04-01",
              matrix_type="KPI_SCORING", scopes=None, **attrs):
    hr, chro = people["hr_head"][1], people["chro"][1]
    matrix = create(hr, name, matrix_type, scopes, **attrs).json()
    vid = matrix["latest_version"]["id"]
    assert save(hr, matrix, vid, definition, effective_from, scopes).status_code == 200
    assert step(hr, matrix, vid, "submit").status_code == 200
    assert step(chro, matrix, vid, "approve").status_code == 200
    assert step(hr, matrix, vid, "publish").status_code == 200
    return matrix, vid


def test_hr_head_creates_a_kpi_matrix_and_its_policy(people):
    resp = create(people["hr_head"][1])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["code"].startswith("KSM-") and body["latest_version"]["status"] == "DRAFT"
    assert body["policy"]["code"].startswith("POL-") and body["in_force"] is None
    policies = people["hr_head"][1].get("/api/kpi/policies").json()
    created = next(p for p in policies if p["id"] == body["policy"]["id"])
    assert created["matrix"]["latest"]["status"] == "DRAFT" and created["direction"] == "HIGHER_IS_BETTER"


def test_drafts_save_with_errors_but_cannot_be_submitted(people):
    hr = people["hr_head"][1]
    matrix = create(hr).json()
    vid = matrix["latest_version"]["id"]
    bad = {**VALID, "rules": [*VALID["rules"], VALID["rules"][0] | {"priority": 9}]}
    saved = save(hr, matrix, vid, bad)
    assert saved.status_code == 200 and not saved.json()["check"]["ok"]
    assert any("same conditions" in e["message"] for e in saved.json()["check"]["errors"])
    submitted = step(hr, matrix, vid, "submit")
    assert submitted.status_code == 422
    # An effective date and applicability are needed too.
    save(hr, matrix, vid, VALID, effective_from=None)
    issues = step(hr, matrix, vid, "submit").json()["issues"]
    assert any("Set the date from which" in i["message"] for i in issues)


def test_full_workflow_with_chro_approval(people, db):
    hr, chro = people["hr_head"][1], people["chro"][1]
    matrix = create(hr).json()
    vid = matrix["latest_version"]["id"]
    save(hr, matrix, vid)
    assert step(hr, matrix, vid, "submit").json()["status"] == "SUBMITTED"
    assert hr.put(f"/api/matrices/{matrix['id']}/versions/{vid}", json={
        "definition": VALID, "applicability": [{}]}).status_code == 409   # no edits under review
    assert step(hr, matrix, vid, "approve").status_code == 403           # HR Head can't approve
    assert step(people["dept_head"][1], matrix, vid, "approve").status_code == 403
    assert step(hr, matrix, vid, "publish").status_code == 409           # not approved yet
    approved = step(chro, matrix, vid, "approve", {"note": "Matches the agreed bands."}).json()
    assert approved["status"] == "APPROVED" and approved["approved_by"]["username"] == "tst.mx.chro"
    assert step(people["dept_head"][1], matrix, vid, "publish").status_code == 403
    done = step(hr, matrix, vid, "publish").json()
    assert done["status"] == "PUBLISHED"
    detail = hr.get(f"/api/matrices/{matrix['id']}").json()
    assert detail["in_force"]["version_no"] == 1
    actions = db.scalars(select(AuditEvent.action).where(
        AuditEvent.entity_type == "matrix", AuditEvent.entity_id == str(matrix["id"]))
        .order_by(AuditEvent.id)).all()
    assert actions == ["matrix.create", "matrix_version.update", "matrix_version.submit",
                       "matrix_version.approve", "matrix_version.publish"]
    approval = db.scalars(select(AuditEvent).where(AuditEvent.action == "matrix_version.approve")).one()
    assert approval.reason == "Matches the agreed bands."
    assert approval.changes["content_sha256"] == done["definition_hash"]


def test_separation_of_duties(people, db):
    dual = people["dual"][1]
    matrix = create(dual, "Dual role matrix").json()
    vid = matrix["latest_version"]["id"]
    save(dual, matrix, vid)
    step(dual, matrix, vid, "submit")
    refused = step(dual, matrix, vid, "approve")
    assert refused.status_code == 403 and "different person" in refused.json()["detail"]
    # The database refuses self-approval too.
    version = db.get(MatrixVersion, vid)
    with pytest.raises(DBAPIError) as exc_info:
        with db.begin_nested():
            version.approved_by_user_id = version.submitted_by_user_id
            db.flush()
    assert exc_info.value.orig.args[0] == 3819  # CHECK constraint violated


def test_rejection_keeps_history_and_revisions_are_new_versions(people):
    hr, chro = people["hr_head"][1], people["chro"][1]
    matrix = create(hr).json()
    vid = matrix["latest_version"]["id"]
    save(hr, matrix, vid)
    step(hr, matrix, vid, "submit")
    assert step(chro, matrix, vid, "reject", {"reason": ""}).status_code == 422
    rejected = step(chro, matrix, vid, "reject", {"reason": "Bands need HR review"}).json()
    assert rejected["status"] == "REJECTED" and rejected["rejection_reason"] == "Bands need HR review"
    assert save(hr, matrix, vid).status_code == 409
    revision = hr.post(f"/api/matrices/{matrix['id']}/revisions")
    assert revision.status_code == 201
    assert revision.json()["version_no"] == 2 and revision.json()["status"] == "DRAFT"
    assert revision.json()["definition"]["rules"] == VALID["rules"]
    assert hr.post(f"/api/matrices/{matrix['id']}/revisions").status_code == 409  # one open draft
    versions = hr.get(f"/api/matrices/{matrix['id']}").json()["versions"]
    assert [(v["version_no"], v["status"]) for v in versions] == [(2, "DRAFT"), (1, "REJECTED")]


def test_published_versions_never_change_and_new_ones_take_over_by_date(people, db):
    hr, chro = people["hr_head"][1], people["chro"][1]
    matrix, v1 = published(people)
    assert save(hr, matrix, v1).status_code == 409   # in force: never edited in place
    v2 = hr.post(f"/api/matrices/{matrix['id']}/revisions").json()["id"]
    stricter = matrix_rules.definition_from_bands(
        KpiDirection.HIGHER_IS_BETTER, [{"threshold": 105, "score": 5}], 1, None, None)
    save(hr, matrix, v2, stricter, effective_from="2027-01-01")
    step(hr, matrix, v2, "submit")
    step(chro, matrix, v2, "approve")
    step(chro, matrix, v2, "publish")                    # the CHRO may publish too
    first = db.get(MatrixVersion, v1)
    db.refresh(first)
    assert first.status == MatrixVersionStatus.PUBLISHED and first.effective_to == date(2026, 12, 31)
    assert matrix_service.resolve(db, matrix["id"], date(2026, 10, 1), 1, 1).id == v1
    assert matrix_service.resolve(db, matrix["id"], date(2027, 2, 1), 1, 1).id == v2
    assert first.definition_hash == matrix_rules.definition_hash(first.definition)


def test_scope_rules_for_authors_and_readers(people, org):
    p1, p2, q = org.plants["P1"], org.plants["P2"], org.departments["Q"]
    plant_hr = people["hr_head_p1"][1]
    assert create(plant_hr, "Company wide by plant HR").status_code == 403
    own = create(plant_hr, "Plant one matrix", scopes=[{"plant_id": p1.id}])
    assert own.status_code == 201
    assert create(plant_hr, "Plant two matrix", scopes=[{"plant_id": p2.id}]).status_code == 403
    company = create(people["hr_head"][1], "Company matrix").json()
    assert save(plant_hr, company, company["latest_version"]["id"]).status_code == 403
    # Readers: a Quality head sees KPI matrices but cannot author them.
    dept_head = people["dept_head"][1]
    assert any(m["id"] == company["id"] for m in dept_head.get("/api/matrices").json())
    assert create(dept_head, "Dept head matrix").status_code == 403
    assert people["admin"][1].post("/api/matrices", json={
        "matrix_type": "KPI_SCORING", "name": "Admin matrix",
        "attributes": {"direction": "HIGHER_IS_BETTER"}, "applicability": [{}]}).status_code == 403
    assert people["employee"][1].get("/api/matrices").status_code == 403
    _ = q


def test_compensation_matrices_are_hidden_from_other_roles(people):
    hr, dept_head = people["hr_head"][1], people["dept_head"][1]
    assert {t["code"] for t in hr.get("/api/matrix-types").json()} == {
        "KPI_SCORING", "KRA_PERFORMANCE", "CR_IMPACT", "INCREMENT"}
    assert {t["code"] for t in dept_head.get("/api/matrix-types").json()} == {
        "KPI_SCORING", "KRA_PERFORMANCE"}
    increment = create(hr, "Increment matrix", "INCREMENT").json()
    assert increment["policy_note"].startswith("Awaiting approved configuration")
    assert dept_head.get(f"/api/matrices/{increment['id']}").status_code == 404
    assert all(m["matrix_type"] != "INCREMENT" for m in dept_head.get("/api/matrices").json())


INCREMENT_TABLE = {
    "fields": [matrix_types.INCREMENT.standard_input("performance_rating").as_definition(),
               matrix_types.INCREMENT.outputs[0].as_definition()],
    "rules": [{"priority": 1, "conditions": {"performance_rating": {
        "min": "1", "min_inclusive": True, "max": "5", "max_inclusive": True}},
        "outputs": {"increment_percent": "1"}}],  # synthetic structure test, not a policy
    "no_match": {"mode": "error"}, "test_cases": [],
}


def test_matrices_chosen_by_applicability_may_not_overlap(people):
    published(people, "Increment A", INCREMENT_TABLE, matrix_type="INCREMENT")
    hr, chro = people["hr_head"][1], people["chro"][1]
    other = create(hr, "Increment B", "INCREMENT").json()
    vid = other["latest_version"]["id"]
    save(hr, other, vid, INCREMENT_TABLE)
    step(hr, other, vid, "submit")
    step(chro, other, vid, "approve")
    clash = step(hr, other, vid, "publish")
    assert clash.status_code == 409 and "Only one increment matrix may apply" in clash.json()["detail"]


def test_preview_and_unsaved_checks(people):
    hr = people["hr_head"][1]
    matrix, vid = published(people)
    preview = hr.post(f"/api/matrices/{matrix['id']}/versions/{vid}/preview",
                      json={"inputs": {"achievement_percent": "95"}})
    assert preview.json()["outputs"] == {"score": 4}
    assert preview.json()["rule"]["description"] == "Achievement % is more than 90% and at most 100%"
    bad = hr.post(f"/api/matrices/{matrix['id']}/versions/{vid}/preview",
                  json={"inputs": {"achievement_percent": "abc"}})
    assert bad.status_code == 422
    check = hr.post("/api/matrix-types/KPI_SCORING/check", json={
        "definition": VALID, "attributes": {"direction": "HIGHER_IS_BETTER"},
        "inputs": {"achievement_percent": "100"}}).json()
    assert check["check"]["ok"] and check["preview"]["outputs"] == {"score": 4}
    assert check["rule_summaries"][0]["description"] == "Achievement % is more than 100%"


def test_protected_attributes_cannot_be_configured(people):
    hr = people["hr_head"][1]
    matrix = create(hr).json()
    gender = {"key": "gender", "label": "Gender", "role": "input", "data_type": "CATEGORY",
              "allowed_values": ["F", "M"], "aggregation": "LAST"}
    saved = save(hr, matrix, matrix["latest_version"]["id"],
                 {**VALID, "fields": [gender, *VALID["fields"]]}).json()
    assert any("protected personal attribute" in e["message"] for e in saved["check"]["errors"])


def test_new_standard_fields_appear_in_type_metadata(people, monkeypatch):
    extended = replace(matrix_types.KPI_SCORING, standard_inputs=(
        *matrix_types.KPI_SCORING.standard_inputs,
        FieldSpec("on_time_rate", "On-time rate", DataType.PERCENT, "input", unit="%",
                  source=Source.ACTUAL)))
    monkeypatch.setitem(matrix_types.REGISTRY, "KPI_SCORING", extended)
    types = people["hr_head"][1].get("/api/matrix-types").json()
    kpi = next(t for t in types if t["code"] == "KPI_SCORING")
    assert "on_time_rate" in [f["key"] for f in kpi["standard_inputs"]]


def test_audit_failure_rolls_back_the_approval(people, db, monkeypatch):
    hr, _chro = people["hr_head"][1], people["chro"][1]
    matrix = create(hr).json()
    vid = matrix["latest_version"]["id"]
    save(hr, matrix, vid)
    step(hr, matrix, vid, "submit")
    chro_user = people["chro"][0]
    principal = build_principal(chro_user)

    def failing(*args, **kwargs):
        raise RuntimeError("audit store unavailable")

    monkeypatch.setattr(matrix_service, "record_event", failing)
    with pytest.raises(RuntimeError):
        with transaction(db):
            m, v = matrix_service.get_version(db, principal, matrix["id"], vid)
            matrix_service.approve(db, principal, AuditActor.from_user(chro_user), m, v, None)
    version = db.get(MatrixVersion, vid)
    db.refresh(version)
    assert version.status == MatrixVersionStatus.SUBMITTED and version.approved_by_user_id is None
