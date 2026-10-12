"""Organization structure: plants, the shared department master, the
plant-department mapping, and designations.

Deletes are not cascaded anywhere: organizational rows are deactivated with
`is_active = False` so historical assignments, scores and budgets that refer
to them remain intact.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.employee import EmployeeAssignment


class Plant(TimestampMixin, Base):
    __tablename__ = "plants"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)  # business ID
    name: Mapped[str] = mapped_column(String(100), unique=True)
    location: Mapped[str | None] = mapped_column(String(150))
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))

    plant_departments: Mapped[list[PlantDepartment]] = relationship(
        back_populates="plant"
    )


class Department(TimestampMixin, Base):
    """Shared department master — one row per department, e.g. "Quality",
    regardless of how many plants it exists at."""

    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)  # business ID
    name: Mapped[str] = mapped_column(String(100), unique=True)
    description: Mapped[str | None] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))

    plant_departments: Mapped[list[PlantDepartment]] = relationship(
        back_populates="department"
    )


class PlantDepartment(TimestampMixin, Base):
    """A department as it exists at one plant ("Quality — Plant A").

    This is the organizational unit that employees are assigned to and that
    plant/department-level budgets and reports will reference.
    """

    __tablename__ = "plant_departments"
    __table_args__ = (
        # One mapping per plant/department pair. Also the target of the
        # composite foreign key from user_role_scopes.
        UniqueConstraint(
            "plant_id", "department_id", name="uq_plant_departments_plant_department"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # plant_id is indexed by the leading column of the unique constraint.
    plant_id: Mapped[int] = mapped_column(ForeignKey("plants.id"))
    department_id: Mapped[int] = mapped_column(
        ForeignKey("departments.id"), index=True
    )
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))

    plant: Mapped[Plant] = relationship(back_populates="plant_departments")
    department: Mapped[Department] = relationship(back_populates="plant_departments")
    assignments: Mapped[list[EmployeeAssignment]] = relationship(
        back_populates="plant_department"
    )


class Designation(TimestampMixin, Base):
    """Job title master (the anchor for standardized JDs in a later stage)."""

    __tablename__ = "designations"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))
