"""Controlled corrections of published quarters (Stage M).

A published quarter never changes. An HR Head requests a correction: the
monthly source values and contribution weights to change, each with its value
before and after, and a reason. When the CHRO approves it, the correction
becomes version N+1 of the quarter's results:

  * the corrected values and weights apply to that version only (the stored
    monthly values and weights are not edited; the items here are the
    overlay, applied in version order);
  * the affected KPI sheets are recalculated with the matrix versions frozen
    on them, as new rows of kpi_sheet_results;
  * after department review, the affected employees and their normalization
    cohorts get new rows of employee_quarter_results and normalization_runs;
  * when the version is published, those rows become PUBLISHED and the rows
    they replace SUPERSEDED. Nothing is deleted.

Only one correction of a quarter may be open (requested or in progress) at a
time, and each version number is used once.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.enums import CorrectionItemKind, CorrectionStatus, enum_values
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.cycle import PmsCycleQuarter


class QuarterCorrection(TimestampMixin, Base):
    __tablename__ = "quarter_corrections"
    __table_args__ = (
        UniqueConstraint("cycle_quarter_id", "version_no", name="uq_quarter_corrections_version"),
        UniqueConstraint("open_key", name="uq_quarter_corrections_one_open"),
        CheckConstraint("version_no IS NULL OR version_no >= 2", name="version_range"),
        CheckConstraint(
            "decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id",
            name="decider_not_requester",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_quarter_id: Mapped[int] = mapped_column(ForeignKey("pms_cycle_quarters.id"))
    status: Mapped[CorrectionStatus] = mapped_column(
        Enum(CorrectionStatus, name="correction_status", values_callable=enum_values),
        default=CorrectionStatus.REQUESTED,
        server_default=CorrectionStatus.REQUESTED.value,
    )
    # The published version the request was made against, and the version
    # this correction becomes when approved (base_version + 1).
    base_version: Mapped[int] = mapped_column(SmallInteger)
    version_no: Mapped[int | None] = mapped_column(SmallInteger)
    reason: Mapped[str] = mapped_column(String(2000))
    # Projected effect when requested (sheet and employee scores before and
    # after), so the CHRO can review the change; recomputed on approval.
    preview: Mapped[dict[str, Any]] = mapped_column(JSON)
    # Set on approval: affected sheets and employees, the cohorts to
    # renormalize with their members, and the annual results flagged.
    affected: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    requested_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    requested_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP")
    )
    decided_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime)
    decision_reason: Mapped[str | None] = mapped_column(String(1000))
    published_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)
    open_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status IN ('REQUESTED', 'DEPARTMENT_REVIEW', 'NORMALIZATION', "
                 "'READY') THEN cycle_quarter_id END", persisted=True)
    )

    quarter: Mapped[PmsCycleQuarter] = relationship()
    items: Mapped[list[QuarterCorrectionItem]] = relationship(
        back_populates="correction", order_by="QuarterCorrectionItem.id",
        cascade="all, delete-orphan")


class QuarterCorrectionItem(Base):
    """One change of a correction, with the value before and after."""

    __tablename__ = "quarter_correction_items"
    __table_args__ = (
        CheckConstraint(
            "(kind = 'VALUE' AND sheet_id IS NOT NULL AND kpi_definition_id IS NOT NULL "
            "AND period_month IS NOT NULL) OR (kind = 'WEIGHTS' AND employee_id IS NOT NULL "
            "AND after_weights IS NOT NULL)",
            name="item_shape",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    correction_id: Mapped[int] = mapped_column(ForeignKey("quarter_corrections.id"), index=True)
    kind: Mapped[CorrectionItemKind] = mapped_column(
        Enum(CorrectionItemKind, name="correction_item_kind", values_callable=enum_values)
    )
    # VALUE: one monthly source value of one KPI of one sheet.
    sheet_id: Mapped[int | None] = mapped_column(ForeignKey("kpi_sheets.id"), index=True)
    kpi_definition_id: Mapped[int | None] = mapped_column(
        ForeignKey("kpi_definitions.id"), index=True
    )
    period_month: Mapped[date | None] = mapped_column(Date)  # first day of the month
    had_value: Mapped[bool] = mapped_column(default=True, server_default=text("1"))
    before_actual: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    after_actual: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    before_inputs: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    after_inputs: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    # WEIGHTS: {assignment id: weight %} before and after (total 100).
    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), index=True)
    before_weights: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    after_weights: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    correction: Mapped[QuarterCorrection] = relationship(back_populates="items")
