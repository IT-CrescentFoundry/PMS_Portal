from datetime import datetime

from sqlalchemy import DateTime, FetchedValue, text
from sqlalchemy.orm import Mapped, mapped_column


class TimestampMixin:
    """Adds created_at / updated_at audit columns maintained by MySQL.

    The database sets both values (server clock), so they stay correct even
    for rows written by raw SQL or seed scripts, not only through the ORM.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        # Tells the ORM the DB changes this value on UPDATE, so it is
        # re-fetched instead of going stale in memory.
        server_onupdate=FetchedValue(),
        nullable=False,
    )
