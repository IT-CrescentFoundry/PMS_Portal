"""Matrix type registry: what each kind of configurable matrix may contain.

A type declares its standard input fields, its fixed output fields, which
data types and value sources custom fields may use, its limits, and how a
version is chosen at scoring time. The portal's forms, the generated Excel
templates, upload parsing and previews are all derived from this metadata
plus the field definitions stored in each version; there are no other field
lists to keep in step.

Adding a type, or a standard field to a type, is a code change reviewed like
any other (see docs/matrix-framework.md); it needs no database migration,
because `matrices.matrix_type` stores the registry code and versions store
their own field definitions. Bump `schema_version` when a change would make
older content mean something different, and register a migration for it.

Business values are never defined here. Types whose policy has not been
approved yet carry a `policy_note` that the portal shows instead of values.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from app.auth.permissions import Permission
from app.models.enums import KpiDirection


class DataType(StrEnum):
    DECIMAL = "DECIMAL"
    INTEGER = "INTEGER"    # whole numbers, e.g. a count of incidents
    PERCENT = "PERCENT"    # a decimal shown with a % unit (100 = 100 %)
    CATEGORY = "CATEGORY"  # one of a declared list of values
    BOOLEAN = "BOOLEAN"
    DATE = "DATE"


NUMERIC_TYPES = frozenset({DataType.DECIMAL, DataType.INTEGER, DataType.PERCENT})
RANGE_TYPES = NUMERIC_TYPES | {DataType.DATE}
DISCRETE_RANGE_TYPES = frozenset({DataType.INTEGER, DataType.DATE})

DATA_TYPE_LABELS = {
    DataType.DECIMAL: "Number",
    DataType.INTEGER: "Whole number",
    DataType.PERCENT: "Percentage",
    DataType.CATEGORY: "Category",
    DataType.BOOLEAN: "Yes / No",
    DataType.DATE: "Date",
}


class Source(StrEnum):
    """Where an input value comes from when a matrix is evaluated. This is an
    allow-list: there is no free-form expression language."""

    MANUAL = "MANUAL"                  # supplied directly (preview, future modules)
    ACTUAL = "ACTUAL"                  # KPI: quarterly actual (monthly values combined)
    TARGET = "TARGET"                  # KPI: the sheet item's quarterly target
    PERCENT_OF_TARGET = "PERCENT_OF_TARGET"            # KPI: actual / target x 100
    DIFFERENCE_FROM_TARGET = "DIFFERENCE_FROM_TARGET"  # KPI: actual - target
    IMPORTED = "IMPORTED"              # KPI: its own column in the monthly import


SOURCE_LABELS = {
    Source.MANUAL: "Entered directly",
    Source.ACTUAL: "Quarterly actual",
    Source.TARGET: "Quarterly target",
    Source.PERCENT_OF_TARGET: "Actual ÷ target × 100",
    Source.DIFFERENCE_FROM_TARGET: "Actual − target",
    Source.IMPORTED: "Own column in the monthly data import",
}
TARGET_SOURCES = frozenset({Source.TARGET, Source.PERCENT_OF_TARGET, Source.DIFFERENCE_FROM_TARGET})
ACTUAL_SOURCES = frozenset({Source.ACTUAL, Source.PERCENT_OF_TARGET, Source.DIFFERENCE_FROM_TARGET})


class Aggregation(StrEnum):
    """How the monthly values of an IMPORTED input combine into the quarter."""

    SUM = "SUM"
    AVERAGE = "AVERAGE"
    MIN = "MIN"
    MAX = "MAX"
    FIRST = "FIRST"
    LAST = "LAST"
    ANY = "ANY"  # booleans: true if any month is true
    ALL = "ALL"  # booleans: true only if every month is true


AGGREGATIONS_BY_TYPE: dict[DataType, frozenset[Aggregation]] = {
    DataType.DECIMAL: frozenset({Aggregation.SUM, Aggregation.AVERAGE, Aggregation.MIN,
                                 Aggregation.MAX, Aggregation.FIRST, Aggregation.LAST}),
    DataType.PERCENT: frozenset({Aggregation.AVERAGE, Aggregation.MIN, Aggregation.MAX,
                                 Aggregation.FIRST, Aggregation.LAST}),
    # No AVERAGE: an average of whole numbers is not a whole number.
    DataType.INTEGER: frozenset({Aggregation.SUM, Aggregation.MIN, Aggregation.MAX,
                                 Aggregation.FIRST, Aggregation.LAST}),
    DataType.CATEGORY: frozenset({Aggregation.FIRST, Aggregation.LAST}),
    DataType.BOOLEAN: frozenset({Aggregation.ANY, Aggregation.ALL, Aggregation.FIRST,
                                 Aggregation.LAST}),
    DataType.DATE: frozenset({Aggregation.MIN, Aggregation.MAX, Aggregation.FIRST,
                              Aggregation.LAST}),
}


class Selection(StrEnum):
    # Chosen explicitly by reference, e.g. a KPI's scoring policy.
    REFERENCE = "REFERENCE"
    # The published version in force for the unit and date; matrices of the
    # type may therefore not overlap in dates and applicability.
    APPLICABILITY = "APPLICABILITY"


@dataclass(frozen=True)
class FieldSpec:
    """A standard field of a type. Versions store a copy of the definition."""

    key: str
    label: str
    data_type: DataType
    role: str  # "input" | "output"
    unit: str | None = None
    description: str = ""
    required: bool = True
    min: str | None = None  # number or ISO date, as text
    max: str | None = None
    allowed_values: tuple[str, ...] = ()
    source: Source | None = None
    aggregation: Aggregation | None = None
    round_to: int | None = None

    def as_definition(self) -> dict[str, Any]:
        """The field as stored in a version's definition JSON."""
        return {
            "key": self.key,
            "label": self.label,
            "role": self.role,
            "data_type": self.data_type.value,
            "unit": self.unit,
            "description": self.description or None,
            "required": self.required,
            "min": self.min,
            "max": self.max,
            "allowed_values": list(self.allowed_values) or None,
            "source": self.source.value if self.source else None,
            "aggregation": self.aggregation.value if self.aggregation else None,
            "round_to": self.round_to,
        }


@dataclass(frozen=True)
class AttributeSpec:
    """A lineage-level attribute chosen when the matrix is created."""

    key: str
    label: str
    allowed_values: tuple[str, ...]
    description: str = ""


@dataclass(frozen=True)
class MatrixTypeSpec:
    code: str
    name: str
    description: str
    schema_version: int
    code_prefix: str
    standard_inputs: tuple[FieldSpec, ...]
    outputs: tuple[FieldSpec, ...]
    allow_custom_inputs: bool
    custom_input_types: frozenset[DataType]
    custom_input_source: Source
    allow_custom_outputs: bool = False
    custom_output_types: frozenset[DataType] = frozenset()
    max_inputs: int = 4
    max_outputs: int = 4
    max_rules: int = 200
    selection: Selection = Selection.APPLICABILITY
    read_permission: Permission = Permission.MATRIX_READ
    attributes: tuple[AttributeSpec, ...] = ()
    # Shown while no approved configuration exists. Never a value.
    policy_note: str | None = None
    # {older schema version: function(definition dict) -> definition dict}
    migrations: Mapping[int, Callable[[dict[str, Any]], dict[str, Any]]] = field(
        default_factory=dict
    )
    # Type-specific `settings` in a version's definition, validated by
    # settings_hook(raw settings, parsed definition, report) -> parsed value.
    settings_hook: Callable[[Any, Any, Any], Any] | None = None
    # The content of a new draft (default: the type's fixed outputs only).
    initial_definition: Callable[[], dict[str, Any]] | None = None
    # Whether versions can be authored in generated Excel workbooks.
    excel_templates: bool = True

    def standard_input(self, key: str) -> FieldSpec | None:
        return next((f for f in self.standard_inputs if f.key == key), None)

    def standard_output(self, key: str) -> FieldSpec | None:
        return next((f for f in self.outputs if f.key == key), None)


_KPI_SOURCES_NOTE = (
    "Inputs come from the KPI's quarterly data: the actual (monthly values combined as the "
    "KPI defines), its target, actual ÷ target × 100, actual − target, or an extra column "
    "imported with the monthly data."
)

KPI_SCORING = MatrixTypeSpec(
    code="KPI_SCORING",
    name="KPI scoring matrix",
    description=(
        "Turns a KPI's quarterly result into a score from 0 to 5. Each KPI refers to one "
        "scoring policy; the version in force when its sheet is published is frozen on the "
        "sheet. " + _KPI_SOURCES_NOTE
    ),
    schema_version=1,
    code_prefix="KSM",
    standard_inputs=(
        FieldSpec("achievement_percent", "Achievement %", DataType.PERCENT, "input", unit="%",
                  description="Quarterly actual ÷ quarterly target × 100.",
                  source=Source.PERCENT_OF_TARGET),
        FieldSpec("actual", "Quarterly actual", DataType.DECIMAL, "input",
                  description="The quarterly actual in the KPI's own unit.",
                  source=Source.ACTUAL),
        FieldSpec("incident_count", "Number of incidents", DataType.INTEGER, "input", min="0",
                  description="Quarterly count, e.g. for a zero-tolerance KPI.",
                  source=Source.ACTUAL),
        FieldSpec("variance", "Actual minus target", DataType.DECIMAL, "input",
                  description="Quarterly actual − quarterly target, in the KPI's unit.",
                  source=Source.DIFFERENCE_FROM_TARGET),
        FieldSpec("target", "Quarterly target", DataType.DECIMAL, "input",
                  description="The sheet item's quarterly target.", source=Source.TARGET),
    ),
    outputs=(
        FieldSpec("score", "Score", DataType.INTEGER, "output", min="0", max="5",
                  description="KPI score from 0 to 5. A matrix may return 0 where configured, "
                              "although the ordinary rating scale is 1–5."),
    ),
    allow_custom_inputs=True,
    custom_input_types=frozenset(DataType),
    custom_input_source=Source.IMPORTED,
    max_inputs=4,
    selection=Selection.REFERENCE,
    read_permission=Permission.MATRIX_READ,
    attributes=(
        AttributeSpec("direction", "What good looks like", tuple(d.value for d in KpiDirection),
                      "Chosen explicitly; never inferred from a KPI's title. KPIs can use "
                      "only scoring policies with the same direction."),
    ),
)

KRA_PERFORMANCE = MatrixTypeSpec(
    code="KRA_PERFORMANCE",
    name="KRA performance matrix",
    description="Maps a weighted KPI score (and other approved inputs) to a performance "
                "rating on the ordinary 1–5 scale.",
    schema_version=1,
    code_prefix="KRM",
    standard_inputs=(
        FieldSpec("weighted_score", "Weighted KPI score", DataType.DECIMAL, "input", min="0",
                  max="5", description="Weighted score (0–5); for compensation, the employee's "
                                       "approved annual final score.",
                  source=Source.MANUAL),
    ),
    outputs=(
        FieldSpec("rating", "Performance rating", DataType.INTEGER, "output", min="1", max="5",
                  description="Rating on the ordinary 1–5 scale."),
    ),
    allow_custom_inputs=True,
    custom_input_types=frozenset({DataType.DECIMAL, DataType.INTEGER, DataType.PERCENT,
                                  DataType.CATEGORY, DataType.BOOLEAN}),
    custom_input_source=Source.MANUAL,
    allow_custom_outputs=True,
    custom_output_types=frozenset({DataType.CATEGORY, DataType.DECIMAL, DataType.INTEGER}),
    max_inputs=6,
    selection=Selection.APPLICABILITY,
    read_permission=Permission.MATRIX_READ,
    policy_note="Awaiting approved configuration: no KRA performance matrix has been "
                "approved yet. Nothing is calculated with this type until one is.",
)

CR_IMPACT = MatrixTypeSpec(
    code="CR_IMPACT",
    name="Compa-ratio impact matrix",
    description="Describes how an employee's compa-ratio position (salary ÷ the cycle's "
                "reference salary) and rating affect compensation. Outputs are defined by HR; "
                "a compensation cycle using the impact-multiplier method reads the output "
                "'increment_multiplier', applied to the base increment.",
    schema_version=1,
    code_prefix="CRM",
    standard_inputs=(
        FieldSpec("compa_ratio", "Compa-ratio", DataType.DECIMAL, "input", min="0",
                  description="Current salary ÷ the compensation cycle's reference salary "
                              "(e.g. the salary-range midpoint), from its salary baseline; "
                              "1.0000 = at the reference.", source=Source.MANUAL),
        FieldSpec("performance_rating", "Performance rating", DataType.INTEGER, "input",
                  min="1", max="5", description="Rating on the ordinary 1–5 scale.",
                  source=Source.MANUAL),
    ),
    outputs=(),
    allow_custom_inputs=True,
    custom_input_types=frozenset({DataType.DECIMAL, DataType.INTEGER, DataType.PERCENT,
                                  DataType.CATEGORY}),
    custom_input_source=Source.MANUAL,
    allow_custom_outputs=True,
    custom_output_types=frozenset({DataType.DECIMAL, DataType.PERCENT, DataType.INTEGER,
                                   DataType.CATEGORY}),
    max_inputs=6,
    selection=Selection.APPLICABILITY,
    read_permission=Permission.MATRIX_READ_COMPENSATION,
    policy_note="Awaiting approved configuration: CR bands, salary-range midpoints and "
                "their impact have not been defined or approved.",
)

INCREMENT = MatrixTypeSpec(
    code="INCREMENT",
    name="Increment matrix",
    description="Gives the increment percentage for a rating and compa-ratio position.",
    schema_version=1,
    code_prefix="INM",
    standard_inputs=(
        FieldSpec("performance_rating", "Performance rating", DataType.INTEGER, "input",
                  min="1", max="5", description="Rating on the ordinary 1–5 scale.",
                  source=Source.MANUAL),
        FieldSpec("compa_ratio", "Compa-ratio", DataType.DECIMAL, "input", min="0",
                  description="Current salary ÷ the compensation cycle's reference salary "
                              "(e.g. the salary-range midpoint), from its salary baseline; "
                              "1.0000 = at the reference.", source=Source.MANUAL),
    ),
    outputs=(
        FieldSpec("increment_percent", "Increment %", DataType.PERCENT, "output", unit="%",
                  min="0", description="Increment as a percentage of current pay."),
    ),
    allow_custom_inputs=True,
    custom_input_types=frozenset({DataType.DECIMAL, DataType.INTEGER, DataType.PERCENT,
                                  DataType.CATEGORY}),
    custom_input_source=Source.MANUAL,
    allow_custom_outputs=True,
    custom_output_types=frozenset({DataType.DECIMAL, DataType.PERCENT, DataType.CATEGORY}),
    max_inputs=6,
    selection=Selection.APPLICABILITY,
    read_permission=Permission.MATRIX_READ_COMPENSATION,
    policy_note="Awaiting approved configuration: increment percentages and budget rules "
                "have not been defined or approved.",
)

def _normalization_settings(raw: Any, definition: Any, report: Any) -> Any:
    """Validate a normalization version's settings and their fit with its fields
    and rules (imported lazily: the policy module uses the rule engine)."""
    from app.services import normalization_policy as policy

    settings = policy.parse_settings(raw, report)
    if settings is None:
        return None
    keys = set(settings.keys)
    group_field = definition.field("group")
    if group_field is not None and set(group_field.allowed_values) != keys:
        report.error("fields", f"{group_field.label} must list exactly the groups of the "
                               f"settings: {', '.join(settings.keys)}.")
    if definition.no_match is None or definition.no_match.mode == "error":
        covered: set[str] = set()
        for rule in definition.rules:
            condition = rule.conditions.get("group")
            covered |= keys if condition is None else set(condition.values)
        missing = [k for k in settings.keys if k not in covered]
        if definition.rules and missing:
            report.error("rules", f"No rule gives a rating for {', '.join(missing)}; add one, or a "
                                  "default result.")
    return settings


def _normalization_initial() -> dict[str, Any]:
    from app.services import normalization_policy as policy

    settings = policy.default_settings()
    group = NORMALIZATION.standard_input("group").as_definition()
    group["allowed_values"] = [g["key"] for g in settings["groups"]]
    return {"fields": [group, *(f.as_definition() for f in NORMALIZATION.outputs)],
            "rules": [], "no_match": None, "test_cases": [], "settings": settings}


NORMALIZATION = MatrixTypeSpec(
    code="NORMALIZATION",
    name="Normalization policy",
    description=(
        "Compares the employees of a cohort (for example one department across all plants) "
        "by their quarterly score, places them in groups with target shares (for example "
        "top 20 %, middle 60 %, bottom 20 %), and maps each group to a normalized rating. "
        "Each employee is counted once, through their primary assignment."
    ),
    schema_version=1,
    code_prefix="NRM",
    standard_inputs=(
        FieldSpec("group", "Performance group", DataType.CATEGORY, "input",
                  description="The group the employee was placed in.", source=Source.MANUAL),
        FieldSpec("score", "Quarterly score", DataType.DECIMAL, "input", min="0", max="5",
                  required=False, description="The employee's final quarterly score.",
                  source=Source.MANUAL),
    ),
    outputs=(
        FieldSpec("rating", "Normalized rating", DataType.DECIMAL, "output", min="0", max="5",
                  description="The rating the group (and score) leads to; defined by the "
                              "approved policy, never fixed in code."),
    ),
    allow_custom_inputs=False,
    custom_input_types=frozenset(),
    custom_input_source=Source.MANUAL,
    max_inputs=2,
    max_outputs=1,
    selection=Selection.APPLICABILITY,
    read_permission=Permission.MATRIX_READ,
    settings_hook=_normalization_settings,
    initial_definition=_normalization_initial,
    excel_templates=False,
)

REGISTRY: dict[str, MatrixTypeSpec] = {
    spec.code: spec for spec in (KPI_SCORING, KRA_PERFORMANCE, CR_IMPACT, INCREMENT, NORMALIZATION)
}


class UnknownMatrixType(KeyError):
    pass


def get_type(code: str) -> MatrixTypeSpec:
    try:
        return REGISTRY[code]
    except KeyError:
        raise UnknownMatrixType(code) from None


def field_metadata(spec: FieldSpec) -> dict[str, Any]:
    data = spec.as_definition()
    data["data_type_label"] = DATA_TYPE_LABELS[spec.data_type]
    data["source_label"] = SOURCE_LABELS[spec.source] if spec.source else None
    return data


def type_metadata(spec: MatrixTypeSpec) -> dict[str, Any]:
    """Everything a client needs to render forms for this type."""
    return {
        "code": spec.code,
        "name": spec.name,
        "description": spec.description,
        "schema_version": spec.schema_version,
        "standard_inputs": [field_metadata(f) for f in spec.standard_inputs],
        "outputs": [field_metadata(f) for f in spec.outputs],
        "allow_custom_inputs": spec.allow_custom_inputs,
        "custom_input_types": sorted(t.value for t in spec.custom_input_types),
        "custom_input_source": spec.custom_input_source.value,
        "allow_custom_outputs": spec.allow_custom_outputs,
        "custom_output_types": sorted(t.value for t in spec.custom_output_types),
        "aggregations": {t.value: sorted(a.value for a in aggs)
                         for t, aggs in AGGREGATIONS_BY_TYPE.items()},
        "max_inputs": spec.max_inputs,
        "max_outputs": spec.max_outputs,
        "max_rules": spec.max_rules,
        "selection": spec.selection.value,
        "attributes": [
            {"key": a.key, "label": a.label, "allowed_values": list(a.allowed_values),
             "description": a.description}
            for a in spec.attributes
        ],
        "policy_note": spec.policy_note,
        "data_type_labels": {t.value: label for t, label in DATA_TYPE_LABELS.items()},
        "source_labels": {s.value: label for s, label in SOURCE_LABELS.items()},
        "excel_templates": spec.excel_templates,
        "settings": _settings_metadata(spec),
    }


def _settings_metadata(spec: MatrixTypeSpec) -> dict[str, Any] | None:
    """The choices a type's settings offer, with labels (normalization only)."""
    if spec.code != NORMALIZATION.code:
        return None
    from app.services import normalization_policy as policy

    return {
        "kind": "normalization",
        "cohort_levels": policy.COHORT_LEVELS,
        "size_rounding": policy.ROUNDING,
        "rank_by": policy.RANK_BY,
        "ties": policy.TIES,
        "small_cohort": policy.SMALL_COHORT,
        "max_groups": policy.MAX_GROUPS,
    }
