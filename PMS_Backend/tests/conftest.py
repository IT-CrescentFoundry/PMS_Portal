"""Test fixtures.

Tests run against the configured MySQL database (`pms`) but every test runs
inside a transaction that is ROLLED BACK afterwards, so no test data is ever
committed and existing (seeded) data is left untouched. Test records use
"TST" codes so they cannot collide with the demo seed.
"""
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db import engine
from app.dependencies import get_db
from app.main import app
from app.models import (
    Department,
    Designation,
    Employee,
    EmployeeAssignment,
    Plant,
    PlantDepartment,
)


@pytest.fixture
def db() -> Iterator[Session]:
    connection = engine.connect()
    outer = connection.begin()
    # Session commits/rollbacks become SAVEPOINTs inside the outer transaction.
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        outer.rollback()
        connection.close()


@pytest.fixture
def client(db: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_db] = lambda: db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


@dataclass
class Org:
    """Handles to the synthetic test organization built by the `org` fixture."""

    plants: dict[str, Plant] = field(default_factory=dict)
    departments: dict[str, Department] = field(default_factory=dict)
    units: dict[tuple[str, str], PlantDepartment] = field(default_factory=dict)
    designation: Designation | None = None
    employees: dict[str, Employee] = field(default_factory=dict)


def add_assignment(db: Session, org: Org, emp: str, unit: tuple[str, str], **kw) -> EmployeeAssignment:
    a = EmployeeAssignment(
        employee_id=org.employees[emp].id,
        plant_department_id=org.units[unit].id,
        designation_id=org.designation.id,
        effective_from=kw.pop("effective_from", date(2025, 4, 1)),
        **kw,
    )
    db.add(a)
    db.flush()
    return a


@pytest.fixture
def org(db: Session) -> Org:
    """Test organization (all dates evaluated at AS_OF = 2026-08-01):

      TST-P1, TST-P2 plants; TST-Q (shared) and TST-M departments
      units: P1/Q, P2/Q, P1/M
      TST001  primary P1/Q, secondary P2/Q            (multi-plant)
      TST002  primary P2/Q
      TST003  P1/M until 2026-06-30, then P2/Q        (transfer)
      TST004  only a secondary P1/M, no primary        (data issue)
    """
    o = Org()
    for code in ("P1", "P2"):
        o.plants[code] = Plant(code=f"TST-{code}", name=f"Test Plant {code}")
    for code in ("Q", "M"):
        o.departments[code] = Department(code=f"TST-{code}", name=f"Test Dept {code}")
    db.add_all([*o.plants.values(), *o.departments.values()])
    db.flush()
    for p, d in (("P1", "Q"), ("P2", "Q"), ("P1", "M")):
        o.units[(p, d)] = PlantDepartment(
            plant_id=o.plants[p].id, department_id=o.departments[d].id
        )
    o.designation = Designation(code="TST-ENG", name="Test Engineer")
    for code in ("001", "002", "003", "004"):
        o.employees[code] = Employee(employee_code=f"TST{code}", full_name=f"Test Person {code}")
    db.add_all([*o.units.values(), o.designation, *o.employees.values()])
    db.flush()

    add_assignment(db, o, "001", ("P1", "Q"), is_primary=True)
    add_assignment(db, o, "001", ("P2", "Q"), is_primary=False)
    add_assignment(db, o, "002", ("P2", "Q"), is_primary=True)
    add_assignment(db, o, "003", ("P1", "M"), is_primary=True, effective_to=date(2026, 6, 30))
    add_assignment(db, o, "003", ("P2", "Q"), is_primary=True, effective_from=date(2026, 7, 1))
    add_assignment(db, o, "004", ("P1", "M"), is_primary=False)
    return o
