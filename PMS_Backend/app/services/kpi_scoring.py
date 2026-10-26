"""KPI scoring through approved matrix versions (Stage K).

At publication (or when an approved deviation is applied) every sheet item
is bound to:
  * the PUBLISHED version of its scoring policy's matrix that is in force on
    the quarter's start date and applies to the assignment's unit, and
  * the KPI's measurement semantics (aggregation, reporting frequency,
    method, unit, direction).
Both are frozen on the item (`matrix_version_id`, `measurement_snapshot`,
and the version's content hash in `scoring_snapshot`), so later revisions
of the matrix or of the KPI never change a published quarter. Anything
missing blocks publication; nothing falls back to a default.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models import (
    KpiDefinition,
    KpiScoringPolicy,
    MatrixVersion,
    PlantDepartment,
    PmsCycleQuarter,
    ReportingFrequency,
)
from app.services import matrix_rules as rules
from app.services import matrix_service
from app.services.errors import Issue
from app.services.matrix_types import TARGET_SOURCES, Source


def measurement_problem(kpi: KpiDefinition) -> str | None:
    if kpi.reporting_frequency is None:
        return (f"'{kpi.name}': set its reporting frequency in the KPI library before "
                "publishing.")
    if kpi.reporting_frequency == ReportingFrequency.MONTHLY and kpi.aggregation is None:
        return (f"'{kpi.name}': choose how its monthly values combine into the quarter in the "
                "KPI library before publishing.")
    return None


def measurement_snapshot(kpi: KpiDefinition, unit: str) -> dict[str, Any]:
    return {
        "kpi_code": kpi.code,
        "direction": kpi.direction.value,
        "unit": unit,
        "reporting_frequency": kpi.reporting_frequency.value if kpi.reporting_frequency else None,
        "aggregation": kpi.aggregation.value if kpi.aggregation else None,
        "measurement_method": kpi.measurement_method,
    }


def resolve_version(db: Session, policy: KpiScoringPolicy, unit: PlantDepartment,
                    quarter: PmsCycleQuarter, label: str) -> tuple[MatrixVersion | None, Issue | None]:
    """The approved version that governs an item, or the reason there is none."""
    if policy.matrix_id is None:
        return None, Issue(f"{label}: the scoring policy '{policy.name}' has no versioned matrix "
                           "configuration; HR must configure one and the CHRO approve it.",
                           "scoring_policy_id")
    version = matrix_service.resolve(db, policy.matrix_id, quarter.start_date, unit.plant_id,
                                     unit.department_id)
    if version is None:
        return None, Issue(
            f"{label}: no approved and published version of the scoring policy '{policy.name}' "
            f"applies to this plant and department on {quarter.start_date.isoformat()} (the "
            f"start of {quarter.name}).", "scoring_policy_id")
    return version, None


def version_problem(version: MatrixVersion, target: Any, label: str) -> str | None:
    """Why an approved version can't score this item: unreadable or altered
    content, or a matrix that needs a target the item lacks."""
    try:
        definition = matrix_service.frozen_definition(version)
    except (rules.EvaluationError, matrix_service.IntegrityProblem) as exc:
        return f"{label}: {exc}"
    sources = {f.source for f in definition.inputs}
    if Source.PERCENT_OF_TARGET in sources and (target is None or target == 0):
        return f"{label}: the scoring matrix uses actual ÷ target, so enter a target other than 0."
    if sources & TARGET_SOURCES and target is None:
        return f"{label}: the scoring matrix uses the target, so enter one."
    return None


def scoring_snapshot(version: MatrixVersion, policy: KpiScoringPolicy) -> dict[str, Any]:
    return {"matrix_version_id": version.id, "matrix_id": version.matrix_id,
            "version_no": version.version_no, "definition_hash": version.definition_hash,
            "policy_code": policy.code}
