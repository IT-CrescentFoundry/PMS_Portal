"""The database itself must reject invalid organizational data."""
from datetime import date

import pytest
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.models import EmployeeAssignment, PmsCycle, PmsCycleQuarter, Role, User, UserRole, UserRoleScope
from app.models.enums import ScopeType
from tests.conftest import Org, add_assignment

DUPLICATE_KEY = 1062
FK_VIOLATION = 1452
CHECK_VIOLATION = 3819


def assert_rejected(db: Session, obj, mysql_error: int) -> None:
    with pytest.raises(DBAPIError) as exc_info:
        with db.begin_nested():
            db.add(obj)
            db.flush()
    assert exc_info.value.orig.args[0] == mysql_error


def assignment(org: Org, emp: str, unit: tuple[str, str], **kw) -> EmployeeAssignment:
    return EmployeeAssignment(
        employee_id=org.employees[emp].id,
        plant_department_id=org.units[unit].id,
        designation_id=org.designation.id,
        effective_from=kw.pop("effective_from", date(2026, 1, 1)),
        **kw,
    )


def test_second_open_primary_assignment_is_rejected(db, org):
    # TST002 already has an open primary in P2/Q.
    assert_rejected(db, assignment(org, "002", ("P1", "Q"), is_primary=True), DUPLICATE_KEY)


def test_second_open_assignment_in_same_unit_is_rejected(db, org):
    assert_rejected(db, assignment(org, "002", ("P2", "Q")), DUPLICATE_KEY)


def test_closed_primary_allows_a_new_open_primary(db, org):
    # TST003's transfer: a closed primary plus a new open primary coexist.
    current = [a for a in org.employees["003"].assignments if a.effective_to is None]
    assert len(current) == 1 and current[0].is_primary


def test_multi_plant_secondary_assignment_is_allowed(db, org):
    add_assignment(db, org, "002", ("P1", "Q"), is_primary=False)


def test_end_before_start_is_rejected(db, org):
    bad = assignment(org, "004", ("P1", "Q"), effective_from=date(2026, 5, 1), effective_to=date(2026, 4, 30))
    assert_rejected(db, bad, CHECK_VIOLATION)


def test_self_reporting_manager_is_rejected(db, org):
    emp = org.employees["004"]
    assert_rejected(db, assignment(org, "004", ("P1", "Q"), reporting_manager_id=emp.id), CHECK_VIOLATION)


def _user_role(db: Session) -> UserRole:
    user = User(username="tst.user")
    role = Role(code="TST_ROLE", name="Test Role")
    db.add_all([user, role])
    db.flush()
    user_role = UserRole(user_id=user.id, role_id=role.id)
    db.add(user_role)
    db.flush()
    return user_role


def test_scope_shape_is_enforced(db, org):
    ur = _user_role(db)
    # DEPARTMENT scope must not carry a plant.
    bad = UserRoleScope(
        user_role_id=ur.id, scope_type=ScopeType.DEPARTMENT,
        plant_id=org.plants["P1"].id, department_id=org.departments["Q"].id,
    )
    assert_rejected(db, bad, CHECK_VIOLATION)


def test_plant_department_scope_must_exist_at_that_plant(db, org):
    ur = _user_role(db)
    # Department M does not exist at plant P2.
    bad = UserRoleScope(
        user_role_id=ur.id, scope_type=ScopeType.PLANT_DEPARTMENT,
        plant_id=org.plants["P2"].id, department_id=org.departments["M"].id,
    )
    assert_rejected(db, bad, FK_VIOLATION)


def test_department_wide_scope_is_allowed(db, org):
    ur = _user_role(db)
    db.add(UserRoleScope(user_role_id=ur.id, scope_type=ScopeType.DEPARTMENT,
                         department_id=org.departments["Q"].id))
    db.flush()


def test_quarter_number_must_be_1_to_4(db):
    cycle = PmsCycle(code="TST-FY", name="Test", start_date=date(2030, 4, 1), end_date=date(2031, 3, 31))
    db.add(cycle)
    db.flush()
    bad = PmsCycleQuarter(cycle_id=cycle.id, quarter_number=5, name="Q5",
                          start_date=date(2031, 4, 1), end_date=date(2031, 6, 30))
    assert_rejected(db, bad, CHECK_VIOLATION)
