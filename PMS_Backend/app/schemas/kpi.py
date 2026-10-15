"""KPI library, scoring policy, sheet, upload and deviation schemas."""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import DeviationStatus, KpiDirection, KpiSheetStatus, QuarterStatus
from app.schemas.employee import DesignationRef, EmployeeRef
from app.schemas.jd import UserRef
from app.schemas.organization import DepartmentRef, ORMModel, PlantRef

Weightage = Annotated[Decimal, Field(gt=0, le=100, max_digits=5, decimal_places=2)]
Target = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]


# --- scoring policies ---------------------------------------------------------------------

class Band(BaseModel):
    model_config = ConfigDict(extra="forbid")
    threshold: float = Field(ge=0, le=10000, description="Achievement % boundary")
    score: int = Field(ge=0, le=5)


class PolicyWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    direction: KpiDirection
    bands: list[Band] = Field(default_factory=list, max_length=10)
    fallback_score: int = Field(default=0, ge=0, le=5)
    met_score: int | None = Field(default=None, ge=0, le=5)
    breached_score: int | None = Field(default=None, ge=0, le=5)
    is_active: bool = True


class PolicyRef(ORMModel):
    id: int
    code: str
    name: str


class PolicyRead(PolicyRef):
    description: str | None
    direction: KpiDirection
    bands: list[Band]
    fallback_score: int
    met_score: int | None
    breached_score: int | None
    is_active: bool


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    achievement_percent: float | None = Field(default=None, ge=0, le=100000)
    actual: float | None = None


class PreviewResult(BaseModel):
    score: int


# --- KPI library ---------------------------------------------------------------------------

class ApplicabilityIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plant_id: int | None = None
    department_id: int | None = None


class ApplicabilityRead(BaseModel):
    plant: PlantRef | None
    department: DepartmentRef | None
    label: str


class KpiWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=150)
    description: str | None = Field(default=None, max_length=1000)
    unit: str = Field(min_length=1, max_length=30)
    direction: KpiDirection
    default_scoring_policy_id: int
    data_source: str | None = Field(default=None, max_length=50)
    applicability: list[ApplicabilityIn] = Field(min_length=1, max_length=50)
    is_active: bool = True


class KpiRef(ORMModel):
    id: int
    code: str
    name: str
    direction: KpiDirection


class KpiRead(KpiRef):
    description: str | None
    unit: str
    default_scoring_policy: PolicyRef
    data_source: str | None
    is_active: bool
    applicability: list[ApplicabilityRead]


# --- quarters and sheets -----------------------------------------------------------------

class QuarterRead(BaseModel):
    id: int
    cycle_code: str
    cycle_name: str
    quarter_number: int
    name: str
    start_date: date
    end_date: date
    status: QuarterStatus


class StartScoringResult(BaseModel):
    quarter: QuarterRead
    locked_sheets: int
    unpublished_sheets: int


class AssignmentBrief(BaseModel):
    id: int
    employee: EmployeeRef
    plant: PlantRef
    department: DepartmentRef
    designation: DesignationRef
    is_primary: bool


class SheetBrief(BaseModel):
    id: int
    status: KpiSheetStatus
    item_count: int
    total: float


class SheetRow(BaseModel):
    assignment: AssignmentBrief
    sheet: SheetBrief | None


class SheetList(BaseModel):
    quarter: QuarterRead
    rows: list[SheetRow]


class SheetItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kpi_definition_id: int
    weightage: Weightage
    target_value: Target | None = None
    target_note: str | None = Field(default=None, max_length=255)
    unit: str | None = Field(default=None, max_length=30)
    scoring_policy_id: int | None = None


class SheetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignment_id: int
    quarter_id: int
    job_description_id: int | None = None


class SheetUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[SheetItemIn] = Field(default_factory=list, max_length=30)
    notes: str | None = Field(default=None, max_length=1000)
    job_description_id: int | None = None


class CopyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_quarter_id: int


class SheetItemRead(BaseModel):
    id: int
    kpi: KpiRef
    weightage: float
    target_value: float | None
    target_note: str | None
    unit: str
    scoring_policy: PolicyRef
    frozen: bool  # the scoring policy was frozen at publication


class JDRef(BaseModel):
    id: int
    code: str
    title: str


class SheetRead(BaseModel):
    id: int
    status: KpiSheetStatus
    quarter: QuarterRead
    assignment: AssignmentBrief
    job_description: JDRef | None
    notes: str | None
    items: list[SheetItemRead]
    total: float
    warnings: list[str]
    published_at: datetime | None
    locked_at: datetime | None
    can_edit: bool
    can_request_deviation: bool
    pending_deviation_id: int | None


class SheetSaved(BaseModel):
    sheet: SheetRead
    warnings: list[str]


# --- uploads -------------------------------------------------------------------------------

class IssueRead(BaseModel):
    message: str
    field: str | None = None
    row: int | None = None


class UploadItemRead(BaseModel):
    row: int
    kpi_name: str
    weightage: float
    target_value: float | None
    unit: str | None
    scoring_policy: str | None
    target_note: str | None


class UploadSheetRead(BaseModel):
    employee: EmployeeRef
    plant: PlantRef
    department: DepartmentRef
    action: Literal["create", "replace"]
    items: list[UploadItemRead]
    total: float


class UploadPreviewRead(BaseModel):
    quarter: QuarterRead
    row_count: int
    issues: list[IssueRead]
    sheets: list[UploadSheetRead]


class UploadConfirmed(BaseModel):
    sheets_created: int
    sheets_updated: int
    items: int
    rows: int


# --- deviations ----------------------------------------------------------------------------

class DeviationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sheet_id: int
    reason: str = Field(min_length=10, max_length=1000)
    items: list[SheetItemIn] = Field(min_length=1, max_length=30)


class DeviationApprove(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    as_role: Literal["HR_HEAD", "PLANT_HEAD"] = Field(alias="as")


class DeviationRead(BaseModel):
    id: int
    status: DeviationStatus
    sheet_id: int
    employee: EmployeeRef
    plant: PlantRef
    department: DepartmentRef
    quarter_name: str
    reason: str
    original_items: list[dict[str, Any]]
    proposed_items: list[dict[str, Any]]
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
