"""Achievement matrices (scoring policies).

Semantics are taken from workbook 'PMS Prerequisites.xlsx', Sheet1, and were
verified against Excel's cached results (docs/business-requirements/
stage-j-findings.md, section 2.2):

  HIGHER_IS_BETTER  achievement % = actual / target * 100; the first band
                    whose threshold the achievement EXCEEDS (strict >),
                    scanning from the highest threshold.
  LOWER_IS_BETTER   achievement % = actual / target * 100; the first band
                    whose threshold the achievement is BELOW (strict <),
                    scanning from the lowest threshold.
  ZERO_TOLERANCE    met_score when the actual is zero, else breached_score.
  No band matched -> fallback_score.

Stage J uses this only to validate and PREVIEW policies; scoring of real
quarterly data belongs to the scoring stage.
"""
from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from app.models import KpiDirection, KpiScoringPolicy
from app.services.errors import Issue

MIN_SCORE, MAX_SCORE = 0, 5


def _sorted_bands(direction: KpiDirection, bands: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(
        ({"threshold": Decimal(str(b["threshold"])), "score": int(b["score"])} for b in bands),
        key=lambda b: b["threshold"],
        reverse=direction == KpiDirection.HIGHER_IS_BETTER,
    )
    return ordered


def validate_policy(
    direction: KpiDirection,
    bands: list[Mapping[str, Any]],
    fallback_score: int,
    met_score: int | None,
    breached_score: int | None,
) -> list[Issue]:
    """Every problem with a policy definition (empty list = valid)."""
    issues: list[Issue] = []

    def score_ok(value: int | None, field: str) -> None:
        if value is None or not MIN_SCORE <= value <= MAX_SCORE:
            issues.append(Issue(f"{field} must be between {MIN_SCORE} and {MAX_SCORE}.", field))

    if direction == KpiDirection.ZERO_TOLERANCE:
        if bands:
            issues.append(Issue("A zero-tolerance policy has no bands.", "bands"))
        score_ok(met_score, "met_score")
        score_ok(breached_score, "breached_score")
        return issues

    score_ok(fallback_score, "fallback_score")
    if not bands:
        issues.append(Issue("At least one band is required.", "bands"))
        return issues
    for band in bands:
        score_ok(band.get("score"), "bands.score")
        threshold = band.get("threshold")
        if threshold is None or Decimal(str(threshold)) < 0:
            issues.append(Issue("Band thresholds must be zero or more (achievement %).", "bands"))
    if issues:
        return issues
    ordered = _sorted_bands(direction, bands)
    thresholds = [b["threshold"] for b in ordered]
    if len(set(thresholds)) != len(thresholds):
        issues.append(Issue("Band thresholds must be unique.", "bands"))
    scores = [b["score"] for b in ordered]
    if any(a <= b for a, b in zip(scores, scores[1:])):
        issues.append(Issue("Better achievement must always earn a higher score.", "bands"))
    if fallback_score >= scores[-1]:
        issues.append(
            Issue("The fallback score must be lower than every band's score.", "fallback_score")
        )
    return issues


def snapshot(policy: KpiScoringPolicy) -> dict[str, Any]:
    """Frozen, JSON-safe copy stored on sheet items at publication."""
    return {
        "policy_id": policy.id,
        "code": policy.code,
        "name": policy.name,
        "direction": policy.direction.value,
        "bands": [
            {"threshold": str(b["threshold"]), "score": b["score"]}
            for b in _sorted_bands(policy.direction, policy.bands)
        ],
        "fallback_score": policy.fallback_score,
        "met_score": policy.met_score,
        "breached_score": policy.breached_score,
    }


def achievement_percent(actual: Decimal, target: Decimal) -> Decimal:
    if target == 0:
        raise ValueError("Achievement % needs a non-zero target.")
    return actual / target * 100


def evaluate(policy: Mapping[str, Any], *, achievement: Decimal | None = None,
             actual: Decimal | None = None) -> int:
    """Score 0-5 for an achievement % (or, for zero tolerance, the actual)."""
    direction = KpiDirection(policy["direction"])
    if direction == KpiDirection.ZERO_TOLERANCE:
        if actual is None:
            raise ValueError("Zero-tolerance scoring needs the actual value.")
        return int(policy["met_score"] if actual == 0 else policy["breached_score"])
    if achievement is None:
        raise ValueError("Scoring needs an achievement %.")
    for band in _sorted_bands(direction, policy["bands"]):
        if direction == KpiDirection.HIGHER_IS_BETTER and achievement > band["threshold"]:
            return band["score"]
        if direction == KpiDirection.LOWER_IS_BETTER and achievement < band["threshold"]:
            return band["score"]
    return int(policy["fallback_score"])
