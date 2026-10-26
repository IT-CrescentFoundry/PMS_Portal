"""Normalization settings, group placement and consolidation arithmetic (pure, no database)."""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.models.enums import NormalizationPlacement as P
from app.models.enums import ScoreResultStatus
from app.services import kpi_results, quarterly
from app.services import normalization_policy as policy
from app.services.matrix_rules import Report, analyse, new_definition
from app.services.matrix_types import KPI_SCORING, NORMALIZATION
from tests.conftest import TEST_RATINGS, normalization_settings


def settings(**overrides) -> policy.Settings:
    report = Report()
    parsed = policy.parse_settings(normalization_settings(**overrides), report)
    assert parsed is not None, [e.message for e in report.errors]
    return parsed


def candidates(*scores, ineligible=()):
    return [policy.Candidate(i + 1, Decimal(str(s)), i + 1 not in ineligible)
            for i, s in enumerate(scores)]


def groups(outcome) -> dict[int, str | None]:
    return {p.employee_id: p.group for p in outcome.placed}


def members(outcome, group) -> set[int]:
    return {p.employee_id for p in outcome.placed if p.group == group}


# --- settings ---------------------------------------------------------------------------------

def test_a_new_draft_leaves_every_choice_open():
    report = Report()
    assert policy.parse_settings(policy.default_settings(), report) is None
    paths = {e.path for e in report.errors}
    assert paths == {"settings.cohort_level", "settings.size_rounding", "settings.rank_by",
                     "settings.ties", "settings.min_cohort_size", "settings.small_cohort"}
    skeleton = new_definition(NORMALIZATION)
    assert skeleton["settings"]["groups"][1] == {"key": "MIDDLE", "label": "Middle 60%",
                                                 "percent": "60", "remainder": True}
    assert skeleton["fields"][0]["allowed_values"] == ["TOP", "MIDDLE", "BOTTOM"]


@pytest.mark.parametrize("change, message", [
    ({"groups": [{"key": "TOP", "label": "Top", "percent": "20"},
                 {"key": "REST", "label": "Rest", "percent": "70", "remainder": True}]},
     "total 90 %"),
    ({"groups": [{"key": "TOP", "label": "Top", "percent": "50", "remainder": True},
                 {"key": "REST", "label": "Rest", "percent": "50", "remainder": True}]},
     "exactly one group"),
    ({"groups": [{"key": "top", "label": "Top", "percent": "100", "remainder": True},
                 {"key": "B", "label": "B", "percent": "0"}]}, "capital letters"),
    ({"small_cohort": "DEFAULT_GROUP", "small_cohort_group": None}, "Choose the group"),
    ({"small_cohort": "REQUIRE_RESOLUTION", "small_cohort_group": "MIDDLE"},
     "only when small cohorts"),
    ({"min_cohort_size": 0}, "smallest cohort"),
    ({"ties": "SPLIT_RANDOMLY"}, "tied at a group boundary"),
])
def test_invalid_settings_are_reported(change, message):
    report = Report()
    assert policy.parse_settings(normalization_settings(**change), report) is None
    assert any(message in e.message for e in report.errors), [e.message for e in report.errors]


def test_a_policy_definition_must_fit_its_settings():
    definition = policy.group_rating_definition(normalization_settings(), TEST_RATINGS)
    _, report = analyse(NORMALIZATION, definition)
    assert report.ok and all(t.passed for t in report.test_results)

    mismatch = dict(definition, fields=[dict(definition["fields"][0],
                                             allowed_values=["TOP", "MIDDLE"]),
                                        definition["fields"][1]])
    _, report = analyse(NORMALIZATION, mismatch)
    assert any("must list exactly the groups" in e.message for e in report.errors)

    uncovered = dict(definition, rules=definition["rules"][:2], test_cases=[])
    _, report = analyse(NORMALIZATION, uncovered)
    assert any("No rule gives a rating for BOTTOM" in e.message for e in report.errors)

    kpi = dict(new_definition(KPI_SCORING), settings={"x": 1})
    _, report = analyse(KPI_SCORING, kpi)
    assert any(e.path == "settings" for e in report.errors)


# --- placement --------------------------------------------------------------------------------

def test_twenty_sixty_twenty_with_distinct_scores():
    outcome = policy.place(settings(), candidates(5, 4.9, 4.8, 4.7, 4.6, 4.5, 4.4, 4.3, 4.2, 4.1))
    assert outcome.targets == {"TOP": 2, "MIDDLE": 6, "BOTTOM": 2}
    assert members(outcome, "TOP") == {1, 2} and members(outcome, "BOTTOM") == {9, 10}
    assert all(p.placement == P.AUTO for p in outcome.placed)
    assert [p.rank for p in outcome.placed] == list(range(1, 11))
    assert not [e for e in outcome.exceptions if e["type"] == "tie"]


@pytest.mark.parametrize("rounding, expected", [
    ("NEAREST", {"TOP": 1, "MIDDLE": 5, "BOTTOM": 1}),
    ("DOWN", {"TOP": 1, "MIDDLE": 5, "BOTTOM": 1}),
    ("UP", {"TOP": 2, "MIDDLE": 3, "BOTTOM": 2}),
])
def test_group_sizes_round_as_configured_and_say_so(rounding, expected):
    outcome = policy.place(settings(size_rounding=rounding), candidates(7, 6, 5, 4, 3, 2, 1))
    assert outcome.targets == expected
    notes = [e["message"] for e in outcome.exceptions if e["type"] == "rounding"]
    assert notes and "20 % of 7 is 1.4" in notes[0]


TOP_TIE = (5.0, 4.5, 4.5, 4.0, 3.9, 3.8, 3.7, 3.6, 2.0, 1.0)


@pytest.mark.parametrize("rule, top, middle", [
    ("HIGHER_GROUP", {1, 2, 3}, {4, 5, 6, 7, 8}),
    ("LOWER_GROUP", {1}, {2, 3, 4, 5, 6, 7, 8}),
])
def test_ties_at_a_boundary_are_kept_together_by_the_policy_rule(rule, top, middle):
    outcome = policy.place(settings(ties=rule), candidates(*TOP_TIE))
    assert members(outcome, "TOP") == top and members(outcome, "MIDDLE") == middle
    assert {p.employee_id for p in outcome.placed if p.placement == P.TIE_RULE} == {2, 3}
    tie = next(e for e in outcome.exceptions if e["type"] == "tie")
    assert tie["employee_ids"] == [2, 3] and "differ from the targets" in tie["message"]
    assert [p.rank for p in outcome.placed][:4] == [1, 2, 2, 4]


def test_ties_can_require_an_authorized_placement():
    outcome = policy.place(settings(), candidates(*TOP_TIE))
    pending = [p for p in outcome.placed if p.placement == P.NEEDS_RESOLUTION]
    assert [(p.employee_id, p.group, p.options) for p in pending] == [
        (2, None, ["TOP", "MIDDLE"]), (3, None, ["TOP", "MIDDLE"])]
    assert members(outcome, "TOP") == {1}


@pytest.mark.parametrize("rule, bottom", [
    ("HIGHER_GROUP", {10}), ("LOWER_GROUP", {8, 9, 10})])
def test_a_tie_at_the_bottom_boundary(rule, bottom):
    outcome = policy.place(settings(ties=rule),
                           candidates(5, 4.9, 4.8, 4.7, 4.6, 4.5, 4.4, 1.0, 1.0, 0.5))
    assert members(outcome, "BOTTOM") == bottom


def test_equal_scores_inside_one_group_are_not_a_tie():
    outcome = policy.place(settings(), candidates(5, 5, 4, 3.9, 3.8, 3.7, 3.6, 3.5, 2, 1))
    assert members(outcome, "TOP") == {1, 2}
    assert not [e for e in outcome.exceptions if e["type"] == "tie"]


def test_a_tie_spanning_every_group_offers_every_group():
    outcome = policy.place(settings(min_cohort_size=1), candidates(3, 3, 3, 3, 3, 3))
    assert {tuple(p.options) for p in outcome.placed} == {("TOP", "MIDDLE", "BOTTOM")}
    assert all(p.group is None for p in outcome.placed)


def test_small_cohorts_follow_the_policy():
    default = policy.place(settings(), candidates(5, 4, 3))
    assert default.small_cohort and set(groups(default).values()) == {"MIDDLE"}
    assert {p.placement for p in default.placed} == {P.SMALL_COHORT_DEFAULT}
    review = policy.place(settings(small_cohort="REQUIRE_RESOLUTION", small_cohort_group=None),
                          candidates(5, 4, 3))
    assert {p.placement for p in review.placed} == {P.NEEDS_RESOLUTION}
    assert review.placed[0].options == ["TOP", "MIDDLE", "BOTTOM"]
    # Rounding up can ask for more people than the cohort has: treated as small.
    tiny = policy.place(settings(size_rounding="UP", min_cohort_size=1), candidates(4))
    assert tiny.small_cohort and groups(tiny) == {1: "MIDDLE"}


def test_ineligible_employees_are_listed_but_not_normalized():
    outcome = policy.place(settings(), candidates(5, 4, 3, 2, 1, 0, ineligible={2}))
    excluded = next(p for p in outcome.placed if p.employee_id == 2)
    assert (excluded.group, excluded.rank, excluded.placement) == (None, None, P.NOT_ELIGIBLE)
    assert sum(outcome.targets.values()) == 5
    assert any(e["type"] == "not_eligible" for e in outcome.exceptions)


# --- monthly aggregation and consolidation arithmetic -----------------------------------------

def test_monthly_values_combine_as_configured():
    values = [Decimal("1"), Decimal("2"), Decimal("2")]
    assert kpi_results._combine(values, "SUM") == Decimal("5")
    assert kpi_results._combine(values, "AVERAGE") == Decimal(5) / Decimal(3)
    assert kpi_results._combine(values, "LAST") == Decimal("2")
    assert kpi_results._combine(values, "MIN") == Decimal("1")
    assert kpi_results._combine(values, "MAX") == Decimal("2")
    assert kpi_results._combine([], "SUM") is None


def _view(score: str, primary: bool, unit: str, assignment_id: int):
    plant_department = SimpleNamespace(plant_id=1, department_id=1,
                                       department=SimpleNamespace(name=unit),
                                       plant=SimpleNamespace(name="Plant"))
    assignment = SimpleNamespace(id=assignment_id, is_primary=primary,
                                 plant_department=plant_department)
    result = SimpleNamespace(id=1, inputs_hash="x", final_score=Decimal(score), override_score=None,
                             status=ScoreResultStatus.REVIEWED, is_complete=True, explanation={})
    return SimpleNamespace(sheet=SimpleNamespace(id=1, assignment=assignment), result=result,
                           stale=False, pending_override=None)


def test_weighted_consolidation_is_exact_then_rounded_once():
    a, b = _view("4.13", True, "Quality", 1), _view("2.27", False, "Assembly", 2)
    comps = [quarterly.Component(a, Decimal("33.33")), quarterly.Component(b, Decimal("66.67"))]
    c = quarterly.Consolidation(SimpleNamespace(id=1, employee_code="T1", full_name="T"), comps,
                                "CONFIGURED", [], a.sheet.assignment)
    # 4.13 x 33.33 % + 2.27 x 66.67 % = 1.376529 + 1.513409
    assert c.exact == Decimal("2.889938")
    assert (c.calculated, c.final) == (Decimal("2.8899"), Decimal("2.89"))
    assert c.ready


def test_weights_must_cover_the_scored_assignments_and_total_100():
    a, b = _view("4", True, "Quality", 1), _view("3", False, "Assembly", 2)
    comps = [quarterly.Component(a, None), quarterly.Component(b, None)]
    ida, idb = a.sheet.assignment.id, b.sheet.assignment.id
    assert quarterly._check_weights(comps, {})[0] == "MISSING"
    source, issues, _ = quarterly._check_weights(comps, {ida: Decimal("60"), idb: Decimal("30")})
    assert source == "INVALID" and "total 90 %" in issues[0]
    assert quarterly._check_weights(comps, {ida: Decimal("60"), idb: Decimal("40")})[0] == "CONFIGURED"
    assert quarterly._check_weights(comps[:1], {})[0] == "SINGLE"
