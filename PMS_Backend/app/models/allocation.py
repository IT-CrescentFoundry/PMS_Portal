"""Budget distribution and department allocation proposals (Stage O).

  * budget_distributions(_lines)  versions of how the finalized company budget
                                  is split to plants and then to plant-department
                                  units (percentage of the parent, rounded down
                                  to the cent, or a fixed amount)
  * allocation_proposals(_lines)  a department's proposed increments for one
                                  plant-department unit, versioned through
                                  Admin review and CHRO approval

A proposal line keeps the matrix-derived recommendation (from the finalized
scenario line) beside the proposed value; neither the scenario, the matrices
nor the annual results are ever changed. See docs/database-design.md
(Stage O).
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Computed,
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
    AllocationStatus,
    DistributionLevel,
    DistributionMethod,
    DistributionStatus,
    enum_values,
)
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.compensation import CompensationCycle
    from app.models.employee import Employee


class BudgetDistribution(TimestampMixin, Base):
    __tablename__ = "budget_distributions"
    __table_args__ = (
        UniqueConstraint("cycle_id", "version_no", name="uq_budget_distributions_version"),
        UniqueConstraint("published_key", name="uq_budget_distributions_one_published"),
        UniqueConstraint("draft_key", name="uq_budget_distributions_one_draft"),
        CheckConstraint("budget_amount >= 0", name="budget_not_negative"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_id: Mapped[int] = mapped_column(ForeignKey("compensation_cycles.id"))
    version_no: Mapped[int] = mapped_column(SmallInteger)
    status: Mapped[DistributionStatus] = mapped_column(
        Enum(DistributionStatus, name="distribution_status", values_callable=enum_values),
        default=DistributionStatus.DRAFT,
        server_default=DistributionStatus.DRAFT.value,
    )
    # The finalized scenario and the budget decision it was approved against;
    # a draft follows the current ones, a published version keeps them.
    scenario_id: Mapped[int] = mapped_column(ForeignKey("budget_scenarios.id"), index=True)
    budget_decision_id: Mapped[int] = mapped_column(ForeignKey("budget_decisions.id"), index=True)
    budget_amount: Mapped[Decimal] = mapped_column(Numeric(16, 2))
    allow_mixed_methods: Mapped[bool] = mapped_column(Boolean, default=False,
                                                      server_default=text("0"))
    note: Mapped[str | None] = mapped_column(String(1000))
    # Required from version 2: why the published distribution changes.
    revision_reason: Mapped[str | None] = mapped_column(String(1000))
    # Company and plant sums, unallocated balances and rounding residuals.
    totals: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    published_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime)
    published_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'PUBLISHED' THEN cycle_id END", persisted=True)
    )
    draft_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'DRAFT' THEN cycle_id END", persisted=True)
    )

    cycle: Mapped[CompensationCycle] = relationship()
    lines: Mapped[list[BudgetDistributionLine]] = relationship(
        back_populates="distribution", order_by="BudgetDistributionLine.id",
        cascade="all, delete-orphan", foreign_keys="BudgetDistributionLine.distribution_id")


class BudgetDistributionLine(Base):
    """A plant's share of the company budget, or a unit's share of its plant."""

    __tablename__ = "budget_distribution_lines"
    __table_args__ = (
        # A plant, and a plant-department unit, at most once per version.
        UniqueConstraint("distribution_id", "plant_id", "unit_key",
                         name="uq_budget_distribution_lines_unit"),
        CheckConstraint("amount >= 0", name="amount_not_negative"),
        CheckConstraint(
            "(method = 'PERCENT' AND percent IS NOT NULL AND percent > 0 AND percent <= 100) "
            "OR (method = 'AMOUNT' AND percent IS NULL)", name="method_value"),
        CheckConstraint(
            "(level = 'PLANT' AND department_id IS NULL AND parent_id IS NULL) "
            "OR (level = 'UNIT' AND department_id IS NOT NULL AND parent_id IS NOT NULL)",
            name="level_shape"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    distribution_id: Mapped[int] = mapped_column(ForeignKey("budget_distributions.id"))
    level: Mapped[DistributionLevel] = mapped_column(
        Enum(DistributionLevel, name="distribution_level", values_callable=enum_values)
    )
    plant_id: Mapped[int] = mapped_column(ForeignKey("plants.id"), index=True)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"), index=True)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("budget_distribution_lines.id"), index=True
    )
    method: Mapped[DistributionMethod] = mapped_column(
        Enum(DistributionMethod, name="distribution_method", values_callable=enum_values)
    )
    percent: Mapped[Decimal | None] = mapped_column(Numeric(9, 4))
    amount: Mapped[Decimal] = mapped_column(Numeric(16, 2))         # the allocation
    amount_exact: Mapped[Decimal] = mapped_column(Numeric(20, 6))   # before rounding down
    unit_key: Mapped[int] = mapped_column(
        Computed("COALESCE(department_id, 0)", persisted=True)
    )

    distribution: Mapped[BudgetDistribution] = relationship(
        back_populates="lines", foreign_keys=[distribution_id])


class AllocationProposal(TimestampMixin, Base):
    """One version of a department's proposed increments for one unit."""

    __tablename__ = "allocation_proposals"
    __table_args__ = (
        UniqueConstraint("cycle_id", "plant_id", "department_id", "version_no",
                         name="uq_allocation_proposals_version"),
        UniqueConstraint("open_key", name="uq_allocation_proposals_one_open"),
        UniqueConstraint("approved_key", name="uq_allocation_proposals_one_approved"),
        CheckConstraint("unit_budget >= 0", name="unit_budget_not_negative"),
        CheckConstraint(
            "admin_reviewed_by_user_id IS NULL OR submitted_by_user_id IS NULL "
            "OR admin_reviewed_by_user_id <> submitted_by_user_id",
            name="reviewer_not_submitter"),
        CheckConstraint(
            "decided_by_user_id IS NULL OR ("
            "(submitted_by_user_id IS NULL OR decided_by_user_id <> submitted_by_user_id) AND "
            "(admin_reviewed_by_user_id IS NULL "
            "OR decided_by_user_id <> admin_reviewed_by_user_id))",
            name="decider_not_submitter_or_reviewer"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    cycle_id: Mapped[int] = mapped_column(ForeignKey("compensation_cycles.id"))
    plant_id: Mapped[int] = mapped_column(ForeignKey("plants.id"), index=True)
    department_id: Mapped[int] = mapped_column(ForeignKey("departments.id"), index=True)
    version_no: Mapped[int] = mapped_column(SmallInteger)
    status: Mapped[AllocationStatus] = mapped_column(
        Enum(AllocationStatus, name="allocation_status", values_callable=enum_values),
        default=AllocationStatus.DRAFT,
        server_default=AllocationStatus.DRAFT.value,
    )
    previous_id: Mapped[int | None] = mapped_column(
        ForeignKey("allocation_proposals.id"), index=True
    )
    # Sources: the finalized scenario (recommendations), the budget decision
    # it was approved against, the published distribution and the unit's line.
    scenario_id: Mapped[int] = mapped_column(ForeignKey("budget_scenarios.id"), index=True)
    budget_decision_id: Mapped[int] = mapped_column(ForeignKey("budget_decisions.id"), index=True)
    distribution_id: Mapped[int] = mapped_column(
        ForeignKey("budget_distributions.id"), index=True
    )
    distribution_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("budget_distribution_lines.id"), index=True
    )
    unit_budget: Mapped[Decimal] = mapped_column(Numeric(16, 2))
    # The discretion policy the lines were checked against (copied).
    policy: Mapped[dict[str, Any]] = mapped_column(JSON)
    included_count: Mapped[int] = mapped_column(Integer)
    recommended_total: Mapped[Decimal] = mapped_column(Numeric(16, 2))
    proposed_total: Mapped[Decimal] = mapped_column(Numeric(16, 2))
    changed_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    note: Mapped[str | None] = mapped_column(String(1000))
    prepared_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    submitted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime)
    admin_reviewed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    admin_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    admin_note: Mapped[str | None] = mapped_column(String(1000))
    # Approval, rejection or return (by the Admin or the CHRO), with the reason.
    decided_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime)
    decision_reason: Mapped[str | None] = mapped_column(String(1000))
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime)
    open_key: Mapped[str | None] = mapped_column(
        String(40),
        Computed("CASE WHEN status IN ('DRAFT', 'ADMIN_REVIEW', 'CHRO_REVIEW') THEN "
                 "CONCAT(cycle_id, '-', plant_id, '-', department_id) END", persisted=True),
    )
    approved_key: Mapped[str | None] = mapped_column(
        String(40),
        Computed("CASE WHEN status = 'APPROVED' THEN "
                 "CONCAT(cycle_id, '-', plant_id, '-', department_id) END", persisted=True),
    )

    cycle: Mapped[CompensationCycle] = relationship()
    lines: Mapped[list[AllocationProposalLine]] = relationship(
        back_populates="proposal", order_by="AllocationProposalLine.id",
        cascade="all, delete-orphan")


class AllocationProposalLine(Base):
    """One included employee: the recommendation and the proposal."""

    __tablename__ = "allocation_proposal_lines"
    __table_args__ = (
        UniqueConstraint("proposal_id", "employee_id",
                         name="uq_allocation_proposal_lines_employee"),
        CheckConstraint("proposed_amount >= 0 OR proposed_amount = recommended_amount",
                        name="proposed_not_negative"),
        CheckConstraint("proposed_percent = recommended_percent OR reason IS NOT NULL",
                        name="departure_has_reason"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    proposal_id: Mapped[int] = mapped_column(ForeignKey("allocation_proposals.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    scenario_line_id: Mapped[int] = mapped_column(
        ForeignKey("budget_scenario_lines.id"), index=True
    )
    annual_result_id: Mapped[int | None] = mapped_column(
        ForeignKey("annual_results.id"), index=True
    )
    current_salary: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    recommended_percent: Mapped[Decimal] = mapped_column(Numeric(7, 2))
    recommended_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    proposed_percent: Mapped[Decimal] = mapped_column(Numeric(7, 2))
    proposed_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    proposed_amount_exact: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    new_salary: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    reason: Mapped[str | None] = mapped_column(String(500))

    proposal: Mapped[AllocationProposal] = relationship(back_populates="lines")
    employee: Mapped[Employee] = relationship()
