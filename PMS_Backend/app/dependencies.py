from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy.orm import Session

from app.db import SessionLocal


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one database session per request, always closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def transaction(db: Session) -> Iterator[Session]:
    """Commit once if the block succeeds, roll back on any error.

    Write endpoints wrap their service call in this, so a business change and
    its audit record are always committed (or discarded) together.
    """
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
