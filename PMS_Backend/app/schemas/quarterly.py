"""Quarterly review, consolidation, normalization and publication schemas (Stage L).

Scores travel as text ("3.40") so they stay exact.
"""
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import (
    CohortLevel,
    KpiSheetStatus,
    NormalizationPlacement,
    NormalizationRunStatus,
    QuarterStatus,
    ScoreResultStatus,
    SheetCommentKind,
)
from app.schemas.employee import EmployeeRef
from app.schemas.jd import UserRef
from app.schemas.kpi import AssignmentBrief, QuarterRead, SheetItemRead
from app.schemas.organization import DepartmentRef, PlantRef

# --- quarter -------------------------------------------------------------------------------


class SheetProgress(BaseModel):
    locked: int
    calculated: int
    complete: int
    stale: int
    reviewed: int
    pending_overrides: int
    published: int


class EmployeeProgress(BaseModel):
    total: int
    ready: int
    multi_assignment: int
    weights_needed: int


class CohortProgress(BaseModel):
    total: int
    approved: int
    unresolved: int


class QuarterActions(BaseModel):
    can_advance: bool
    can_return: bool
    can_publish: bool


class QuarterOverview(BaseModel):
    quarter: QuarterRead
    next_status: QuarterStatus | None
    previous_status: QuarterStatus | None
    sheets: SheetProgress
    employees: EmployeeProgress
    cohorts: CohortProgress
    # Sheets that were never published, so are not scored this quarter.
    unscorable_sheets: int
    # What blocks the next step (company-wide; shown to those who take it).
    blockers: list[str]
    feedback_enabled: bool
    published_at: datetime | None
    published_by: UserRef | None
    actions: QuarterActions


class TransitionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    to: QuarterStatus
    reason: str | None = Field(default=None, max_length=1000)


# --- employee results ---------------------------------------------------------------------


class ComponentRead(BaseModel):
    assignment_id: int
    sheet_id: int
    plant: PlantRef
    department: DepartmentRef
    is_primary: bool
    result_status: ScoreResultStatus | None
    score: str | None
    score_source: str | None  # final | override
    weight: str | None
    contribution: str | None
    problems: list[str]
    can_open_sheet: bool


class NormalizationOutcome(BaseModel):
    run_id: int
    cohort_label: str
    run_status: NormalizationRunStatus
    rank: int | None
    group_key: str | None
    group_label: str | None
    placement: NormalizationPlacement | None
    placement_reason: str | None
    placed_by: UserRef | None
    normalized_rating: str | None
    rating_explanation: dict[str, Any] | None


class EmployeeResultRead(BaseModel):
    employee: EmployeeRef
    quarter_id: int
    # LIVE: calculated now, before normalization. DRAFT: frozen for
    # normalization. PUBLISHED: final.
    status: str
    home_plant: PlantRef | None
    home_department: DepartmentRef | None
    weights_source: str
    calculated_score: str | None
    final_score: str | None
    ready: bool
    issues: list[str]
    components: list[ComponentRead]
    normalization: NormalizationOutcome | None
    can_set_weights: bool


class WeightIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignment_id: int
    weight: Annotated[Decimal, Field(gt=0, le=100, max_digits=5, decimal_places=2)]


class WeightsWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    weights: list[WeightIn] = Field(min_length=2, max_length=20)


# --- normalization ------------------------------------------------------------------------


class PolicyVersionRef(BaseModel):
    matrix_id: int
    code: str
    name: str
    version_id: int
    version_no: int


class GroupDistribution(BaseModel):
    key: str
    label: str
    target_percent: str
    target_count: int
    actual_count: int
    actual_percent: str | None


class RunActionsRead(BaseModel):
    can_place: bool
    can_approve: bool
    can_reopen: bool


class RunSummary(BaseModel):
    id: int
    status: NormalizationRunStatus
    cohort_label: str
    cohort_level: CohortLevel
    policy: PolicyVersionRef
    population: int
    eligible: int
    small_cohort: bool
    distribution: list[GroupDistribution]
    matches_targets: bool
    unresolved: int
    rating_errors: int
    exceptions: int
    approved_by: UserRef | None
    approved_at: datetime | None


class MemberRead(BaseModel):
    employee: EmployeeRef
    home_plant: PlantRef
    home_department: DepartmentRef
    final_score: str
    calculated_score: str
    rank: int | None
    group_key: str | None
    group_label: str | None
    placement: NormalizationPlacement | None
    options: list[str] | None
    placement_reason: str | None
    placed_by: UserRef | None
    normalized_rating: str | None
    rating_explanation: dict[str, Any] | None


class RunRead(RunSummary):
    quarter: QuarterRead
    settings: dict[str, Any] | None
    policy_problem: str | None
    exception_list: list[dict[str, Any]]
    members: list[MemberRead]
    approval_note: str | None
    computed_at: datetime | None
    actions: RunActionsRead


class PlacementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: int
    group: str = Field(min_length=1, max_length=20)
    reason: str = Field(min_length=10, max_length=500)


class RunApprove(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str | None = Field(default=None, max_length=1000)


# --- comments and the employee's own sheets ------------------------------------------------


class CommentRead(BaseModel):
    id: int
    kind: SheetCommentKind
    body: str
    author: UserRef | None
    created_at: datetime


class CommentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: SheetCommentKind
    body: str = Field(min_length=1, max_length=2000)


class CommentList(BaseModel):
    comments: list[CommentRead]
    can_comment: bool


class OwnOutcome(BaseModel):
    final_score: str
    group_label: str | None
    normalized_rating: str | None
    published_at: datetime | None


class OwnSheet(BaseModel):
    id: int
    status: KpiSheetStatus
    quarter: QuarterRead
    assignment: AssignmentBrief
    items: list[SheetItemRead]
    total: float
    published_score: str | None
    published_at: datetime | None
    # The employee's consolidated quarterly outcome, once published.
    outcome: OwnOutcome | None
    feedback: list[CommentRead]
