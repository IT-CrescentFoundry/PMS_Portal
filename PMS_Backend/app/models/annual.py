"""Annual performance results and annual score deviations (Stage M).

  * annual_results            one version of an employee's annual result for a
                              cycle, calculated from the four PUBLISHED quarterly
                              employee results under the cycle's annual rule;
                              the CHRO approves (publishes) it
  * annual_score_deviations   an Admin's request to adjust one annual result
                              version, decided by the CHRO

A version is never edited after calculation except for an approved
adjustment (adjusted_score, kept apart from calculated_score) and its
approval. A recalculation with different sources or rule creates a new
version: a draft it replaces is DISCARDED, a published version stays current
until the new one is approved, then becomes SUPERSEDED.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Computed,
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
from app.models.enums import AnnualDeviationStatus, AnnualResultStatus, enum_values
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.cycle import PmsCycle
    from app.models.employee import Employee


class AnnualResult(TimestampMixin, Base):
    __tablename__ = "annual_results"
    __table_args__ = (
        UniqueConstraint("cycle_id", "employee_id", "version_no", name="uq_annual_results_version"),
        UniqueConstraint("cycle_id", "draft_employee", name="uq_annual_results_one_draft"),
        UniqueConstraint("cycle_id", "published_employee", name="uq_annual_results_one_published"),
        CheckConstraint("version_no >= 1", name="version_range"),
        CheckConstraint("calculated_score BETWEEN 0 AND 5", name="calculated_range"),
        CheckConstraint("adjusted_score IS NULL OR adjusted_score BETWEEN 0 AND 5",
                        name="adjusted_range"),
        CheckConstraint("final_score BETWEEN 0 AND 5", name="final_range"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_id: Mapped[int] = mapped_column(ForeignKey("pms_cycles.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    version_no: Mapped[int] = mapped_column(SmallInteger)
    status: Mapped[AnnualResultStatus] = mapped_column(
        Enum(AnnualResultStatus, name="annual_result_status", values_callable=enum_values),
        default=AnnualResultStatus.CALCULATED,
        server_default=AnnualResultStatus.CALCULATED.value,
    )
    # Home (attribution) unit: that of the latest quarter used.
    plant_id: Mapped[int] = mapped_column(ForeignKey("plants.id"), index=True)
    department_id: Mapped[int] = mapped_column(ForeignKey("departments.id"), index=True)
    # The published quarterly results used: row id and version, scores, and
    # the scoring matrix and normalization policy versions behind them.
    sources: Mapped[list[Any]] = mapped_column(JSON)
    # The rule (formula) as applied, and its SHA-256.
    rule: Mapped[dict[str, Any]] = mapped_column(JSON)
    rule_sha256: Mapped[str] = mapped_column(String(64))
    # SHA-256 of the sources and the rule: identical inputs, identical result.
    inputs_hash: Mapped[str] = mapped_column(String(64))
    calculated_exact: Mapped[Decimal] = mapped_column(Numeric(10, 6))
    calculated_score: Mapped[Decimal] = mapped_column(Numeric(5, 2))  # rounded per the rule
    adjusted_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))  # approved deviation
    final_score: Mapped[Decimal] = mapped_column(Numeric(5, 2))  # adjusted, else calculated
    calculated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    calculated_at: Mapped[datetime | None] = mapped_column(DateTime)
    published_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)
    approval_note: Mapped[str | None] = mapped_column(String(1000))
    # The version this one replaces (a draft, or the published version).
    previous_id: Mapped[int | None] = mapped_column(ForeignKey("annual_results.id"), index=True)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime)
    # Set when a quarter it was calculated from is being corrected or has a
    # newer published version; the result must not be presented as current.
    recalculation_required: Mapped[bool] = mapped_column(default=False, server_default=text("0"))
    recalculation_reason: Mapped[str | None] = mapped_column(String(500))
    draft_employee: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'CALCULATED' THEN employee_id END", persisted=True)
    )
    published_employee: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'PUBLISHED' THEN employee_id END", persisted=True)
    )

    cycle: Mapped[PmsCycle] = relationship()
    employee: Mapped[Employee] = relationship()


class AnnualScoreDeviation(Base):
    """An Admin's request to adjust one annual result version; the CHRO
    decides. The requester never decides, and the calculated score is kept."""

    __tablename__ = "annual_score_deviations"
    __table_args__ = (
        UniqueConstraint("pending_key", name="uq_annual_score_deviations_one_pending"),
        CheckConstraint("proposed_score BETWEEN 0 AND 5", name="proposed_range"),
        CheckConstraint(
            "decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id",
            name="decider_not_requester",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    annual_result_id: Mapped[int] = mapped_column(ForeignKey("annual_results.id"), index=True)
    status: Mapped[AnnualDeviationStatus] = mapped_column(
        Enum(AnnualDeviationStatus, name="annual_deviation_status", values_callable=enum_values),
        default=AnnualDeviationStatus.PENDING,
        server_default=AnnualDeviationStatus.PENDING.value,
    )
    original_score: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    proposed_score: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    reason: Mapped[str] = mapped_column(String(1000))
    requested_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    requested_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP")
    )
    decided_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime)
    decision_reason: Mapped[str | None] = mapped_column(String(1000))
    voided_at: Mapped[datetime | None] = mapped_column(DateTime)
    pending_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'PENDING' THEN annual_result_id END", persisted=True)
    )

    result: Mapped[AnnualResult] = relationship()
