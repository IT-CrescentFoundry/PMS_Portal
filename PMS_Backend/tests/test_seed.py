"""The demo seed must be repeatable without creating duplicates."""
import pytest
from sqlalchemy import func, select

from app.models import (
    Employee,
    EmployeeAssignment,
    KpiScoringPolicy,
    KpiSheet,
    KpiSheetStatus,
    Matrix,
    MatrixVersion,
    MatrixVersionStatus,
    PmsCycle,
    PmsCycleQuarter,
    User,
)
from app.seed.runner import SeedError, demo_password_from_env, seed
from app.services.matrix_rules import analyse
from app.services.matrix_types import NORMALIZATION

DEMO_PASSWORD = "synthetic-demo-password"  # test-only value


def test_seed_hashes_demo_password_and_stays_idempotent(db):
    first = seed(db, DEMO_PASSWORD)
    # 7 original + Plant A HR Head + Plant Head (Stage J) + company-wide HR Head (Stage K)
    assert first[("users (password)", "updated")] == 10
    second = seed(db, DEMO_PASSWORD)
    assert second[("users (password)", "unchanged")] == 10
    hashes = db.scalars(select(User.password_hash).where(User.username.like("demo.%"))).all()
    assert len(hashes) == 10
    assert all(h.startswith("$argon2id$") and DEMO_PASSWORD not in h for h in hashes)


def test_seed_without_demo_password_leaves_accounts_unusable(db):
    seed(db)
    assert db.scalar(
        select(func.count()).select_from(User).where(User.password_hash.is_not(None))
    ) == 0


def test_weak_demo_password_is_refused(monkeypatch):
    monkeypatch.setenv("DEMO_USER_PASSWORD", "short")
    with pytest.raises(SeedError, match="DEMO_USER_PASSWORD"):
        demo_password_from_env()


def test_seeded_demo_accounts_sign_in_with_expected_access(db, anon_client):
    seed(db, DEMO_PASSWORD)
    resp = anon_client.post(
        "/api/auth/login", json={"username": "demo.quality.head", "password": DEMO_PASSWORD}
    )
    assert resp.status_code == 200
    # Quality head across all plants: sees every plant that has Quality.
    plants = [p["code"] for p in anon_client.get("/api/plants").json()]
    assert plants == ["PLT-A", "PLT-B", "PLT-C"]
    departments = [d["code"] for d in anon_client.get("/api/departments").json()]
    assert departments == ["QA"]


def test_seed_is_idempotent(db):
    seed(db)  # brings the database up to the seed definition
    second = seed(db)
    assert sum(n for (_, action), n in second.items() if action in ("created", "updated")) == 0

    demo_employees = db.scalar(
        select(func.count()).select_from(Employee).where(Employee.employee_code.like("DEMO%"))
    )
    assert demo_employees == 15


def test_seeded_policies_are_backed_by_published_matrices(db):
    seed(db)
    policies = db.scalars(select(KpiScoringPolicy).where(KpiScoringPolicy.code.like("POL-_"))).all()
    assert {p.code for p in policies} == {"POL-A", "POL-B", "POL-E", "POL-Z"}
    for policy in policies:
        versions = db.scalars(select(MatrixVersion).where(
            MatrixVersion.matrix_id == policy.matrix_id)).all()
        assert [(v.version_no, v.status) for v in versions] == [(1, MatrixVersionStatus.PUBLISHED)]
        # The synthetic approval trail still respects separation of duties.
        assert versions[0].approved_by_user_id != versions[0].submitted_by_user_id
        assert "not an approved company policy" in versions[0].approval_note


def test_seeded_normalization_policy_is_synthetic_and_valid(db):
    seed(db)
    matrix = db.scalars(select(Matrix).where(Matrix.code == "NRM-DEMO")).one()
    [version] = db.scalars(select(MatrixVersion).where(MatrixVersion.matrix_id == matrix.id)).all()
    assert version.status == MatrixVersionStatus.PUBLISHED
    assert "not an approved company policy" in version.approval_note
    _, report = analyse(NORMALIZATION, version.definition)
    assert report.ok
    assert version.definition["settings"]["groups"][1]["percent"] == "60"


def test_seeded_q3_sheets_are_locked_with_frozen_versions(db):
    seed(db)
    sheets = db.scalars(select(KpiSheet).join(KpiSheet.quarter)
                        .where(PmsCycleQuarter.name.like("Q3%"))).all()
    assert len(sheets) == 2 and {s.status for s in sheets} == {KpiSheetStatus.LOCKED}
    for sheet in sheets:
        assert sum(i.weightage for i in sheet.items) == 100
        assert all(i.matrix_version_id and i.measurement_snapshot["aggregation"] for i in sheet.items)


def test_seed_multi_plant_employee_has_one_identity(db):
    seed(db)
    emp = db.scalars(select(Employee).where(Employee.employee_code == "DEMO0001")).one()
    open_assignments = db.scalars(
        select(EmployeeAssignment).where(
            EmployeeAssignment.employee_id == emp.id, EmployeeAssignment.effective_to.is_(None)
        )
    ).all()
    assert len(open_assignments) == 2
    assert sum(a.is_primary for a in open_assignments) == 1


def test_each_browser_test_run_gets_its_own_complete_quarter(db):
    from tests.e2e_server import seed_run_quarter

    seed(db)
    code = seed_run_quarter(db)
    quarter = db.scalars(select(PmsCycleQuarter).join(PmsCycleQuarter.cycle)
                         .where(PmsCycle.code == code)).one()
    assert quarter.status.value == "OPEN" and quarter.end_date.isoformat() == "2026-06-30"
    sheets = db.scalars(select(KpiSheet).where(KpiSheet.cycle_quarter_id == quarter.id)).all()
    assert len(sheets) == 5 and {s.status for s in sheets} == {KpiSheetStatus.LOCKED}
    assert all(len(s.items) == 3 and all(i.matrix_version_id for i in s.items) for s in sheets)


def test_each_browser_test_run_gets_its_own_annual_cycle(db):
    from tests.e2e_server import seed_annual_cycle

    seed(db)
    code = seed_annual_cycle(db)
    cycle = db.scalars(select(PmsCycle).where(PmsCycle.code == code)).one()
    quarters = sorted(cycle.quarters, key=lambda q: q.quarter_number)
    assert [(q.start_date.isoformat(), q.end_date.isoformat(), q.status.value) for q in quarters] == [
        ("2026-04-01", "2026-04-30", "OPEN"), ("2026-05-01", "2026-05-31", "OPEN"),
        ("2026-06-01", "2026-06-30", "OPEN"), ("2026-07-01", "2026-07-31", "OPEN")]
    sheets = db.scalars(select(KpiSheet).where(
        KpiSheet.cycle_quarter_id.in_([q.id for q in quarters]))).all()
    assert len(sheets) == 4 and {s.assignment.employee.employee_code for s in sheets} == {"DEMO0005"}
    assert all(len(s.items) == 2 and all(i.matrix_version_id for i in s.items) for s in sheets)
