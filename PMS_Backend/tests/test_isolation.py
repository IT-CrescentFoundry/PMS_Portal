"""Guards that the suite can never touch the development database."""
import os

from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import text

from app.db import Base, engine
from tests.conftest import TEST_DB_NAME


def test_suite_is_connected_to_the_test_database(db):
    assert TEST_DB_NAME.endswith("_test")
    assert os.environ["DB_NAME"] == TEST_DB_NAME
    assert db.execute(text("SELECT DATABASE()")).scalar() == TEST_DB_NAME


def test_test_schema_matches_models_after_migration():
    """Migrations applied from scratch produce exactly the model schema."""
    with engine.connect() as conn:
        diff = compare_metadata(
            MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata
        )
    assert diff == []
