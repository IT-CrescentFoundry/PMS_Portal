"""SQLAlchemy models for the PMS backend.

Every model module must be imported here so that Base.metadata is complete
when Alembic (migrations/env.py) autogenerates migrations.
"""
from app.models.access import Role, User, UserRole, UserRoleScope
from app.models.audit import AuditEvent
from app.models.cycle import PmsCycle, PmsCycleQuarter
from app.models.employee import Employee, EmployeeAssignment
from app.models.enums import (
    AuditActorType,
    CycleStatus,
    DeviationStatus,
    JDVersionStatus,
    KpiDirection,
    KpiSheetStatus,
    NatureOfJob,
    QuarterStatus,
    ScopeType,
    VacancyType,
)
from app.models.jd import JobDescription, JobDescriptionVersion
from app.models.kpi import (
    KpiApplicability,
    KpiDefinition,
    KpiDeviation,
    KpiScoringPolicy,
    KpiSheet,
    KpiSheetItem,
)
from app.models.organization import Department, Designation, Plant, PlantDepartment

__all__ = [
    "AuditActorType",
    "AuditEvent",
    "CycleStatus",
    "Department",
    "Designation",
    "DeviationStatus",
    "Employee",
    "EmployeeAssignment",
    "JDVersionStatus",
    "JobDescription",
    "JobDescriptionVersion",
    "KpiApplicability",
    "KpiDefinition",
    "KpiDeviation",
    "KpiDirection",
    "KpiScoringPolicy",
    "KpiSheet",
    "KpiSheetItem",
    "KpiSheetStatus",
    "NatureOfJob",
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
    "VacancyType",
]
