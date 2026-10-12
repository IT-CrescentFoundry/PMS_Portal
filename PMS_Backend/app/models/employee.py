"""Employees (one row per person) and their dated organizational assignments.

An employee who works in Quality at Plant A and also supports Quality at
Plant B has ONE employees row and TWO employee_assignments rows. Moves and
role changes close the old assignment (set effective_to) and open a new one,
so assignment history is never overwritten.
"""
from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    Computed,
    Date,
    ForeignKey,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.access import User
    from app.models.organization import Designation, PlantDepartment


class Employee(TimestampMixin, Base):
    """Person-level employee profile, independent of any login account."""

    __tablename__ = "employees"
    __table_args__ = (
        CheckConstraint(
            "date_of_exit IS NULL OR date_of_joining IS NULL "
            "OR date_of_exit >= date_of_joining",
            name="exit_after_joining",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_code: Mapped[str] = mapped_column(String(20), unique=True)  # business ID
    full_name: Mapped[str] = mapped_column(String(150))
    email: Mapped[str | None] = mapped_column(String(255), unique=True)
    date_of_joining: Mapped[date | None] = mapped_column(Date)
    date_of_exit: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))

    assignments: Mapped[list[EmployeeAssignment]] = relationship(
        back_populates="employee",
        foreign_keys="EmployeeAssignment.employee_id",
        order_by="EmployeeAssignment.effective_from",
    )
    user: Mapped[User | None] = relationship(back_populates="employee")


class EmployeeAssignment(TimestampMixin, Base):
    """Links an employee to a plant-department unit for a date range.

    effective_to is the last day of the assignment (inclusive); NULL means
    the assignment is current/open-ended.

    Integrity enforced by the database:
      * effective_to >= effective_from, and nobody reports to themselves.
      * At most ONE open assignment per employee per plant-department.
      * At most ONE open PRIMARY assignment per employee.
      * No duplicate (employee, unit, start date) rows.

    MySQL has no partial unique indexes, so the two "open" rules use stored
    generated columns that are NULL for closed rows (NULLs never collide in a
    unique index). Overlap between *closed* date ranges cannot be expressed
    as a constraint and is validated in the service layer.
    """

    __tablename__ = "employee_assignments"
    __table_args__ = (
        CheckConstraint(
            "effective_to IS NULL OR effective_to >= effective_from",
            name="valid_dates",
        ),
        CheckConstraint(
            "reporting_manager_id IS NULL OR reporting_manager_id <> employee_id",
            name="not_self_managed",
        ),
        UniqueConstraint(
            "employee_id",
            "plant_department_id",
            "effective_from",
            name="uq_employee_assignments_unit_start",
        ),
        UniqueConstraint(
            "employee_id",
            "plant_department_id",
            "open_assignment_flag",
            name="uq_employee_assignments_one_open_per_unit",
        ),
        UniqueConstraint(
            "open_primary_employee_id",
            name="uq_employee_assignments_one_open_primary",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # employee_id is indexed by the leading column of the unique constraints.
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    plant_department_id: Mapped[int] = mapped_column(
        ForeignKey("plant_departments.id"), index=True
    )
    designation_id: Mapped[int] = mapped_column(
        ForeignKey("designations.id"), index=True
    )
    # Manager can differ per plant, so it lives on the assignment.
    reporting_manager_id: Mapped[int | None] = mapped_column(
        ForeignKey("employees.id"), index=True
    )
    # The employee's "home" unit: used to count them once in headcount,
    # normalization and budget (see docs/database-design.md).
    is_primary: Mapped[bool] = mapped_column(default=False, server_default=text("0"))
    effective_from: Mapped[date] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)

    # Generated helper columns (read-only) backing the "open" unique rules.
    open_assignment_flag: Mapped[int | None] = mapped_column(
        Computed("CASE WHEN effective_to IS NULL THEN 1 END", persisted=True)
    )
    open_primary_employee_id: Mapped[int | None] = mapped_column(
        Computed(
            "CASE WHEN is_primary = 1 AND effective_to IS NULL THEN employee_id END",
            persisted=True,
        )
    )

    employee: Mapped[Employee] = relationship(
        back_populates="assignments", foreign_keys=[employee_id]
    )
    reporting_manager: Mapped[Employee | None] = relationship(
        foreign_keys=[reporting_manager_id]
    )
    plant_department: Mapped[PlantDepartment] = relationship(
        back_populates="assignments"
    )
    designation: Mapped[Designation] = relationship()
