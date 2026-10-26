"""Scoring policies reproduce the workbook's achievement matrices exactly."""
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import KpiDirection, KpiScoringPolicy
from app.models.enums import ScopeType
from app.seed.runner import seed
from app.services import scoring

# Achievement % and the score Excel cached for it ('PMS Prerequisites.xlsx',
# Sheet1, rows 7-12). KPI names and raw figures are deliberately omitted.
MATRIX_A = [(71.8683, 2), (80.6490, 3), (104.9869, 5), (95.4426, 4), (59.8061, 1),
            (57.3867, 1), (60.6061, 1), (84.8485, 3)]
MATRIX_B = [(132.8571, 2), (168.5714, 1), (85.7143, 5), (92.8571, 5)]
MATRIX_E = [(52.4, 1), (48.8, 1), (60.0, 1), (64.0, 1)]


@pytest.fixture
def seeded(db):
    seed(db)
    return {p.code: scoring.snapshot(p) for p in db.scalars(select(KpiScoringPolicy)).all()}


@pytest.mark.parametrize("code, cases", [("POL-A", MATRIX_A), ("POL-B", MATRIX_B), ("POL-E", MATRIX_E)])
def test_seeded_policies_match_workbook_cached_scores(seeded, code, cases):
    for achievement, expected in cases:
        assert scoring.evaluate(seeded[code], achievement=Decimal(str(achievement))) == expected


@pytest.mark.parametrize(
    "code, achievement, expected",
    [
        ("POL-A", 100, 4),    # exactly on target scores 4 (strict > 100 for a 5)
        ("POL-A", 100.01, 5),
        ("POL-A", 50, 0),     # matrix A can return 0 (finding D5)
        ("POL-B", 100, 4),    # lower-is-better: exactly on target also scores 4
        ("POL-B", 150, 1),
        ("POL-E", 95, 4),
    ],
)
def test_boundaries_are_strict_as_in_the_workbook(seeded, code, achievement, expected):
    assert scoring.evaluate(seeded[code], achievement=Decimal(str(achievement))) == expected


def test_zero_tolerance_scores_the_intended_way(seeded):
    assert scoring.evaluate(seeded["POL-Z"], actual=Decimal("0")) == 5
    assert scoring.evaluate(seeded["POL-Z"], actual=Decimal("23.42")) == 0


def test_achievement_percent_needs_a_target():
    assert scoring.achievement_percent(Decimal("9.3"), Decimal("7")).quantize(Decimal("0.01")) == Decimal("132.86")
    with pytest.raises(ValueError):
        scoring.achievement_percent(Decimal("1"), Decimal("0"))


@pytest.mark.parametrize(
    "direction, bands, fallback, met, breached, message",
    [
        (KpiDirection.HIGHER_IS_BETTER, [], 0, None, None, "At least one band"),
        (KpiDirection.HIGHER_IS_BETTER, [{"threshold": 90, "score": 3}, {"threshold": 100, "score": 2}],
         0, None, None, "higher score"),
        (KpiDirection.HIGHER_IS_BETTER, [{"threshold": 90, "score": 3}, {"threshold": 90, "score": 4}],
         0, None, None, "unique"),
        (KpiDirection.LOWER_IS_BETTER, [{"threshold": 100, "score": 5}, {"threshold": 120, "score": 2}],
         3, None, None, "fallback"),
        (KpiDirection.HIGHER_IS_BETTER, [{"threshold": 100, "score": 6}], 0, None, None, "between 0 and 5"),
        (KpiDirection.ZERO_TOLERANCE, [{"threshold": 1, "score": 1}], 0, 5, 0, "no bands"),
        (KpiDirection.ZERO_TOLERANCE, [], 0, None, 0, "met_score"),
    ],
)
def test_inconsistent_policies_are_refused(direction, bands, fallback, met, breached, message):
    issues = scoring.validate_policy(direction, bands, fallback, met, breached)
    assert any(message.lower() in i.message.lower() for i in issues), issues


def test_policies_api_and_preview(as_role, kpi_env):
    # Since Stage K a policy is a versioned matrix authored by an HR Head.
    _, hr_head = as_role("tst.pol.hrh", [("HR_HEAD", [(ScopeType.GLOBAL, None, None)])])
    created = hr_head.post("/api/kpi/policies", json={
        "name": "Test custom higher", "direction": "HIGHER_IS_BETTER",
        "bands": [{"threshold": 95, "score": 5}, {"threshold": 80, "score": 3}], "fallback_score": 1})
    assert created.status_code == 201, created.text
    policy = created.json()
    assert policy["code"].startswith("POL-")
    # Version 1 is a draft: not in force until the CHRO approves and it is published.
    assert policy["matrix"]["in_force"] is None
    assert policy["matrix"]["latest"]["status"] == "DRAFT"
    preview = hr_head.post(f"/api/kpi/policies/{policy['id']}/preview",
                           json={"achievement_percent": 96})
    assert preview.json()["score"] == 5 and preview.json()["status"] == "DRAFT"
    bad = hr_head.post("/api/kpi/policies", json={
        "name": "Bad", "direction": "HIGHER_IS_BETTER", "bands": [{"threshold": 90, "score": 2},
                                                                  {"threshold": 95, "score": 1}]})
    assert bad.status_code == 422 and bad.json()["issues"]
    # Admins no longer author scoring rules.
    _, admin = as_role("tst.pol.admin", [("ADMIN", [(ScopeType.GLOBAL, None, None)])])
    assert admin.post("/api/kpi/policies", json={
        "name": "Admin policy", "direction": "LOWER_IS_BETTER",
        "bands": [{"threshold": 100, "score": 5}], "fallback_score": 1}).status_code == 403


def test_policies_are_company_wide_and_need_global_scope(as_role, kpi_env):
    p1 = kpi_env.org.plants["P1"]
    _, hr = as_role("tst.pol.hr", [("HR", [(ScopeType.PLANT, p1, None)])])
    resp = hr.post("/api/kpi/policies", json={"name": "Plant policy", "direction": "LOWER_IS_BETTER",
                                              "bands": [{"threshold": 100, "score": 5}], "fallback_score": 1})
    assert resp.status_code == 403
