"""Normalization policy settings and group placement (pure: no database).

A NORMALIZATION matrix version (app/services/matrix_types.py) holds
`settings`, validated here, and a decision table that maps a group (and
optionally the score) to a normalized rating:

    "settings": {
      "cohort_level": "DEPARTMENT",        # COMPANY | PLANT | DEPARTMENT | PLANT_DEPARTMENT
      "groups": [                           # best first; target shares total 100
        {"key": "TOP", "label": "Top 20%", "percent": "20"},
        {"key": "MIDDLE", "label": "Middle 60%", "percent": "60", "remainder": true},
        {"key": "BOTTOM", "label": "Bottom 20%", "percent": "20"}
      ],
      "size_rounding": "NEAREST",           # NEAREST (half up) | DOWN | UP
      "rank_by": "FINAL_SCORE",             # FINAL_SCORE (2 decimals) | EXACT_SCORE
      "ties": "REQUIRE_RESOLUTION",         # REQUIRE_RESOLUTION | HIGHER_GROUP | LOWER_GROUP
      "min_cohort_size": 5,
      "small_cohort": "REQUIRE_RESOLUTION", # REQUIRE_RESOLUTION | DEFAULT_GROUP
      "small_cohort_group": null,           # the group, with DEFAULT_GROUP
      "eligible_designations": []           # designation codes; empty = everyone
    }

Placement never splits tied employees and never moves anyone silently: the
policy's explicit tie or small-cohort rule applies, or the employees are
left for an authorized reviewer to place (with a reason).
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP, Decimal
from typing import Any

from app.models.enums import CohortLevel, NormalizationPlacement
from app.services.matrix_rules import Report, decimal_text, parse_decimal

ROUNDING = {"NEAREST": "Nearest whole number (half up)", "DOWN": "Round down", "UP": "Round up"}
RANK_BY = {"FINAL_SCORE": "Final score (2 decimals)", "EXACT_SCORE": "Exact (unrounded) score"}
TIES = {
    "REQUIRE_RESOLUTION": "An authorized reviewer places tied employees",
    "HIGHER_GROUP": "Tied employees all go to the better group",
    "LOWER_GROUP": "Tied employees all go to the lower group",
}
SMALL_COHORT = {
    "REQUIRE_RESOLUTION": "An authorized reviewer places everyone",
    "DEFAULT_GROUP": "Everyone goes to one named group (no forced distribution)",
}
COHORT_LEVELS = {
    CohortLevel.COMPANY.value: "Whole company",
    CohortLevel.PLANT.value: "Each plant",
    CohortLevel.DEPARTMENT.value: "Each department across all plants",
    CohortLevel.PLANT_DEPARTMENT.value: "Each department at each plant",
}
GROUP_KEY = re.compile(r"^[A-Z][A-Z0-9_]{0,19}$")
MAX_GROUPS = 7
HUNDRED = Decimal(100)


@dataclass(frozen=True)
class Group:
    key: str
    label: str
    percent: Decimal
    remainder: bool = False


@dataclass(frozen=True)
class Settings:
    cohort_level: CohortLevel
    groups: tuple[Group, ...]
    size_rounding: str
    rank_by: str
    ties: str
    min_cohort_size: int
    small_cohort: str
    small_cohort_group: str | None
    eligible_designations: tuple[str, ...]

    def group(self, key: str) -> Group | None:
        return next((g for g in self.groups if g.key == key), None)

    @property
    def keys(self) -> list[str]:
        return [g.key for g in self.groups]

    def label(self, key: str | None) -> str:
        group = self.group(key) if key else None
        return group.label if group else (key or "—")


def default_settings() -> dict[str, Any]:
    """A new draft: the intended 20/60/20 split, every other choice left open."""
    return {
        "cohort_level": None,
        "groups": [
            {"key": "TOP", "label": "Top 20%", "percent": "20", "remainder": False},
            {"key": "MIDDLE", "label": "Middle 60%", "percent": "60", "remainder": True},
            {"key": "BOTTOM", "label": "Bottom 20%", "percent": "20", "remainder": False},
        ],
        "size_rounding": None,
        "rank_by": None,
        "ties": None,
        "min_cohort_size": None,
        "small_cohort": None,
        "small_cohort_group": None,
        "eligible_designations": [],
    }


def _choice(raw: Mapping[str, Any], key: str, options: Mapping[str, str], message: str,
            report: Report) -> str | None:
    value = raw.get(key)
    if value not in options:
        report.error(f"settings.{key}", message)
        return None
    return value


def parse_settings(raw: Any, report: Report) -> Settings | None:
    """Validated settings, or None with every problem recorded in `report`."""
    if not isinstance(raw, Mapping):
        report.error("settings", "Define the normalization settings.")
        return None
    errors_before = len(report.errors)
    level = _choice(raw, "cohort_level", COHORT_LEVELS,
                    "Choose who is compared with whom (the cohort level).", report)

    groups: list[Group] = []
    raw_groups = raw.get("groups")
    if not isinstance(raw_groups, list) or not 2 <= len(raw_groups) <= MAX_GROUPS:
        report.error("settings.groups", f"Define 2 to {MAX_GROUPS} groups, best first.")
        raw_groups = raw_groups if isinstance(raw_groups, list) else []
    seen: set[str] = set()
    for i, rg in enumerate(raw_groups[:MAX_GROUPS]):
        path = f"settings.groups[{i}]"
        if not isinstance(rg, Mapping):
            report.error(path, f"Group {i + 1} must be an object.")
            continue
        key, label = rg.get("key"), rg.get("label")
        if not isinstance(key, str) or not GROUP_KEY.fullmatch(key):
            report.error(f"{path}.key", f"Group {i + 1}: use a key of capital letters, digits and "
                                        "underscores, starting with a letter (e.g. TOP).")
            continue
        if key in seen:
            report.error(f"{path}.key", f"The group key '{key}' is used twice.")
            continue
        seen.add(key)
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 40:
            report.error(f"{path}.label", f"Group {key}: give a label of 1–40 characters.")
            continue
        try:
            percent = parse_decimal(rg.get("percent"))
        except ValueError as exc:
            report.error(f"{path}.percent", f"Group {key} share: {exc}")
            continue
        if not Decimal(0) <= percent <= HUNDRED or percent != percent.quantize(Decimal("0.01")):
            report.error(f"{path}.percent", f"Group {key}: the share must be 0–100 % with at most "
                                            "two decimals.")
            continue
        remainder = rg.get("remainder", False)
        if not isinstance(remainder, bool):
            report.error(f"{path}.remainder", f"Group {key}: 'takes the remainder' must be true or "
                                              "false.")
            continue
        groups.append(Group(key, label.strip(), percent, remainder))
    if len(groups) == len(raw_groups) and groups:
        if sum((g.remainder for g in groups), 0) != 1:
            report.error("settings.groups", "Choose exactly one group that takes the remainder "
                                            "after rounding (usually the middle group).")
        total = sum((g.percent for g in groups), Decimal(0))
        if total != HUNDRED:
            report.error("settings.groups", f"The group shares total {decimal_text(total)} %; they "
                                            "must total exactly 100 %.")

    rounding = _choice(raw, "size_rounding", ROUNDING,
                       "Choose how group sizes are rounded to whole employees.", report)
    rank_by = _choice(raw, "rank_by", RANK_BY, "Choose the score employees are ranked by.", report)
    ties = _choice(raw, "ties", TIES, "Choose what happens to employees tied at a group "
                                      "boundary.", report)
    size = raw.get("min_cohort_size")
    if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= 1000:
        report.error("settings.min_cohort_size", "Set the smallest cohort that is normalized "
                                                 "(a whole number from 1 to 1000).")
        size = None
    small = _choice(raw, "small_cohort", SMALL_COHORT,
                    "Choose what happens to a cohort below the minimum size.", report)
    small_group = raw.get("small_cohort_group")
    if small == "DEFAULT_GROUP":
        if small_group not in seen:
            report.error("settings.small_cohort_group", "Choose the group a small cohort is "
                                                        "placed in.")
    elif small_group not in (None, ""):
        report.error("settings.small_cohort_group", "A default group applies only when small "
                                                    "cohorts are placed in one group.")
    designations = raw.get("eligible_designations") or []
    if (not isinstance(designations, list) or len(designations) > 100
            or not all(isinstance(d, str) and 1 <= len(d.strip()) <= 20 for d in designations)):
        report.error("settings.eligible_designations", "List eligible designation codes (up to "
                                                       "100), or leave the list empty for everyone.")
        designations = []
    elif len({d.strip() for d in designations}) != len(designations):
        report.error("settings.eligible_designations", "Each designation code may be listed "
                                                       "once.")

    if len(report.errors) != errors_before:
        return None
    return Settings(CohortLevel(level), tuple(groups), rounding, rank_by, ties, size, small,
                    small_group if small == "DEFAULT_GROUP" else None,
                    tuple(d.strip() for d in designations))


def settings_json(settings: Settings) -> dict[str, Any]:
    return {
        "cohort_level": settings.cohort_level.value,
        "groups": [{"key": g.key, "label": g.label, "percent": decimal_text(g.percent),
                    "remainder": g.remainder} for g in settings.groups],
        "size_rounding": settings.size_rounding,
        "rank_by": settings.rank_by,
        "ties": settings.ties,
        "min_cohort_size": settings.min_cohort_size,
        "small_cohort": settings.small_cohort,
        "small_cohort_group": settings.small_cohort_group,
        "eligible_designations": list(settings.eligible_designations),
    }


def group_rating_definition(settings: Mapping[str, Any],
                            ratings: Mapping[str, Any]) -> dict[str, Any]:
    """A complete NORMALIZATION definition whose decision table gives each
    group one rating. Used for synthetic demo and test policies only; real
    ratings come from an approved policy."""
    from app.services.matrix_types import NORMALIZATION

    group = NORMALIZATION.standard_input("group").as_definition()
    group["allowed_values"] = [g["key"] for g in settings["groups"]]
    rules = [{"priority": i + 1, "label": g["label"],
              "conditions": {"group": {"values": [g["key"]]}},
              "outputs": {"rating": str(ratings[g["key"]])}}
             for i, g in enumerate(settings["groups"])]
    cases = [{"label": g["label"], "inputs": {"group": g["key"]},
              "expected": {"rating": str(ratings[g["key"]])}} for g in settings["groups"]]
    return {"fields": [group, NORMALIZATION.outputs[0].as_definition()], "rules": rules,
            "no_match": {"mode": "error"}, "test_cases": cases, "settings": dict(settings)}


# --- placement --------------------------------------------------------------------------------

@dataclass(frozen=True)
class Candidate:
    employee_id: int
    score: Decimal          # the value ranked by (see Settings.rank_by)
    eligible: bool = True


@dataclass
class Placed:
    employee_id: int
    rank: int | None
    group: str | None
    placement: NormalizationPlacement
    options: list[str] | None = None


@dataclass
class Outcome:
    targets: dict[str, int]
    placed: list[Placed]
    exceptions: list[dict[str, Any]] = field(default_factory=list)
    small_cohort: bool = False


def _round(value: Decimal, mode: str) -> int:
    rounding = {"NEAREST": ROUND_HALF_UP, "DOWN": ROUND_FLOOR, "UP": ROUND_CEILING}[mode]
    return int(value.quantize(Decimal(1), rounding=rounding))


def target_counts(settings: Settings, n: int) -> dict[str, int]:
    """Whole-employee group sizes for a cohort of n; the remainder group takes
    what is left (negative when the rounded groups exceed the cohort)."""
    counts = {g.key: _round(g.percent * n / HUNDRED, settings.size_rounding)
              for g in settings.groups if not g.remainder}
    rest = next(g.key for g in settings.groups if g.remainder)
    counts[rest] = n - sum(counts.values())
    return {g.key: counts[g.key] for g in settings.groups}


def _exception(kind: str, message: str, employee_ids: Sequence[int] = (),
               groups: Sequence[str] = ()) -> dict[str, Any]:
    return {"type": kind, "message": message, "employee_ids": list(employee_ids),
            "groups": list(groups)}


def place(settings: Settings, candidates: Sequence[Candidate]) -> Outcome:
    """Rank eligible candidates (highest score first) and place them in the
    policy's groups."""
    eligible = sorted((c for c in candidates if c.eligible),
                      key=lambda c: (-c.score, c.employee_id))
    others = [c for c in candidates if not c.eligible]
    n = len(eligible)
    targets = target_counts(settings, n)
    scores = [c.score for c in eligible]
    ranks = [1 + sum(1 for s in scores if s > score) for score in scores]
    exceptions: list[dict[str, Any]] = []
    group_of: list[str | None] = [None] * n
    how: list[NormalizationPlacement] = [NormalizationPlacement.AUTO] * n
    options: dict[int, list[str]] = {}
    small = n > 0 and (n < settings.min_cohort_size or any(v < 0 for v in targets.values()))

    if small:
        ids = [c.employee_id for c in eligible]
        if settings.small_cohort == "DEFAULT_GROUP":
            group = settings.small_cohort_group
            group_of = [group] * n
            how = [NormalizationPlacement.SMALL_COHORT_DEFAULT] * n
            exceptions.append(_exception(
                "small_cohort", f"{n} employee(s), below the minimum of {settings.min_cohort_size}: "
                                f"as the policy sets, everyone is placed in {settings.label(group)} "
                                "without a forced distribution.", ids, [group]))
        else:
            how = [NormalizationPlacement.NEEDS_RESOLUTION] * n
            options = {i: settings.keys for i in range(n)}
            exceptions.append(_exception(
                "small_cohort", f"{n} employee(s), below the minimum of {settings.min_cohort_size}: "
                                "an authorized reviewer must place each employee, with a reason.",
                ids, settings.keys))
    elif n:
        groups = settings.groups
        r = next(i for i, g in enumerate(groups) if g.remainder)
        # Each rank position's group if nobody were tied: groups above the
        # remainder fill from the top, groups below it from the bottom.
        natural: list[str] = [groups[r].key] * n
        position = 0
        for g in groups[:r]:
            for _ in range(targets[g.key]):
                natural[position] = g.key
                position += 1
        position = n
        for g in reversed(groups[r + 1:]):
            for _ in range(targets[g.key]):
                position -= 1
                natural[position] = g.key
        group_of = list(natural)
        order = {g.key: i for i, g in enumerate(groups)}
        lo = 0
        while lo < n:
            hi = lo
            while hi + 1 < n and scores[hi + 1] == scores[lo]:
                hi += 1
            spanned = sorted({natural[i] for i in range(lo, hi + 1)}, key=order.__getitem__)
            if len(spanned) > 1:  # equal scores across a group boundary
                ids = [eligible[i].employee_id for i in range(lo, hi + 1)]
                labels = " / ".join(settings.label(k) for k in spanned)
                score = decimal_text(scores[lo])
                if settings.ties == "REQUIRE_RESOLUTION":
                    for i in range(lo, hi + 1):
                        group_of[i] = None
                        how[i] = NormalizationPlacement.NEEDS_RESOLUTION
                        options[i] = list(spanned)
                    exceptions.append(_exception(
                        "tie", f"{len(ids)} employees are tied at {score} across {labels}: an "
                               "authorized reviewer must place each of them, with a reason.",
                        ids, spanned))
                else:
                    target = spanned[0] if settings.ties == "HIGHER_GROUP" else spanned[-1]
                    for i in range(lo, hi + 1):
                        group_of[i] = target
                        how[i] = NormalizationPlacement.TIE_RULE
                    exceptions.append(_exception(
                        "tie", f"{len(ids)} employees are tied at {score} across {labels}: as the "
                               f"policy sets, all are placed in {settings.label(target)}, so the "
                               "group sizes differ from the targets.", ids, spanned))
            lo = hi + 1

        for g in groups:
            if not g.remainder:
                share = g.percent * n / HUNDRED
                if share != share.to_integral_value():
                    exceptions.append(_exception(
                        "rounding", f"{decimal_text(g.percent)} % of {n} is "
                                    f"{decimal_text(share.normalize())}: the policy rounds this "
                                    f"to {targets[g.key]} ({ROUNDING[settings.size_rounding].lower()}).",
                        groups=[g.key]))

    placed = [Placed(c.employee_id, ranks[i], group_of[i], how[i], options.get(i))
              for i, c in enumerate(eligible)]
    placed += [Placed(c.employee_id, None, None, NormalizationPlacement.NOT_ELIGIBLE)
               for c in others]
    if others:
        exceptions.append(_exception(
            "not_eligible", f"{len(others)} employee(s) are outside the policy's eligible "
                            "designations and are not normalized.",
            [c.employee_id for c in others]))
    return Outcome(targets, placed, exceptions, small)


def counts(settings: Settings, groups: Sequence[str | None]) -> dict[str, int]:
    """Employees per group, in the policy's order."""
    return {g.key: sum(1 for x in groups if x == g.key) for g in settings.groups}
