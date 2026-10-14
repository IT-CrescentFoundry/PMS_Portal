"""Audit trail: attribution, transaction consistency and safe content."""
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError

from app.auth.dependencies import get_audit_actor
from app.models import AuditActorType, AuditEvent, Designation
from app.services.audit import (
    REDACTED,
    AuditActor,
    AuditError,
    field_changes,
    record_event,
)

CHECK_VIOLATION = 3819


@pytest.fixture
def actor(make_user) -> AuditActor:
    return AuditActor.from_user(make_user("tst.auditor"))


def events(db, entity_id: str):
    return db.scalars(
        select(AuditEvent).where(AuditEvent.entity_type == "designation", AuditEvent.entity_id == entity_id)
    ).all()


def test_event_is_attributed_to_the_authenticated_actor(db, actor, org):
    event = record_event(
        db,
        actor=actor,
        action="designation.create",
        entity_type="designation",
        entity_id=42,
        summary="Created designation TST-X",
        reason="Approved in HR review",
        plant_id=org.plants["P1"].id,
        department_id=org.departments["Q"].id,
    )
    db.refresh(event)
    assert event.id is not None and event.occurred_at is not None
    assert (event.actor_type, event.actor_user_id, event.actor_username) == (
        AuditActorType.USER,
        actor.user_id,
        "tst.auditor",
    )
    assert event.entity_id == "42" and event.reason == "Approved in HR review"


def test_audit_record_and_business_change_commit_together(db, actor):
    with db.begin_nested():
        db.add(Designation(code="TST-AUD1", name="Audit Test One"))
        record_event(
            db, actor=actor, action="designation.create", entity_type="designation",
            entity_id="TST-AUD1", summary="Created",
        )
    assert db.scalar(select(Designation).where(Designation.code == "TST-AUD1")) is not None
    assert len(events(db, "TST-AUD1")) == 1


def test_audit_record_and_business_change_roll_back_together(db, actor):
    with pytest.raises(RuntimeError):
        with db.begin_nested():
            db.add(Designation(code="TST-AUD2", name="Audit Test Two"))
            record_event(
                db, actor=actor, action="designation.create", entity_type="designation",
                entity_id="TST-AUD2", summary="Created",
            )
            raise RuntimeError("business rule failed after the audit record was written")
    assert db.scalar(select(Designation).where(Designation.code == "TST-AUD2")) is None
    assert events(db, "TST-AUD2") == []


def test_sensitive_values_are_redacted_and_values_made_json_safe(db, actor):
    event = record_event(
        db,
        actor=actor,
        action="user.update",
        entity_type="designation",
        entity_id="TST-AUD3",
        summary="Updated",
        changes={
            "name": {"from": "Old", "to": "New"},
            "password": "hunter2-hunter2",
            "nested": {"api_key": "abc", "access_token": "xyz", "effective_from": date(2026, 4, 1)},
            "weight": Decimal("12.50"),
        },
    )
    db.refresh(event)
    assert event.changes["name"] == {"from": "Old", "to": "New"}
    assert event.changes["password"] == REDACTED
    assert event.changes["nested"]["api_key"] == REDACTED
    assert event.changes["nested"]["access_token"] == REDACTED
    assert event.changes["nested"]["effective_from"] == "2026-04-01"
    assert event.changes["weight"] == "12.50"


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"action": "Update KRA"}, "action code"),
        ({"action": "kra"}, "action code"),
        ({"summary": "  "}, "summary"),
        ({"entity_id": ""}, "entity"),
        ({"reason_required": True}, "reason"),
        ({"reason_required": True, "reason": "   "}, "reason"),
        ({"changes": {"blob": "x" * 20_000}}, "too large"),
        ({"changes": {"obj": object()}}, "cannot contain"),
    ],
)
def test_invalid_records_are_refused(db, actor, overrides, message):
    arguments = dict(
        actor=actor, action="kra.update", entity_type="kra", entity_id="1", summary="Changed"
    )
    arguments.update(overrides)
    with pytest.raises(AuditError, match=message):
        record_event(db, **arguments)


def test_user_actor_without_id_is_refused(db):
    with pytest.raises(AuditError):
        record_event(
            db, actor=AuditActor(AuditActorType.USER, None, "someone"), action="kra.update",
            entity_type="kra", entity_id="1", summary="Changed",
        )


def test_database_enforces_user_attribution(db):
    """Even bypassing the service, a USER event without a user id is rejected."""
    with pytest.raises(DBAPIError) as exc_info:
        with db.begin_nested():
            db.add(AuditEvent(
                actor_type=AuditActorType.USER, actor_user_id=None, actor_username="x",
                action="kra.update", entity_type="kra", entity_id="1", summary="Changed",
            ))
            db.flush()
    assert exc_info.value.orig.args[0] == CHECK_VIOLATION


def test_system_actor_is_allowed_without_a_user(db):
    event = record_event(
        db, actor=AuditActor.system("nightly-import"), action="employee.import",
        entity_type="employee", entity_id="batch-1", summary="Imported 3 employees",
    )
    assert event.actor_user_id is None and event.actor_username == "nightly-import"


def test_field_changes_lists_only_changed_fields():
    before = {"name": "A", "weight": 10, "status": "DRAFT"}
    after = {"name": "A", "weight": 20, "status": "ACTIVE"}
    assert field_changes(before, after, ["name", "weight", "status"]) == {
        "weight": {"from": 10, "to": 20},
        "status": {"from": "DRAFT", "to": "ACTIVE"},
    }


def test_actor_dependency_uses_the_signed_in_user(make_user):
    user = make_user("tst.actor")
    actor = get_audit_actor(user)
    assert actor == AuditActor(AuditActorType.USER, user.id, "tst.actor")
