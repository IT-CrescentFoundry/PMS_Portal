"""Annual results, annual score deviations and quarter corrections (Stage M).

Scores travel as text ("3.95") so they stay exact.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import (
    AnnualDeviationStatus,
    AnnualResultStatus,
    CorrectionItemKind,
    CorrectionStatus,
    CycleStatus,
    QuarterStatus,
    ScoreResultStatus,
)
from app.schemas.employee import EmployeeRef
from app.schemas.jd import UserRef
from app.schemas.kpi import QuarterRead
from app.schemas.organization import DepartmentRef, PlantRef
from app.schemas.quarterly import WeightIn

Score = Annotated[Decimal, Field(ge=0, le=5, max_digits=3, decimal_places=2)]


class AuditEntry(BaseModel):
    id: int
    action: str
    summary: str
    reason: str | None
    actor: str
    occurred_at: datetime


# --- annual results ----------------------------------------------------------------------------


class AnnualRuleRead(BaseModel):
    code: str
    version: int
    quarter_weights: dict[str, str]
    decimals: int
    rounding: str
    description: str
    sha256: str


class AnnualCycleRead(BaseModel):
    id: int
    code: str
    name: str
    start_date: date
    end_date: date
    status: CycleStatus
    quarters: list[QuarterRead]
    rule: AnnualRuleRead
    can_set_rule: bool


class RuleWeight(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quarter_number: int = Field(ge=1, le=4)
    weight: Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)]


class RuleWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    weights: list[RuleWeight] = Field(min_length=1, max_length=4)


class AnnualQuarterRead(BaseModel):
    quarter_id: int
    quarter_number: int
    name: str
    status: QuarterStatus
    weight: str
    required: bool
    published: bool
    score: str | None
    version_no: int | None
    employee_result_id: int | None
    correction_ids: list[int]


class AnnualVersionBrief(BaseModel):
    id: int
    version_no: int
    status: AnnualResultStatus
    calculated_exact: str
    calculated_score: str
    adjusted_score: str | None
    final_score: str
    recalculation_required: bool
    recalculation_reason: str | None
    calculated_by: UserRef | None
    calculated_at: datetime | None
    published_by: UserRef | None
    published_at: datetime | None
    approval_note: str | None
    previous_id: int | None
    superseded_at: datetime | None
    rule_version: int | None
    rule_sha256: str


class AnnualVersionRead(AnnualVersionBrief):
    sources: list[dict[str, Any]]
    rule: dict[str, Any]


class DeviationBrief(BaseModel):
    id: int
    status: AnnualDeviationStatus
    original_score: str
    proposed_score: str
    requested_by: UserRef | None
    requested_at: datetime


class AnnualActions(BaseModel):
    can_calculate: bool
    can_request_deviation: bool
    can_decide_deviation: bool
    can_finalize: bool


class AnnualRow(BaseModel):
    employee: EmployeeRef
    cycle_id: int
    home_plant: PlantRef | None
    home_department: DepartmentRef | None
    quarters: list[AnnualQuarterRead]
    complete: bool
    issues: list[str]
    draft: AnnualVersionBrief | None
    published: AnnualVersionBrief | None
    pending_deviation: DeviationBrief | None
    actions: AnnualActions


class CalculateAnnual(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_ids: list[int] | None = Field(default=None, max_length=500)


class AnnualCalculated(BaseModel):
    calculated: int
    unchanged: int
    incomplete: int


class FinalizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str | None = Field(default=None, max_length=1000)


class DeviationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    original_score: Score
    proposed_score: Score
    reason: str = Field(min_length=1, max_length=1000)


class DecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=1, max_length=1000)


class DeviationRead(BaseModel):
    id: int
    status: AnnualDeviationStatus
    annual_result_id: int
    version_no: int
    cycle_id: int
    cycle_name: str
    employee: EmployeeRef
    original_score: str
    proposed_score: str
    reason: str
    requested_by: UserRef | None
    requested_at: datetime
    decided_by: UserRef | None
    decided_at: datetime | None
    decision_reason: str | None
    voided_at: datetime | None
    can_decide: bool


class AnnualDetail(AnnualRow):
    versions: list[AnnualVersionRead]
    deviations: list[DeviationRead]
    finalize_blockers: list[str]
    history: list[AuditEntry]


class OwnAnnualQuarter(BaseModel):
    quarter_number: int
    name: str
    score: str


class OwnAnnualRead(BaseModel):
    cycle_id: int
    cycle_code: str
    cycle_name: str
    version_no: int
    final_score: str
    published_at: datetime | None
    quarters: list[OwnAnnualQuarter]
    notice: str | None


# --- corrections of published quarters ----------------------------------------------------


class ValueChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sheet_id: int
    kpi_definition_id: int
    period: str = Field(pattern=r"^\d{4}-\d{2}$")
    actual: str | None = Field(default=None, max_length=30)
    inputs: dict[str, str | int | float | bool | None] | None = None


class WeightChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: int
    weights: list[WeightIn] = Field(min_length=2, max_length=20)


class CorrectionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(default="", max_length=2000)
    values: list[ValueChangeIn] = Field(default_factory=list, max_length=200)
    weights: list[WeightChangeIn] = Field(default_factory=list, max_length=50)


class CorrectionTransition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    to: CorrectionStatus
    reason: str | None = Field(default=None, max_length=1000)


class WeightRead(BaseModel):
    assignment_id: int
    unit: str
    weight: str


class CorrectionItemRead(BaseModel):
    id: int | None
    kind: CorrectionItemKind
    employee: EmployeeRef | None
    unit: str | None
    sheet_id: int | None
    kpi_code: str | None
    kpi_name: str | None
    period: str | None
    had_value: bool
    before_actual: str | None
    after_actual: str | None
    before_inputs: dict[str, Any] | None
    after_inputs: dict[str, Any] | None
    before_weights: list[WeightRead]
    after_weights: list[WeightRead]


class ProjectedSheet(BaseModel):
    sheet_id: int
    employee: str
    unit: str
    before: str | None
    after: str | None
    complete: bool


class ProjectedEmployee(BaseModel):
    employee_id: int
    employee: str
    before: str | None
    after: str | None


class AffectedCohort(BaseModel):
    run_id: int
    label: str
    members: int


class AffectedRead(BaseModel):
    employees: list[EmployeeRef]
    dependents: list[EmployeeRef]
    cohorts: list[AffectedCohort]
    annual_results_flagged: list[int]


class CorrectionPreview(BaseModel):
    sheets: list[ProjectedSheet]
    employees: list[ProjectedEmployee]
    problems: list[str]
    affected: AffectedRead


class VersionSheet(BaseModel):
    sheet_id: int
    employee: EmployeeRef
    unit: str
    status: ScoreResultStatus | None
    final_score: str | None
    published_score: str | None


class VersionCohort(BaseModel):
    run_id: int
    label: str
    status: str


class CorrectionActions(BaseModel):
    can_decide: bool
    can_advance: bool
    can_return: bool
    can_publish: bool


class CorrectionSummary(BaseModel):
    id: int
    status: CorrectionStatus
    quarter: QuarterRead
    base_version: int
    version_no: int | None
    reason: str
    requested_by: UserRef | None
    requested_at: datetime
    items: int


class CorrectionRead(CorrectionSummary):
    decided_by: UserRef | None
    decided_at: datetime | None
    decision_reason: str | None
    published_by: UserRef | None
    published_at: datetime | None
    changes: list[CorrectionItemRead]
    preview: CorrectionPreview
    affected: AffectedRead | None
    sheets: list[VersionSheet]
    cohorts: list[VersionCohort]
    next_status: CorrectionStatus | None
    previous_status: CorrectionStatus | None
    blockers: list[str]
    actions: CorrectionActions
    history: list[AuditEntry]


class QuarterVersionRead(BaseModel):
    version_no: int
    current: bool
    correction_id: int | None
    published_by: UserRef | None
    published_at: datetime | None
