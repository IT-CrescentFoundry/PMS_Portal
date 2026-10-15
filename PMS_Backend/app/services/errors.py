"""Domain errors raised by services and mapped to HTTP responses in app.main."""
from dataclasses import dataclass


class NotFoundError(LookupError):
    """A requested record does not exist (or is outside the caller's scope). HTTP 404."""

    def __init__(self, entity: str, record_id: int | str) -> None:
        super().__init__(f"{entity} {record_id} not found")
        self.entity = entity
        self.record_id = record_id


class PermissionDeniedError(PermissionError):
    """The caller may see the record but not perform this action. HTTP 403."""


class ConflictError(RuntimeError):
    """The action is not allowed in the record's current state (e.g. a
    locked quarter or an already-approved version). HTTP 409."""


@dataclass(frozen=True)
class Issue:
    """One business-rule problem, e.g. weightages not totalling 100 %."""

    message: str
    field: str | None = None
    row: int | None = None  # spreadsheet row, for uploads


class ValidationFailedError(ValueError):
    """Business validation failed; carries every problem found. HTTP 422."""

    def __init__(self, issues: list[Issue]) -> None:
        super().__init__("; ".join(i.message for i in issues))
        self.issues = issues
