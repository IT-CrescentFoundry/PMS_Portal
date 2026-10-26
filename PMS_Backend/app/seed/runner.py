"""Idempotent seed runner.

Each record is looked up by its business key (codes, or the natural unique
key for mapping rows). Missing records are inserted; existing ones are
updated to match the seed definition. Nothing is ever deleted, and records
not mentioned in the seed are left untouched. Everything runs in a single
transaction: either the whole seed applies, or nothing does.
"""
import os
from collections import Counter
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, TypeVar

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.passwords import (
    PasswordPolicyError,
    hash_password,
    validate_new_password,
    verify_password,
)
from app.db import Base, SessionLocal, engine
from app.models import (
    Department,
    Designation,
    Employee,
    EmployeeAssignment,
    KpiApplicability,
    KpiDefinition,
    KpiScoringPolicy,
    KpiSheet,
    KpiSheetItem,
    KpiSheetStatus,
    Matrix,
    MatrixVersion,
    MatrixVersionScope,
    MatrixVersionSource,
    MatrixVersionStatus,
    Plant,
    PlantDepartment,
    PmsCycle,
    PmsCycleQuarter,
    Role,
    User,
    UserRole,
    UserRoleScope,
)
from app.seed import demo_data as data
from app.services import kpi_scoring, matrix_rules, matrix_service
from app.services.matrix_types import KPI_SCORING

ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"

ModelT = TypeVar("ModelT", bound=Base)


class SeedError(RuntimeError):
    pass


def ensure_schema_at_head() -> None:
    """Refuse to seed a database whose schema is not fully migrated."""
    script = ScriptDirectory.from_config(Config(str(ALEMBIC_INI)))
    with engine.connect() as conn:
        current = set(MigrationContext.configure(conn).get_current_heads())
    expected = set(script.get_heads())
    if current != expected:
        raise SeedError(
            f"Database schema is at {sorted(current) or 'no revision'}, expected "
            f"{sorted(expected)}. Run 'alembic upgrade head' first."
        )


def upsert(
    session: Session,
    model: type[ModelT],
    key: dict[str, Any],
    values: dict[str, Any],
    stats: Counter,
) -> ModelT:
    """Insert or update one row identified by `key`; count what happened."""
    conditions = [
        getattr(model, col).is_(None) if val is None else getattr(model, col) == val
        for col, val in key.items()
    ]
    obj = session.scalars(select(model).where(*conditions)).one_or_none()
    table = model.__tablename__

    if obj is None:
        obj = model(**key, **values)
        session.add(obj)
        session.flush()  # assign the id so later rows can reference it
        stats[(table, "created")] += 1
        return obj

    changed = False
    for col, val in values.items():
        if getattr(obj, col) != val:
            setattr(obj, col, val)
            changed = True
    stats[(table, "updated" if changed else "unchanged")] += 1
    return obj


def _without(record: dict[str, Any], *keys: str) -> dict[str, Any]:
    return {k: v for k, v in record.items() if k not in keys}


def seed(session: Session, demo_password: str | None = None) -> Counter:
    """Upsert all demo records. With demo_password, every demo account gets
    that password (stored only as an Argon2id hash)."""
    stats: Counter = Counter()

    plants = {
        p["code"]: upsert(session, Plant, {"code": p["code"]}, _without(p, "code"), stats)
        for p in data.PLANTS
    }
    departments = {
        d["code"]: upsert(session, Department, {"code": d["code"]}, _without(d, "code"), stats)
        for d in data.DEPARTMENTS
    }
    units = {
        (p, d): upsert(
            session,
            PlantDepartment,
            {"plant_id": plants[p].id, "department_id": departments[d].id},
            {"is_active": True},
            stats,
        )
        for p, d in data.PLANT_DEPARTMENTS
    }
    designations = {
        d["code"]: upsert(session, Designation, {"code": d["code"]}, _without(d, "code"), stats)
        for d in data.DESIGNATIONS
    }
    employees = {
        e["employee_code"]: upsert(
            session,
            Employee,
            {"employee_code": e["employee_code"]},
            _without(e, "employee_code"),
            stats,
        )
        for e in data.EMPLOYEES
    }

    for a in data.ASSIGNMENTS:
        upsert(
            session,
            EmployeeAssignment,
            {
                "employee_id": employees[a["employee"]].id,
                "plant_department_id": units[(a["plant"], a["department"])].id,
                "effective_from": a["effective_from"],
            },
            {
                "designation_id": designations[a["designation"]].id,
                "reporting_manager_id": employees[a["manager"]].id if a["manager"] else None,
                "is_primary": a["is_primary"],
                "effective_to": a["effective_to"],
            },
            stats,
        )

    roles = {
        r["code"]: upsert(session, Role, {"code": r["code"]}, _without(r, "code"), stats)
        for r in data.ROLES
    }
    users = {
        u["username"]: upsert(
            session,
            User,
            {"username": u["username"]},
            {
                "email": u["email"],
                "employee_id": employees[u["employee"]].id if u["employee"] else None,
                "is_active": True,
            },
            stats,
        )
        for u in data.USERS
    }
    if demo_password is not None:
        for user in users.values():
            # Re-hash only when needed, so reruns stay "unchanged".
            if user.password_hash and verify_password(user.password_hash, demo_password):
                stats[("users (password)", "unchanged")] += 1
            else:
                user.password_hash = hash_password(demo_password)
                stats[("users (password)", "updated")] += 1

    for username, role_code, scopes in data.USER_ROLES:
        user_role = upsert(
            session,
            UserRole,
            {"user_id": users[username].id, "role_id": roles[role_code].id},
            {},
            stats,
        )
        for scope_type, plant_code, dept_code in scopes:
            upsert(
                session,
                UserRoleScope,
                {
                    "user_role_id": user_role.id,
                    "scope_type": scope_type,
                    "plant_id": plants[plant_code].id if plant_code else None,
                    "department_id": departments[dept_code].id if dept_code else None,
                },
                {},
                stats,
            )

    for c in data.CYCLES:
        # Statuses are workflow state (e.g. "scoring started" locks a quarter):
        # set them only when the record is first created, never on reruns.
        existing_cycle = session.scalars(select(PmsCycle).where(PmsCycle.code == c["code"])).one_or_none()
        cycle_values = _without(c, "code", "quarters")
        if existing_cycle is not None:
            cycle_values.pop("status")
        cycle = upsert(session, PmsCycle, {"code": c["code"]}, cycle_values, stats)
        for number, name, start, end, status in c["quarters"]:
            exists = session.scalar(select(PmsCycleQuarter.id).where(
                PmsCycleQuarter.cycle_id == cycle.id, PmsCycleQuarter.quarter_number == number))
            values = {"name": name, "start_date": start, "end_date": end}
            if exists is None:
                values["status"] = status
            upsert(
                session,
                PmsCycleQuarter,
                {"cycle_id": cycle.id, "quarter_number": number},
                values,
                stats,
            )

    policies = {}
    for p in data.SCORING_POLICIES:
        policies[p["code"]] = upsert(
            session,
            KpiScoringPolicy,
            {"code": p["code"]},
            {
                "name": p["name"],
                "description": p["description"],
                "direction": p["direction"],
                "bands": [{"threshold": t, "score": s} for t, s in p["bands"]],
                "fallback_score": p["fallback_score"],
                "met_score": p.get("met_score"),
                "breached_score": p.get("breached_score"),
                "is_active": True,
            },
            stats,
        )
    _seed_matrices(session, policies, users, stats)
    kpis = {}
    for k in data.KPI_LIBRARY:
        kpi = upsert(
            session,
            KpiDefinition,
            {"code": k["code"]},
            {
                "name": k["name"],
                "unit": k["unit"],
                "direction": k["direction"],
                "default_scoring_policy_id": policies[k["policy"]].id,
                "data_source": k["data_source"],
                "is_active": True,
                "reporting_frequency": k["frequency"],
                "aggregation": k["aggregation"],
                "measurement_method": k["method"],
            },
            stats,
        )
        kpis[k["code"]] = kpi
        for plant_code, dept_code in k["applicability"]:
            upsert(
                session,
                KpiApplicability,
                {
                    "kpi_definition_id": kpi.id,
                    "plant_id": plants[plant_code].id if plant_code else None,
                    "department_id": departments[dept_code].id if dept_code else None,
                },
                {},
                stats,
            )

    _seed_demo_sheets(session, kpis, plants, departments, employees, stats)
    return stats


def _seed_matrices(session: Session, policies: dict[str, KpiScoringPolicy],
                   users: dict[str, User], stats: Counter) -> None:
    """Back each demo policy with a KPI-scoring matrix. Version 1 is created
    once (PUBLISHED, synthetic approval trail) and never changed afterwards:
    approved configurations change only through new versions."""
    author, approver = users["demo.hrhead"], users["demo.chro"]
    for m in data.SCORING_MATRICES:
        policy = policies[m["policy"]]
        matrix = upsert(
            session,
            Matrix,
            {"code": m["code"]},
            {
                "matrix_type": "KPI_SCORING",
                "name": policy.name,
                "description": policy.description,
                "attributes": {"direction": policy.direction.value},
                "is_active": True,
            },
            stats,
        )
        if policy.matrix_id != matrix.id:
            policy.matrix_id = matrix.id
        if session.scalar(select(MatrixVersion.id).where(MatrixVersion.matrix_id == matrix.id)):
            stats[("matrix_versions", "unchanged")] += 1
            continue
        definition = matrix_rules.definition_from_bands(
            policy.direction, policy.bands, policy.fallback_score, policy.met_score,
            policy.breached_score)
        now = datetime.now().replace(microsecond=0)
        session.add(MatrixVersion(
            matrix_id=matrix.id, version_no=1, status=MatrixVersionStatus.PUBLISHED,
            schema_version=KPI_SCORING.schema_version, definition=definition,
            definition_hash=matrix_rules.definition_hash(definition),
            effective_from=data.MATRIX_EFFECTIVE_FROM, change_summary=data.MATRIX_DEMO_NOTE,
            source=MatrixVersionSource.SEED, created_by_user_id=author.id,
            submitted_by_user_id=author.id, submitted_at=now, approved_by_user_id=approver.id,
            approved_at=now, approval_note=data.MATRIX_DEMO_NOTE, published_by_user_id=author.id,
            published_at=now, scopes=[MatrixVersionScope(plant_id=None, department_id=None)],
        ))
        session.flush()
        stats[("matrix_versions", "created")] += 1


def _seed_demo_sheets(session: Session, kpis: dict[str, KpiDefinition], plants: dict[str, Plant],
                      departments: dict[str, Department], employees: dict[str, Employee],
                      stats: Counter) -> None:
    """Locked Q3 demo sheets, created once (workflow records), with every item
    bound to the policy's published matrix version like a real publication."""
    for s in data.DEMO_SHEETS:
        quarter = session.scalars(
            select(PmsCycleQuarter).join(PmsCycle).where(
                PmsCycle.code == s["cycle"], PmsCycleQuarter.quarter_number == s["quarter"])
        ).one()
        assignment = session.scalars(
            select(EmployeeAssignment).join(EmployeeAssignment.plant_department).where(
                EmployeeAssignment.employee_id == employees[s["employee"]].id,
                PlantDepartment.plant_id == plants[s["plant"]].id,
                PlantDepartment.department_id == departments[s["department"]].id,
            ).order_by(EmployeeAssignment.effective_from.desc())
        ).first()
        if assignment is None:
            raise SeedError(f"No assignment for demo sheet {s['employee']} {s['plant']}/{s['department']}.")
        if session.scalar(select(KpiSheet.id).where(KpiSheet.employee_assignment_id == assignment.id,
                                                    KpiSheet.cycle_quarter_id == quarter.id)):
            stats[("kpi_sheets", "unchanged")] += 1
            continue
        now = datetime.now().replace(microsecond=0)
        sheet = KpiSheet(employee_assignment_id=assignment.id, cycle_quarter_id=quarter.id,
                         status=KpiSheetStatus.LOCKED, published_at=now, locked_at=now,
                         notes="Synthetic demo sheet.")
        session.add(sheet)
        session.flush()
        unit = session.get(PlantDepartment, assignment.plant_department_id)
        for order, (kpi_code, weightage, target) in enumerate(s["items"], 1):
            kpi = kpis[kpi_code]
            policy = session.get(KpiScoringPolicy, kpi.default_scoring_policy_id)
            version = matrix_service.resolve(session, policy.matrix_id, quarter.start_date,
                                             unit.plant_id, unit.department_id)
            if version is None:
                raise SeedError(f"No published matrix version for {policy.code}.")
            session.add(KpiSheetItem(
                sheet_id=sheet.id, kpi_definition_id=kpi.id, sort_order=order,
                weightage=Decimal(weightage),
                target_value=Decimal(target) if target is not None else Decimal(0),
                unit=kpi.unit, scoring_policy_id=policy.id,
                scoring_snapshot=kpi_scoring.scoring_snapshot(version, policy),
                matrix_version_id=version.id,
                measurement_snapshot=kpi_scoring.measurement_snapshot(kpi, kpi.unit),
            ))
        session.flush()
        stats[("kpi_sheets", "created")] += 1


def demo_password_from_env() -> str | None:
    """DEMO_USER_PASSWORD from PMS_Backend/.env (never from source code)."""
    password = os.getenv("DEMO_USER_PASSWORD") or None
    if password is not None:
        try:
            validate_new_password(password)
        except PasswordPolicyError as exc:
            raise SeedError(f"DEMO_USER_PASSWORD rejected: {exc}") from None
    return password


def run() -> Counter:
    ensure_schema_at_head()
    demo_password = demo_password_from_env()
    with SessionLocal() as session, session.begin():  # commit, or roll back on error
        return seed(session, demo_password)
