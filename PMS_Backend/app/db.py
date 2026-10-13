import os

from sqlalchemy import MetaData, create_engine
from sqlalchemy.engine import URL
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import env_int, require_env

# Required settings have no fallback: a silent default (e.g. a default
# database name) could point the app at the wrong database.
DATABASE_URL = URL.create(
    drivername="mysql+pymysql",
    username=require_env("DB_USER"),
    password=require_env("DB_PASSWORD"),
    host=os.getenv("DB_HOST", "localhost"),
    port=env_int("DB_PORT", 3306),
    database=require_env("DB_NAME"),
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
