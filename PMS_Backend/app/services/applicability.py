"""Where a configuration applies, and who may see or set that.

Shared by the KPI library and configurable matrices:
  (plant, department) one unit · (None, department) that department at every
  plant · (plant, None) every department at a plant · (None, None)
  company-wide.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.orm import Session

from app.services.scope import AccessScope, department_visible, plant_visible


class ScopeLike(Protocol):
    plant_id: int | None
    department_id: int | None


@dataclass(frozen=True)
class ApplicabilityInput:
    plant_id: int | None
    department_id: int | None


def applicability_visible(db: Session, access: AccessScope, a: ScopeLike) -> bool:
    if access.is_empty:
        return False
    if a.plant_id is None and a.department_id is None:
        return True  # company-wide
    if a.plant_id is not None and a.department_id is not None:
        return access.allows_unit(a.plant_id, a.department_id)
    if a.department_id is not None:
        return department_visible(db, access, a.department_id)
    return plant_visible(db, access, a.plant_id)  # type: ignore[arg-type]


def applicability_writable(access: AccessScope, a: ScopeLike) -> bool:
    """A writer may only set applicability where their whole scope reaches."""
    if access.is_global:
        return True
    if a.plant_id is not None and a.department_id is not None:
        return access.allows_unit(a.plant_id, a.department_id)
    if a.department_id is not None:
        return a.department_id in access.department_ids
    if a.plant_id is not None:
        return a.plant_id in access.plant_ids
    return False  # company-wide needs GLOBAL
