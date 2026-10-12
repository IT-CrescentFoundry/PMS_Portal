"""Alembic environment for the PMS backend.

The database connection is NOT configured here or in alembic.ini. Both online
and offline modes reuse the application's engine from app/db.py, so there is a
single source of database configuration (PMS_Backend/.env) and no credentials
live in migration files.
"""
from logging.config import fileConfig

from alembic import context

from app.db import Base, engine
import app.models  # noqa: F401  (registers every model on Base.metadata)

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Metadata of all PMS models, used by 'alembic revision --autogenerate'.
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emit SQL to stdout, no connection).

    Only the dialect of the URL is needed here; nothing connects to MySQL.
    """
    context.configure(
        url=engine.url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode against the configured database."""
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
