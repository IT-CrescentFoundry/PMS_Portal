"""Budget distribution and department allocation proposals (Stage O).

Amounts and percentages travel as text so they stay exact. Amounts a reader
may not see (employee lines, small units for budget-only readers) are null.
"""
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import (
    AllocationStatus,
    CompensationCycleStatus,
    DiscretionMode,
    DistributionMethod,
    DistributionStatus,
)
from app.schemas.annual import AuditEntry
from app.schemas.employee import EmployeeRef
from app.schemas.jd import UserRef
from app.schemas.organization import DepartmentRef, PlantRef


class AllocationCycle(BaseModel):
    id: int
    code: str
    name: str
    status: CompensationCycleStatus
    currency: str
    effective_date: date
    revision_no: int
    budget_finalized: bool
    distribution_version: int | None


class PolicyRead(BaseModel):
    mode: DiscretionMode
    max_increase_points: str | None
    max_decrease_points: str | None
    version: int
    configured: bool


class PolicyWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: DiscretionMode
    max_increase_points: Decimal | None = None
    max_decrease_points: Decimal | None = None


# --- distribution ------------------------------------------------------------------------------

class DistributionUnitWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    department_id: int
    method: DistributionMethod
    value: Decimal


class DistributionPlantWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plant_id: int
    method: DistributionMethod
    value: Decimal
    units: list[DistributionUnitWrite] = Field(default_factory=list, max_length=200)


class DistributionWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    allow_mixed_methods: bool = False
    note: str | None = Field(default=None, max_length=1000)
    plants: list[DistributionPlantWrite] = Field(default_factory=list, max_length=100)


class DistributionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision_reason: str | None = Field(default=None, max_length=1000)


class DistributionUnitRead(BaseModel):
    id: int
    department: DepartmentRef
    method: DistributionMethod
    percent: str | None
    amount: str
    amount_exact: str


class DistributionPlantRead(BaseModel):
    id: int
    plant: PlantRef
    method: DistributionMethod
    percent: str | None
    amount: str
    amount_exact: str
    units_total: str
    unallocated: str
    rounding_residual: str
    units: list[DistributionUnitRead]


class DistributionTotals(BaseModel):
    budget: str | None = None
    plants_total: str | None = None
    units_total: str | None = None
    unallocated: str | None = None
    plants_unallocated: str | None = None
    rounding_residual: str | None = None


class DistributionSummary(BaseModel):
    id: int
    version_no: int
    status: DistributionStatus
    budget_amount: str
    totals: DistributionTotals
    revision_reason: str | None
    created_by: UserRef | None
    created_at: datetime
    published_by: UserRef | None
    published_at: datetime | None


class DistributionActions(BaseModel):
    can_edit: bool
    can_publish: bool
    can_start_revision: bool


class DistributionRead(DistributionSummary):
    cycle: AllocationCycle
    allow_mixed_methods: bool
    note: str | None
    scenario_id: int
    budget_decision_id: int
    plants: list[DistributionPlantRead]
    # Why a published version no longer matches the finalized budget.
    stale_reasons: list[str]
    versions: list[DistributionSummary]
    actions: DistributionActions
    history: list[AuditEntry]


# --- proposals ---------------------------------------------------------------------------------

class ProposalBrief(BaseModel):
    id: int
    version_no: int
    status: AllocationStatus
    proposed_total: str | None
    changed_count: int
    stale_reasons: list[str]
    submitted_at: datetime | None
    decided_at: datetime | None


class ExcludedRead(BaseModel):
    employee: EmployeeRef
    plant: PlantRef | None
    department: DepartmentRef | None
    code: str | None
    reason: str | None


class UnitRow(BaseModel):
    plant: PlantRef
    department: DepartmentRef
    distributed: str | None
    included: int
    excluded: int
    excluded_by_reason: dict[str, int]
    recommended: str | None
    proposed: str | None
    approved: str | None
    difference: str | None
    # Amounts hidden: fewer than 3 included employees for a budget-only reader.
    suppressed: bool
    latest: ProposalBrief | None
    approved_proposal: ProposalBrief | None
    can_start: bool


class OverviewSummary(BaseModel):
    budget: str | None
    distributed_to_plants: str | None
    distributed_to_units: str | None
    unallocated_company: str | None
    unallocated_plants: str | None
    rounding_residual: str | None
    recommended_total: str | None
    proposed_total: str | None
    approved_total: str | None
    by_status: dict[str, int]
    stale: int
    excluded_by_reason: dict[str, int]
    reconciliation: dict[str, str | bool | None]


class OverviewActions(BaseModel):
    can_distribute: bool
    can_set_policy: bool
    can_read_employees: bool
    # The open draft distribution, for the budget owner.
    draft_distribution_id: int | None = None


class OverviewRead(BaseModel):
    cycle: AllocationCycle
    policy: PolicyRead
    distribution: DistributionSummary | None
    # Company figures (null for readers limited to some units).
    summary: OverviewSummary | None
    units: list[UnitRow]
    excluded: list[ExcludedRead]
    actions: OverviewActions


class ProposalStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plant_id: int
    department_id: int


class ProposalLineWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: int
    proposed_percent: Decimal
    reason: str | None = Field(default=None, max_length=500)


class ProposalWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lines: list[ProposalLineWrite] = Field(default_factory=list, max_length=5000)
    note: str | None = Field(default=None, max_length=1000)


class ForwardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str | None = Field(default=None, max_length=1000)


class ProposalLineRead(BaseModel):
    employee: EmployeeRef
    own: bool  # the reader's own increment
    annual_result_id: int | None
    current_salary: str
    recommended_percent: str
    recommended_amount: str
    proposed_percent: str
    proposed_amount: str
    new_salary: str
    difference: str  # proposed - recommended amount
    reason: str | None


class ProposalActions(BaseModel):
    can_edit: bool
    can_refresh: bool
    can_submit: bool
    can_forward: bool
    can_return: bool
    can_approve: bool
    can_reject: bool
    can_start_next: bool


class ProposalRead(BaseModel):
    id: int
    cycle: AllocationCycle
    plant: PlantRef
    department: DepartmentRef
    version_no: int
    status: AllocationStatus
    scenario_id: int
    budget_decision_id: int
    distribution_id: int
    distribution_version: int | None
    unit_budget: str
    # The unit's amount in the published distribution now (may differ: stale).
    current_unit_budget: str | None
    included_count: int
    changed_count: int
    recommended_total: str | None
    proposed_total: str | None
    remaining_budget: str | None  # unit budget - proposed total
    suppressed: bool
    policy: PolicyRead
    note: str | None
    prepared_by: UserRef | None
    created_at: datetime
    submitted_by: UserRef | None
    submitted_at: datetime | None
    admin_reviewed_by: UserRef | None
    admin_reviewed_at: datetime | None
    admin_note: str | None
    decided_by: UserRef | None
    decided_at: datetime | None
    decision_reason: str | None
    stale_reasons: list[str]
    # Null for readers without employee-level access to the unit.
    lines: list[ProposalLineRead] | None
    excluded: list[ExcludedRead] | None
    versions: list[ProposalBrief]
    actions: ProposalActions
    history: list[AuditEntry]


class ReportLine(BaseModel):
    plant: PlantRef
    department: DepartmentRef
    proposal_id: int
    version_no: int
    status: AllocationStatus
    stale: bool
    employee: EmployeeRef
    current_salary: str
    recommended_percent: str
    recommended_amount: str
    proposed_percent: str
    proposed_amount: str
    difference: str
    reason: str | None
