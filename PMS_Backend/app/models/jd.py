"""Job descriptions: a ROLE (not a designation) and its signed-off versions.

Several roles may share one designation and department; the role title is
unique per department and plant. Content lives in versions, so every
revision stays traceable; only a DRAFT version can be edited.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.enums import JDVersionStatus, NatureOfJob, VacancyType, enum_values
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.organization import Department, Designation, Plant


class JobDescription(TimestampMixin, Base):
    __tablename__ = "job_descriptions"
    __table_args__ = (
        # One role title per department and plant (NULL plant = all plants).
        UniqueConstraint("department_id", "plant_key", "title", name="uq_job_descriptions_role"),
        # A plant-specific JD must name a department that exists at that plant.
        ForeignKeyConstraint(
            ["plant_id", "department_id"],
            ["plant_departments.plant_id", "plant_departments.department_id"],
            name="fk_job_descriptions_plant_department",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    title: Mapped[str] = mapped_column(String(150))  # role, e.g. "Quality Manager — Inspection"
    department_id: Mapped[int] = mapped_column(ForeignKey("departments.id"), index=True)
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"), index=True)
    designation_id: Mapped[int | None] = mapped_column(ForeignKey("designations.id"), index=True)
    plant_key: Mapped[int] = mapped_column(Computed("COALESCE(plant_id, 0)", persisted=True))
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)

    department: Mapped[Department] = relationship()
    plant: Mapped[Plant | None] = relationship(foreign_keys=[plant_id])
    designation: Mapped[Designation | None] = relationship()
    versions: Mapped[list[JobDescriptionVersion]] = relationship(
        back_populates="job_description", order_by="JobDescriptionVersion.version_no"
    )


class JobDescriptionVersion(TimestampMixin, Base):
    """All fields of the current JD format (workbook 'Current JD Format',
    sheet 'Table 1'), plus the three-step sign-off trail."""

    __tablename__ = "job_description_versions"
    __table_args__ = (
        UniqueConstraint("job_description_id", "version_no", name="uq_jd_versions_number"),
        # At most one APPROVED (active) version, and one open draft, per role.
        UniqueConstraint("approved_key", name="uq_jd_versions_one_approved"),
        UniqueConstraint("open_key", name="uq_jd_versions_one_open"),
        CheckConstraint("version_no >= 1", name="version_positive"),
        CheckConstraint("vacancies IS NULL OR vacancies >= 0", name="vacancies_non_negative"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    job_description_id: Mapped[int] = mapped_column(ForeignKey("job_descriptions.id"))
    version_no: Mapped[int] = mapped_column(SmallInteger)
    status: Mapped[JDVersionStatus] = mapped_column(
        Enum(JDVersionStatus, name="jd_version_status", values_callable=enum_values),
        default=JDVersionStatus.DRAFT,
        server_default=JDVersionStatus.DRAFT.value,
    )

    # Document control
    format_no: Mapped[str | None] = mapped_column(String(50))
    rev_issue_no: Mapped[str | None] = mapped_column(String(20))
    effective_date: Mapped[date | None] = mapped_column(Date)
    # Job description / requisition
    vacancies: Mapped[int | None] = mapped_column(SmallInteger)
    vacancy_type: Mapped[VacancyType | None] = mapped_column(
        Enum(VacancyType, name="vacancy_type", values_callable=enum_values)
    )
    nature_of_job: Mapped[NatureOfJob | None] = mapped_column(
        Enum(NatureOfJob, name="nature_of_job", values_callable=enum_values)
    )
    hiring_reason: Mapped[str | None] = mapped_column(Text)
    replacement_of: Mapped[str | None] = mapped_column(String(150))
    # Candidate requirements
    proposed_ctc: Mapped[str | None] = mapped_column(String(100))
    available_budget: Mapped[str | None] = mapped_column(String(100))  # filled by HR only
    min_qualification: Mapped[str | None] = mapped_column(String(255))
    age_band_gender: Mapped[str | None] = mapped_column(String(100))
    work_experience: Mapped[str | None] = mapped_column(String(255))
    languages: Mapped[str | None] = mapped_column(String(255))
    # Job relationship
    reports_to: Mapped[str | None] = mapped_column(String(255))
    supervises: Mapped[str | None] = mapped_column(String(255))
    hr_remarks: Mapped[str | None] = mapped_column(Text)  # role summary / purpose
    # [{"heading": str, "points": [str, ...]}, ...]
    responsibilities: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    # [{"name": str, "level": 1..5}, ...] (required proficiency for the role)
    technical_competencies: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    behavioural_competencies: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)

    # Sign-off trail (Proposed → Authorised → Approved)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    proposed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    proposed_at: Mapped[datetime | None] = mapped_column(DateTime)
    authorised_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    authorised_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    returned_reason: Mapped[str | None] = mapped_column(String(1000))

    approved_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status = 'APPROVED' THEN job_description_id END", persisted=True)
    )
    open_key: Mapped[int | None] = mapped_column(
        Computed(
            "CASE WHEN status IN ('DRAFT', 'PROPOSED', 'AUTHORISED') THEN job_description_id END",
            persisted=True,
        )
    )

    job_description: Mapped[JobDescription] = relationship(back_populates="versions")
