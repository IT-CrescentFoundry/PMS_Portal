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
    """Lifecycle of a quarter within a PMS cycle (see docs/database-design.md,
    Stage L). Every status after DRAFT means scoring has started and KPI
    sheets are locked."""

    DRAFT = "DRAFT"                          # KPI setup
    OPEN = "OPEN"                            # scoring started: data collection
    CLOSED = "CLOSED"                        # historic (read-only)
    DEPARTMENT_REVIEW = "DEPARTMENT_REVIEW"  # data frozen; departments review
    NORMALIZATION = "NORMALIZATION"          # employee scores frozen; cohorts placed
    READY = "READY"                          # every cohort approved
    PUBLISHED = "PUBLISHED"                  # published and locked


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
    SUPERSEDED = "SUPERSEDED"  # replaced by a corrected version published later (Stage M)


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


class EmployeeResultStatus(StrEnum):
    """An employee's consolidated quarterly score."""

    DRAFT = "DRAFT"            # frozen for normalization; recomputed if the quarter steps back
    PUBLISHED = "PUBLISHED"    # final and immutable
    SUPERSEDED = "SUPERSEDED"  # replaced by a corrected version published later (Stage M)


class NormalizationRunStatus(StrEnum):
    """One normalization cohort of a quarter."""

    DRAFT = "DRAFT"          # computed; placements may be needed
    APPROVED = "APPROVED"    # checked by an HR Head or the CHRO
    PUBLISHED = "PUBLISHED"    # published with the quarter
    DISCARDED = "DISCARDED"    # the cohort no longer exists after a recomputation
    SUPERSEDED = "SUPERSEDED"  # replaced by a corrected version published later (Stage M)


class NormalizationPlacement(StrEnum):
    """How an employee came to be in a normalization group."""

    AUTO = "AUTO"                                      # ranked into the group
    TIE_RULE = "TIE_RULE"                              # tied at a boundary; the policy's tie rule
    TIE_RESOLVED = "TIE_RESOLVED"                      # tied; placed by an authorized reviewer
    SMALL_COHORT_DEFAULT = "SMALL_COHORT_DEFAULT"      # small cohort; the policy's default group
    SMALL_COHORT_RESOLVED = "SMALL_COHORT_RESOLVED"    # small cohort; placed by a reviewer
    NEEDS_RESOLUTION = "NEEDS_RESOLUTION"              # waiting for a reviewer
    NOT_ELIGIBLE = "NOT_ELIGIBLE"                      # outside the policy's eligible population


class CohortLevel(StrEnum):
    COMPANY = "COMPANY"
    PLANT = "PLANT"
    DEPARTMENT = "DEPARTMENT"              # one department across all plants
    PLANT_DEPARTMENT = "PLANT_DEPARTMENT"  # one department at one plant


class SheetCommentKind(StrEnum):
    REVIEW_COMMENT = "REVIEW_COMMENT"  # between reviewers
    FEEDBACK = "FEEDBACK"              # for the employee; always optional


class CorrectionStatus(StrEnum):
    """A correction of a published quarter (Stage M). Once the CHRO approves
    it, it is a new version of the quarter's results that goes through the
    review steps again; the published version stays current until then."""

    REQUESTED = "REQUESTED"                  # by an HR Head; awaits the CHRO
    REJECTED = "REJECTED"                    # by the CHRO
    DEPARTMENT_REVIEW = "DEPARTMENT_REVIEW"  # approved: corrected results recalculated
    NORMALIZATION = "NORMALIZATION"          # affected cohorts renormalized
    READY = "READY"                          # every affected cohort approved
    PUBLISHED = "PUBLISHED"                  # the corrected version is current


class CorrectionItemKind(StrEnum):
    VALUE = "VALUE"      # one monthly source value of one KPI of one sheet
    WEIGHTS = "WEIGHTS"  # the contribution weights of one cross-plant employee


class AnnualResultStatus(StrEnum):
    """One version of an employee's annual result for a cycle (Stage M)."""

    CALCULATED = "CALCULATED"  # from the published quarters; awaits CHRO approval
    PUBLISHED = "PUBLISHED"    # approved by the CHRO: final
    SUPERSEDED = "SUPERSEDED"  # a published version replaced by a newer published one
    DISCARDED = "DISCARDED"    # a calculation replaced by a newer one before approval


class CompaRatioMethod(StrEnum):
    """How compa-ratio affects the increment in a compensation cycle (Stage N).
    Configuration, chosen per cycle; neither is company policy until the
    matrices it uses are approved."""

    MATRIX_INPUT = "MATRIX_INPUT"            # the increment matrix takes compa-ratio as an input
    IMPACT_MULTIPLIER = "IMPACT_MULTIPLIER"  # base increment x a CR-impact matrix multiplier


class CompensationCycleStatus(StrEnum):
    OPEN = "OPEN"            # baselines, scenarios and budget decisions may be added
    FINALIZED = "FINALIZED"  # the CHRO approved a scenario against the approved budget


class BudgetScenarioStatus(StrEnum):
    CALCULATED = "CALCULATED"  # prepared by an HR Head; frozen lines
    SUBMITTED = "SUBMITTED"    # submitted for the CHRO's decision
    FINALIZED = "FINALIZED"    # approved by the CHRO against the approved budget
    REJECTED = "REJECTED"      # rejected by the CHRO, with a reason
    SUPERSEDED = "SUPERSEDED"  # another scenario of the cycle was finalized


class BudgetLineStatus(StrEnum):
    INCLUDED = "INCLUDED"
    EXCLUDED = "EXCLUDED"  # with a recorded reason; never silently dropped


class BudgetDecisionStatus(StrEnum):
    CURRENT = "CURRENT"
    SUPERSEDED = "SUPERSEDED"  # replaced by a later recorded amount


class AnnualDeviationStatus(StrEnum):
    PENDING = "PENDING"    # requested by an Admin; awaits the CHRO
    APPROVED = "APPROVED"  # the adjusted score applies to that annual result version
    REJECTED = "REJECTED"
    VOIDED = "VOIDED"      # the annual result was recalculated before a decision
