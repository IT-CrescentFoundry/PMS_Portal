"""Versions of a quarter's results (Stage M).

Version 1 is the quarter's own result. Each approved correction of the
published quarter is a further version (2, 3, ...) of the results it
recalculates; sheets, employees and cohorts it does not affect keep their
rows. Therefore:

  * the WORKING row of a sheet, employee or cohort is its highest version;
  * the PUBLISHED row is the one with status PUBLISHED (at most one, enforced
    by a unique key); the rows a corrected version replaces become SUPERSEDED;
  * the review step that applies to a row is its version's phase: the
    quarter's status for version 1, the correction's step for later ones.

Corrected monthly values and contribution weights are never written over the
stored ones. Each approved correction's items are applied on top of them, in
version order (an overlay), so every version stays reproducible.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, TypeVar

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    CorrectionItemKind,
    CorrectionStatus,
    PmsCycleQuarter,
    QuarterCorrection,
    QuarterCorrectionItem,
    QuarterStatus,
)

# Approved corrections whose items apply (in progress or published).
APPLIED = (CorrectionStatus.DEPARTMENT_REVIEW, CorrectionStatus.NORMALIZATION,
           CorrectionStatus.READY, CorrectionStatus.PUBLISHED)
IN_PROGRESS = (CorrectionStatus.DEPARTMENT_REVIEW, CorrectionStatus.NORMALIZATION,
               CorrectionStatus.READY)
OPEN = (CorrectionStatus.REQUESTED, *IN_PROGRESS)


def correction_of(db: Session, quarter_id: int, version_no: int) -> QuarterCorrection | None:
    return db.scalars(select(QuarterCorrection).where(
        QuarterCorrection.cycle_quarter_id == quarter_id,
        QuarterCorrection.version_no == version_no)).one_or_none()


def phase(db: Session, quarter: PmsCycleQuarter, version_no: int) -> QuarterStatus:
    """The review step that applies to rows of this version."""
    if version_no <= 1:
        return quarter.status
    correction = correction_of(db, quarter.id, version_no)
    if correction is None or correction.status not in APPLIED:
        return QuarterStatus.PUBLISHED  # nothing may change
    return QuarterStatus(correction.status.value)


def active_correction(db: Session, quarter_id: int) -> QuarterCorrection | None:
    """The approved correction of the quarter still in its review steps."""
    return db.scalars(select(QuarterCorrection).where(
        QuarterCorrection.cycle_quarter_id == quarter_id,
        QuarterCorrection.status.in_(IN_PROGRESS))).one_or_none()


def open_correction(db: Session, quarter_id: int) -> QuarterCorrection | None:
    """A correction requested or in progress (at most one per quarter)."""
    return db.scalars(select(QuarterCorrection).where(
        QuarterCorrection.cycle_quarter_id == quarter_id,
        QuarterCorrection.status.in_(OPEN))).one_or_none()


def published_version(db: Session, quarter: PmsCycleQuarter) -> int | None:
    """The quarter's current published version, or None before publication."""
    if quarter.status != QuarterStatus.PUBLISHED:
        return None
    latest = db.scalar(select(func.max(QuarterCorrection.version_no)).where(
        QuarterCorrection.cycle_quarter_id == quarter.id,
        QuarterCorrection.status == CorrectionStatus.PUBLISHED))
    return latest or 1


R = TypeVar("R")


def latest(rows: Iterable[R], key: Any) -> dict[Any, R]:
    """The highest version per key (the working row)."""
    found: dict[Any, R] = {}
    for row in rows:
        k = key(row)
        if k not in found or row.version_no > found[k].version_no:  # type: ignore[attr-defined]
            found[k] = row
    return found


# --- overlays of corrected inputs -------------------------------------------------------------

@dataclass
class CorrectedValue:
    """A corrected monthly value; read like a stored kpi_monthly_values row."""

    sheet_id: int
    kpi_definition_id: int
    period_month: date
    actual_value: Decimal | None
    input_values: dict[str, Any] | None
    correction_id: int
    data_import_id: None = None
    source_row: None = None


def value_overlay(db: Session, sheet_ids: Sequence[int],
                  *, extra: Sequence[QuarterCorrectionItem] = (),
                  correction_id: int | None = None) -> dict[int, dict[int, dict[date, CorrectedValue]]]:
    """{sheet: {kpi: {month: corrected value}}} from every approved correction,
    in version order. `extra` adds unsaved items (a request being checked)."""
    found: dict[int, dict[int, dict[date, CorrectedValue]]] = {}
    rows = db.execute(
        select(QuarterCorrectionItem, QuarterCorrection.id)
        .join(QuarterCorrection, QuarterCorrectionItem.correction_id == QuarterCorrection.id)
        .where(QuarterCorrectionItem.kind == CorrectionItemKind.VALUE,
               QuarterCorrectionItem.sheet_id.in_(list(sheet_ids) or [0]),
               QuarterCorrection.status.in_(APPLIED))
        .order_by(QuarterCorrection.version_no, QuarterCorrectionItem.id)).all()
    pairs = [(item, cid) for item, cid in rows] + [(item, correction_id or 0) for item in extra]
    for item, cid in pairs:
        found.setdefault(item.sheet_id, {}).setdefault(item.kpi_definition_id, {})[
            item.period_month] = CorrectedValue(item.sheet_id, item.kpi_definition_id,
                                                item.period_month, item.after_actual,
                                                item.after_inputs, cid)
    return found


def merge_values(base: dict[int, dict[int, dict[date, Any]]],
                 overlay: dict[int, dict[int, dict[date, Any]]]) -> dict[int, dict[int, dict[date, Any]]]:
    merged = {sheet: {kpi: dict(months) for kpi, months in kpis.items()}
              for sheet, kpis in base.items()}
    for sheet, kpis in overlay.items():
        for kpi, months in kpis.items():
            merged.setdefault(sheet, {}).setdefault(kpi, {}).update(months)
    return merged


def weight_overlay(db: Session, quarter_id: int, employee_ids: Sequence[int], *,
                   extra: Sequence[QuarterCorrectionItem] = ()) -> dict[int, dict[int, Decimal]]:
    """{employee: {assignment: weight}} set by approved corrections (a later
    version's set replaces an earlier one)."""
    found: dict[int, dict[int, Decimal]] = {}
    items = db.scalars(
        select(QuarterCorrectionItem)
        .join(QuarterCorrection, QuarterCorrectionItem.correction_id == QuarterCorrection.id)
        .where(QuarterCorrectionItem.kind == CorrectionItemKind.WEIGHTS,
               QuarterCorrection.cycle_quarter_id == quarter_id,
               QuarterCorrectionItem.employee_id.in_(list(employee_ids) or [0]),
               QuarterCorrection.status.in_(APPLIED))
        .order_by(QuarterCorrection.version_no, QuarterCorrectionItem.id)).all()
    for item in [*items, *extra]:
        found[item.employee_id] = {int(k): Decimal(str(v)) for k, v in item.after_weights.items()}
    return found
