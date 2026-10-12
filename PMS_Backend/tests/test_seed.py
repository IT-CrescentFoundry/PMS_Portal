"""The demo seed must be repeatable without creating duplicates."""
from sqlalchemy import func, select

from app.models import Employee, EmployeeAssignment
from app.seed.runner import seed


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
