"""Enumerations stored in the database.

Values are stored as their upper-case string value (native MySQL ENUM).
Adding a new value later requires an Alembic migration.
"""
from enum import StrEnum


def enum_values(enum_cls: type[StrEnum]) -> list[str]:
    """`values_callable` for sqlalchemy.Enum: store values, not member names."""
    return [member.value for member in enum_cls]


class CycleStatus(StrEnum):
    """Lifecycle of an annual PMS cycle."""

    DRAFT = "DRAFT"      # being configured (dates, quarters, KRAs)
    ACTIVE = "ACTIVE"    # performance data is being collected/evaluated
    CLOSED = "CLOSED"    # finalized; read-only history


class QuarterStatus(StrEnum):
    """Lifecycle of a quarter within a PMS cycle."""

    DRAFT = "DRAFT"
    OPEN = "OPEN"
    CLOSED = "CLOSED"


class JDVersionStatus(StrEnum):
    """Three-step sign-off from the current JD format, then supersession."""

    DRAFT = "DRAFT"            # editable
    PROPOSED = "PROPOSED"      # by Hiring Manager / HOD (or HR)
    AUTHORISED = "AUTHORISED"  # by Plant Head
    APPROVED = "APPROVED"      # by CHRO: the active version of the role
    SUPERSEDED = "SUPERSEDED"  # replaced by a later approved version


class VacancyType(StrEnum):
    NEW = "NEW"
    REPLACEMENT = "REPLACEMENT"
    EXISTING = "EXISTING"


class NatureOfJob(StrEnum):
    PERMANENT = "PERMANENT"
    TEMPORARY = "TEMPORARY"
    CONTRACTUAL = "CONTRACTUAL"


class KpiDirection(StrEnum):
    HIGHER_IS_BETTER = "HIGHER_IS_BETTER"
    LOWER_IS_BETTER = "LOWER_IS_BETTER"
    ZERO_TOLERANCE = "ZERO_TOLERANCE"  # target is zero occurrences


class KpiSheetStatus(StrEnum):
    DRAFT = "DRAFT"          # editable (also via Excel upload)
    PUBLISHED = "PUBLISHED"  # validated (weightages = 100 %); reopenable until scoring starts
    LOCKED = "LOCKED"        # quarterly scoring started; changes only via approved deviation


class DeviationStatus(StrEnum):
    PENDING = "PENDING"
    APPLIED = "APPLIED"    # both approvals given; change applied to the sheet
    REJECTED = "REJECTED"


class AuditActorType(StrEnum):
    """Who performed an audited action."""

    USER = "USER"      # an authenticated user (actor_user_id is required)
    SYSTEM = "SYSTEM"  # an automated process, e.g. a scheduled job or data load


class ScopeType(StrEnum):
    """Organizational reach of a role assignment.

    GLOBAL            all plants and departments (e.g. Admin, CHRO)
    PLANT             every department at one plant
    DEPARTMENT        one department across all plants ("Quality — All Plants")
    PLANT_DEPARTMENT  one department at one plant ("Quality — Plant A")
    """

    GLOBAL = "GLOBAL"
    PLANT = "PLANT"
    DEPARTMENT = "DEPARTMENT"
    PLANT_DEPARTMENT = "PLANT_DEPARTMENT"
