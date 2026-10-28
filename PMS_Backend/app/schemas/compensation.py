"""Compensation cycles, salary baselines, budget scenarios and decisions (Stage N).

Amounts and percentages travel as text so they stay exact.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import (
    BudgetDecisionStatus,
    BudgetLineStatus,
    BudgetScenarioStatus,
    CompaRatioMethod,
    CompensationCycleStatus,
)
from app.schemas.annual import AuditEntry
from app.schemas.employee import EmployeeRef
from app.schemas.jd import UserRef
from app.schemas.kpi import IssueRead
from app.schemas.organization import DepartmentRef, PlantRef

Amount = Annotated[Decimal, Field(ge=0, max_digits=16, decimal_places=2)]


class CycleWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1, max_length=100)
    pms_cycle_id: int
    currency: str = Field(min_length=3, max_length=3)
    effective_date: date
    cr_method: CompaRatioMethod
    reference_label: str = Field(min_length=1, max_length=60)
    notes: str | None = Field(default=None, max_length=1000)


class PmsCycleRef(BaseModel):
    id: int
    code: str
    name: str


class MatrixVersionRef(BaseModel):
    version_id: int
    matrix_id: int
    code: str
    name: str
    version_no: int
    status: str


class PolicyTypeRead(BaseModel):
    type: str
    label: str
    status: str  # APPROVED | AWAITING_CONFIGURATION
    versions: list[MatrixVersionRef]


class CycleSummary(BaseModel):
    id: int
    code: str
    name: str
    status: CompensationCycleStatus
    pms_cycle: PmsCycleRef
    currency: str
    effective_date: date
    cr_method: CompaRatioMethod
    reference_label: str
    notes: str | None
    finalized_at: datetime | None
    finalized_by: UserRef | None


class BaselineSummary(BaseModel):
    id: int
    version_no: int
    file_name: str
    row_count: int
    imported_by: UserRef | None
    created_at: datetime


class DecisionRead(BaseModel):
    id: int
    version_no: int
    status: BudgetDecisionStatus
    approved_amount: str
    previous_amount: str | None
    reason: str
    recorded_by: UserRef | None
    recorded_at: datetime


class DecisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount: Amount
    reason: str = Field(min_length=1, max_length=1000)


class VarianceRead(BaseModel):
    decision_id: int
    decision_version: int
    approved_budget: str
    requirement: str
    difference: str
    difference_percent: str | None
    state: str  # UNDER_BUDGET | OVER_BUDGET | ON_BUDGET
    unallocated_balance: str
    overspend: str


class ScenarioSummary(BaseModel):
    id: int
    scenario_no: int
    name: str
    status: BudgetScenarioStatus
    analysis_only: bool
    baseline_version_no: int
    included_count: int
    excluded_count: int
    # None for readers without company-wide budget access.
    total_increment: str | None
    calculated_by: UserRef | None
    calculated_at: datetime
    submitted_by: UserRef | None
    submitted_at: datetime | None
    decided_by: UserRef | None
    decided_at: datetime | None
    decision_reason: str | None
    variance: VarianceRead | None


class CycleActions(BaseModel):
    can_manage: bool
    can_record_budget: bool
    can_approve: bool
    can_read_employees: bool


class CycleRead(CycleSummary):
    policy: list[PolicyTypeRead]
    baselines: list[BaselineSummary]
    decisions: list[DecisionRead]
    scenarios: list[ScenarioSummary]
    actions: CycleActions
    history: list[AuditEntry]


class ScenarioCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    baseline_id: int | None = None
    # {matrix type: version id}: an analysis-only scenario.
    overrides: dict[str, int] | None = None
    note: str | None = Field(default=None, max_length=1000)


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: int
    baseline_id: int | None = None
    overrides: dict[str, int] | None = None


class UnitTotal(BaseModel):
    plant: PlantRef | None
    department: DepartmentRef | None
    included: int
    excluded: int
    # None when the group is too small to show without revealing individuals.
    current_salary: str | None
    increment: str | None
    suppressed: bool


class TotalsRead(BaseModel):
    population: int
    included: int
    excluded: int
    excluded_by_reason: dict[str, int]
    excluded_salary: str | None
    total_current_salary: str | None
    total_increment: str | None
    total_increment_exact: str | None
    rounding_difference: str | None
    average_increment_percent: str | None
    negative_adjustments: int
    by_unit: list[UnitTotal]
    reconciliation: dict[str, Any]


class LineRead(BaseModel):
    employee: EmployeeRef
    status: BudgetLineStatus
    exclusion_code: str | None
    exclusion_reason: str | None
    plant: PlantRef | None
    department: DepartmentRef | None
    annual_score: str | None
    current_salary: str | None
    reference_salary: str | None
    compa_ratio: str | None
    performance_rating: int | None
    base_increment_percent: str | None
    cr_multiplier: str | None
    increment_percent: str | None
    increment_amount: str | None
    increment_amount_exact: str | None
    new_salary: str | None
    trace: dict[str, Any]


class ScenarioActions(BaseModel):
    can_submit: bool
    can_approve: bool
    can_reject: bool


class ScenarioRead(ScenarioSummary):
    cycle: CycleSummary
    note: str | None
    cr_method: CompaRatioMethod
    effective_date: date
    currency: str
    overrides: dict[str, int] | None
    matrix_versions: list[dict[str, Any]]
    totals: TotalsRead
    stale_reasons: list[str]
    # None for readers without employee-level compensation access.
    lines: list[LineRead] | None
    actions: ScenarioActions
    history: list[AuditEntry]


class BaselineLineRead(BaseModel):
    row: int
    employee: EmployeeRef
    current_salary: str | None
    reference_salary: str | None
    grade: str | None
    eligible: bool
    exclusion_reason: str | None


class BaselinePreview(BaseModel):
    file_name: str
    file_format: str
    rows: int
    eligible: int
    not_eligible: int
    issues: list[IssueRead]
    warnings: list[str]
    lines: list[BaselineLineRead]
    lines_truncated: bool
    ready: bool


class BaselineRows(BaselineSummary):
    rows: list[BaselineLineRead]
