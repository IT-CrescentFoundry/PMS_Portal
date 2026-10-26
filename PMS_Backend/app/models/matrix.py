"""Configurable matrices: one lineage per configuration, versioned content.

Matrix TYPES (KPI scoring, KRA performance, CR impact, increment, ...) are
declared in code (app/services/matrix_types.py). `matrix_type` stores the
registry code and is validated there, so adding a type needs no schema
change. A version's content is a declarative decision table stored as JSON,
together with the field definitions it was written against, so old versions
stay interpretable when a type gains fields. Content changes only in DRAFT;
every other change is a new version.
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
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.enums import MatrixVersionSource, MatrixVersionStatus, enum_values
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.organization import Department, Plant


class Matrix(TimestampMixin, Base):
    __tablename__ = "matrices"
    __table_args__ = (
        UniqueConstraint("matrix_type", "name", name="uq_matrices_type_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), unique=True)
    matrix_type: Mapped[str] = mapped_column(String(40), index=True)  # registry code
    name: Mapped[str] = mapped_column(String(150))
    description: Mapped[str | None] = mapped_column(String(1000))
    # Type-specific lineage attributes, e.g. {"direction": "HIGHER_IS_BETTER"}.
    attributes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)

    versions: Mapped[list[MatrixVersion]] = relationship(
        back_populates="matrix", order_by="MatrixVersion.version_no"
    )


class MatrixVersion(TimestampMixin, Base):
    __tablename__ = "matrix_versions"
    __table_args__ = (
        UniqueConstraint("matrix_id", "version_no", name="uq_matrix_versions_number"),
        # At most one open (DRAFT or SUBMITTED) version per matrix.
        UniqueConstraint("open_key", name="uq_matrix_versions_one_open"),
        CheckConstraint("version_no > 0", name="version_positive"),
        CheckConstraint(
            "effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from",
            name="valid_dates",
        ),
        # Separation of duties: the CHRO's approval cannot be self-approval.
        CheckConstraint(
            "approved_by_user_id IS NULL OR submitted_by_user_id IS NULL "
            "OR approved_by_user_id <> submitted_by_user_id",
            name="approver_not_submitter",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    matrix_id: Mapped[int] = mapped_column(ForeignKey("matrices.id"))
    version_no: Mapped[int] = mapped_column(SmallInteger)
    status: Mapped[MatrixVersionStatus] = mapped_column(
        Enum(MatrixVersionStatus, name="matrix_version_status", values_callable=enum_values),
        default=MatrixVersionStatus.DRAFT,
        server_default=MatrixVersionStatus.DRAFT.value,
    )
    # The type's schema version the content was written against.
    schema_version: Mapped[int] = mapped_column(SmallInteger)
    # {"fields": [...], "rules": [...], "no_match": {...}, "test_cases": [...]}
    definition: Mapped[dict[str, Any]] = mapped_column(JSON)
    definition_hash: Mapped[str] = mapped_column(String(64))  # SHA-256 of the canonical JSON
    effective_from: Mapped[date | None] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)  # inclusive; NULL = open-ended
    change_summary: Mapped[str | None] = mapped_column(String(1000))
    source: Mapped[MatrixVersionSource] = mapped_column(
        Enum(MatrixVersionSource, name="matrix_version_source", values_callable=enum_values),
        default=MatrixVersionSource.PORTAL,
        server_default=MatrixVersionSource.PORTAL.value,
    )
    source_file_name: Mapped[str | None] = mapped_column(String(255))
    source_file_sha256: Mapped[str | None] = mapped_column(String(64))
    template_version: Mapped[int | None] = mapped_column(SmallInteger)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    submitted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    approval_note: Mapped[str | None] = mapped_column(String(1000))
    rejected_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime)
    rejection_reason: Mapped[str | None] = mapped_column(String(1000))
    published_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime)
    open_key: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN status IN ('DRAFT', 'SUBMITTED') THEN matrix_id END", persisted=True)
    )

    matrix: Mapped[Matrix] = relationship(back_populates="versions")
    scopes: Mapped[list[MatrixVersionScope]] = relationship(
        back_populates="version", cascade="all, delete-orphan"
    )


class MatrixVersionScope(Base):
    """Where a version applies: (plant, department) one unit · (NULL,
    department) that department at every plant · (plant, NULL) every
    department at a plant · (NULL, NULL) company-wide."""

    __tablename__ = "matrix_version_scopes"
    __table_args__ = (
        UniqueConstraint(
            "matrix_version_id", "plant_key", "department_key", name="uq_matrix_version_scopes_scope"
        ),
        ForeignKeyConstraint(
            ["plant_id", "department_id"],
            ["plant_departments.plant_id", "plant_departments.department_id"],
            name="fk_matrix_version_scopes_plant_department",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    matrix_version_id: Mapped[int] = mapped_column(ForeignKey("matrix_versions.id"))
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"), index=True)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"), index=True)
    plant_key: Mapped[int] = mapped_column(Computed("COALESCE(plant_id, 0)", persisted=True))
    department_key: Mapped[int] = mapped_column(
        Computed("COALESCE(department_id, 0)", persisted=True)
    )

    version: Mapped[MatrixVersion] = relationship(back_populates="scopes")
    plant: Mapped[Plant | None] = relationship(foreign_keys=[plant_id])
    department: Mapped[Department | None] = relationship(foreign_keys=[department_id])
