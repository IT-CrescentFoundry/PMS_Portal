from pathlib import Path

# PMS_Backend/.env — read by conftest before any app module is imported.
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
