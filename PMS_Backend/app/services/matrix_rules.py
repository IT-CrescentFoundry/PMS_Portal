"""Decision-table matrices: parse, validate and evaluate a version's content.

Definition JSON (stored on matrix_versions.definition):

    {
      "fields": [
        {"key": "achievement_percent", "label": "Achievement %", "role": "input",
         "data_type": "PERCENT", "unit": "%", "required": true, "min": null, "max": null,
         "allowed_values": null, "source": "PERCENT_OF_TARGET", "aggregation": null,
         "round_to": null, "description": null},
        {"key": "score", "label": "Score", "role": "output", "data_type": "INTEGER",
         "min": "0", "max": "5", ...}
      ],
      "rules": [
        {"priority": 1, "label": "Above target",
         "conditions": {"achievement_percent": {"min": "100", "min_inclusive": false,
                                                "max": null, "max_inclusive": null}},
         "outputs": {"score": 5}}
      ],
      "no_match": {"mode": "default", "outputs": {"score": 0}},  # or {"mode": "error"}
      "test_cases": [{"label": "On target", "inputs": {"achievement_percent": "100"},
                      "expected": {"score": 4}}]
    }

Conditions by data type:
  numbers, dates  {"min", "min_inclusive", "max", "max_inclusive"}; at least one
                  bound, and each given bound states whether it is included
  category        {"values": ["A", "B"]}
  yes/no          {"value": true}
A field without a condition in a rule matches any value.

Semantics, chosen so that nothing is ever decided silently:
  * At most one rule may match any input: overlapping rules are invalid, and
    an ambiguous match at evaluation time is an error, never a choice.
  * Whether a boundary is included is always explicit, so "more than 100"
    (exactly 100 scores the band below, as in the source workbook) and "at
    least 100" cannot be confused.
  * When no rule matches, the version's explicit no_match setting applies:
    a default output, or an evaluation error.
  * Numbers are Decimals end to end; NaN and infinity are refused. An
    input's `round_to` (decimal places, half-up) is applied before matching.
  * Nothing here is ever executed as code.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from app.models.enums import KpiDirection
from app.services.matrix_types import (
    AGGREGATIONS_BY_TYPE,
    DISCRETE_RANGE_TYPES,
    NUMERIC_TYPES,
    RANGE_TYPES,
    Aggregation,
    DataType,
    MatrixTypeSpec,
    Source,
)

KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
MAX_FIELDS = 12
MAX_TEST_CASES = 100
MAX_ALLOWED_VALUES = 50
MAX_PRIORITY = 9999
NO_MATCH_MODES = ("default", "error")
RANGE_KEYS = frozenset({"min", "min_inclusive", "max", "max_inclusive"})

# Protected personal attributes: never usable in performance or compensation
# matrices (matched as whole words in a field's key or label).
_PROTECTED = re.compile(
    r"(?:^|[^a-z])(age|ages|aged|gender\w*|sex|sexes|dob|birth\w*|religio\w*|caste\w*|"
    r"marital|pregnan\w*|ethnic\w*|race|races|nationalit\w*|disab\w*)(?:[^a-z]|$)"
)


# --- values ---------------------------------------------------------------------------------

_PLAIN_NUMBER = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")
# Thousands (1,234,567) or Indian lakh (1,23,456) grouping; never a decimal comma.
_GROUPED_NUMBER = re.compile(
    r"^[+-]?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$"
)


def parse_decimal(value: Any, *, integer: bool = False) -> Decimal:
    """A finite Decimal from a JSON/Excel/CSV value; raises ValueError."""
    if value is None or isinstance(value, bool):
        raise ValueError("Enter a number.")
    if isinstance(value, Decimal):
        number = value
    elif isinstance(value, int):
        number = Decimal(value)
    elif isinstance(value, float):
        number = Decimal(repr(value))  # shortest round-trip text, never binary noise
    elif isinstance(value, str):
        text = value.strip()
        if _GROUPED_NUMBER.match(text):
            text = text.replace(",", "")
        if not _PLAIN_NUMBER.match(text):
            raise ValueError(f"'{value.strip()}' is not a number (use a dot for decimals).")
        number = Decimal(text)
    else:
        raise ValueError("Enter a number.")
    if not number.is_finite():
        raise ValueError("Numbers must be finite (not NaN or infinity).")
    if integer and number != number.to_integral_value():
        raise ValueError("Enter a whole number.")
    return number


def parse_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            pass
    raise ValueError("Enter a date as YYYY-MM-DD.")


_TRUE = {"yes", "y", "true", "1"}
_FALSE = {"no", "n", "false", "0"}


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
    raise ValueError("Enter Yes or No.")


def decimal_text(number: Decimal) -> str:
    """Canonical text: 100 -> '100', 0.50 -> '0.5'."""
    text = format(number.normalize(), "f")
    return "0" if text in ("-0", "") else text


def jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return decimal_text(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


def canonical_json(data: Any) -> str:
    return json.dumps(jsonable(data), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def definition_hash(data: Mapping[str, Any]) -> str:
    """SHA-256 of a definition's canonical JSON (detects any change of content)."""
    return hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


# --- intervals --------------------------------------------------------------------------------

@dataclass(frozen=True)
class Interval:
    """A range of numbers or dates; None is unbounded on that side."""

    lo: Any = None
    lo_inclusive: bool = True
    hi: Any = None
    hi_inclusive: bool = True


def _step(data_type: DataType) -> Any:
    return timedelta(days=1) if data_type == DataType.DATE else Decimal(1)


def normalized(iv: Interval, data_type: DataType) -> Interval:
    """Whole numbers and dates are discrete: '> 2' is '>= 3'."""
    if data_type not in DISCRETE_RANGE_TYPES:
        return iv
    step = _step(data_type)
    lo = iv.lo + step if iv.lo is not None and not iv.lo_inclusive else iv.lo
    hi = iv.hi - step if iv.hi is not None and not iv.hi_inclusive else iv.hi
    return Interval(lo, True, hi, True)


def is_empty(iv: Interval) -> bool:
    if iv.lo is None or iv.hi is None or iv.lo < iv.hi:
        return False
    if iv.lo > iv.hi:
        return True
    return not (iv.lo_inclusive and iv.hi_inclusive)


def _max_lower(a: Interval, b: Interval) -> tuple[Any, bool]:
    if a.lo is None:
        return b.lo, b.lo_inclusive
    if b.lo is None or a.lo > b.lo:
        return a.lo, a.lo_inclusive
    if b.lo > a.lo:
        return b.lo, b.lo_inclusive
    return a.lo, a.lo_inclusive and b.lo_inclusive


def _min_upper(a: Interval, b: Interval) -> tuple[Any, bool]:
    if a.hi is None:
        return b.hi, b.hi_inclusive
    if b.hi is None or a.hi < b.hi:
        return a.hi, a.hi_inclusive
    if b.hi < a.hi:
        return b.hi, b.hi_inclusive
    return a.hi, a.hi_inclusive and b.hi_inclusive


def intersect(a: Interval, b: Interval) -> Interval | None:
    lo, lo_inc = _max_lower(a, b)
    hi, hi_inc = _min_upper(a, b)
    iv = Interval(lo, lo_inc, hi, hi_inc)
    return None if is_empty(iv) else iv


def contains(iv: Interval, value: Any) -> bool:
    if iv.lo is not None and (value < iv.lo or (value == iv.lo and not iv.lo_inclusive)):
        return False
    if iv.hi is not None and (value > iv.hi or (value == iv.hi and not iv.hi_inclusive)):
        return False
    return True


# --- definition model ----------------------------------------------------------------------

@dataclass(frozen=True)
class FieldDef:
    key: str
    label: str
    role: str
    data_type: DataType
    unit: str | None
    description: str | None
    required: bool
    min: Any
    max: Any
    allowed_values: tuple[str, ...]
    source: Source | None
    aggregation: Aggregation | None
    round_to: int | None

    @property
    def is_input(self) -> bool:
        return self.role == "input"

    @property
    def domain(self) -> Interval:
        return Interval(self.min, True, self.max, True)

    def canonical_category(self, value: str) -> str | None:
        wanted = value.strip().casefold()
        return next((v for v in self.allowed_values if v.casefold() == wanted), None)

    def fmt(self, value: Any) -> str:
        if isinstance(value, bool):
            return "Yes" if value else "No"
        if isinstance(value, date):
            return value.isoformat()
        if isinstance(value, Decimal):
            text = decimal_text(value)
            if self.data_type == DataType.PERCENT:
                return f"{text}%"
            return f"{text} {self.unit}" if self.unit else text
        return str(value)


@dataclass(frozen=True)
class RangeCondition:
    interval: Interval  # as written (bounds and inclusiveness)

    def matches(self, f: FieldDef, value: Any) -> bool:
        return contains(normalized(self.interval, f.data_type), value)


@dataclass(frozen=True)
class SetCondition:
    values: frozenset[str]

    def matches(self, f: FieldDef, value: Any) -> bool:
        return value in self.values


@dataclass(frozen=True)
class BoolCondition:
    value: bool

    def matches(self, f: FieldDef, value: Any) -> bool:
        return value is self.value


Condition = RangeCondition | SetCondition | BoolCondition


@dataclass(frozen=True)
class RuleDef:
    priority: int
    label: str | None
    conditions: dict[str, Condition]
    outputs: dict[str, Any]

    @property
    def name(self) -> str:
        return f"Rule {self.priority}" + (f" ('{self.label}')" if self.label else "")


@dataclass(frozen=True)
class NoMatch:
    mode: str  # "default" | "error"
    outputs: dict[str, Any] | None


@dataclass(frozen=True)
class TestCaseDef:
    label: str
    inputs: dict[str, Any]
    expected: dict[str, Any]


@dataclass
class Definition:
    fields: list[FieldDef]
    rules: list[RuleDef]
    no_match: NoMatch | None
    test_cases: list[TestCaseDef]
    # False when any part failed to parse; such a definition is never evaluated.
    evaluable: bool = True
    # Type-specific settings, parsed by the type's settings_hook (or None).
    settings: Any = None

    @property
    def inputs(self) -> list[FieldDef]:
        return [f for f in self.fields if f.is_input]

    @property
    def outputs(self) -> list[FieldDef]:
        return [f for f in self.fields if not f.is_input]

    def field(self, key: str) -> FieldDef | None:
        return next((f for f in self.fields if f.key == key), None)


@dataclass(frozen=True)
class Problem:
    path: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "message": self.message}


@dataclass
class TestResult:
    label: str
    passed: bool
    expected: dict[str, Any]
    actual: dict[str, Any] | None
    rule: int | None
    error: str | None

    def as_dict(self) -> dict[str, Any]:
        return {"label": self.label, "passed": self.passed, "expected": jsonable(self.expected),
                "actual": jsonable(self.actual), "rule": self.rule, "error": self.error}


@dataclass
class Report:
    errors: list[Problem] = field(default_factory=list)
    warnings: list[Problem] = field(default_factory=list)
    test_results: list[TestResult] = field(default_factory=list)
    gaps: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def error(self, path: str, message: str) -> None:
        self.errors.append(Problem(path, message))

    def warn(self, path: str, message: str) -> None:
        self.warnings.append(Problem(path, message))

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "errors": [p.as_dict() for p in self.errors],
            "warnings": [p.as_dict() for p in self.warnings],
            "test_results": [t.as_dict() for t in self.test_results],
            "gaps": list(self.gaps),
        }


# --- descriptions -------------------------------------------------------------------------

def describe_interval(f: FieldDef, iv: Interval) -> str:
    dates = f.data_type == DataType.DATE
    if (iv.lo is not None and iv.hi is not None and iv.lo == iv.hi
            and iv.lo_inclusive and iv.hi_inclusive):
        return f"on {f.fmt(iv.lo)}" if dates else f"exactly {f.fmt(iv.lo)}"
    parts = []
    if iv.lo is not None:
        word = ("on or after" if iv.lo_inclusive else "after") if dates else (
            "at least" if iv.lo_inclusive else "more than")
        parts.append(f"{word} {f.fmt(iv.lo)}")
    if iv.hi is not None:
        word = ("on or before" if iv.hi_inclusive else "before") if dates else (
            "at most" if iv.hi_inclusive else "less than")
        parts.append(f"{word} {f.fmt(iv.hi)}")
    return " and ".join(parts) or "any value"


def describe_condition(f: FieldDef, c: Condition) -> str:
    if isinstance(c, RangeCondition):
        return f"{f.label} is {describe_interval(f, c.interval)}"
    if isinstance(c, SetCondition):
        ordered = [v for v in f.allowed_values if v in c.values]
        return f"{f.label} is {' or '.join(ordered)}"
    return f"{f.label} is {'Yes' if c.value else 'No'}"


def describe_rule(definition: Definition, rule: RuleDef) -> str:
    parts = [describe_condition(f, rule.conditions[f.key])
             for f in definition.inputs if f.key in rule.conditions]
    return " and ".join(parts)


# --- parsing ------------------------------------------------------------------------------

def _protected(text: str) -> bool:
    return bool(_PROTECTED.search(text.lower().replace("_", " ")))


def _parse_typed(data_type: DataType, value: Any, f: FieldDef | None = None) -> Any:
    """A value of the field's data type (ValueError with a readable message)."""
    if data_type in NUMERIC_TYPES:
        return parse_decimal(value, integer=data_type == DataType.INTEGER)
    if data_type == DataType.DATE:
        return parse_date(value)
    if data_type == DataType.BOOLEAN:
        return parse_bool(value)
    # CATEGORY
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Choose one of the listed values.")
    if f is not None:
        canonical = f.canonical_category(value)
        if canonical is None:
            raise ValueError(f"'{value.strip()}' is not one of: {', '.join(f.allowed_values)}.")
        return canonical
    return value.strip()


def _check_range(f: FieldDef, value: Any) -> None:
    if f.min is not None and value < f.min:
        raise ValueError(f"must be at least {f.fmt(f.min)}.")
    if f.max is not None and value > f.max:
        raise ValueError(f"must be at most {f.fmt(f.max)}.")


def parse_value(f: FieldDef, raw: Any) -> Any:
    """A raw value (JSON, CSV or Excel) as the field's data type, without
    rounding or range checks (e.g. one month of an imported input)."""
    return _parse_typed(f.data_type, raw, f)


def coerce_input(f: FieldDef, raw: Any) -> Any:
    """Typed, rounded and range-checked input value (ValueError if invalid)."""
    value = _parse_typed(f.data_type, raw, f)
    if f.round_to is not None and isinstance(value, Decimal):
        value = value.quantize(Decimal(1).scaleb(-f.round_to), rounding=ROUND_HALF_UP)
    if f.data_type in RANGE_TYPES:
        _check_range(f, value)
    return value


def _output_value(f: FieldDef, raw: Any) -> Any:
    value = _parse_typed(f.data_type, raw, f)
    if f.data_type in RANGE_TYPES:
        _check_range(f, value)
    return int(value) if f.data_type == DataType.INTEGER else value


def _parse_field(spec: MatrixTypeSpec | None, raw: Any, index: int,
                 report: Report) -> FieldDef | None:
    """One field. With spec=None (a frozen version being evaluated) only the
    stored definition is used, so old versions stay interpretable even after
    their type changes; type conformance is checked when spec is given."""
    path = f"fields[{index}]"
    if not isinstance(raw, Mapping):
        report.error(path, "Each field must be an object.")
        return None
    errors_before = len(report.errors)
    key = raw.get("key")
    if not isinstance(key, str) or not KEY_PATTERN.fullmatch(key):
        report.error(f"{path}.key", "Use a key of lower-case letters, digits and underscores, "
                                    "starting with a letter (at most 40 characters).")
        return None
    label = str(raw.get("label") or "").strip()
    if not 1 <= len(label) <= 100:
        report.error(f"{path}.label", f"Give '{key}' a label of 1–100 characters.")
    if _protected(key) or _protected(label):
        report.error(path, f"'{label or key}' looks like a protected personal attribute (such as "
                           "age, gender or religion). These may never be used in performance or "
                           "compensation matrices.")
    role = raw.get("role")
    if role not in ("input", "output"):
        report.error(f"{path}.role", f"'{key}': the role must be input or output.")
        return None
    try:
        data_type = DataType(raw.get("data_type"))
    except ValueError:
        report.error(f"{path}.data_type", f"'{key}': unsupported data type "
                                          f"'{raw.get('data_type')}'.")
        return None
    unit = raw.get("unit")
    if unit is not None and (not isinstance(unit, str) or len(unit) > 20):
        report.error(f"{path}.unit", f"'{key}': the unit must be text of at most 20 characters.")
    unit = unit.strip() or None if isinstance(unit, str) else None
    description = raw.get("description")
    if description is not None and (not isinstance(description, str) or len(description) > 500):
        report.error(f"{path}.description", f"'{key}': the description must be at most 500 "
                                            "characters.")
        description = None
    required = raw.get("required", True)
    if not isinstance(required, bool):
        report.error(f"{path}.required", f"'{key}': required must be true or false.")
        required = True

    allowed: tuple[str, ...] = ()
    raw_allowed = raw.get("allowed_values")
    if data_type == DataType.CATEGORY:
        if not isinstance(raw_allowed, list) or not raw_allowed:
            report.error(f"{path}.allowed_values", f"'{key}': list the allowed values.")
        else:
            cleaned = [str(v).strip() for v in raw_allowed if isinstance(v, (str, int))]
            if len(cleaned) != len(raw_allowed) or any(not v or len(v) > 100 for v in cleaned):
                report.error(f"{path}.allowed_values", f"'{key}': each allowed value must be "
                                                       "text of 1–100 characters.")
            elif len({v.casefold() for v in cleaned}) != len(cleaned):
                report.error(f"{path}.allowed_values", f"'{key}': allowed values must be unique.")
            elif len(cleaned) > MAX_ALLOWED_VALUES:
                report.error(f"{path}.allowed_values", f"'{key}': at most {MAX_ALLOWED_VALUES} "
                                                       "allowed values.")
            allowed = tuple(cleaned)
    elif raw_allowed not in (None, []):
        report.error(f"{path}.allowed_values", f"'{key}': only category fields list allowed "
                                               "values.")

    bounds: dict[str, Any] = {"min": None, "max": None}
    for side in ("min", "max"):
        value = raw.get(side)
        if _blank(value):
            continue
        if data_type not in RANGE_TYPES:
            report.error(f"{path}.{side}", f"'{key}': only numbers and dates have a {side}imum.")
            continue
        try:
            bounds[side] = _parse_typed(data_type, value)
        except ValueError as exc:
            report.error(f"{path}.{side}", f"'{key}' {side}imum: {exc}")
    if bounds["min"] is not None and bounds["max"] is not None and bounds["min"] > bounds["max"]:
        report.error(path, f"'{key}': the minimum is greater than the maximum.")

    round_to = raw.get("round_to")
    if round_to is not None:
        if (not isinstance(round_to, int) or isinstance(round_to, bool)
                or not 0 <= round_to <= 6):
            report.error(f"{path}.round_to", f"'{key}': round to 0–6 decimal places.")
            round_to = None
        elif data_type not in (DataType.DECIMAL, DataType.PERCENT):
            report.error(f"{path}.round_to", f"'{key}': only decimal numbers can be rounded.")
            round_to = None

    source: Source | None = None
    aggregation: Aggregation | None = None
    raw_source, raw_aggregation = raw.get("source"), raw.get("aggregation")
    if spec is None:
        try:
            source = Source(raw_source) if raw_source is not None else None
            aggregation = Aggregation(raw_aggregation) if raw_aggregation is not None else None
        except ValueError:
            report.error(path, f"'{key}': unknown source or aggregation.")
        if role == "input" and source is None:
            report.error(f"{path}.source", f"'{key}': the input has no source.")
    elif role == "input":
        standard = spec.standard_input(key)
        if standard is not None:
            if data_type != standard.data_type:
                report.error(f"{path}.data_type", f"'{key}' is a standard field of type "
                                                  f"{standard.data_type.value}.")
            if raw_source not in (None, standard.source.value if standard.source else None):
                report.error(f"{path}.source", f"'{key}' always comes from "
                                               f"{standard.source.value if standard.source else 'input'}.")
            source = standard.source
        else:
            if not spec.allow_custom_inputs:
                report.error(path, f"'{key}' is not a field of this matrix type.")
            elif data_type not in spec.custom_input_types:
                report.error(f"{path}.data_type", f"'{key}': {data_type.value} inputs are not "
                                                  "allowed in this matrix type.")
            if raw_source not in (None, spec.custom_input_source.value):
                report.error(f"{path}.source", f"'{key}': custom inputs of this type come from "
                                               f"{spec.custom_input_source.value}.")
            source = spec.custom_input_source
        if source == Source.IMPORTED:
            try:
                aggregation = Aggregation(raw_aggregation)
            except ValueError:
                report.error(f"{path}.aggregation", f"'{key}': choose how monthly values combine "
                                                    "into the quarter.")
            if aggregation is not None and aggregation not in AGGREGATIONS_BY_TYPE[data_type]:
                report.error(f"{path}.aggregation", f"'{key}': {aggregation.value} does not suit "
                                                    f"{data_type.value} values.")
                aggregation = None
        elif raw_aggregation is not None:
            report.error(f"{path}.aggregation", f"'{key}': only imported inputs have an "
                                                "aggregation.")
    else:
        standard = spec.standard_output(key)
        if standard is not None:
            if data_type != standard.data_type:
                report.error(f"{path}.data_type", f"'{key}' is a standard output of type "
                                                  f"{standard.data_type.value}.")
            else:
                for side, limit in (("min", standard.min), ("max", standard.max)):
                    if limit is None:
                        continue
                    allowed_limit = _parse_typed(data_type, limit)
                    value = bounds[side]
                    outside = value is None or (value < allowed_limit if side == "min"
                                                else value > allowed_limit)
                    if outside:
                        report.error(f"{path}.{side}", f"'{key}': the {side}imum must stay "
                                                       f"within {limit}.")
        elif not spec.allow_custom_outputs:
            report.error(path, f"'{key}' is not an output of this matrix type.")
        elif data_type not in spec.custom_output_types:
            report.error(f"{path}.data_type", f"'{key}': {data_type.value} outputs are not "
                                              "allowed in this matrix type.")
        if raw_source is not None or raw_aggregation is not None:
            report.error(path, f"'{key}': outputs have no source or aggregation.")

    if len(report.errors) > errors_before:
        return None
    return FieldDef(key=key, label=label, role=role, data_type=data_type, unit=unit,
                    description=description, required=required, min=bounds["min"],
                    max=bounds["max"], allowed_values=allowed, source=source,
                    aggregation=aggregation, round_to=round_to)


def _parse_condition(f: FieldDef, raw: Any, path: str, report: Report) -> Condition | None:
    if not isinstance(raw, Mapping):
        report.error(path, f"{f.label}: each condition must be an object.")
        return None
    if f.data_type in RANGE_TYPES:
        extra = set(raw) - RANGE_KEYS
        if extra:
            report.error(path, f"{f.label}: unsupported condition setting(s): "
                               f"{', '.join(sorted(extra))}.")
            return None
        lo_raw, hi_raw = raw.get("min"), raw.get("max")
        if _blank(lo_raw) and _blank(hi_raw):
            report.error(path, f"{f.label}: give a lower or an upper bound, or leave the field "
                               "out of the rule to match any value.")
            return None
        bounds: dict[str, Any] = {}
        ok = True
        for side, raw_value in (("min", lo_raw), ("max", hi_raw)):
            if _blank(raw_value):
                bounds[side], bounds[f"{side}_inclusive"] = None, True
                continue
            try:
                bounds[side] = _parse_typed(f.data_type, raw_value)
            except ValueError as exc:
                report.error(f"{path}.{side}", f"{f.label} {'lower' if side == 'min' else 'upper'} "
                                               f"bound: {exc}")
                ok = False
                continue
            inclusive = raw.get(f"{side}_inclusive")
            if not isinstance(inclusive, bool):
                report.error(f"{path}.{side}_inclusive",
                             f"{f.label}: say whether the {'lower' if side == 'min' else 'upper'} "
                             f"bound {f.fmt(bounds[side])} is included.")
                ok = False
            bounds[f"{side}_inclusive"] = bool(inclusive)
        if not ok:
            return None
        iv = Interval(bounds["min"], bounds["min_inclusive"], bounds["max"], bounds["max_inclusive"])
        if is_empty(normalized(iv, f.data_type)):
            report.error(path, f"{f.label}: the range '{describe_interval(f, iv)}' contains no "
                               "values, so the rule can never match.")
            return None
        if intersect(normalized(iv, f.data_type), f.domain) is None:
            report.error(path, f"{f.label}: '{describe_interval(f, iv)}' lies outside the "
                               f"accepted values ({describe_interval(f, f.domain)}), so the rule "
                               "can never match.")
            return None
        return RangeCondition(iv)
    if f.data_type == DataType.CATEGORY:
        if set(raw) != {"values"}:
            report.error(path, f"{f.label}: a category condition lists 'values' only.")
            return None
        values = raw.get("values")
        if not isinstance(values, list) or not values:
            report.error(path, f"{f.label}: choose at least one value.")
            return None
        chosen = set()
        for v in values:
            canonical = f.canonical_category(v) if isinstance(v, str) else None
            if canonical is None:
                report.error(path, f"{f.label}: '{v}' is not one of: {', '.join(f.allowed_values)}.")
                return None
            chosen.add(canonical)
        return SetCondition(frozenset(chosen))
    # BOOLEAN
    if set(raw) != {"value"}:
        report.error(path, f"{f.label}: a yes/no condition has a 'value' only.")
        return None
    try:
        return BoolCondition(parse_bool(raw.get("value")))
    except ValueError as exc:
        report.error(path, f"{f.label}: {exc}")
        return None


def _parse_outputs(outputs: list[FieldDef], raw: Any, path: str, owner: str,
                   report: Report) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        report.error(path, f"{owner}: give the output values.")
        return None
    result: dict[str, Any] = {}
    ok = True
    known = {f.key for f in outputs}
    for extra in sorted(set(raw) - known):
        report.error(f"{path}.{extra}", f"{owner}: '{extra}' is not an output of this matrix.")
        ok = False
    for f in outputs:
        value = raw.get(f.key)
        if _blank(value):
            report.error(f"{path}.{f.key}", f"{owner}: enter the {f.label}.")
            ok = False
            continue
        try:
            result[f.key] = _output_value(f, value)
        except ValueError as exc:
            report.error(f"{path}.{f.key}", f"{owner}, {f.label}: {exc}")
            ok = False
    return result if ok else None


def _parse_priority(raw: Any) -> int | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        value = raw
    elif isinstance(raw, str) and raw.strip().isdigit():
        value = int(raw.strip())
    elif isinstance(raw, float) and raw.is_integer():
        value = int(raw)
    else:
        return None
    return value if 1 <= value <= MAX_PRIORITY else None


# --- analysis -----------------------------------------------------------------------------

def _intersect_conditions(f: FieldDef, a: Condition, b: Condition) -> Condition | None:
    if isinstance(a, RangeCondition) and isinstance(b, RangeCondition):
        iv = intersect(normalized(a.interval, f.data_type), normalized(b.interval, f.data_type))
        return RangeCondition(iv) if iv is not None else None
    if isinstance(a, SetCondition) and isinstance(b, SetCondition):
        common = a.values & b.values
        return SetCondition(common) if common else None
    if isinstance(a, BoolCondition) and isinstance(b, BoolCondition):
        return a if a.value == b.value else None
    return None


def _overlap(definition: Definition, a: RuleDef, b: RuleDef) -> list[str] | None:
    """Where both rules match (descriptions per field), or None if nowhere."""
    parts = []
    for f in definition.inputs:
        ca, cb = a.conditions.get(f.key), b.conditions.get(f.key)
        if ca is None and cb is None:
            continue
        if ca is None or cb is None:
            parts.append(describe_condition(f, ca or cb))  # type: ignore[arg-type]
            continue
        common = _intersect_conditions(f, ca, cb)
        if common is None:
            return None
        parts.append(describe_condition(f, common))
    return parts


def _gaps(f: FieldDef, rules: Sequence[RuleDef]) -> list[str]:
    """Values of a single input that no rule covers (descriptions)."""
    if f.data_type == DataType.CATEGORY:
        covered = set().union(*(r.conditions[f.key].values for r in rules
                                if isinstance(r.conditions.get(f.key), SetCondition)))
        return [f"{f.label} is {v}" for v in f.allowed_values if v not in covered]
    if f.data_type == DataType.BOOLEAN:
        covered = {r.conditions[f.key].value for r in rules
                   if isinstance(r.conditions.get(f.key), BoolCondition)}
        return [f"{f.label} is {'Yes' if v else 'No'}" for v in (True, False) if v not in covered]
    intervals = sorted(
        (normalized(r.conditions[f.key].interval, f.data_type) for r in rules
         if isinstance(r.conditions.get(f.key), RangeCondition)),
        key=lambda iv: (iv.lo is not None, iv.lo if iv.lo is not None else 0,
                        not iv.lo_inclusive),
    )
    domain = normalized(f.domain, f.data_type)
    gaps: list[Interval] = []
    # "covered up to" (value, value itself covered?); None value = nothing yet.
    cur, cur_inc = domain.lo, False
    at_start = True
    for iv in intervals:
        clipped = intersect(iv, domain)
        if clipped is None:
            continue
        if at_start and cur is None:
            if clipped.lo is not None:
                gaps.append(Interval(None, True, clipped.lo, not clipped.lo_inclusive))
        else:
            if cur is not None and clipped.lo is not None and (
                    cur < clipped.lo or (cur == clipped.lo and not cur_inc
                                         and not clipped.lo_inclusive)):
                gap = Interval(cur, not cur_inc, clipped.lo, not clipped.lo_inclusive)
                if not is_empty(normalized(gap, f.data_type)):
                    gaps.append(gap)
        at_start = False
        cur, cur_inc = clipped.hi, clipped.hi_inclusive
        if cur is None:
            break
    else:
        if at_start:
            gaps.append(domain)
        elif cur is not None:
            tail = Interval(cur, not cur_inc, domain.hi, domain.hi_inclusive)
            if domain.hi is None or not is_empty(normalized(tail, f.data_type)):
                gaps.append(tail)
    return [f"{f.label} is {describe_interval(f, normalized(g, f.data_type))}" for g in gaps]


def parse_definition(spec: MatrixTypeSpec | None, raw: Mapping[str, Any] | None,
                     report: Report) -> Definition:
    """Parse a definition, recording every problem in `report`. With
    spec=None, only the stored content is used (see _parse_field)."""
    raw = raw or {}
    if not isinstance(raw, Mapping):
        report.error("definition", "The definition must be an object.")
        return Definition([], [], None, [], evaluable=False)
    errors_before = len(report.errors)

    raw_fields = raw.get("fields") or []
    fields: list[FieldDef] = []
    declared: set[str] = set()
    if not isinstance(raw_fields, list):
        report.error("fields", "Fields must be a list.")
        raw_fields = []
    if len(raw_fields) > MAX_FIELDS:
        report.error("fields", f"Use at most {MAX_FIELDS} fields.")
    for i, rf in enumerate(raw_fields[:MAX_FIELDS]):
        key = rf.get("key") if isinstance(rf, Mapping) else None
        if isinstance(key, str):
            if key in declared:
                report.error(f"fields[{i}].key", f"The field '{key}' is listed twice.")
                continue
            declared.add(key)
        parsed = _parse_field(spec, rf, i, report)
        if parsed is not None:
            fields.append(parsed)
    inputs = [f for f in fields if f.is_input]
    outputs = [f for f in fields if not f.is_input]
    declared_inputs = {rf.get("key") for rf in raw_fields if isinstance(rf, Mapping)
                       and rf.get("role") == "input"}
    declared_outputs = {rf.get("key") for rf in raw_fields if isinstance(rf, Mapping)
                        and rf.get("role") == "output"}
    max_inputs = spec.max_inputs if spec else MAX_FIELDS
    max_outputs = spec.max_outputs if spec else MAX_FIELDS
    max_rules = spec.max_rules if spec else 1000
    if not declared_inputs:
        report.error("fields", "Add at least one input field.")
    elif len(declared_inputs) > max_inputs:
        report.error("fields", f"This matrix type allows at most {max_inputs} inputs.")
    for standard in spec.outputs if spec else ():
        if standard.key not in declared:
            report.error("fields", f"The output '{standard.label}' ({standard.key}) is required "
                                   "for this matrix type.")
    if not declared_outputs:
        report.error("fields", "Add at least one output field.")
    elif len(declared_outputs) > max_outputs:
        report.error("fields", f"This matrix type allows at most {max_outputs} outputs.")

    by_key = {f.key: f for f in fields}
    raw_rules = raw.get("rules") or []
    rules: list[RuleDef] = []
    if not isinstance(raw_rules, list):
        report.error("rules", "Rules must be a list.")
        raw_rules = []
    if not raw_rules:
        report.error("rules", "Add at least one rule.")
    if len(raw_rules) > max_rules:
        report.error("rules", f"This matrix type allows at most {max_rules} rules.")
    seen_priorities: dict[int, int] = {}
    for i, rr in enumerate(raw_rules[:max_rules]):
        path = f"rules[{i}]"
        if not isinstance(rr, Mapping):
            report.error(path, f"Rule {i + 1} must be an object.")
            continue
        priority = _parse_priority(rr.get("priority"))
        if priority is None:
            report.error(f"{path}.priority", f"Rule {i + 1}: the priority must be a whole number "
                                             f"from 1 to {MAX_PRIORITY}.")
            continue
        if priority in seen_priorities:
            report.error(f"{path}.priority", f"Priority {priority} is used by more than one rule; "
                                             "priorities must be unique.")
            continue
        seen_priorities[priority] = i
        label = rr.get("label")
        if label is not None and (not isinstance(label, str) or len(label) > 100):
            report.error(f"{path}.label", f"Rule {priority}: the label must be text of at most "
                                          "100 characters.")
            label = None
        label = label.strip() or None if isinstance(label, str) else None
        owner = f"Rule {priority}"
        raw_conditions = rr.get("conditions") or {}
        if not isinstance(raw_conditions, Mapping):
            report.error(f"{path}.conditions", f"{owner}: conditions must be an object.")
            continue
        conditions: dict[str, Condition] = {}
        rule_ok = True
        for key, rc in raw_conditions.items():
            cpath = f"{path}.conditions.{key}"
            if key not in declared:
                report.error(cpath, f"{owner}: '{key}' is not a field of this matrix.")
                rule_ok = False
                continue
            f = by_key.get(key)
            if f is None:  # declared but invalid: already reported
                rule_ok = False
                continue
            if not f.is_input:
                report.error(cpath, f"{owner}: '{f.label}' is an output, not a condition.")
                rule_ok = False
                continue
            condition = _parse_condition(f, rc, cpath, report)
            if condition is None:
                rule_ok = False
                continue
            conditions[key] = condition
        if rule_ok and not conditions:
            report.error(f"{path}.conditions", f"{owner} has no conditions; use 'When no rule "
                                               "matches' for everything else.")
            rule_ok = False
        rule_outputs = _parse_outputs(outputs, rr.get("outputs"), f"{path}.outputs", owner, report)
        if rule_ok and rule_outputs is not None:
            rules.append(RuleDef(priority, label, conditions, rule_outputs))
    rules.sort(key=lambda r: r.priority)

    raw_no_match = raw.get("no_match")
    no_match: NoMatch | None = None
    if not isinstance(raw_no_match, Mapping) or raw_no_match.get("mode") not in NO_MATCH_MODES:
        report.error("no_match", "Choose what happens when no rule matches: a default output, "
                                 "or stop with an error.")
    elif raw_no_match["mode"] == "default":
        default_outputs = _parse_outputs(outputs, raw_no_match.get("outputs"), "no_match.outputs",
                                         "Default output", report)
        if default_outputs is not None:
            no_match = NoMatch("default", default_outputs)
    else:
        if raw_no_match.get("outputs"):
            report.error("no_match.outputs", "With 'stop with an error', leave the default "
                                             "output empty.")
        no_match = NoMatch("error", None)

    test_cases: list[TestCaseDef] = []
    raw_cases = raw.get("test_cases") or []
    if not isinstance(raw_cases, list):
        report.error("test_cases", "Test cases must be a list.")
        raw_cases = []
    if len(raw_cases) > MAX_TEST_CASES:
        report.error("test_cases", f"Use at most {MAX_TEST_CASES} test cases.")
    for i, rc in enumerate(raw_cases[:MAX_TEST_CASES]):
        path = f"test_cases[{i}]"
        if not isinstance(rc, Mapping):
            report.error(path, f"Test case {i + 1} must be an object.")
            continue
        label = str(rc.get("label") or f"Test case {i + 1}").strip()[:100]
        case_inputs = rc.get("inputs") or {}
        if not isinstance(case_inputs, Mapping):
            report.error(f"{path}.inputs", f"'{label}': inputs must be an object.")
            continue
        unknown = [k for k in case_inputs if k not in declared_inputs]
        if unknown:
            report.error(f"{path}.inputs", f"'{label}': unknown input(s) {', '.join(unknown)}.")
            continue
        expected = _parse_outputs(outputs, rc.get("expected"), f"{path}.expected",
                                  f"Test case '{label}'", report)
        if expected is not None:
            test_cases.append(TestCaseDef(label, dict(case_inputs), expected))

    return Definition(fields, rules, no_match, test_cases,
                      evaluable=len(report.errors) == errors_before)


def analyse(spec: MatrixTypeSpec, raw: Mapping[str, Any] | None,
            attributes: Mapping[str, Any] | None = None) -> tuple[Definition, Report]:
    """Parse and fully validate a definition; never raises for bad content."""
    report = Report()
    definition = parse_definition(spec, raw, report)
    rules, inputs = definition.rules, definition.inputs
    raw_settings = raw.get("settings") if isinstance(raw, Mapping) else None
    if spec.settings_hook is not None:
        definition.settings = spec.settings_hook(raw_settings, definition, report)
    elif raw_settings not in (None, {}):
        report.error("settings", "This matrix type has no settings.")

    # Overlaps: at most one rule may match any input.
    for i, a in enumerate(rules):
        for b in rules[i + 1:]:
            where = _overlap(definition, a, b)
            if where is None:
                continue
            if a.conditions == b.conditions:
                report.error("rules", f"{a.name} and {b.name} have the same conditions.")
            else:
                report.error("rules", f"{a.name} and {b.name} overlap where "
                                      f"{' and '.join(where)}. Exactly one rule may match any "
                                      "input.")

    # Coverage (checked exactly for a single input).
    if len(inputs) == 1 and rules and not report.errors:
        f = inputs[0]
        gaps = _gaps(f, rules)
        report.gaps = gaps
        if definition.no_match and definition.no_match.mode == "error":
            if gaps:
                report.warn("no_match", f"No rule covers: {'; '.join(gaps)}. Such values stop "
                                        "with an error.")
            if not f.required:
                report.warn("no_match", f"When {f.label} is missing, no rule matches and "
                                        "evaluation stops with an error.")
        elif definition.no_match and not gaps and f.required:
            report.warn("no_match", "The rules cover every value, so the default output is "
                                    "never used.")
    elif len(inputs) > 1 and definition.no_match and definition.no_match.mode == "error":
        report.warn("no_match", "Coverage of every combination of inputs can't be checked "
                                "automatically; any combination no rule covers stops with an "
                                "error.")

    # KPI scoring: direction-specific checks (warnings; the matrix is the rule).
    direction = (attributes or {}).get("direction")
    if spec.code == "KPI_SCORING" and len(inputs) == 1 and rules and not report.errors:
        f = inputs[0]
        score_field = definition.field("score")
        if (f.data_type in NUMERIC_TYPES and score_field is not None
                and direction in (KpiDirection.HIGHER_IS_BETTER, KpiDirection.LOWER_IS_BETTER)):
            ordered = sorted(
                (r for r in rules if isinstance(r.conditions.get(f.key), RangeCondition)),
                key=lambda r: (r.conditions[f.key].interval.lo is not None,
                               r.conditions[f.key].interval.lo or 0),
            )
            scores = [r.outputs["score"] for r in ordered]
            higher = direction == KpiDirection.HIGHER_IS_BETTER
            for prev, nxt, rule in zip(scores, scores[1:], ordered[1:]):
                if (nxt < prev) if higher else (nxt > prev):
                    report.warn("rules", f"{rule.name}: a {'higher' if higher else 'lower'} "
                                         f"{f.label} earns a lower score than the band before "
                                         "it. Check the order (direction: "
                                         f"{'higher' if higher else 'lower'} is better).")
                    break
    if spec.code == "KPI_SCORING" and direction == KpiDirection.ZERO_TOLERANCE and not any(
            f.data_type == DataType.INTEGER and f.source == Source.ACTUAL for f in inputs):
        report.warn("fields", "A zero-tolerance matrix usually scores the number of incidents; "
                              "no whole-number input from the quarterly actual is used.")

    # Test cases: the author's own expectations must hold.
    for case in definition.test_cases:
        if not definition.evaluable or report.errors:
            break
        try:
            result = evaluate(definition, case.inputs)
        except EvaluationError as exc:
            report.test_results.append(TestResult(case.label, False, case.expected, None, None,
                                                  str(exc)))
            report.error("test_cases", f"Test case '{case.label}': {exc}")
            continue
        passed = result.outputs == case.expected
        report.test_results.append(TestResult(
            case.label, passed, case.expected, result.outputs,
            result.rule.priority if result.rule else None, None))
        if not passed:
            got = ", ".join(f"{definition.field(k).label} {v}" for k, v in result.outputs.items())
            want = ", ".join(f"{definition.field(k).label} {v}" for k, v in case.expected.items())
            source = result.rule.name if result.rule else "the default output"
            report.error("test_cases", f"Test case '{case.label}': expected {want}, got {got} "
                                       f"(from {source}).")
    return definition, report


# --- evaluation ---------------------------------------------------------------------------

class EvaluationError(ValueError):
    """The inputs are invalid, or no (or more than one) rule matches."""


@dataclass(frozen=True)
class Evaluation:
    outputs: dict[str, Any]
    rule: RuleDef | None
    used_default: bool
    inputs: dict[str, Any]

    def as_dict(self, definition: Definition) -> dict[str, Any]:
        return {
            "outputs": jsonable(self.outputs),
            "rule": None if self.rule is None else {
                "priority": self.rule.priority, "label": self.rule.label,
                "description": describe_rule(definition, self.rule)},
            "used_default": self.used_default,
            "inputs": jsonable(self.inputs),
        }


def evaluate(definition: Definition, inputs: Mapping[str, Any]) -> Evaluation:
    """Outputs for one set of inputs. Never guesses: invalid input, no match
    under 'stop with an error', and more than one match all raise."""
    if not definition.evaluable:
        raise EvaluationError("The configuration has errors and cannot be evaluated.")
    known = {f.key for f in definition.inputs}
    unknown = sorted(set(inputs) - known)
    if unknown:
        raise EvaluationError(f"Unknown input(s): {', '.join(unknown)}.")
    values: dict[str, Any] = {}
    for f in definition.inputs:
        raw = inputs.get(f.key)
        if _blank(raw):
            if f.required:
                raise EvaluationError(f"{f.label} is required.")
            values[f.key] = None
            continue
        try:
            values[f.key] = coerce_input(f, raw)
        except ValueError as exc:
            raise EvaluationError(f"{f.label}: {exc}") from None
    by_key = {f.key: f for f in definition.inputs}
    matches = [
        r for r in definition.rules
        if all(values[k] is not None and c.matches(by_key[k], values[k])
               for k, c in r.conditions.items())
    ]
    if len(matches) > 1:
        names = ", ".join(r.name for r in matches)
        raise EvaluationError(f"{names} all match these inputs; the configuration is ambiguous.")
    if matches:
        return Evaluation(dict(matches[0].outputs), matches[0], False, values)
    if definition.no_match and definition.no_match.mode == "default":
        return Evaluation(dict(definition.no_match.outputs or {}), None, True, values)
    shown = "; ".join(f"{by_key[k].label} = {by_key[k].fmt(v)}" for k, v in values.items()
                      if v is not None)
    raise EvaluationError(f"No rule matches {shown or 'these inputs'}.")


# --- helpers for other modules -------------------------------------------------------------

def frozen_definition(raw: Mapping[str, Any]) -> Definition:
    """A stored (approved) version, read from its own field definitions only,
    so later changes to the type never change how it evaluates."""
    report = Report()
    definition = parse_definition(None, raw, report)
    if report.errors:
        raise EvaluationError(f"The stored configuration cannot be read: {report.errors[0].message}")
    return definition


class SchemaMismatch(ValueError):
    """Content written for a schema version that cannot be converted."""


def migrate_definition(spec: MatrixTypeSpec, raw: Mapping[str, Any],
                       schema_version: int) -> dict[str, Any]:
    """Convert content written for an older schema version to the current one
    with the type's explicit, tested migrations; never reinterpret silently."""
    if schema_version == spec.schema_version:
        return dict(raw)
    if schema_version > spec.schema_version:
        raise SchemaMismatch(f"Schema version {schema_version} is newer than this system "
                             f"supports ({spec.schema_version}).")
    data = dict(raw)
    for version in range(schema_version, spec.schema_version):
        step = spec.migrations.get(version)
        if step is None:
            raise SchemaMismatch(f"Content for schema version {schema_version} can't be "
                                 f"converted to version {spec.schema_version}.")
        data = step(data)
    return data


def new_definition(spec: MatrixTypeSpec) -> dict[str, Any]:
    """Skeleton for a new draft: the type's own starting content, else its
    fixed outputs and nothing else."""
    if spec.initial_definition is not None:
        return spec.initial_definition()
    return {"fields": [f.as_definition() for f in spec.outputs], "rules": [],
            "no_match": None, "test_cases": []}


def definition_from_bands(direction: KpiDirection, bands: Sequence[Mapping[str, Any]],
                          fallback_score: int, met_score: int | None,
                          breached_score: int | None) -> dict[str, Any]:
    """A Stage J policy (strict threshold bands) as an equivalent decision
    table, with boundary test cases documenting the strict comparisons."""
    from app.services.matrix_types import KPI_SCORING

    score = KPI_SCORING.outputs[0].as_definition()
    if direction == KpiDirection.ZERO_TOLERANCE:
        field_def = KPI_SCORING.standard_input("incident_count").as_definition()
        return {
            "fields": [field_def, score],
            "rules": [
                {"priority": 1, "label": "No incidents",
                 "conditions": {"incident_count": {"min": "0", "min_inclusive": True,
                                                   "max": "0", "max_inclusive": True}},
                 "outputs": {"score": met_score}},
                {"priority": 2, "label": "One or more incidents",
                 "conditions": {"incident_count": {"min": "1", "min_inclusive": True,
                                                   "max": None, "max_inclusive": None}},
                 "outputs": {"score": breached_score}},
            ],
            "no_match": {"mode": "error"},
            "test_cases": [
                {"label": "No incidents", "inputs": {"incident_count": "0"},
                 "expected": {"score": met_score}},
                {"label": "One incident", "inputs": {"incident_count": "1"},
                 "expected": {"score": breached_score}},
            ],
        }
    field_def = KPI_SCORING.standard_input("achievement_percent").as_definition()
    higher = direction == KpiDirection.HIGHER_IS_BETTER
    ordered = sorted(((parse_decimal(b["threshold"]), int(b["score"])) for b in bands),
                     key=lambda b: b[0], reverse=higher)
    rules, cases = [], []
    previous: Decimal | None = None
    step = Decimal("0.01")
    for n, (threshold, value) in enumerate(ordered, 1):
        t = decimal_text(threshold)
        if higher:  # achievement > threshold (and <= the previous, higher threshold)
            condition = {"min": t, "min_inclusive": False,
                         "max": decimal_text(previous) if previous is not None else None,
                         "max_inclusive": True if previous is not None else None}
            label = f"More than {t}%"
            cases.append({"label": f"Just above {t}%", "inputs": {"achievement_percent":
                          decimal_text(threshold + step)}, "expected": {"score": value}})
        else:  # achievement < threshold (and >= the previous, lower threshold)
            condition = {"min": decimal_text(previous) if previous is not None else None,
                         "min_inclusive": True if previous is not None else None,
                         "max": t, "max_inclusive": False}
            label = f"Less than {t}%"
            cases.append({"label": f"Just below {t}%", "inputs": {"achievement_percent":
                          decimal_text(threshold - step)}, "expected": {"score": value}})
        rules.append({"priority": n, "label": label,
                      "conditions": {"achievement_percent": condition},
                      "outputs": {"score": value}})
        previous = threshold
    # Exactly on a threshold scores the next band (strict comparison).
    for n, (threshold, _value) in enumerate(ordered):
        following = ordered[n + 1][1] if n + 1 < len(ordered) else fallback_score
        cases.append({"label": f"Exactly {decimal_text(threshold)}%",
                      "inputs": {"achievement_percent": decimal_text(threshold)},
                      "expected": {"score": following}})
    return {"fields": [field_def, score], "rules": rules,
            "no_match": {"mode": "default", "outputs": {"score": fallback_score}},
            "test_cases": cases}
