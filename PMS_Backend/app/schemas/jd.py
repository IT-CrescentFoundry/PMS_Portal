"""JD request/response schemas. Field set = workbook 'Current JD Format.xlsx',
sheet 'Table 1' (see docs/business-requirements/stage-j-findings.md, section 3)."""
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import JDVersionStatus, NatureOfJob, VacancyType
from app.schemas.employee import DesignationRef
from app.schemas.organization import DepartmentRef, ORMModel, PlantRef

Text100 = Field(default=None, max_length=100)


class ResponsibilitySection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    heading: str = Field(min_length=1, max_length=200)
    points: list[str] = Field(default_factory=list, max_length=30)


class Competency(BaseModel):
    """Required proficiency for the role (E-Scale: 1 Awareness … 5 Expert)."""

    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=300)
    level: int = Field(ge=1, le=5)


class JDContent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Document control
    format_no: str | None = Field(default=None, max_length=50)
    rev_issue_no: str | None = Field(default=None, max_length=20)
    effective_date: date | None = None
    # Job description / requisition
    vacancies: int | None = Field(default=None, ge=0, le=999)
    vacancy_type: VacancyType | None = None
    nature_of_job: NatureOfJob | None = None
    hiring_reason: str | None = Field(default=None, max_length=2000)
    replacement_of: str | None = Field(default=None, max_length=150)
    # Candidate requirements
    proposed_ctc: str | None = Text100
    available_budget: str | None = Text100  # filled by HR only (enforced by the API)
    min_qualification: str | None = Field(default=None, max_length=255)
    age_band_gender: str | None = Text100  # not collected: any value is refused (services.jd)
    work_experience: str | None = Field(default=None, max_length=255)
    languages: str | None = Field(default=None, max_length=255)
    # Job relationship
    reports_to: str | None = Field(default=None, max_length=255)
    supervises: str | None = Field(default=None, max_length=255)
    hr_remarks: str | None = Field(default=None, max_length=5000)
    # Responsibilities and competencies
    responsibilities: list[ResponsibilitySection] = Field(default_factory=list, max_length=20)
    technical_competencies: list[Competency] = Field(default_factory=list, max_length=20)
    behavioural_competencies: list[Competency] = Field(default_factory=list, max_length=20)

    def content(self) -> dict:
        """Content fields, with blank strings stored as NULL."""
        data = self.model_dump(exclude=set(type(self).model_fields) - set(JDContent.model_fields))
        return {k: (v.strip() or None) if isinstance(v, str) else v for k, v in data.items()}


class JDCreate(JDContent):
    title: str = Field(min_length=2, max_length=150)
    department_id: int
    plant_id: int | None = None  # None = every plant where the department exists
    designation_id: int | None = None


class JDUpdate(JDContent):
    title: str | None = Field(default=None, min_length=2, max_length=150)
    designation_id: int | None = None


class ReasonRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=1, max_length=1000)


class UserRef(BaseModel):
    id: int
    username: str


class JDVersionSummary(ORMModel):
    id: int
    version_no: int
    status: JDVersionStatus
    effective_date: date | None
    updated_at: datetime


class JDVersionRead(JDContent):
    model_config = ConfigDict(from_attributes=True, extra="ignore")

    id: int
    job_description_id: int
    version_no: int
    status: JDVersionStatus
    created_at: datetime
    updated_at: datetime
    created_by: UserRef | None = None
    proposed_by: UserRef | None = None
    proposed_at: datetime | None = None
    authorised_by: UserRef | None = None
    authorised_at: datetime | None = None
    approved_by: UserRef | None = None
    approved_at: datetime | None = None
    returned_reason: str | None = None


class JDSummary(BaseModel):
    id: int
    code: str
    title: str
    department: DepartmentRef
    plant: PlantRef | None
    designation: DesignationRef | None
    is_active: bool
    approved_version: JDVersionSummary | None
    open_version: JDVersionSummary | None
    updated_at: datetime


class JDDetail(JDSummary):
    versions: list[JDVersionSummary]
