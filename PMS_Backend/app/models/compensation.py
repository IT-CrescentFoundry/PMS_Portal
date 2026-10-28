"""Compensation cycles, salary baselines, budget scenarios and budget decisions (Stage N).

  * compensation_cycles          one annual compensation exercise: the PMS cycle
                                 whose approved annual results it uses, the date
                                 on which matrix versions are resolved, the
                                 currency and how compa-ratio affects increments
  * compensation_baselines(_rows) a restricted, immutable salary baseline per
                                 import: current and reference salary, optional
                                 grade and eligibility per employee. Never seeded
  * budget_scenarios(_lines)     one calculation of the proposed increments with
                                 the matrix versions it used; frozen once made.
                                 A revised scenario is a new row
  * budget_decisions             the company-approved budget amount, each
                                 revision a new row with the amount it replaces

Increment percentage, increment amount and the resulting salary are kept in
separate columns. Every employee has at most one line per scenario (one
identity, attributed to the primary unit of the annual result); excluded
employees keep a line with the reason. See docs/database-design.md (Stage N).
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
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.enums import (
    BudgetDecisionStatus,
    BudgetLineStatus,
    BudgetScenarioStatus,
    CompaRatioMethod,
    CompensationCycleStatus,
    enum_values,
)
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.cycle import PmsCycle
    from app.models.employee import Employee


class CompensationCycle(TimestampMixin, Base):
    __tablename__ = "compensation_cycles"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    pms_cycle_id: Mapped[int] = mapped_column(ForeignKey("pms_cycles.id"), index=True)
    currency: Mapped[str] = mapped_column(String(3))  # ISO 4217, e.g. INR
    # Matrix versions are resolved by applicability on this date.
    effective_date: Mapped[date] = mapped_column(Date)
    cr_method: Mapped[CompaRatioMethod] = mapped_column(
        Enum(CompaRatioMethod, name="compa_ratio_method", values_callable=enum_values)
    )
    # What the compa-ratio denominator is, e.g. "salary-range midpoint".
    reference_label: Mapped[str] = mapped_column(String(60))
    # PRIMARY: one cost per employee, attributed to the primary unit. A future
    # approved apportionment rule would split that one cost, never duplicate it.
    apportionment: Mapped[str] = mapped_column(String(20), default="PRIMARY",
                                               server_default="PRIMARY")
    status: Mapped[CompensationCycleStatus] = mapped_column(
        Enum(CompensationCycleStatus, name="compensation_cycle_status",
             values_callable=enum_values),
        default=CompensationCycleStatus.OPEN,
        server_default=CompensationCycleStatus.OPEN.value,
    )
    notes: Mapped[str | None] = mapped_column(String(1000))
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    finalized_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime)
    # Stage O. Explicit budget revisions: the CHRO reopens a finalized budget
    # (FINALIZED -> OPEN) with a reason; the latest reopening is kept here,
    # every one in the audit trail.
    revision_no: Mapped[int] = mapped_column(SmallInteger, default=0, server_default=text("0"))
    reopened_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    reopened_at: Mapped[datetime | None] = mapped_column(DateTime)
    reopen_reason: Mapped[str | None] = mapped_column(String(1000))
    # Stage O. How far departments may depart from the matrix recommendation
    # (HR Head): {"mode", "max_increase_points", "max_decrease_points",
    # "version", "set_by_user_id", "set_at"}. NULL: recommendation only.
    allocation_policy: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    pms_cycle: Mapped[PmsCycle] = relationship()


class CompensationBaseline(TimestampMixin, Base):
    """One imported salary baseline (immutable). The file itself is not kept."""

    __tablename__ = "compensation_baselines"
    __table_args__ = (
        UniqueConstraint("cycle_id", "version_no", name="uq_compensation_baselines_version"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_id: Mapped[int] = mapped_column(ForeignKey("compensation_cycles.id"))
    version_no: Mapped[int] = mapped_column(SmallInteger)
    file_name: Mapped[str] = mapped_column(String(255))
    file_sha256: Mapped[str] = mapped_column(String(64))
    file_size: Mapped[int] = mapped_column(Integer)
    file_format: Mapped[str] = mapped_column(String(10))
    row_count: Mapped[int] = mapped_column(Integer)
    imported_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)

    rows: Mapped[list[CompensationBaselineRow]] = relationship(
        back_populates="baseline", order_by="CompensationBaselineRow.source_row",
        cascade="all, delete-orphan")


class CompensationBaselineRow(Base):
    __tablename__ = "compensation_baseline_rows"
    __table_args__ = (
        UniqueConstraint("baseline_id", "employee_id", name="uq_compensation_baseline_rows_employee"),
        CheckConstraint("current_salary IS NULL OR current_salary > 0", name="current_positive"),
        CheckConstraint("reference_salary IS NULL OR reference_salary > 0",
                        name="reference_positive"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    baseline_id: Mapped[int] = mapped_column(ForeignKey("compensation_baselines.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    source_row: Mapped[int] = mapped_column(Integer)
    current_salary: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))  # annual
    reference_salary: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    grade: Mapped[str | None] = mapped_column(String(40))
    eligible: Mapped[bool] = mapped_column(default=True, server_default=text("1"))
    exclusion_reason: Mapped[str | None] = mapped_column(String(255))

    baseline: Mapped[CompensationBaseline] = relationship(back_populates="rows")
    employee: Mapped[Employee] = relationship()


class BudgetScenario(TimestampMixin, Base):
    __tablename__ = "budget_scenarios"
    __table_args__ = (
        UniqueConstraint("cycle_id", "scenario_no", name="uq_budget_scenarios_number"),
        UniqueConstraint("finalized_key", name="uq_budget_scenarios_one_finalized"),
        CheckConstraint(
            "decided_by_user_id IS NULL OR (decided_by_user_id <> calculated_by_user_id "
            "AND (submitted_by_user_id IS NULL OR decided_by_user_id <> submitted_by_user_id))",
            name="decider_not_preparer",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_id: Mapped[int] = mapped_column(ForeignKey("compensation_cycles.id"))
    scenario_no: Mapped[int] = mapped_column(SmallInteger)
    name: Mapped[str] = mapped_column(String(100))
    note: Mapped[str | None] = mapped_column(String(1000))
    baseline_id: Mapped[int] = mapped_column(ForeignKey("compensation_baselines.id"), index=True)
    status: Mapped[BudgetScenarioStatus] = mapped_column(
        Enum(BudgetScenarioStatus, name="budget_scenario_status", values_callable=enum_values),
        default=BudgetScenarioStatus.CALCULATED,
        server_default=BudgetScenarioStatus.CALCULATED.value,
    )
    # Copied from the cycle when calculated, so later configuration changes
    # never reinterpret the scenario.
    cr_method: Mapped[CompaRatioMethod] = mapped_column(
        Enum(CompaRatioMethod, name="compa_ratio_method", values_callable=enum_values)
    )
    effective_date: Mapped[date] = mapped_column(Date)
    currency: Mapped[str] = mapped_column(String(3))
    # Explicit matrix versions chosen for analysis ({type: version id}); such a
    # scenario is analysis only and can never be submitted.
    overrides: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    analysis_only: Mapped[bool] = mapped_column(default=False, server_default=text("0"))
    # The matrix versions the lines used: [{type, version_id, matrix code, version_no}].
    matrix_versions: Mapped[list[Any]] = mapped_column(JSON)
    # Counts, sums, breakdown by unit, reconciliation (see services/compensation.py).
    totals: Mapped[dict[str, Any]] = mapped_column(JSON)
    included_count: Mapped[int] = mapped_column(Integer)
    excluded_count: Mapped[int] = mapped_column(Integer)
    total_current_salary: Mapped[Decimal] = mapped_column(Numeric(16, 2))
    total_increment: Mapped[Decimal] = mapped_column(Numeric(16, 2))  # sum of rounded lines
    total_increment_exact: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    inputs_hash: Mapped[str] = mapped_column(String(64))
    calculated_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    calculated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP")
    )
    submitted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime)
    decided_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime)
    decision_reason: Mapped[str | None] = mapped_column(String(1000))
    # The budget decision the CHRO approved the scenario against.
    budget_decision_id: Mapped[int | None] = mapped_column(
        ForeignKey("budget_decisions.id"), index=True
    )
    finalized_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'FINALIZED' THEN cycle_id END", persisted=True)
    )

    cycle: Mapped[CompensationCycle] = relationship()
    lines: Mapped[list[BudgetScenarioLine]] = relationship(
        back_populates="scenario", order_by="BudgetScenarioLine.id",
        cascade="all, delete-orphan")


class BudgetScenarioLine(Base):
    """One employee in one scenario: included with the calculation and its
    explanation, or excluded with the reason."""

    __tablename__ = "budget_scenario_lines"
    __table_args__ = (
        UniqueConstraint("scenario_id", "employee_id", name="uq_budget_scenario_lines_employee"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    scenario_id: Mapped[int] = mapped_column(ForeignKey("budget_scenarios.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    status: Mapped[BudgetLineStatus] = mapped_column(
        Enum(BudgetLineStatus, name="budget_line_status", values_callable=enum_values)
    )
    exclusion_code: Mapped[str | None] = mapped_column(String(40))
    exclusion_reason: Mapped[str | None] = mapped_column(String(500))
    # Attribution (the annual result's home unit: the primary assignment).
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"), index=True)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"), index=True)
    annual_result_id: Mapped[int | None] = mapped_column(
        ForeignKey("annual_results.id"), index=True
    )
    annual_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    baseline_row_id: Mapped[int | None] = mapped_column(
        ForeignKey("compensation_baseline_rows.id"), index=True
    )
    current_salary: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    reference_salary: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    compa_ratio: Mapped[Decimal | None] = mapped_column(Numeric(8, 4))
    performance_rating: Mapped[int | None] = mapped_column(SmallInteger)
    base_increment_percent: Mapped[Decimal | None] = mapped_column(Numeric(9, 4))
    cr_multiplier: Mapped[Decimal | None] = mapped_column(Numeric(9, 4))
    increment_percent: Mapped[Decimal | None] = mapped_column(Numeric(7, 2))  # final, rounded
    increment_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))  # rounded
    increment_amount_exact: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))
    new_salary: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    kra_version_id: Mapped[int | None] = mapped_column(ForeignKey("matrix_versions.id"), index=True)
    increment_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("matrix_versions.id"), index=True
    )
    cr_version_id: Mapped[int | None] = mapped_column(ForeignKey("matrix_versions.id"), index=True)
    # Inputs, matched rules, outputs and rounding of every step.
    trace: Mapped[dict[str, Any]] = mapped_column(JSON)

    scenario: Mapped[BudgetScenario] = relationship(back_populates="lines")
    employee: Mapped[Employee] = relationship()


class BudgetDecision(Base):
    """The company-approved budget amount; each revision is a new row."""

    __tablename__ = "budget_decisions"
    __table_args__ = (
        UniqueConstraint("cycle_id", "version_no", name="uq_budget_decisions_version"),
        UniqueConstraint("current_key", name="uq_budget_decisions_one_current"),
        CheckConstraint("approved_amount >= 0", name="amount_not_negative"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_id: Mapped[int] = mapped_column(ForeignKey("compensation_cycles.id"))
    version_no: Mapped[int] = mapped_column(SmallInteger)
    status: Mapped[BudgetDecisionStatus] = mapped_column(
        Enum(BudgetDecisionStatus, name="budget_decision_status", values_callable=enum_values),
        default=BudgetDecisionStatus.CURRENT,
        server_default=BudgetDecisionStatus.CURRENT.value,
    )
    approved_amount: Mapped[Decimal] = mapped_column(Numeric(16, 2))
    previous_amount: Mapped[Decimal | None] = mapped_column(Numeric(16, 2))
    reason: Mapped[str] = mapped_column(String(1000))
    recorded_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP")
    )
    current_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'CURRENT' THEN cycle_id END", persisted=True)
    )
