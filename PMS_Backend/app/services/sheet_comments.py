"""Review comments and optional quarterly feedback on a KPI sheet (Stage L).

Comments are append-only and never a prerequisite: no review, normalization
or publication step looks at them. Review comments are for readers of the
sheet in the organization; feedback is also shown to the employee.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.permissions import Permission, Principal
from app.models import KpiSheetComment, KpiSheetStatus, QuarterStatus, SheetCommentKind
from app.services import kpi_results
from app.services.audit import AuditActor, record_event
from app.services.errors import ConflictError, Issue, PermissionDeniedError, ValidationFailedError

MAX_LENGTH = 2000
# While the quarter is being scored, reviewed and normalized; not after publication.
OPEN_FOR_COMMENTS = (QuarterStatus.OPEN, QuarterStatus.DEPARTMENT_REVIEW,
                     QuarterStatus.NORMALIZATION, QuarterStatus.READY)


def list_comments(db: Session, principal: Principal, sheet_id: int) -> list[KpiSheetComment]:
    sheet = kpi_results.get_sheet(db, principal, sheet_id)
    rows = db.scalars(select(KpiSheetComment).where(KpiSheetComment.sheet_id == sheet.id)
                      .order_by(KpiSheetComment.id)).all()
    if kpi_results.self_only(principal, sheet):
        return [r for r in rows if r.kind == SheetCommentKind.FEEDBACK]
    return list(rows)


def can_comment(principal: Principal, sheet) -> bool:
    unit = sheet.assignment.plant_department
    return (sheet.status == KpiSheetStatus.LOCKED and sheet.quarter.status in OPEN_FOR_COMMENTS
            and principal.scope_for(Permission.KPI_WRITE).allows_unit(unit.plant_id,
                                                                      unit.department_id))


def add_comment(db: Session, principal: Principal, actor: AuditActor, sheet_id: int,
                kind: SheetCommentKind, body: str) -> KpiSheetComment:
    sheet = kpi_results.get_sheet(db, principal, sheet_id)
    unit = sheet.assignment.plant_department
    if not principal.scope_for(Permission.KPI_WRITE).allows_unit(unit.plant_id, unit.department_id):
        raise PermissionDeniedError("Only reviewers of this plant and department can comment.")
    if sheet.status != KpiSheetStatus.LOCKED or sheet.quarter.status not in OPEN_FOR_COMMENTS:
        raise ConflictError("Comments and feedback are possible while the quarter is being scored "
                            "and reviewed, until its scores are published.")
    text = body.strip()
    if not 1 <= len(text) <= MAX_LENGTH:
        raise ValidationFailedError([Issue(f"Write 1 to {MAX_LENGTH} characters.", "body")])
    comment = KpiSheetComment(sheet_id=sheet.id, kind=kind, body=text,
                              author_user_id=principal.user_id)
    db.add(comment)
    db.flush()
    record_event(db, actor=actor, action="kpi_sheet.comment", entity_type="kpi_sheet",
                 entity_id=sheet.id,
                 summary=(f"Added {'feedback' if kind == SheetCommentKind.FEEDBACK else 'a review comment'}"
                          f" on the {sheet.quarter.name} sheet of "
                          f"{sheet.assignment.employee.employee_code}"),
                 changes={"comment_id": comment.id, "kind": kind.value, "length": len(text)},
                 plant_id=unit.plant_id, department_id=unit.department_id)
    return comment
