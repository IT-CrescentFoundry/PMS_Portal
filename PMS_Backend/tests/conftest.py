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
import json  # noqa: E402
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
    KpiAggregation,
    KpiApplicability,
    KpiDefinition,
    KpiDirection,
    KpiScoringPolicy,
    Matrix,
    MatrixVersion,
    MatrixVersionScope,
    MatrixVersionSource,
    MatrixVersionStatus,
    PmsCycle,
    PmsCycleQuarter,
    ReportingFrequency,
)
from app.services import matrix_rules  # noqa: E402


def published_matrix(db: Session, policy: KpiScoringPolicy, *, definition: dict | None = None,
                     effective_from: date = date(2026, 4, 1)) -> MatrixVersion:
    """Back a scoring policy with a matrix whose version 1 is PUBLISHED
    (company-wide), as if authored, approved and published earlier."""
    definition = definition or matrix_rules.definition_from_bands(
        policy.direction, policy.bands, policy.fallback_score, policy.met_score,
        policy.breached_score)
    matrix = Matrix(code=f"T{policy.code}", matrix_type="KPI_SCORING", name=policy.name,
                    attributes={"direction": policy.direction.value})
    db.add(matrix)
    db.flush()
    version = MatrixVersion(
        matrix_id=matrix.id, version_no=1, status=MatrixVersionStatus.PUBLISHED, schema_version=1,
        definition=definition, definition_hash=matrix_rules.definition_hash(definition),
        effective_from=effective_from, source=MatrixVersionSource.SEED,
        scopes=[MatrixVersionScope(plant_id=None, department_id=None)])
    db.add(version)
    policy.matrix_id = matrix.id
    db.flush()
    return version


@dataclass
class KpiEnv:
    """Synthetic KPI setup on top of `org`.

    Quarters TQ1 (2026-07-01..09-30) and TQ2 (2026-10-01..12-31), both DRAFT.
    KPIs: profit (company-wide, higher), claims (dept Q at all plants, zero
    tolerance), lower (dept Q, lower-is-better), yield_p1 (unit P1/Q only),
    maint (unit P1/M only). All are measured monthly. Policies A, B and Z are
    backed by matrices with a PUBLISHED version 1 in force from 2026-04-01
    (`versions`).
    """

    org: Org
    cycle: PmsCycle
    q1: PmsCycleQuarter
    q2: PmsCycleQuarter
    policies: dict[str, KpiScoringPolicy]
    kpis: dict[str, KpiDefinition]
    versions: dict[str, MatrixVersion]

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

    versions = {key: published_matrix(db, policy) for key, policy in policies.items()}

    def kpi(code, name, direction, policy, scopes, aggregation):
        k = KpiDefinition(code=code, name=name, unit="%", direction=direction,
                          default_scoring_policy_id=policies[policy].id,
                          reporting_frequency=ReportingFrequency.MONTHLY, aggregation=aggregation,
                          applicabilities=[KpiApplicability(plant_id=p, department_id=d) for p, d in scopes])
        db.add(k)
        return k

    a = KpiAggregation
    kpis = {
        "profit": kpi("TKPI-1", "Test profit", KpiDirection.HIGHER_IS_BETTER, "A", [(None, None)],
                      a.SUM),
        "claims": kpi("TKPI-2", "Test claims", KpiDirection.ZERO_TOLERANCE, "Z",
                      [(None, o.departments["Q"].id)], a.SUM),
        "lower": kpi("TKPI-3", "Test inventory days", KpiDirection.LOWER_IS_BETTER, "B",
                     [(None, o.departments["Q"].id)], a.AVERAGE),
        "yield_p1": kpi("TKPI-4", "Test yield P1", KpiDirection.HIGHER_IS_BETTER, "A",
                        [(o.plants["P1"].id, o.departments["Q"].id)], a.AVERAGE),
        "maint": kpi("TKPI-5", "Test maintenance", KpiDirection.HIGHER_IS_BETTER, "A",
                     [(o.plants["P1"].id, o.departments["M"].id)], a.AVERAGE),
    }
    db.flush()
    return KpiEnv(org, cycle, q1, q2, policies, kpis, versions)


@pytest.fixture
def as_role(make_user, client_for):
    """as_role("tst.x", [("HR_HEAD", [(ScopeType.PLANT, plant, None)])]) -> (user, client)."""

    def _make(username, roles, employee=None):
        user = make_user(username, roles=roles, employee=employee)
        return user, client_for(user)

    return _make


# --- Stage K (monthly data and scoring) fixtures -----------------------------------------

TODAY = date(2026, 10, 15)


@pytest.fixture
def fixed_today(monkeypatch) -> date:
    """Pin "today" so month-has-started rules are deterministic."""
    from app.services import clock

    monkeypatch.setattr(clock, "today", lambda: TODAY)
    return TODAY


@dataclass
class ScoringEnv:
    """TQ1 (Jul–Sep 2026) after scoring started:
      p1_sheet  TST001 at P1/Q, LOCKED: profit 40 % (target 100, SUM),
                claims 20 % (zero tolerance, SUM), lower 40 % (target 10, AVERAGE)
      p2_sheet  TST001 at P2/Q, LOCKED: profit 100 % (target 50)
      draft     TST002 at P2/Q, never published (DRAFT)
    Clients: head (Quality, all plants), chro, hr_head (P1), plant_head (P1).
    """

    env: KpiEnv
    p1_sheet: int
    p2_sheet: int
    draft: int
    users: dict[str, User]
    clients: dict[str, TestClient]


@pytest.fixture
def scoring_env(kpi_env: KpiEnv, as_role, db: Session, fixed_today) -> ScoringEnv:
    o = kpi_env.org
    roles = {
        "head": [("DEPT_HEAD", [(ScopeType.DEPARTMENT, None, o.departments["Q"])])],
        "chro": [("CHRO", [(ScopeType.GLOBAL, None, None)])],
        "hr_head": [("HR_HEAD", [(ScopeType.PLANT, o.plants["P1"], None)])],
        "plant_head": [("PLANT_HEAD", [(ScopeType.PLANT, o.plants["P1"], None)])],
    }
    users, clients = {}, {}
    for key, grants in roles.items():
        users[key], clients[key] = as_role(f"tst.sc.{key}", grants)
    head = clients["head"]

    def sheet(employee: str, unit: tuple[str, str], items: list[dict], publish: bool = True) -> int:
        created = head.post("/api/kpi/sheets", json={
            "assignment_id": kpi_env.assignment_id(db, employee, unit),
            "quarter_id": kpi_env.q1.id})
        assert created.status_code == 201, created.text
        sheet_id = created.json()["id"]
        saved = head.put(f"/api/kpi/sheets/{sheet_id}", json={"items": items})
        assert saved.status_code == 200, saved.text
        if publish:
            published = head.post(f"/api/kpi/sheets/{sheet_id}/publish")
            assert published.status_code == 200, published.text
        return sheet_id

    k = kpi_env.kpis
    p1 = sheet("001", ("P1", "Q"), [
        {"kpi_definition_id": k["profit"].id, "weightage": "40", "target_value": "100"},
        {"kpi_definition_id": k["claims"].id, "weightage": "20"},
        {"kpi_definition_id": k["lower"].id, "weightage": "40", "target_value": "10"}])
    p2 = sheet("001", ("P2", "Q"), [
        {"kpi_definition_id": k["profit"].id, "weightage": "100", "target_value": "50"}])
    draft = sheet("002", ("P2", "Q"), [
        {"kpi_definition_id": k["profit"].id, "weightage": "100", "target_value": "50"}],
        publish=False)
    started = clients["chro"].post(f"/api/kpi/quarters/{kpi_env.q1.id}/start-scoring")
    assert started.status_code == 200, started.text
    return ScoringEnv(kpi_env, p1, p2, draft, users, clients)


def csv_bytes(rows: list[list[object]], header: list[str] | None = None) -> bytes:
    """A CSV file with the import contract's headings (or the given ones)."""
    import csv
    import io

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header or ["Employee Code", "Plant Code", "Department Code", "KPI", "Period",
                               "Actual"])
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def quarter_rows(values: dict[str, list[object]], months=("2026-07", "2026-08", "2026-09"),
                 plant: str = "TST-P1") -> list[list[object]]:
    """{KPI code: [value per month]} -> CSV rows for TST001 at `plant`/Quality."""
    rows = []
    for code, monthly in values.items():
        for month, value in zip(months, monthly):
            if value is not None:
                rows.append(["TST001", plant, "TST-Q", code, month, value])
    return rows


def import_data(client: TestClient, env: ScoringEnv, step: str, data: bytes, period: str,
                name: str = "data.csv", **form) -> object:
    return client.post(f"/api/kpi/data/{step}", data={
        "quarter_id": str(env.env.q1.id), "period": period,
        **{k: (json.dumps(v) if isinstance(v, dict) else str(v).lower() if isinstance(v, bool)
               else str(v)) for k, v in form.items()}},
        files={"file": (name, data, "text/csv" if name.endswith(".csv") else
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})


def import_quarter(client: TestClient, env: ScoringEnv, values: dict[str, list[object]],
                   months=("2026-07", "2026-08", "2026-09"), plant: str = "TST-P1") -> None:
    """Import one file per month and confirm each."""
    for i, month in enumerate(months):
        rows = [r for r in quarter_rows({k: [v[i]] for k, v in values.items()}, (month,), plant)]
        if not rows:
            continue
        resp = import_data(client, env, "confirm", csv_bytes(rows), month)
        assert resp.status_code == 200, resp.text


# --- Stage L (quarterly review, normalization, publication) fixtures ---------------------

from app.services import normalization_policy  # noqa: E402

TEST_GROUPS = [
    {"key": "TOP", "label": "Top 20%", "percent": "20", "remainder": False},
    {"key": "MIDDLE", "label": "Middle 60%", "percent": "60", "remainder": True},
    {"key": "BOTTOM", "label": "Bottom 20%", "percent": "20", "remainder": False},
]
TEST_RATINGS = {"TOP": "5", "MIDDLE": "3", "BOTTOM": "1"}


def normalization_settings(**overrides) -> dict:
    """Synthetic test policy: departments across plants, 20/60/20, ties for a
    reviewer, cohorts below 5 all placed in MIDDLE."""
    return {"cohort_level": "DEPARTMENT", "groups": TEST_GROUPS, "size_rounding": "NEAREST",
            "rank_by": "FINAL_SCORE", "ties": "REQUIRE_RESOLUTION", "min_cohort_size": 5,
            "small_cohort": "DEFAULT_GROUP", "small_cohort_group": "MIDDLE",
            "eligible_designations": [], **overrides}


def published_normalization_policy(db: Session, *, name: str = "Test normalization",
                                   effective_from: date = date(2026, 4, 1),
                                   scopes: list[tuple[int | None, int | None]] | None = None,
                                   **settings) -> MatrixVersion:
    """A NORMALIZATION matrix with a PUBLISHED version 1, as if approved earlier."""
    definition = normalization_policy.group_rating_definition(normalization_settings(**settings),
                                                              TEST_RATINGS)
    matrix = Matrix(code=f"TNRM-{name[:20]}", matrix_type="NORMALIZATION", name=name,
                    attributes={})
    db.add(matrix)
    db.flush()
    version = MatrixVersion(
        matrix_id=matrix.id, version_no=1, status=MatrixVersionStatus.PUBLISHED, schema_version=1,
        definition=definition, definition_hash=matrix_rules.definition_hash(definition),
        effective_from=effective_from, source=MatrixVersionSource.SEED,
        scopes=[MatrixVersionScope(plant_id=p, department_id=d)
                for p, d in (scopes or [(None, None)])])
    db.add(version)
    db.flush()
    return version


# Quarterly actuals of the single KPI (profit, SUM, target 100 over 3 months).
# Scores under policy A: >100 5, >90 4, >80 3, >70 2, >50 1, else 0.
REVIEW_ACTUALS = {
    ("010", "P1"): (40, 40, 40),   # 120 % -> 5
    ("003", "P2"): (35, 35, 35),   # 105 % -> 5
    ("011", "P1"): (30, 30, 35),   # 95 % -> 4
    ("001", "P1"): (30, 30, 35),   # 95 % -> 4   (TST001 is also at P2, target 50)
    ("001", "P2"): (15, 15, 15),   # 45 of 50 = 90 % -> 3 (90 is not more than 90)
    ("012", "P1"): (25, 30, 30),   # 85 % -> 3
    ("013", "P1"): (25, 25, 25),   # 75 % -> 2
    ("014", "P1"): (20, 20, 20),   # 60 % -> 1
    ("002", "P2"): (10, 15, 15),   # 40 % -> 0
}
MONTHS = ("2026-07", "2026-08", "2026-09")


@dataclass
class ReviewEnv:
    """TQ1 (Jul-Sep 2026) after scoring started, with eight Quality employees:
    TST001 primary P1/Q and supporting P2/Q (two locked sheets), TST002 and
    TST003 at P2/Q, TST010-TST014 at P1/Q; one KPI each (profit, target 100,
    or 50 for TST001 at P2). A company-wide normalization policy (DEPARTMENT
    level, 20/60/20) is published. Clients: head (Quality, all plants),
    hr (HR Head, GLOBAL), chro, hr_p1 (HR Head, P1), plant_head (P1)."""

    env: KpiEnv
    sheets: dict[tuple[str, str], int]
    policy: MatrixVersion
    users: dict[str, User]
    clients: dict[str, TestClient]
    db: Session

    @property
    def quarter(self) -> PmsCycleQuarter:
        return self.env.q1

    def employee_id(self, code: str) -> int:
        return self.env.org.employees[code].id

    def import_all(self, actuals: dict | None = None) -> None:
        actuals = actuals or REVIEW_ACTUALS
        for i, month in enumerate(MONTHS):
            rows = [[f"TST{emp}", f"TST-{plant}", "TST-Q", "TKPI-1", month, values[i]]
                    for (emp, plant), values in actuals.items() if values[i] is not None]
            resp = self.clients["head"].post("/api/kpi/data/confirm", data={
                "quarter_id": str(self.quarter.id), "period": month, "replace_existing": "true"},
                files={"file": (f"{month}.csv", csv_bytes(rows), "text/csv")})
            assert resp.status_code == 200, resp.text

    def calculate(self) -> dict:
        resp = self.clients["head"].post("/api/kpi/results/calculate",
                                         json={"quarter_id": self.quarter.id})
        assert resp.status_code == 200, resp.text
        return resp.json()

    def transition(self, to: str, client: str = "hr", reason: str | None = None):
        return self.clients[client].post(f"/api/kpi/quarters/{self.quarter.id}/transition",
                                         json={"to": to, "reason": reason})

    def advance(self, to: str) -> dict:
        resp = self.transition(to)
        assert resp.status_code == 200, resp.text
        return resp.json()

    def review_all(self) -> None:
        for sheet_id in self.sheets.values():
            resp = self.clients["head"].post(f"/api/kpi/results/{sheet_id}/review")
            assert resp.status_code == 200, resp.text

    def assignment(self, emp: str, plant: str) -> int:
        return self.env.assignment_id(self.db, emp, (plant, "Q"))

    def set_weights(self, p1: str = "60", p2: str = "40", client: str = "hr"):
        return self.clients[client].put(
            f"/api/kpi/quarters/{self.quarter.id}/employees/{self.employee_id('001')}/weights",
            json={"weights": [{"assignment_id": self.assignment("001", "P1"), "weight": p1},
                              {"assignment_id": self.assignment("001", "P2"), "weight": p2}]})

    def to_normalization(self, actuals: dict | None = None) -> dict:
        self.import_all(actuals)
        self.calculate()
        self.advance("DEPARTMENT_REVIEW")
        self.review_all()
        assert self.set_weights().status_code == 200
        return self.advance("NORMALIZATION")

    def runs(self, client: str = "hr") -> list[dict]:
        resp = self.clients[client].get(f"/api/kpi/quarters/{self.quarter.id}/normalization")
        assert resp.status_code == 200, resp.text
        return resp.json()

    def run(self, run_id: int, client: str = "hr") -> dict:
        resp = self.clients[client].get(f"/api/kpi/normalization-runs/{run_id}")
        assert resp.status_code == 200, resp.text
        return resp.json()

    def approve(self, run_id: int, client: str = "chro"):
        return self.clients[client].post(f"/api/kpi/normalization-runs/{run_id}/approve",
                                         json={})

    def publish(self, client: str = "chro"):
        return self.clients[client].post(f"/api/kpi/quarters/{self.quarter.id}/publish")

    def to_published(self) -> dict:
        self.to_normalization()
        for run in self.runs():
            assert self.approve(run["id"]).status_code == 200
        self.advance("READY")
        resp = self.publish()
        assert resp.status_code == 200, resp.text
        return resp.json()


@pytest.fixture
def review_env(kpi_env: KpiEnv, as_role, db: Session, fixed_today) -> ReviewEnv:
    o = kpi_env.org
    for code in ("010", "011", "012", "013", "014"):
        o.employees[code] = Employee(employee_code=f"TST{code}", full_name=f"Test Person {code}")
        db.add(o.employees[code])
        db.flush()
        add_assignment(db, o, code, ("P1", "Q"), is_primary=True)
    roles = {
        "head": [("DEPT_HEAD", [(ScopeType.DEPARTMENT, None, o.departments["Q"])])],
        "hr": [("HR_HEAD", [(ScopeType.GLOBAL, None, None)])],
        "chro": [("CHRO", [(ScopeType.GLOBAL, None, None)])],
        "hr_p1": [("HR_HEAD", [(ScopeType.PLANT, o.plants["P1"], None)])],
        "plant_head": [("PLANT_HEAD", [(ScopeType.PLANT, o.plants["P1"], None)])],
    }
    users, clients = {}, {}
    for key, grants in roles.items():
        users[key], clients[key] = as_role(f"tst.rv.{key}", grants)
    head = clients["head"]
    sheets = {}
    for emp, plant in REVIEW_ACTUALS:
        created = head.post("/api/kpi/sheets", json={
            "assignment_id": kpi_env.assignment_id(db, emp, (plant, "Q")),
            "quarter_id": kpi_env.q1.id})
        assert created.status_code == 201, created.text
        sheet_id = created.json()["id"]
        target = "50" if (emp, plant) == ("001", "P2") else "100"
        saved = head.put(f"/api/kpi/sheets/{sheet_id}", json={"items": [
            {"kpi_definition_id": kpi_env.kpis["profit"].id, "weightage": "100",
             "target_value": target}]})
        assert saved.status_code == 200, saved.text
        assert head.post(f"/api/kpi/sheets/{sheet_id}/publish").status_code == 200
        sheets[(emp, plant)] = sheet_id
    started = clients["chro"].post(f"/api/kpi/quarters/{kpi_env.q1.id}/start-scoring")
    assert started.status_code == 200, started.text
    policy = published_normalization_policy(db)
    return ReviewEnv(kpi_env, sheets, policy, users, clients, db)
