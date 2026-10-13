"""Idempotent seed runner.

Each record is looked up by its business key (codes, or the natural unique
key for mapping rows). Missing records are inserted; existing ones are
updated to match the seed definition. Nothing is ever deleted, and records
not mentioned in the seed are left untouched. Everything runs in a single
transaction: either the whole seed applies, or nothing does.
"""
import os
from collections import Counter
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
        cycle = upsert(
            session, PmsCycle, {"code": c["code"]}, _without(c, "code", "quarters"), stats
        )
        for number, name, start, end, status in c["quarters"]:
            upsert(
                session,
                PmsCycleQuarter,
                {"cycle_id": cycle.id, "quarter_number": number},
                {"name": name, "start_date": start, "end_date": end, "status": status},
                stats,
            )

    return stats


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
