"""Login accounts, roles and scoped role assignments.

Access is never inferred from a department name. A user's reach is the union
of the explicit scopes attached to their role assignments; a role assignment
with no scope rows grants no organizational data access.
"""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.enums import ScopeType, enum_values
from app.models.mixins import TimestampMixin

if TYPE_CHECKING:
    from app.models.employee import Employee
    from app.models.organization import Department, Plant


class User(TimestampMixin, Base):
    """Login account, kept separate from the employee profile.

    employee_id is optional (e.g. a technical admin account) and unique
    (one login per employee).
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True)
    email: Mapped[str | None] = mapped_column(String(255), unique=True)
    # Stays NULL until authentication is implemented. Only a password hash
    # will ever be stored here, never a plain-text password.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    employee_id: Mapped[int | None] = mapped_column(
        ForeignKey("employees.id"), unique=True
    )
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("1"))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)

    employee: Mapped[Employee | None] = relationship(back_populates="user")
    user_roles: Mapped[list[UserRole]] = relationship(back_populates="user")


class Role(TimestampMixin, Base):
    """Application role, e.g. ADMIN, HR, CHRO, DEPT_HEAD, EMPLOYEE, BUDGET_USER."""

    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), unique=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    description: Mapped[str | None] = mapped_column(String(255))

    user_roles: Mapped[list[UserRole]] = relationship(back_populates="role")


class UserRole(TimestampMixin, Base):
    """Grants a role to a user. Its reach is defined by UserRoleScope rows."""

    __tablename__ = "user_roles"
    __table_args__ = (
        UniqueConstraint("user_id", "role_id", name="uq_user_roles_user_role"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # user_id is indexed by the leading column of the unique constraint.
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"), index=True)

    user: Mapped[User] = relationship(back_populates="user_roles")
    role: Mapped[Role] = relationship(back_populates="user_roles")
    scopes: Mapped[list[UserRoleScope]] = relationship(
        back_populates="user_role", cascade="all, delete-orphan"
    )


class UserRoleScope(TimestampMixin, Base):
    """One organizational scope of a role assignment.

    Examples for a DEPT_HEAD role assignment:
      PLANT_DEPARTMENT (plant A, Quality)  -> Quality at Plant A only
      DEPARTMENT       (NULL,    Quality)  -> Quality at every plant,
                                              including plants added later
    Several rows may be attached to one role assignment.
    """

    __tablename__ = "user_role_scopes"
    __table_args__ = (
        # Which columns must be filled depends on the scope type.
        CheckConstraint(
            "(scope_type = 'GLOBAL' AND plant_id IS NULL AND department_id IS NULL)"
            " OR (scope_type = 'PLANT' AND plant_id IS NOT NULL"
            " AND department_id IS NULL)"
            " OR (scope_type = 'DEPARTMENT' AND plant_id IS NULL"
            " AND department_id IS NOT NULL)"
            " OR (scope_type = 'PLANT_DEPARTMENT' AND plant_id IS NOT NULL"
            " AND department_id IS NOT NULL)",
            name="scope_shape",
        ),
        # A PLANT_DEPARTMENT scope must name a department that actually exists
        # at that plant. MySQL skips this check when either column is NULL,
        # so it only applies to PLANT_DEPARTMENT scopes.
        ForeignKeyConstraint(
            ["plant_id", "department_id"],
            ["plant_departments.plant_id", "plant_departments.department_id"],
            name="fk_user_role_scopes_plant_department",
        ),
        Index("ix_user_role_scopes_plant_department", "plant_id", "department_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_role_id: Mapped[int] = mapped_column(ForeignKey("user_roles.id"), index=True)
    scope_type: Mapped[ScopeType] = mapped_column(
        Enum(ScopeType, name="scope_type", values_callable=enum_values)
    )
    # plant_id is indexed by ix_user_role_scopes_plant_department.
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"))
    department_id: Mapped[int | None] = mapped_column(
        ForeignKey("departments.id"), index=True
    )

    user_role: Mapped[UserRole] = relationship(back_populates="scopes")
    plant: Mapped[Plant | None] = relationship(foreign_keys=[plant_id])
    department: Mapped[Department | None] = relationship(foreign_keys=[department_id])
