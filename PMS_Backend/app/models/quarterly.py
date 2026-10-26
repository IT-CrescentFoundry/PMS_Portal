"""Quarterly consolidation, normalization and review records (Stage L).

  * assignment_score_weights   how much each assignment of a cross-plant
                               employee contributes to their quarterly score
  * employee_quarter_results   the employee's consolidated quarterly score,
                               frozen when normalization starts, and their
                               normalization outcome; published with the quarter
  * normalization_runs         one normalization cohort of a quarter
  * kpi_sheet_comments         review comments and optional feedback

Assignment-level results stay in kpi_sheet_results; nothing here replaces
them. See docs/database-design.md (Stage L).
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.enums import (
    CohortLevel,
    EmployeeResultStatus,
    NormalizationPlacement,
    NormalizationRunStatus,
    SheetCommentKind,
    enum_values,
)
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.cycle import PmsCycleQuarter
    from app.models.employee import Employee, EmployeeAssignment
    from app.models.kpi import KpiSheet
    from app.models.matrix import MatrixVersion
    from app.models.organization import Department, Plant


class AssignmentScoreWeight(TimestampMixin, Base):
    """Contribution of one assignment to its employee's quarterly score. The
    weights of an employee's scored assignments must total exactly 100.00
    (checked in the service, since it spans rows)."""

    __tablename__ = "assignment_score_weights"
    __table_args__ = (
        UniqueConstraint(
            "cycle_quarter_id", "employee_assignment_id", name="uq_assignment_score_weights_quarter"
        ),
        CheckConstraint("weight > 0 AND weight <= 100", name="weight_range"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_quarter_id: Mapped[int] = mapped_column(ForeignKey("pms_cycle_quarters.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    employee_assignment_id: Mapped[int] = mapped_column(
        ForeignKey("employee_assignments.id"), index=True
    )
    weight: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    set_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)

    assignment: Mapped[EmployeeAssignment] = relationship()


class NormalizationRun(TimestampMixin, Base):
    """One cohort of a quarter under one normalization policy version."""

    __tablename__ = "normalization_runs"
    __table_args__ = (
        UniqueConstraint("cycle_quarter_id", "cohort_key", name="uq_normalization_runs_cohort"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_quarter_id: Mapped[int] = mapped_column(ForeignKey("pms_cycle_quarters.id"))
    matrix_version_id: Mapped[int] = mapped_column(ForeignKey("matrix_versions.id"), index=True)
    cohort_level: Mapped[CohortLevel] = mapped_column(
        Enum(CohortLevel, name="cohort_level", values_callable=enum_values)
    )
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"), index=True)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"), index=True)
    # "<version id>:<level>:<plant id or *>:<department id or *>"
    cohort_key: Mapped[str] = mapped_column(String(80))
    status: Mapped[NormalizationRunStatus] = mapped_column(
        Enum(NormalizationRunStatus, name="normalization_run_status", values_callable=enum_values),
        default=NormalizationRunStatus.DRAFT,
        server_default=NormalizationRunStatus.DRAFT.value,
    )
    population: Mapped[int] = mapped_column(SmallInteger)  # employees in the cohort
    eligible: Mapped[int] = mapped_column(SmallInteger)    # of whom placed in groups
    small_cohort: Mapped[bool] = mapped_column(default=False, server_default=text("0"))
    # {group key: count} as the policy targets, and as placed.
    targets: Mapped[dict[str, Any]] = mapped_column(JSON)
    # Ties, small cohort, distance from the targets, rating problems.
    exceptions: Mapped[list[Any]] = mapped_column(JSON)
    # SHA-256 of the members, their scores and the policy content.
    inputs_hash: Mapped[str] = mapped_column(String(64))
    computed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    computed_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    approval_note: Mapped[str | None] = mapped_column(String(1000))
    published_at: Mapped[datetime | None] = mapped_column(DateTime)

    quarter: Mapped[PmsCycleQuarter] = relationship()
    matrix_version: Mapped[MatrixVersion] = relationship()
    plant: Mapped[Plant | None] = relationship()
    department: Mapped[Department | None] = relationship()


class EmployeeQuarterResult(TimestampMixin, Base):
    """One employee's consolidated quarterly score and normalization outcome."""

    __tablename__ = "employee_quarter_results"
    __table_args__ = (
        UniqueConstraint("cycle_quarter_id", "employee_id", name="uq_employee_quarter_results"),
        CheckConstraint("final_score BETWEEN 0 AND 5", name="final_score_range"),
        CheckConstraint(
            "normalized_rating IS NULL OR normalized_rating BETWEEN 0 AND 5",
            name="normalized_rating_range",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_quarter_id: Mapped[int] = mapped_column(ForeignKey("pms_cycle_quarters.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    status: Mapped[EmployeeResultStatus] = mapped_column(
        Enum(EmployeeResultStatus, name="employee_result_status", values_callable=enum_values),
        default=EmployeeResultStatus.DRAFT,
        server_default=EmployeeResultStatus.DRAFT.value,
    )
    # Attribution: the primary assignment (for cohorts and counting once).
    primary_assignment_id: Mapped[int] = mapped_column(
        ForeignKey("employee_assignments.id"), index=True
    )
    plant_id: Mapped[int] = mapped_column(ForeignKey("plants.id"), index=True)
    department_id: Mapped[int] = mapped_column(ForeignKey("departments.id"), index=True)
    # [{assignment_id, sheet_id, plant, department, score, score_source, weight, contribution}]
    components: Mapped[list[Any]] = mapped_column(JSON)
    weights_source: Mapped[str] = mapped_column(String(20))  # SINGLE | CONFIGURED
    calculated_score: Mapped[Decimal] = mapped_column(Numeric(7, 4))  # exact
    final_score: Mapped[Decimal] = mapped_column(Numeric(5, 2))       # rounded half-up
    inputs_hash: Mapped[str] = mapped_column(String(64))
    # Normalization outcome.
    normalization_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("normalization_runs.id"), index=True
    )
    rank: Mapped[int | None] = mapped_column(SmallInteger)
    group_key: Mapped[str | None] = mapped_column(String(20))
    placement: Mapped[NormalizationPlacement | None] = mapped_column(
        Enum(NormalizationPlacement, name="normalization_placement", values_callable=enum_values)
    )
    # Groups a tied or small-cohort employee may be placed in.
    placement_options: Mapped[list[Any] | None] = mapped_column(JSON)
    placement_reason: Mapped[str | None] = mapped_column(String(500))
    placed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    placed_at: Mapped[datetime | None] = mapped_column(DateTime)
    normalized_rating: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    # The policy rule that gave the rating, or why there is none.
    rating_explanation: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    published_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)

    employee: Mapped[Employee] = relationship()
    primary_assignment: Mapped[EmployeeAssignment] = relationship()
    run: Mapped[NormalizationRun | None] = relationship()


class KpiSheetComment(TimestampMixin, Base):
    """A review comment or feedback on one KPI sheet. Append-only, and never
    a prerequisite for any step."""

    __tablename__ = "kpi_sheet_comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    sheet_id: Mapped[int] = mapped_column(ForeignKey("kpi_sheets.id"), index=True)
    kind: Mapped[SheetCommentKind] = mapped_column(
        Enum(SheetCommentKind, name="sheet_comment_kind", values_callable=enum_values)
    )
    body: Mapped[str] = mapped_column(Text)
    author_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)

    sheet: Mapped[KpiSheet] = relationship()

