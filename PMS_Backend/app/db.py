import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import MetaData, create_engine
from sqlalchemy.engine import URL
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# Load PMS_Backend/.env regardless of the terminal's working directory.
# Variables already set in the process environment take precedence.
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_FILE)


def _require_env(name: str) -> str:
    """Return a required setting, failing fast instead of guessing a value.

    A silent fallback (e.g. a default database name) could point the app at
    the wrong database, so missing settings are treated as a startup error.
    """
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Missing required environment variable '{name}'. "
            f"Copy PMS_Backend/.env.example to PMS_Backend/.env and set it."
        )
    return value


DATABASE_URL = URL.create(
    drivername="mysql+pymysql",
    username=_require_env("DB_USER"),
    password=_require_env("DB_PASSWORD"),
    host=os.getenv("DB_HOST", "localhost"),
    port=int(os.getenv("DB_PORT", "3306")),
    database=_require_env("DB_NAME"),
    query={"charset": "utf8mb4"},
)

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)


# Deterministic constraint/index names. Without this, MySQL invents names and
# later Alembic migrations cannot reliably alter or drop those constraints.
# MySQL limits identifiers to 64 characters; long composite constraints are
# therefore named explicitly in the models.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Base class for PMS SQLAlchemy models."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
