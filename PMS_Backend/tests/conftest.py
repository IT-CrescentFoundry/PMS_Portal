"""Test fixtures.

Isolation: the suite runs ONLY against the dedicated test database named by
TEST_DB_NAME (e.g. pms_test), never the development database. Before any app
module is imported, this file redirects DB_NAME to the test database, and the
session fixture verifies the live connection before migrating the schema.

On top of that, every test runs inside a transaction that is ROLLED BACK
afterwards, so test data is never committed. Test records use "TST" codes.
"""
import os
import secrets

from dotenv import load_dotenv

from tests import ENV_FILE

# --- Redirect the application to the test database (must run first) -------
load_dotenv(ENV_FILE)
_DEV_DB_NAME = os.getenv("DB_NAME", "")
TEST_DB_NAME = os.getenv("TEST_DB_NAME", "")
if not TEST_DB_NAME:
    raise RuntimeError(
        "TEST_DB_NAME is not set. Add TEST_DB_NAME=pms_test to PMS_Backend/.env "
        "(see .env.example). Tests never run against the development database."
    )
if not TEST_DB_NAME.endswith("_test") or TEST_DB_NAME == _DEV_DB_NAME:
    raise RuntimeError(
        f"Refusing to run tests: TEST_DB_NAME '{TEST_DB_NAME}' must end with '_test' "
        "and differ from DB_NAME."
    )
os.environ["DB_NAME"] = TEST_DB_NAME
# Optional dedicated test credentials (e.g. a user granted only on pms_test).
for _name in ("DB_USER", "DB_PASSWORD"):
    if os.getenv(f"TEST_{_name}"):
        os.environ[_name] = os.environ[f"TEST_{_name}"]
# Tests sign tokens with a throwaway key; the real AUTH_SECRET_KEY is unused.
os.environ["AUTH_SECRET_KEY"] = secrets.token_urlsafe(48)
os.environ["AUTH_COOKIE_SECURE"] = "false"  # TestClient talks plain HTTP

# --- Imports below this line see the test configuration --------------------
from collections.abc import Callable, Iterator  # noqa: E402
from dataclasses import dataclass, field  # noqa: E402
from datetime import date  # noqa: E402

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.auth.passwords import hash_password  # noqa: E402
from app.auth.tokens import create_access_token  # noqa: E402
from app.db import engine  # noqa: E402
from app.dependencies import get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    Department,
    Designation,
    Employee,
    EmployeeAssignment,
    Plant,
    PlantDepartment,
    Role,
    User,
    UserRole,
    UserRoleScope,
)
from app.models.enums import ScopeType  # noqa: E402

ALEMBIC_INI = ENV_FILE.parent / "alembic.ini"


def assert_connected_to_test_database() -> None:
    """Verify the LIVE connection, not just configuration, targets the test DB."""
    with engine.connect() as conn:
        current = conn.execute(text("SELECT DATABASE()")).scalar()
    if current != TEST_DB_NAME:
        raise RuntimeError(
            f"Refusing to run tests: connected to '{current}', expected '{TEST_DB_NAME}'."
        )


@pytest.fixture(scope="session", autouse=True)
def test_database() -> str:
    """Verify isolation, then bring the test schema to the latest migration."""
    assert_connected_to_test_database()
    config = Config(str(ALEMBIC_INI))
    config.attributes["configure_logger"] = False  # keep pytest's logging intact
    command.upgrade(config, "head")
    return TEST_DB_NAME


@pytest.fixture(autouse=True)
def reset_login_limiter() -> Iterator[None]:
    """The login limiter is process-wide; each test starts with a clean slate."""
    app.state.login_limiter.reset()
    yield
    app.state.login_limiter.reset()


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


ScopeSpec = tuple[ScopeType, Plant | None, Department | None]
RoleSpec = tuple[str, list[ScopeSpec]]


@pytest.fixture
def make_user(db: Session) -> Callable[..., User]:
    """Create a user with role grants, e.g.
    make_user("tst.hr", roles=[("HR", [(ScopeType.PLANT, plant, None)])])."""

    def _make(
        username: str,
        *,
        roles: list[RoleSpec] = (),
        employee: Employee | None = None,
        password: str | None = None,
        is_active: bool = True,
    ) -> User:
        user = User(
            username=username,
            employee_id=employee.id if employee else None,
            password_hash=hash_password(password) if password else None,
            is_active=is_active,
        )
        db.add(user)
        db.flush()
        for role_code, scopes in roles:
            role = db.scalars(select(Role).where(Role.code == role_code)).one_or_none()
            if role is None:
                role = Role(code=role_code, name=f"Test {role_code}")
                db.add(role)
                db.flush()
            grant = UserRole(user_id=user.id, role_id=role.id)
            db.add(grant)
            db.flush()
            for scope_type, plant, department in scopes:
                db.add(
                    UserRoleScope(
                        user_role_id=grant.id,
                        scope_type=scope_type,
                        plant_id=plant.id if plant else None,
                        department_id=department.id if department else None,
                    )
                )
        db.flush()
        db.expire(user)  # reload relationships on next access
        return user

    return _make


@pytest.fixture
def client_for(db: Session) -> Iterator[Callable[[User | None], TestClient]]:
    """TestClient factory: client_for(user) sends that user's bearer token;
    client_for(None) is anonymous. All share the rolled-back `db` session."""

    def request_session() -> Iterator[Session]:
        # Release the current savepoint so this request starts from a fresh
        # one, like a real per-request session: a failed request then rolls
        # back only its own changes, never the test's fixture data. Everything
        # is still discarded when the outer test transaction rolls back.
        db.commit()
        yield db

    app.dependency_overrides[get_db] = request_session

    def _make(user: User | None) -> TestClient:
        headers = {}
        if user is not None:
            token, _ = create_access_token(user.id)
            headers["Authorization"] = f"Bearer {token}"
        return TestClient(app, headers=headers)

    try:
        yield _make
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def anon_client(client_for) -> TestClient:
    return client_for(None)


@pytest.fixture
def client(client_for, make_user) -> TestClient:
    """A signed-in GLOBAL admin: sees everything (pre-authorization behaviour)."""
    admin = make_user("tst.admin", roles=[("ADMIN", [(ScopeType.GLOBAL, None, None)])])
    return client_for(admin)


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


# --- Stage J (JD / KPI) fixtures ---------------------------------------------------------

from app.models import (  # noqa: E402
    KpiApplicability,
    KpiDefinition,
    KpiDirection,
    KpiScoringPolicy,
    PmsCycle,
    PmsCycleQuarter,
)


@dataclass
class KpiEnv:
    """Synthetic KPI setup on top of `org`.

    Quarters TQ1 (2026-07-01..09-30) and TQ2 (2026-10-01..12-31), both DRAFT.
    KPIs: profit (company-wide, higher), claims (dept Q at all plants, zero
    tolerance), lower (dept Q, lower-is-better), yield_p1 (unit P1/Q only),
    maint (unit P1/M only).
    """

    org: Org
    cycle: PmsCycle
    q1: PmsCycleQuarter
    q2: PmsCycleQuarter
    policies: dict[str, KpiScoringPolicy]
    kpis: dict[str, KpiDefinition]

    def assignment_id(self, db: Session, employee: str, unit: tuple[str, str]) -> int:
        return db.scalar(
            select(EmployeeAssignment.id).where(
                EmployeeAssignment.employee_id == self.org.employees[employee].id,
                EmployeeAssignment.plant_department_id == self.org.units[unit].id,
            ).order_by(EmployeeAssignment.effective_from.desc())
        )


@pytest.fixture
def kpi_env(db: Session, org: Org) -> KpiEnv:
    cycle = PmsCycle(code="TST-FY", name="Test FY", start_date=date(2026, 7, 1), end_date=date(2027, 6, 30))
    db.add(cycle)
    db.flush()
    q1 = PmsCycleQuarter(cycle_id=cycle.id, quarter_number=1, name="TQ1",
                         start_date=date(2026, 7, 1), end_date=date(2026, 9, 30))
    q2 = PmsCycleQuarter(cycle_id=cycle.id, quarter_number=2, name="TQ2",
                         start_date=date(2026, 10, 1), end_date=date(2026, 12, 31))
    policies = {
        "A": KpiScoringPolicy(code="TPOL-A", name="Test higher", direction=KpiDirection.HIGHER_IS_BETTER,
                              bands=[{"threshold": 100, "score": 5}, {"threshold": 90, "score": 4},
                                     {"threshold": 80, "score": 3}, {"threshold": 70, "score": 2},
                                     {"threshold": 50, "score": 1}], fallback_score=0),
        "B": KpiScoringPolicy(code="TPOL-B", name="Test lower", direction=KpiDirection.LOWER_IS_BETTER,
                              bands=[{"threshold": 100, "score": 5}, {"threshold": 110, "score": 4},
                                     {"threshold": 120, "score": 3}, {"threshold": 150, "score": 2}],
                              fallback_score=1),
        "Z": KpiScoringPolicy(code="TPOL-Z", name="Test zero", direction=KpiDirection.ZERO_TOLERANCE,
                              bands=[], fallback_score=0, met_score=5, breached_score=0),
    }
    db.add_all([q1, q2, *policies.values()])
    db.flush()
    o = org

    def kpi(code, name, direction, policy, scopes):
        k = KpiDefinition(code=code, name=name, unit="%", direction=direction,
                          default_scoring_policy_id=policies[policy].id,
                          applicabilities=[KpiApplicability(plant_id=p, department_id=d) for p, d in scopes])
        db.add(k)
        return k

    kpis = {
        "profit": kpi("TKPI-1", "Test profit", KpiDirection.HIGHER_IS_BETTER, "A", [(None, None)]),
        "claims": kpi("TKPI-2", "Test claims", KpiDirection.ZERO_TOLERANCE, "Z",
                      [(None, o.departments["Q"].id)]),
        "lower": kpi("TKPI-3", "Test inventory days", KpiDirection.LOWER_IS_BETTER, "B",
                     [(None, o.departments["Q"].id)]),
        "yield_p1": kpi("TKPI-4", "Test yield P1", KpiDirection.HIGHER_IS_BETTER, "A",
                        [(o.plants["P1"].id, o.departments["Q"].id)]),
        "maint": kpi("TKPI-5", "Test maintenance", KpiDirection.HIGHER_IS_BETTER, "A",
                     [(o.plants["P1"].id, o.departments["M"].id)]),
    }
    db.flush()
    return KpiEnv(org, cycle, q1, q2, policies, kpis)


@pytest.fixture
def as_role(make_user, client_for):
    """as_role("tst.x", [("HR_HEAD", [(ScopeType.PLANT, plant, None)])]) -> (user, client)."""

    def _make(username, roles, employee=None):
        user = make_user(username, roles=roles, employee=employee)
        return user, client_for(user)

    return _make
