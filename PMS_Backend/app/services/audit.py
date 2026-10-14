"""Audit trail service: the only way audit records are written.

Transaction rule: record_event() adds the record to the caller's session and
flushes, but NEVER commits. The caller commits once, after both the business
change and its audit record are in the session, so either both are saved or
neither is. Typical write endpoint:

    def update_kra(..., db: DbSession, actor: AuditActorDep):
        before = snapshot(kra)
        kra.weight = body.weight
        record_event(db, actor=actor, action="kra.update", entity_type="kra",
                     entity_id=kra.id, summary=f"Weight changed for {kra.code}",
                     changes=field_changes(before, snapshot(kra), ["weight"]),
                     plant_id=..., department_id=..., reason=body.reason)
        db.commit()

Never pass passwords, tokens or unnecessary personal data. Keys that look
sensitive are redacted defensively, but callers should list only the fields
that matter for the record.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditActorType, AuditEvent, User

ACTION_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
SENSITIVE_KEY = re.compile(
    r"pass(word|wd)?|secret|token|hash|credential|api[_-]?key|otp|"
    r"aadhaar|pan_?(number|no)|bank_?account|account_?number",
    re.IGNORECASE,
)
REDACTED = "[redacted]"
MAX_CHANGES_BYTES = 16_000


class AuditError(ValueError):
    """An audit record was requested with invalid or unsafe content."""


@dataclass(frozen=True)
class AuditActor:
    """Who is performing the action. Build it from the authenticated user."""

    actor_type: AuditActorType
    user_id: int | None
    username: str

    @classmethod
    def from_user(cls, user: User) -> AuditActor:
        return cls(AuditActorType.USER, user.id, user.username)

    @classmethod
    def system(cls, name: str = "system") -> AuditActor:
        return cls(AuditActorType.SYSTEM, None, name)


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in value]
    raise AuditError(f"Audit changes cannot contain values of type {type(value).__name__}.")


def sanitize(value: Any) -> Any:
    """JSON-safe copy with values under sensitive-looking keys redacted."""
    if isinstance(value, Mapping):
        return {
            str(k): REDACTED if SENSITIVE_KEY.search(str(k)) else sanitize(v)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [sanitize(v) for v in value]
    return _jsonable(value)


def field_changes(
    before: Mapping[str, Any], after: Mapping[str, Any], fields: Iterable[str]
) -> dict[str, dict[str, Any]]:
    """{field: {"from": old, "to": new}} for the listed fields that changed."""
    return {
        field: {"from": before.get(field), "to": after.get(field)}
        for field in fields
        if before.get(field) != after.get(field)
    }


def record_event(
    db: Session,
    *,
    actor: AuditActor,
    action: str,
    entity_type: str,
    entity_id: str | int,
    summary: str,
    reason: str | None = None,
    reason_required: bool = False,
    changes: Mapping[str, Any] | None = None,
    plant_id: int | None = None,
    department_id: int | None = None,
    request_id: str | None = None,
) -> AuditEvent:
    """Add an audit record to the caller's transaction (flushed, not committed)."""
    if not ACTION_PATTERN.fullmatch(action):
        raise AuditError(f"Invalid audit action code '{action}' (expected e.g. 'kra.update').")
    if not entity_type.strip() or not str(entity_id).strip():
        raise AuditError("Audit records need an entity type and id.")
    if not summary.strip():
        raise AuditError("Audit records need a summary.")
    reason = reason.strip() if reason else None
    if reason_required and not reason:
        raise AuditError("A reason is required for this action.")
    if actor.actor_type == AuditActorType.USER and actor.user_id is None:
        raise AuditError("A user action must identify the user.")

    safe_changes = sanitize(changes) if changes else None
    if safe_changes is not None and len(json.dumps(safe_changes)) > MAX_CHANGES_BYTES:
        raise AuditError("Audit changes are too large; record a summary of the fields instead.")

    event = AuditEvent(
        actor_type=actor.actor_type,
        actor_user_id=actor.user_id,
        actor_username=actor.username[:50],
        action=action,
        entity_type=entity_type.strip()[:64],
        entity_id=str(entity_id).strip()[:64],
        plant_id=plant_id,
        department_id=department_id,
        summary=summary.strip()[:500],
        reason=reason[:1000] if reason else None,
        changes=safe_changes,
        request_id=request_id,
    )
    db.add(event)
    db.flush()  # assigns the id and surfaces constraint errors now
    return event
