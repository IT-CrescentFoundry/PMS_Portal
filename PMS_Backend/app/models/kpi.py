"""KPI library, scoring policies, quarterly KPI sheets and deviations.

KRA and KPI are the same concept. A KPI's MEANING lives once in the library
(kpi_definitions); per-employee, per-quarter values (weightage, target,
scoring policy) live on sheet items. A sheet belongs to one employee
ASSIGNMENT (plant-department unit) and one quarter.
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
    ForeignKeyConstraint,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.enums import DeviationStatus, KpiDirection, KpiSheetStatus, enum_values
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.cycle import PmsCycleQuarter
    from app.models.employee import EmployeeAssignment
    from app.models.jd import JobDescription
    from app.models.organization import Department, Plant


def _direction_enum() -> Enum:
    return Enum(KpiDirection, name="kpi_direction", values_callable=enum_values)


class KpiScoringPolicy(TimestampMixin, Base):
    """A reusable achievement matrix (workbook 'PMS Prerequisites', Sheet1).

    HIGHER_IS_BETTER: first band with achievement % > threshold, scanning the
    highest threshold first; LOWER_IS_BETTER: first band with achievement % <
    threshold, scanning the lowest first. Comparisons are strict, as in the
    workbook formulas. No band matched -> fallback_score.
    ZERO_TOLERANCE: met_score if the actual is zero, else breached_score.
    """

    __tablename__ = "kpi_scoring_policies"
    __table_args__ = (
        CheckConstraint("fallback_score BETWEEN 0 AND 5", name="fallback_range"),
        CheckConstraint("met_score IS NULL OR met_score BETWEEN 0 AND 5", name="met_range"),
        CheckConstraint(
            "breached_score IS NULL OR breached_score BETWEEN 0 AND 5", name="breached_range"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    description: Mapped[str | None] = mapped_column(String(500))
    direction: Mapped[KpiDirection] = mapped_column(_direction_enum())
    # [{"threshold": <achievement %>, "score": 0..5}, ...]
    bands: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    fallback_score: Mapped[int] = mapped_column(SmallInteger, default=0, server_default=text("0"))
    met_score: Mapped[int | None] = mapped_column(SmallInteger)
    breached_score: Mapped[int | None] = mapped_column(SmallInteger)
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))


class KpiDefinition(TimestampMixin, Base):
    """Shared KPI library entry: one row per meaning, reused everywhere."""

    __tablename__ = "kpi_definitions"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(150), unique=True)
    description: Mapped[str | None] = mapped_column(String(1000))
    unit: Mapped[str] = mapped_column(String(30))
    direction: Mapped[KpiDirection] = mapped_column(_direction_enum())
    default_scoring_policy_id: Mapped[int] = mapped_column(
        # Explicit name: the conventional one exceeds MySQL's 64-character limit.
        ForeignKey("kpi_scoring_policies.id", name="fk_kpi_definitions_default_policy"),
        index=True,
    )
    data_source: Mapped[str | None] = mapped_column(String(50))  # e.g. MIS, SAP (future), Manual
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)

    default_scoring_policy: Mapped[KpiScoringPolicy] = relationship()
    applicabilities: Mapped[list[KpiApplicability]] = relationship(
        back_populates="kpi_definition", cascade="all, delete-orphan"
    )


class KpiApplicability(Base):
    """Where a KPI may be used.

    (plant, department) one unit · (NULL, department) that department at
    every plant · (plant, NULL) every department at a plant · (NULL, NULL)
    company-wide. A unit pair must exist in plant_departments.
    """

    __tablename__ = "kpi_applicabilities"
    __table_args__ = (
        UniqueConstraint(
            "kpi_definition_id", "plant_key", "department_key", name="uq_kpi_applicabilities_scope"
        ),
        ForeignKeyConstraint(
            ["plant_id", "department_id"],
            ["plant_departments.plant_id", "plant_departments.department_id"],
            name="fk_kpi_applicabilities_plant_department",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kpi_definition_id: Mapped[int] = mapped_column(ForeignKey("kpi_definitions.id"))
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"), index=True)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"), index=True)
    plant_key: Mapped[int] = mapped_column(Computed("COALESCE(plant_id, 0)", persisted=True))
    department_key: Mapped[int] = mapped_column(
        Computed("COALESCE(department_id, 0)", persisted=True)
    )

    kpi_definition: Mapped[KpiDefinition] = relationship(back_populates="applicabilities")
    plant: Mapped[Plant | None] = relationship(foreign_keys=[plant_id])
    department: Mapped[Department | None] = relationship(foreign_keys=[department_id])


class KpiSheet(TimestampMixin, Base):
    """One employee assignment's KPI set for one quarter."""

    __tablename__ = "kpi_sheets"
    __table_args__ = (
        UniqueConstraint(
            "employee_assignment_id", "cycle_quarter_id", name="uq_kpi_sheets_assignment_quarter"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_assignment_id: Mapped[int] = mapped_column(ForeignKey("employee_assignments.id"))
    cycle_quarter_id: Mapped[int] = mapped_column(
        ForeignKey("pms_cycle_quarters.id"), index=True
    )
    job_description_id: Mapped[int | None] = mapped_column(
        ForeignKey("job_descriptions.id"), index=True
    )
    status: Mapped[KpiSheetStatus] = mapped_column(
        Enum(KpiSheetStatus, name="kpi_sheet_status", values_callable=enum_values),
        default=KpiSheetStatus.DRAFT,
        server_default=KpiSheetStatus.DRAFT.value,
    )
    notes: Mapped[str | None] = mapped_column(String(1000))
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    published_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime)

    assignment: Mapped[EmployeeAssignment] = relationship()
    quarter: Mapped[PmsCycleQuarter] = relationship()
    job_description: Mapped[JobDescription | None] = relationship()
    items: Mapped[list[KpiSheetItem]] = relationship(
        back_populates="sheet", cascade="all, delete-orphan", order_by="KpiSheetItem.sort_order"
    )


class KpiSheetItem(Base):
    __tablename__ = "kpi_sheet_items"
    __table_args__ = (
        UniqueConstraint("sheet_id", "kpi_definition_id", name="uq_kpi_sheet_items_kpi"),
        CheckConstraint("weightage > 0 AND weightage <= 100", name="weightage_range"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sheet_id: Mapped[int] = mapped_column(ForeignKey("kpi_sheets.id"))
    kpi_definition_id: Mapped[int] = mapped_column(ForeignKey("kpi_definitions.id"), index=True)
    sort_order: Mapped[int] = mapped_column(SmallInteger, default=0, server_default=text("0"))
    weightage: Mapped[Decimal] = mapped_column(Numeric(5, 2))  # percent, e.g. 20.00
    target_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))  # per quarter
    target_note: Mapped[str | None] = mapped_column(String(255))
    unit: Mapped[str] = mapped_column(String(30))
    scoring_policy_id: Mapped[int] = mapped_column(
        ForeignKey("kpi_scoring_policies.id"), index=True
    )
    # Frozen copy of the policy at publication, so later policy edits never
    # change a published or locked quarter.
    scoring_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    sheet: Mapped[KpiSheet] = relationship(back_populates="items")
    kpi_definition: Mapped[KpiDefinition] = relationship()
    scoring_policy: Mapped[KpiScoringPolicy] = relationship()


class KpiDeviation(Base):
    """A change to a LOCKED sheet; applied only after HR Head AND Plant Head approve."""

    __tablename__ = "kpi_deviations"
    __table_args__ = (
        UniqueConstraint("pending_key", name="uq_kpi_deviations_one_pending"),
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
    sheet_id: Mapped[int] = mapped_column(ForeignKey("kpi_sheets.id"), index=True)
    status: Mapped[DeviationStatus] = mapped_column(
        Enum(DeviationStatus, name="deviation_status", values_callable=enum_values),
        default=DeviationStatus.PENDING,
        server_default=DeviationStatus.PENDING.value,
    )
    reason: Mapped[str] = mapped_column(String(1000))
    original_items: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    proposed_items: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
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
    pending_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'PENDING' THEN sheet_id END", persisted=True)
    )

    sheet: Mapped[KpiSheet] = relationship()
