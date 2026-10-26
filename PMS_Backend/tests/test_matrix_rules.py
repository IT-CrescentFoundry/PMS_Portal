"""The decision-table engine: types, operators, boundaries, conflicts, evaluation."""
from dataclasses import replace
from datetime import date
from decimal import Decimal

import pytest

from app.models.enums import KpiDirection
from app.services import matrix_rules as rules
from app.services import matrix_types
from app.services.matrix_types import (
    INCREMENT,
    KPI_SCORING,
    KRA_PERFORMANCE,
    DataType,
    FieldSpec,
    Source,
)

SCORE = KPI_SCORING.outputs[0].as_definition()
ACHIEVEMENT = KPI_SCORING.standard_input("achievement_percent").as_definition()
INCIDENTS = KPI_SCORING.standard_input("incident_count").as_definition()


def band(lo=None, lo_inc=None, hi=None, hi_inc=None):
    return {"min": lo, "min_inclusive": lo_inc, "max": hi, "max_inclusive": hi_inc}


def definition(rules_, *, fields=(ACHIEVEMENT,), no_match=None, cases=()):
    return {"fields": [*fields, SCORE], "rules": list(rules_),
            "no_match": no_match if no_match is not None else {"mode": "default",
                                                              "outputs": {"score": 0}},
            "test_cases": list(cases)}


def rule(priority, conditions, score, label=None):
    return {"priority": priority, "label": label, "conditions": conditions,
            "outputs": {"score": score}}


def messages(report):
    return [p.message for p in report.errors]


def score(raw, inputs):
    parsed, report = rules.analyse(KPI_SCORING, raw)
    assert report.ok, messages(report)
    return rules.evaluate(parsed, inputs).outputs["score"]


# --- boundaries -------------------------------------------------------------------------

STRICT = definition([
    rule(1, {"achievement_percent": band("100", False)}, 5),
    rule(2, {"achievement_percent": band("90", False, "100", True)}, 4),
])


@pytest.mark.parametrize("value, expected", [
    ("100.01", 5), ("100", 4), ("90.0001", 4), ("90", 0), ("-5", 0),
])
def test_strict_and_inclusive_bounds_are_explicit(value, expected):
    assert score(STRICT, {"achievement_percent": value}) == expected


def test_inclusive_lower_bound_includes_the_value():
    inclusive = definition([rule(1, {"achievement_percent": band("100", True)}, 5)])
    assert score(inclusive, {"achievement_percent": "100"}) == 5
    assert score(inclusive, {"achievement_percent": "99.999"}) == 0


def test_a_given_bound_must_say_whether_it_is_included():
    _parsed, report = rules.analyse(KPI_SCORING, definition([
        rule(1, {"achievement_percent": {"min": "100", "max": None}}, 5)]))
    assert any("say whether the lower bound 100% is included" in m for m in messages(report))


# --- data types and operators ------------------------------------------------------------

def test_whole_numbers_are_discrete():
    raw = definition([
        rule(1, {"incident_count": band("0", True, "0", True)}, 5),
        rule(2, {"incident_count": band("0", False, "2", True)}, 2),   # > 0 means >= 1
        rule(3, {"incident_count": band("2", False)}, 0),
    ], fields=(INCIDENTS,), no_match={"mode": "error"})
    parsed, report = rules.analyse(KPI_SCORING, raw, {"direction": KpiDirection.ZERO_TOLERANCE})
    assert report.ok and report.gaps == []
    assert [rules.evaluate(parsed, {"incident_count": n}).outputs["score"] for n in (0, 1, 2, 3)] \
        == [5, 2, 2, 0]
    with pytest.raises(rules.EvaluationError, match="whole number"):
        rules.evaluate(parsed, {"incident_count": "1.5"})
    with pytest.raises(rules.EvaluationError, match="at least 0"):
        rules.evaluate(parsed, {"incident_count": -1})


def test_zero_tolerance_can_award_zero_when_configured():
    raw = rules.definition_from_bands(KpiDirection.ZERO_TOLERANCE, [], 0, 5, 0)
    assert score(raw, {"incident_count": 0}) == 5
    assert score(raw, {"incident_count": 4}) == 0


GRADE = {"key": "audit_grade", "label": "Audit grade", "role": "input", "data_type": "CATEGORY",
         "allowed_values": ["A", "B", "C"], "required": True, "aggregation": "LAST"}
ON_TIME = {"key": "on_time", "label": "Delivered on time", "role": "input", "data_type": "BOOLEAN",
           "required": True, "aggregation": "ALL"}
DUE = {"key": "milestone", "label": "Milestone date", "role": "input", "data_type": "DATE",
       "required": True, "aggregation": "LAST"}


def test_category_boolean_and_date_conditions():
    categorical = definition([
        rule(1, {"audit_grade": {"values": ["A"]}}, 5),
        rule(2, {"audit_grade": {"values": ["b", "C"]}}, 2),   # matched case-insensitively
    ], fields=(GRADE,), no_match={"mode": "error"})
    assert score(categorical, {"audit_grade": "a"}) == 5
    assert score(categorical, {"audit_grade": "C"}) == 2
    flag = definition([rule(1, {"on_time": {"value": True}}, 5),
                       rule(2, {"on_time": {"value": False}}, 1)],
                      fields=(ON_TIME,), no_match={"mode": "error"})
    assert score(flag, {"on_time": "No"}) == 1
    dated = definition([
        rule(1, {"milestone": band(None, None, "2026-09-30", True)}, 5),
        rule(2, {"milestone": band("2026-09-30", False, "2026-10-15", True)}, 3),
    ], fields=(DUE,))
    assert score(dated, {"milestone": "2026-09-30"}) == 5
    assert score(dated, {"milestone": date(2026, 10, 1)}) == 3
    assert score(dated, {"milestone": "2026-12-01"}) == 0


def test_multiple_inputs_combine():
    composite = definition([
        rule(1, {"achievement_percent": band("100", True), "audit_grade": {"values": ["A"]}}, 5),
        rule(2, {"achievement_percent": band("100", True), "audit_grade": {"values": ["B", "C"]}}, 4),
        rule(3, {"achievement_percent": band(None, None, "100", False)}, 2),
    ], fields=(ACHIEVEMENT, GRADE), no_match={"mode": "error"})
    assert score(composite, {"achievement_percent": "120", "audit_grade": "A"}) == 5
    assert score(composite, {"achievement_percent": "120", "audit_grade": "B"}) == 4
    assert score(composite, {"achievement_percent": "50", "audit_grade": "A"}) == 2


def test_rounding_happens_before_matching():
    rounded = definition([rule(1, {"achievement_percent": band("100", True)}, 5)],
                         fields=({**ACHIEVEMENT, "round_to": 1},))
    assert score(rounded, {"achievement_percent": "99.96"}) == 5   # 100.0 after rounding
    assert score(rounded, {"achievement_percent": "99.94"}) == 0


# --- conflicts and gaps ------------------------------------------------------------------

def test_overlapping_rules_are_refused_with_the_overlap_shown():
    _parsed, report = rules.analyse(KPI_SCORING, definition([
        rule(1, {"achievement_percent": band("90", True)}, 4),
        rule(2, {"achievement_percent": band("95", False, "100", True)}, 5),
    ]))
    assert ("Rule 1 and Rule 2 overlap where Achievement % is more than 95% and at most 100%. "
            "Exactly one rule may match any input.") in messages(report)


def test_touching_bounds_do_not_overlap_but_shared_points_do():
    touching = definition([rule(1, {"achievement_percent": band("100", False)}, 5),
                           rule(2, {"achievement_percent": band(None, None, "100", True)}, 1)])
    assert rules.analyse(KPI_SCORING, touching)[1].ok
    shared = definition([rule(1, {"achievement_percent": band("100", True)}, 5),
                         rule(2, {"achievement_percent": band(None, None, "100", True)}, 1)])
    assert any("exactly 100%" in m for m in messages(rules.analyse(KPI_SCORING, shared)[1]))


def test_overlaps_across_several_inputs_and_categories():
    _parsed, report = rules.analyse(KPI_SCORING, definition([
        rule(1, {"audit_grade": {"values": ["A", "B"]}}, 5),
        rule(2, {"audit_grade": {"values": ["B"]}, "achievement_percent": band("50", True)}, 3),
    ], fields=(ACHIEVEMENT, GRADE)))
    assert any("overlap where Achievement % is at least 50% and Audit grade is B" in m
               for m in messages(report))


@pytest.mark.parametrize("bad_rules, expected", [
    ([rule(1, {"achievement_percent": band("10", True)}, 5),
      rule(1, {"achievement_percent": band(None, None, "10", False)}, 1)], "Priority 1 is used by more"),
    ([rule(1, {"achievement_percent": band("10", True)}, 5),
      rule(2, {"achievement_percent": band("10", True)}, 4)], "have the same conditions"),
    ([rule(1, {"achievement_percent": band("10", False, "10", True)}, 5)], "contains no values"),
    ([rule(1, {"achievement_percent": band("10", True, "5", True)}, 5)], "contains no values"),
    ([rule(1, {}, 5)], "has no conditions"),
    ([rule(1, {"achievement_percent": band(None, None, None, None)}, 5)], "give a lower or an upper"),
    ([rule(1, {"achievement_percent": {"min": "5", "min_inclusive": True, "op": "regex"}}, 5)],
     "unsupported condition setting"),
    ([rule(1, {"achievement_percent": band("NaN", True)}, 5)], "is not a number"),
    ([rule(1, {"achievement_percent": band("1e999", True)}, 5)], "is not a number"),
    ([rule(1, {"unknown": band("1", True)}, 5)], "'unknown' is not a field"),
    ([rule(1, {"achievement_percent": band("1", True)}, 6)], "must be at most 5"),
    ([rule(1, {"achievement_percent": band("1", True)}, "five")], "is not a number"),
    ([], "Add at least one rule"),
])
def test_invalid_configurations_are_explained(bad_rules, expected):
    _parsed, report = rules.analyse(KPI_SCORING, definition(bad_rules))
    assert any(expected in m for m in messages(report)), messages(report)


def test_infinity_and_nan_values_are_refused_everywhere():
    for value in (float("nan"), float("inf"), "Infinity"):
        with pytest.raises(ValueError):
            rules.parse_decimal(value)


def test_unreachable_rule_outside_the_accepted_values():
    capped = {**ACHIEVEMENT, "min": "0", "max": "200"}
    _parsed, report = rules.analyse(KPI_SCORING, definition(
        [rule(1, {"achievement_percent": band("250", True)}, 5)], fields=(capped,)))
    assert any("lies outside the accepted values" in m for m in messages(report))


def test_missing_default_behaviour_and_gaps():
    gappy = {"fields": [ACHIEVEMENT, SCORE],
             "rules": [rule(1, {"achievement_percent": band("100", False)}, 5)],
             "no_match": None, "test_cases": []}
    assert any("Choose what happens when no rule matches" in m
               for m in messages(rules.analyse(KPI_SCORING, gappy)[1]))
    gappy["no_match"] = {"mode": "error"}
    _parsed, report = rules.analyse(KPI_SCORING, gappy)
    assert report.ok and report.gaps == ["Achievement % is at most 100%"]
    assert any("Such values stop with an error" in w.message for w in report.warnings)


def test_no_match_error_stops_evaluation_instead_of_guessing():
    parsed, _report = rules.analyse(KPI_SCORING, {**STRICT, "no_match": {"mode": "error"}})
    with pytest.raises(rules.EvaluationError, match="No rule matches Achievement % = 50%"):
        rules.evaluate(parsed, {"achievement_percent": "50"})


def test_ambiguous_match_at_evaluation_is_an_error_never_a_choice():
    # Construct an invalid (overlapping) definition directly, bypassing validation.
    parsed, _report = rules.analyse(KPI_SCORING, STRICT)
    duplicate = replace(parsed.rules[0], priority=9)
    parsed.rules.append(duplicate)
    with pytest.raises(rules.EvaluationError, match="ambiguous"):
        rules.evaluate(parsed, {"achievement_percent": "150"})


def test_monotonic_warning_follows_the_explicit_direction():
    raw = definition([rule(1, {"achievement_percent": band("100", False)}, 1),
                      rule(2, {"achievement_percent": band(None, None, "100", True)}, 5)],
                     no_match={"mode": "error"})
    higher = rules.analyse(KPI_SCORING, raw, {"direction": "HIGHER_IS_BETTER"})[1]
    lower = rules.analyse(KPI_SCORING, raw, {"direction": "LOWER_IS_BETTER"})[1]
    assert any("higher" in w.message for w in higher.warnings)
    assert not any("lower Achievement" in w.message for w in lower.warnings)


# --- fields --------------------------------------------------------------------------------

@pytest.mark.parametrize("field_def, expected", [
    ({**GRADE, "key": "age_band", "label": "Age band"}, "protected personal attribute"),
    ({**GRADE, "key": "gender_code", "label": "Code"}, "protected personal attribute"),
    ({**GRADE, "key": "grade", "label": "Marital status"}, "protected personal attribute"),
    ({**GRADE, "allowed_values": []}, "list the allowed values"),
    ({**GRADE, "allowed_values": ["A", "a"]}, "must be unique"),
    ({**GRADE, "aggregation": "AVERAGE"}, "does not suit"),
    ({**GRADE, "data_type": "TEXT"}, "unsupported data type"),
    ({**GRADE, "key": "Bad Key"}, "lower-case letters"),
    ({**ACHIEVEMENT, "data_type": "DECIMAL"}, "standard field of type PERCENT"),
    ({**ACHIEVEMENT, "source": "IMPORTED"}, "always comes from"),
    ({**GRADE, "source": "MANUAL"}, "custom inputs of this type come from IMPORTED"),
])
def test_field_definitions_are_validated(field_def, expected):
    _parsed, report = rules.analyse(KPI_SCORING, definition(
        [rule(1, {}, 5)], fields=(field_def,)))
    assert any(expected in m for m in messages(report)), messages(report)


def test_words_containing_protected_terms_are_not_refused():
    for key, label in (("average_value", "Average value"), ("percentage", "Percentage"),
                       ("manager_rating", "Manager rating"), ("traceability", "Traceability")):
        assert not rules._protected(key) and not rules._protected(label)


def test_standard_outputs_are_required_and_bounded():
    no_output = {"fields": [ACHIEVEMENT], "rules": [], "no_match": {"mode": "error"}}
    assert any("The output 'Score' (score) is required" in m
               for m in messages(rules.analyse(KPI_SCORING, no_output)[1]))
    widened = {**SCORE, "max": "10"}
    _parsed, report = rules.analyse(KPI_SCORING, {**definition([]), "fields": [ACHIEVEMENT, widened]})
    assert any("the maximum must stay within 5" in m for m in messages(report))


def test_required_and_optional_inputs_at_evaluation():
    optional = {**GRADE, "required": False}
    parsed, report = rules.analyse(KPI_SCORING, definition(
        [rule(1, {"achievement_percent": band("100", True)}, 5),
         rule(2, {"achievement_percent": band(None, None, "100", False),
                  "audit_grade": {"values": ["A"]}}, 3)],
        fields=(ACHIEVEMENT, optional)))
    assert report.ok, messages(report)
    assert rules.evaluate(parsed, {"achievement_percent": "90"}).outputs["score"] == 0  # default
    assert rules.evaluate(parsed, {"achievement_percent": "90", "audit_grade": "A"}).outputs["score"] == 3
    with pytest.raises(rules.EvaluationError, match="Achievement % is required"):
        rules.evaluate(parsed, {"audit_grade": "A"})


# --- test cases and workbook regressions ---------------------------------------------------

def test_failing_test_cases_block_the_configuration():
    raw = definition(STRICT["rules"], cases=[
        {"label": "On target", "inputs": {"achievement_percent": "100"}, "expected": {"score": 5}}])
    _parsed, report = rules.analyse(KPI_SCORING, raw)
    assert ("Test case 'On target': expected Score 5, got Score 4 (from Rule 2)."
            in messages(report))
    assert report.test_results[0].passed is False and report.test_results[0].rule == 2


# Achievement % and Excel's cached score from the source workbook (Stage J
# findings, section 2.2); names and raw figures are omitted.
WORKBOOK = {
    (KpiDirection.HIGHER_IS_BETTER, ((100, 5), (90, 4), (80, 3), (70, 2), (50, 1)), 0): [
        (71.8683, 2), (80.6490, 3), (104.9869, 5), (95.4426, 4), (59.8061, 1), (57.3867, 1),
        (60.6061, 1), (84.8485, 3)],
    (KpiDirection.LOWER_IS_BETTER, ((100, 5), (110, 4), (120, 3), (150, 2)), 1): [
        (132.8571, 2), (168.5714, 1), (85.7143, 5), (92.8571, 5)],
    (KpiDirection.HIGHER_IS_BETTER, ((95, 5), (90, 4), (80, 3), (70, 2)), 1): [
        (52.4, 1), (48.8, 1), (60.0, 1), (64.0, 1)],
}


@pytest.mark.parametrize("key", list(WORKBOOK))
def test_decision_tables_reproduce_the_workbook_matrices(key):
    direction, bands, fallback = key
    raw = rules.definition_from_bands(direction, [{"threshold": t, "score": s} for t, s in bands],
                                      fallback, None, None)
    parsed, report = rules.analyse(KPI_SCORING, raw, {"direction": direction})
    assert report.ok and all(t.passed for t in report.test_results)
    for achievement, expected in WORKBOOK[key]:
        result = rules.evaluate(parsed, {"achievement_percent": Decimal(str(achievement))})
        assert result.outputs["score"] == expected


# --- frozen versions and schema changes ----------------------------------------------------

def test_a_frozen_version_evaluates_from_its_own_field_definitions(monkeypatch):
    raw = rules.definition_from_bands(KpiDirection.HIGHER_IS_BETTER,
                                      [{"threshold": 100, "score": 5}], 1, None, None)
    # The type later changes its standard field (e.g. adds a range): the frozen
    # content still evaluates exactly as approved.
    changed = replace(KPI_SCORING, standard_inputs=(
        FieldSpec("achievement_percent", "Achievement %", DataType.PERCENT, "input", min="0",
                  max="150", source=Source.PERCENT_OF_TARGET),))
    monkeypatch.setitem(matrix_types.REGISTRY, "KPI_SCORING", changed)
    frozen = rules.frozen_definition(raw)
    assert rules.evaluate(frozen, {"achievement_percent": "500"}).outputs["score"] == 5


def test_schema_migrations_are_explicit():
    v2 = replace(KPI_SCORING, schema_version=2, migrations={
        1: lambda d: {**d, "test_cases": [*d.get("test_cases", []),
                                          {"label": "migrated", "inputs": {}, "expected": {}}]}})
    migrated = rules.migrate_definition(v2, {"fields": [], "test_cases": []}, 1)
    assert migrated["test_cases"][0]["label"] == "migrated"
    with pytest.raises(rules.SchemaMismatch, match="can't be converted"):
        rules.migrate_definition(replace(KPI_SCORING, schema_version=3), {}, 1)
    with pytest.raises(rules.SchemaMismatch, match="newer"):
        rules.migrate_definition(KPI_SCORING, {}, 7)


def test_future_types_define_structure_without_values():
    for spec in (KRA_PERFORMANCE, INCREMENT):
        assert spec.policy_note and "Awaiting approved configuration" in spec.policy_note
        assert all(not f.allowed_values for f in spec.standard_inputs)
    empty = rules.new_definition(INCREMENT)
    assert empty["rules"] == [] and [f["key"] for f in empty["fields"]] == ["increment_percent"]
