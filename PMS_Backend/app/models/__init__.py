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
    KpiAggregation,
    KpiDirection,
    KpiSheetStatus,
    MatrixVersionSource,
    MatrixVersionStatus,
    NatureOfJob,
    QuarterStatus,
    ReportingFrequency,
    ScopeType,
    ScoreOverrideStatus,
    ScoreResultStatus,
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
from app.models.kpi_data import KpiDataImport, KpiMonthlyValue, KpiScoreOverride, KpiSheetResult
from app.models.matrix import Matrix, MatrixVersion, MatrixVersionScope
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
    "KpiAggregation",
    "KpiApplicability",
    "KpiDataImport",
    "KpiDefinition",
    "KpiDeviation",
    "KpiDirection",
    "KpiMonthlyValue",
    "KpiScoreOverride",
    "KpiScoringPolicy",
    "KpiSheet",
    "KpiSheetItem",
    "KpiSheetResult",
    "KpiSheetStatus",
    "Matrix",
    "MatrixVersion",
    "MatrixVersionScope",
    "MatrixVersionSource",
    "MatrixVersionStatus",
    "NatureOfJob",
    "Plant",
    "PlantDepartment",
    "PmsCycle",
    "PmsCycleQuarter",
    "QuarterStatus",
    "ReportingFrequency",
    "Role",
    "ScopeType",
    "ScoreOverrideStatus",
    "ScoreResultStatus",
    "User",
    "UserRole",
    "UserRoleScope",
    "VacancyType",
]
