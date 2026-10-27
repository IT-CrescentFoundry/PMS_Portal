"""Monthly KPI data import and quarterly result schemas (Stage K)."""
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import KpiSheetStatus, ScoreOverrideStatus, ScoreResultStatus
from app.schemas.employee import EmployeeRef
from app.schemas.jd import UserRef
from app.schemas.kpi import AssignmentBrief, IssueRead, QuarterRead
from app.schemas.organization import DepartmentRef, PlantRef


class ContractFieldRead(BaseModel):
    key: str
    label: str
    required: bool
    description: str


class ImportLineRead(BaseModel):
    row: int
    employee_code: str
    employee_name: str
    assignment: str
    kpi_code: str
    kpi_name: str
    actual: str | None
    inputs: dict[str, Any] | None
    action: Literal["new", "replace", "unchanged"]
    previous_actual: str | None
    note: str | None


class DuplicateImport(BaseModel):
    id: int
    file_name: str
    created_at: datetime


class ImportPreviewRead(BaseModel):
    quarter: QuarterRead
    period: str
    file_name: str
    file_format: str
    columns: list[str]
    contract: list[ContractFieldRead]
    mapping: dict[str, str | None]
    row_count: int
    counts: dict[str, int]
    issues: list[IssueRead]
    warnings: list[str]
    lines: list[ImportLineRead]
    lines_truncated: bool
    duplicate_import: DuplicateImport | None
    ready: bool


class ImportConfirmed(BaseModel):
    import_id: int
    created: int
    replaced: int
    unchanged: int
    rows: int


class ImportRead(BaseModel):
    id: int
    period: str
    file_name: str
    file_format: str
    file_size: int
    row_count: int
    rows_created: int
    rows_replaced: int
    rows_unchanged: int
    created_by: str | None
    created_at: datetime


class MonthlyValueRead(BaseModel):
    kpi_id: int
    kpi_code: str
    kpi_name: str
    period: str
    actual: str | None
    inputs: dict[str, Any] | None
    import_id: int | None
    file_name: str | None
    source_row: int | None


class CalculateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quarter_id: int
    sheet_ids: list[int] | None = Field(default=None, max_length=1000)


class CalculateResult(BaseModel):
    calculated: int
    unchanged: int
    published: int
    complete: int


class ResultBrief(BaseModel):
    status: ScoreResultStatus
    # 1 = the quarter's own result; 2+ = a correction of the published quarter.
    version_no: int = 1
    is_complete: bool
    stale: bool
    calculated_score: str | None
    final_score: str | None
    override_score: str | None
    published_score: str | None
    calculated_at: datetime | None
    reviewed_at: datetime | None
    published_at: datetime | None
    pending_override_id: int | None


class ResultSheet(BaseModel):
    id: int
    status: KpiSheetStatus


class ResultRow(BaseModel):
    assignment: AssignmentBrief
    sheet: ResultSheet
    result: ResultBrief | None


class ResultList(BaseModel):
    quarter: QuarterRead
    rows: list[ResultRow]


class OverrideRead(BaseModel):
    id: int
    status: ScoreOverrideStatus
    sheet_id: int
    employee: EmployeeRef
    plant: PlantRef
    department: DepartmentRef
    quarter_name: str
    original_score: str | None
    proposed_score: str
    reason: str
    requested_by: UserRef | None
    requested_at: datetime
    hr_approved_by: UserRef | None
    hr_approved_at: datetime | None
    plant_approved_by: UserRef | None
    plant_approved_at: datetime | None
    rejected_by: UserRef | None
    rejected_at: datetime | None
    rejection_reason: str | None
    applied_at: datetime | None
    voided_at: datetime | None


class ResultVersion(BaseModel):
    """One version of a sheet's result (Stage M): every version stays readable."""

    version_no: int
    status: ScoreResultStatus
    final_score: str | None
    override_score: str | None
    published_score: str | None
    calculated_at: datetime | None
    published_at: datetime | None
    correction_id: int | None


class ResultActions(BaseModel):
    can_calculate: bool
    can_review: bool
    can_publish: bool
    can_request_override: bool


class ResultRead(BaseModel):
    sheet: ResultSheet
    quarter: QuarterRead
    assignment: AssignmentBrief
    result: ResultBrief | None
    months: list[str]
    items: list[dict[str, Any]]  # per-KPI explanation (see kpi_results._item)
    calculated_by: UserRef | None
    reviewed_by: UserRef | None
    published_by: UserRef | None
    pending_override: OverrideRead | None
    applied_override: OverrideRead | None
    actions: ResultActions
    # Every version of the result, oldest first (empty for the employee, who
    # sees the published version only).
    versions: list[ResultVersion] = []


Score = Annotated[Decimal, Field(ge=0, le=5, max_digits=3, decimal_places=2)]


class OverrideCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    proposed_score: Score
    reason: str = Field(min_length=10, max_length=1000)
