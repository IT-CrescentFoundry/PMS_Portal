"""The demo seed must be repeatable without creating duplicates."""
import pytest
from sqlalchemy import func, select

from app.models import Employee, EmployeeAssignment, User
from app.seed.runner import SeedError, demo_password_from_env, seed

DEMO_PASSWORD = "synthetic-demo-password"  # test-only value


def test_seed_hashes_demo_password_and_stays_idempotent(db):
    first = seed(db, DEMO_PASSWORD)
    assert first[("users (password)", "updated")] == 7
    second = seed(db, DEMO_PASSWORD)
    assert second[("users (password)", "unchanged")] == 7
    hashes = db.scalars(select(User.password_hash).where(User.username.like("demo.%"))).all()
    assert len(hashes) == 7
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
