"""Environment-based configuration shared by the whole backend.

PMS_Backend/.env is loaded once, regardless of the terminal's working
directory. Variables already present in the process environment take
precedence (the test suite relies on this to point the app at pms_test).
"""
import os
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from dotenv import load_dotenv

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_FILE)


def require_env(name: str) -> str:
    """Return a required setting, failing fast instead of guessing a value."""
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Missing required environment variable '{name}'. "
            f"Copy PMS_Backend/.env.example to PMS_Backend/.env and set it."
        )
    return value


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise RuntimeError(f"Environment variable '{name}' must be an integer.") from None


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if not raw:
        return default
    if raw.strip().lower() in ("1", "true", "yes", "on"):
        return True
    if raw.strip().lower() in ("0", "false", "no", "off"):
        return False
    raise RuntimeError(f"Environment variable '{name}' must be true or false.")


MIN_SECRET_KEY_LENGTH = 32


@dataclass(frozen=True)
class AuthSettings:
    secret_key: str
    access_token_expire_minutes: int
    cookie_secure: bool


@cache
def get_auth_settings() -> AuthSettings:
    """Authentication settings, validated once and cached."""
    secret_key = require_env("AUTH_SECRET_KEY")
    if len(secret_key) < MIN_SECRET_KEY_LENGTH:
        raise RuntimeError(
            f"AUTH_SECRET_KEY must be at least {MIN_SECRET_KEY_LENGTH} characters long."
        )
    expire_minutes = env_int("AUTH_ACCESS_TOKEN_EXPIRE_MINUTES", 60)
    if not 1 <= expire_minutes <= 24 * 60:
        raise RuntimeError("AUTH_ACCESS_TOKEN_EXPIRE_MINUTES must be between 1 and 1440.")
    return AuthSettings(
        secret_key=secret_key,
        access_token_expire_minutes=expire_minutes,
        # Must be true whenever the API is served over HTTPS.
        cookie_secure=env_bool("AUTH_COOKIE_SECURE", False),
    )


DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"


@dataclass(frozen=True)
class SecuritySettings:
    # Browser origins allowed to call the API with credentials. The same list
    # is trusted by the CSRF Origin check.
    cors_origins: tuple[str, ...]
    login_rate_limit_enabled: bool
    login_max_failures_per_ip: int
    login_max_failures_per_account: int
    login_rate_limit_window_seconds: int


def _parse_origins(raw: str) -> tuple[str, ...]:
    origins = tuple(o.strip().rstrip("/") for o in raw.split(",") if o.strip())
    for origin in origins:
        if origin == "*" or not origin.startswith(("http://", "https://")):
            raise RuntimeError(
                f"CORS_ORIGINS entries must be explicit http(s) origins (got '{origin}')."
            )
    return origins


@cache
def get_security_settings() -> SecuritySettings:
    """CORS / CSRF origins and login rate limits, validated once and cached."""
    settings = SecuritySettings(
        cors_origins=_parse_origins(os.getenv("CORS_ORIGINS") or DEFAULT_CORS_ORIGINS),
        login_rate_limit_enabled=env_bool("LOGIN_RATE_LIMIT_ENABLED", True),
        login_max_failures_per_ip=env_int("LOGIN_MAX_FAILURES_PER_IP", 20),
        login_max_failures_per_account=env_int("LOGIN_MAX_FAILURES_PER_ACCOUNT", 10),
        login_rate_limit_window_seconds=env_int("LOGIN_RATE_LIMIT_WINDOW_SECONDS", 900),
    )
    if min(
        settings.login_max_failures_per_ip,
        settings.login_max_failures_per_account,
        settings.login_rate_limit_window_seconds,
    ) < 1:
        raise RuntimeError("Login rate-limit settings must be positive integers.")
    return settings
