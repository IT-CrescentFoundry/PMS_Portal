"""Enumerations stored in the database.

Values are stored as their upper-case string value (native MySQL ENUM).
Adding a new value later requires an Alembic migration.
"""
from enum import StrEnum


def enum_values(enum_cls: type[StrEnum]) -> list[str]:
    """`values_callable` for sqlalchemy.Enum: store values, not member names."""
    return [member.value for member in enum_cls]


class CycleStatus(StrEnum):
    """Lifecycle of an annual PMS cycle."""

    DRAFT = "DRAFT"      # being configured (dates, quarters, KRAs)
    ACTIVE = "ACTIVE"    # performance data is being collected/evaluated
    CLOSED = "CLOSED"    # finalized; read-only history


class QuarterStatus(StrEnum):
    """Lifecycle of a quarter within a PMS cycle."""

    DRAFT = "DRAFT"
    OPEN = "OPEN"
    CLOSED = "CLOSED"


class ScopeType(StrEnum):
    """Organizational reach of a role assignment.

    GLOBAL            all plants and departments (e.g. Admin, CHRO)
    PLANT             every department at one plant
    DEPARTMENT        one department across all plants ("Quality — All Plants")
    PLANT_DEPARTMENT  one department at one plant ("Quality — Plant A")
    """

    GLOBAL = "GLOBAL"
    PLANT = "PLANT"
    DEPARTMENT = "DEPARTMENT"
    PLANT_DEPARTMENT = "PLANT_DEPARTMENT"
