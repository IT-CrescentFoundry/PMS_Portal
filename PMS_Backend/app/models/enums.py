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
    """What a good result looks like. Always chosen explicitly, never inferred
    from a KPI's title; the scoring matrix carries the actual rule."""

    HIGHER_IS_BETTER = "HIGHER_IS_BETTER"
    LOWER_IS_BETTER = "LOWER_IS_BETTER"
    ZERO_TOLERANCE = "ZERO_TOLERANCE"  # target is zero occurrences
    TARGET_RANGE = "TARGET_RANGE"      # best when close to the target (exact or within a band)
    CATEGORICAL = "CATEGORICAL"        # scored from a category, e.g. an audit grade
    COMPOSITE = "COMPOSITE"            # scored from a combination of inputs


class KpiAggregation(StrEnum):
    """How a KPI's monthly actuals combine into the quarterly actual."""

    SUM = "SUM"
    AVERAGE = "AVERAGE"
    LAST = "LAST"
    MIN = "MIN"
    MAX = "MAX"


class ReportingFrequency(StrEnum):
    MONTHLY = "MONTHLY"
    QUARTERLY = "QUARTERLY"  # one value per quarter


class MatrixVersionStatus(StrEnum):
    """Configuration approval lifecycle (HR Head authors, CHRO approves)."""

    DRAFT = "DRAFT"            # editable
    SUBMITTED = "SUBMITTED"    # awaiting CHRO
    APPROVED = "APPROVED"      # approved, not yet in force
    REJECTED = "REJECTED"      # kept for the record; revise into a new version
    PUBLISHED = "PUBLISHED"    # in force from effective_from (until effective_to)
    SUPERSEDED = "SUPERSEDED"  # replaced before it took effect


class MatrixVersionSource(StrEnum):
    PORTAL = "PORTAL"
    UPLOAD = "UPLOAD"
    SEED = "SEED"  # synthetic demo data


class ScoreResultStatus(StrEnum):
    CALCULATED = "CALCULATED"  # system result; recalculated when inputs change
    REVIEWED = "REVIEWED"      # checked by the manager
    PUBLISHED = "PUBLISHED"    # final and immutable


class ScoreOverrideStatus(StrEnum):
    PENDING = "PENDING"
    APPLIED = "APPLIED"    # both approvals given
    REJECTED = "REJECTED"
    VOIDED = "VOIDED"      # the result was recalculated; request again if still needed


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
