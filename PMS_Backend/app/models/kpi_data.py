"""Monthly KPI data and quarterly score results (Stage K).

Four distinct things, never mixed:
  * imported SOURCE values   kpi_monthly_values (per sheet, KPI and month),
                             traceable to kpi_data_imports (file metadata only)
  * CALCULATED results       kpi_sheet_results, status CALCULATED
  * REVIEWED results         the same row, status REVIEWED (manager)
  * PUBLISHED scores         status PUBLISHED: final and immutable
A manual final-score override is a separate, dual-approved request
(kpi_score_overrides), never an edit of the result.
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
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.enums import ScoreOverrideStatus, ScoreResultStatus, enum_values
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.cycle import PmsCycleQuarter
    from app.models.kpi import KpiDefinition, KpiSheet


class KpiDataImport(TimestampMixin, Base):
    """One confirmed monthly import. The file itself is never stored: only
    what is needed to trace and recognise it."""

    __tablename__ = "kpi_data_imports"

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_quarter_id: Mapped[int] = mapped_column(ForeignKey("pms_cycle_quarters.id"), index=True)
    period_month: Mapped[date] = mapped_column(Date, index=True)  # first day of the month
    file_name: Mapped[str] = mapped_column(String(255))
    file_sha256: Mapped[str] = mapped_column(String(64), index=True)
    file_size: Mapped[int] = mapped_column(Integer)
    file_format: Mapped[str] = mapped_column(String(10))  # csv | xlsx
    mapping: Mapped[dict[str, Any]] = mapped_column(JSON)  # contract field -> file column
    row_count: Mapped[int] = mapped_column(Integer)
    rows_created: Mapped[int] = mapped_column(Integer)
    rows_replaced: Mapped[int] = mapped_column(Integer)
    rows_unchanged: Mapped[int] = mapped_column(Integer)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)

    quarter: Mapped[PmsCycleQuarter] = relationship()


class KpiMonthlyValue(TimestampMixin, Base):
    """Source value for one KPI of one sheet in one month. Keyed by sheet and
    KPI (not by sheet item), so values survive item replacement by an
    approved deviation."""

    __tablename__ = "kpi_monthly_values"
    __table_args__ = (
        UniqueConstraint(
            "sheet_id", "kpi_definition_id", "period_month", name="uq_kpi_monthly_values_month"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sheet_id: Mapped[int] = mapped_column(ForeignKey("kpi_sheets.id"))
    kpi_definition_id: Mapped[int] = mapped_column(ForeignKey("kpi_definitions.id"), index=True)
    period_month: Mapped[date] = mapped_column(Date)  # first day of the month
    actual_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    # Extra matrix inputs imported by key, e.g. {"audit_grade": "B"} (strings).
    input_values: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    data_import_id: Mapped[int | None] = mapped_column(
        ForeignKey("kpi_data_imports.id"), index=True
    )
    source_row: Mapped[int | None] = mapped_column(Integer)
    recorded_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)

    sheet: Mapped[KpiSheet] = relationship()
    kpi_definition: Mapped[KpiDefinition] = relationship()
    data_import: Mapped[KpiDataImport | None] = relationship()


class KpiSheetResult(TimestampMixin, Base):
    """The quarterly result of one KPI sheet (one employee assignment)."""

    __tablename__ = "kpi_sheet_results"
    __table_args__ = (
        CheckConstraint(
            "final_score IS NULL OR final_score BETWEEN 0 AND 5", name="final_score_range"
        ),
        CheckConstraint(
            "published_score IS NULL OR published_score BETWEEN 0 AND 5",
            name="published_score_range",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sheet_id: Mapped[int] = mapped_column(ForeignKey("kpi_sheets.id"), unique=True)
    status: Mapped[ScoreResultStatus] = mapped_column(
        Enum(ScoreResultStatus, name="score_result_status", values_callable=enum_values),
        default=ScoreResultStatus.CALCULATED,
        server_default=ScoreResultStatus.CALCULATED.value,
    )
    # Every KPI scored from every expected month.
    is_complete: Mapped[bool] = mapped_column(default=False, server_default=text("0"))
    # Exact sum of score x weightage / 100 (at most 4 decimals).
    calculated_score: Mapped[Decimal | None] = mapped_column(Numeric(7, 4))
    final_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))  # rounded half-up
    override_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))  # applied override
    published_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    # Per-KPI explanation: inputs, target, version, rule, score, contribution.
    explanation: Mapped[dict[str, Any]] = mapped_column(JSON)
    # SHA-256 of everything the calculation used; a mismatch means stale.
    inputs_hash: Mapped[str] = mapped_column(String(64))
    calculated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    calculated_at: Mapped[datetime | None] = mapped_column(DateTime)
    reviewed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    published_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)

    sheet: Mapped[KpiSheet] = relationship()


class KpiScoreOverride(Base):
    """A manual final-score override: applied only after an HR Head (or the
    CHRO) AND a Plant Head approve; two different people, neither the
    requester."""

    __tablename__ = "kpi_score_overrides"
    __table_args__ = (
        UniqueConstraint("pending_key", name="uq_kpi_score_overrides_one_pending"),
        CheckConstraint("proposed_score BETWEEN 0 AND 5", name="proposed_range"),
        CheckConstraint(
            "hr_approved_by_user_id IS NULL OR plant_approved_by_user_id IS NULL "
            "OR hr_approved_by_user_id <> plant_approved_by_user_id",
            name="distinct_approvers",
        ),
        CheckConstraint(
            "(hr_approved_by_user_id IS NULL OR hr_approved_by_user_id <> requested_by_user_id) "
            "AND (plant_approved_by_user_id IS NULL "
            "OR plant_approved_by_user_id <> requested_by_user_id)",
            name="approver_not_requester",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    result_id: Mapped[int] = mapped_column(ForeignKey("kpi_sheet_results.id"), index=True)
    status: Mapped[ScoreOverrideStatus] = mapped_column(
        Enum(ScoreOverrideStatus, name="score_override_status", values_callable=enum_values),
        default=ScoreOverrideStatus.PENDING,
        server_default=ScoreOverrideStatus.PENDING.value,
    )
    original_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    proposed_score: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    reason: Mapped[str] = mapped_column(String(1000))
    requested_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    requested_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP")
    )
    hr_approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    hr_approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    plant_approved_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    plant_approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    rejected_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime)
    rejection_reason: Mapped[str | None] = mapped_column(String(1000))
    applied_at: Mapped[datetime | None] = mapped_column(DateTime)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime)
    pending_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'PENDING' THEN result_id END", persisted=True)
    )

    result: Mapped[KpiSheetResult] = relationship()
