"""SQLAlchemy models for the PMS backend.

Every model module must be imported here so that Base.metadata is complete
when Alembic (migrations/env.py) autogenerates migrations.
"""
from app.models.access import Role, User, UserRole, UserRoleScope
from app.models.cycle import PmsCycle, PmsCycleQuarter
from app.models.employee import Employee, EmployeeAssignment
from app.models.enums import CycleStatus, QuarterStatus, ScopeType
from app.models.organization import Department, Designation, Plant, PlantDepartment

__all__ = [
    "CycleStatus",
    "Department",
    "Designation",
    "Employee",
    "EmployeeAssignment",
    "Plant",
    "PlantDepartment",
    "PmsCycle",
    "PmsCycleQuarter",
    "QuarterStatus",
    "Role",
    "ScopeType",
    "User",
    "UserRole",
    "UserRoleScope",
]
