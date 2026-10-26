"""Matrix configuration request/response schemas.

A version's `definition` is passed through as JSON and validated by the rule
engine (app/services/matrix_rules.py), the same code that validates Excel
uploads, so the portal, the API and uploads can never disagree.
"""
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import MatrixVersionSource, MatrixVersionStatus
from app.schemas.jd import UserRef
from app.schemas.organization import DepartmentRef, PlantRef

MAX_DEFINITION_BYTES = 200_000


class ScopeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plant_id: int | None = None
    department_id: int | None = None


class ScopeRead(BaseModel):
    plant: PlantRef | None
    department: DepartmentRef | None
    label: str


class MatrixCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    matrix_type: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=2, max_length=150)
    description: str | None = Field(default=None, max_length=1000)
    attributes: dict[str, str] = Field(default_factory=dict)
    applicability: list[ScopeIn] = Field(min_length=1, max_length=50)


class MatrixUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=150)
    description: str | None = Field(default=None, max_length=1000)


class DraftSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    definition: dict[str, Any]
    effective_from: date | None = None
    effective_to: date | None = None
    applicability: list[ScopeIn] = Field(min_length=1, max_length=50)
    change_summary: str | None = Field(default=None, max_length=1000)


class DefinitionCheckRequest(BaseModel):
    """Validate or preview unsaved content (nothing is stored)."""

    model_config = ConfigDict(extra="forbid")
    definition: dict[str, Any]
    attributes: dict[str, str] = Field(default_factory=dict)
    inputs: dict[str, Any] | None = None


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inputs: dict[str, Any]


class ApproveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str | None = Field(default=None, max_length=1000)


class PolicyLink(BaseModel):
    id: int
    code: str
    name: str


class VersionSummary(BaseModel):
    id: int
    version_no: int
    status: MatrixVersionStatus
    schema_version: int
    effective_from: date | None
    effective_to: date | None
    change_summary: str | None
    source: MatrixVersionSource
    source_file_name: str | None
    template_version: int | None
    created_by: UserRef | None
    created_at: datetime
    updated_at: datetime
    submitted_by: UserRef | None
    submitted_at: datetime | None
    approved_by: UserRef | None
    approved_at: datetime | None
    approval_note: str | None
    rejected_by: UserRef | None
    rejected_at: datetime | None
    rejection_reason: str | None
    published_by: UserRef | None
    published_at: datetime | None
    superseded_at: datetime | None
    applicability: list[ScopeRead]


class MatrixSummary(BaseModel):
    id: int
    code: str
    matrix_type: str
    type_name: str
    name: str
    description: str | None
    attributes: dict[str, Any]
    latest_version: VersionSummary
    open_version: VersionSummary | None
    in_force: VersionSummary | None  # published version in force today
    policy: PolicyLink | None  # KPI-scoring matrices: the policy KPIs refer to
    policy_note: str | None  # shown while the type has no approved configuration


class VersionActions(BaseModel):
    can_edit: bool
    can_submit: bool
    can_withdraw: bool
    can_approve: bool
    can_publish: bool


class MatrixDetail(MatrixSummary):
    versions: list[VersionSummary]
    can_write: bool
    can_revise: bool


class RuleSummary(BaseModel):
    priority: int
    label: str | None
    description: str
    outputs: dict[str, Any]


class VersionRead(VersionSummary):
    matrix_id: int
    definition: dict[str, Any]
    definition_hash: str
    check: dict[str, Any]  # errors, warnings, test results, gaps, readiness
    rule_summaries: list[RuleSummary]
    actions: VersionActions


class PreviewResult(BaseModel):
    outputs: dict[str, Any]
    rule: dict[str, Any] | None
    used_default: bool
    inputs: dict[str, Any]


class LocatedProblem(BaseModel):
    location: str
    message: str


class UploadPreviewRead(BaseModel):
    action: Literal["create", "update_draft", "new_version"] | None
    matrix_type: str | None
    type_name: str | None
    matrix_code: str | None
    name: str | None
    target_version_no: int | None
    template_version: int | None
    schema_version: int | None
    effective_from: date | None
    effective_to: date | None
    applicability: list[str]
    fields: list[dict[str, Any]]
    rules: list[RuleSummary]
    test_results: list[dict[str, Any]]
    problems: list[LocatedProblem]
    warnings: list[LocatedProblem]
    ready: bool


class UploadConfirmed(BaseModel):
    matrix_id: int
    matrix_code: str
    version_id: int
    version_no: int
