"""Append-only audit trail for consequential actions.

One row per action: who (actor), what (action + entity), when, why (reason)
and a safe summary of the change. Rows are only ever inserted, through
app/services/audit.py, in the same transaction as the business change.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.enums import AuditActorType, enum_values


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        # A user action must be attributable to a user account.
        CheckConstraint(
            "actor_type <> 'USER' OR actor_user_id IS NOT NULL", name="user_actor_has_id"
        ),
        # History of one record, newest first.
        Index("ix_audit_events_entity", "entity_type", "entity_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP"), nullable=False, index=True
    )

    actor_type: Mapped[AuditActorType] = mapped_column(
        Enum(AuditActorType, name="audit_actor_type", values_callable=enum_values)
    )
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    # Snapshot, so the record stays readable even if the account changes.
    actor_username: Mapped[str] = mapped_column(String(50))

    # Dotted code, e.g. "kra.update", "jd.approve".
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str] = mapped_column(String(64))

    # Organizational context, so HR/Admin can later view events within scope.
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"), index=True)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"), index=True)

    summary: Mapped[str] = mapped_column(String(500))
    # Approved reason / justification, where the action requires one.
    reason: Mapped[str | None] = mapped_column(String(1000))
    # Field-level before/after values (sanitized; never credentials).
    changes: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    # Correlates several events written by one request, when provided.
    request_id: Mapped[str | None] = mapped_column(String(64))
