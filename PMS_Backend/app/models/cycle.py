"""Annual PMS cycles and their four quarters.

Cycle and quarter boundaries are stored as data, never derived from the
calendar, so an April-March financial year (or any other) is just
configuration.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.enums import CycleStatus, QuarterStatus, enum_values
from app.models.mixins import TimestampMixin


class PmsCycle(TimestampMixin, Base):
    __tablename__ = "pms_cycles"
    __table_args__ = (
        CheckConstraint("end_date > start_date", name="valid_dates"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)  # e.g. "FY2026-27"
    name: Mapped[str] = mapped_column(String(100))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)  # inclusive
    status: Mapped[CycleStatus] = mapped_column(
        Enum(CycleStatus, name="cycle_status", values_callable=enum_values),
        default=CycleStatus.DRAFT,
        server_default=CycleStatus.DRAFT.value,
    )
    # Stage M: how the annual score is built from the quarterly scores
    # (app/services/annual.py). NULL means the initial default: an equally
    # weighted average of the four published quarterly scores.
    annual_rule: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    quarters: Mapped[list[PmsCycleQuarter]] = relationship(
        back_populates="cycle", order_by="PmsCycleQuarter.quarter_number"
    )


class PmsCycleQuarter(TimestampMixin, Base):
    """One of the four quarters of a cycle, with its own configurable dates.

    Quarterly feedback is optional: feedback_enabled turns it on. Publication
    never depends on feedback (Stage L business rule), so feedback_blocking
    is not used by any step.

    Checking that quarter dates sit inside the cycle without overlapping is
    a cross-row rule, validated in the service layer.
    """

    __tablename__ = "pms_cycle_quarters"
    __table_args__ = (
        UniqueConstraint(
            "cycle_id", "quarter_number", name="uq_pms_cycle_quarters_cycle_quarter"
        ),
        CheckConstraint("quarter_number BETWEEN 1 AND 4", name="quarter_number_range"),
        CheckConstraint("end_date >= start_date", name="valid_dates"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # cycle_id is indexed by the leading column of the unique constraint.
    cycle_id: Mapped[int] = mapped_column(ForeignKey("pms_cycles.id"))
    quarter_number: Mapped[int] = mapped_column(SmallInteger)  # 1..4
    name: Mapped[str] = mapped_column(String(50))  # e.g. "Q1 (Apr-Jun 2026)"
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)  # inclusive
    status: Mapped[QuarterStatus] = mapped_column(
        Enum(QuarterStatus, name="quarter_status", values_callable=enum_values),
        default=QuarterStatus.DRAFT,
        server_default=QuarterStatus.DRAFT.value,
    )
    feedback_enabled: Mapped[bool] = mapped_column(
        default=True, server_default=text("1")
    )
    feedback_blocking: Mapped[bool] = mapped_column(
        default=False, server_default=text("0")
    )
    # Stage L: who published the quarter's scores, and when.
    published_at: Mapped[datetime | None] = mapped_column(DateTime)
    published_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), index=True
    )

    cycle: Mapped[PmsCycle] = relationship(back_populates="quarters")
