"""Signed, expiring access tokens (JWT, HS256).

A token carries only the user's identity (`sub`) and validity window. Roles,
scopes and the active flag are re-read from the database on every request,
so deactivating a user or changing their access takes effect immediately.
"""
from datetime import UTC, datetime, timedelta

import jwt

from app.config import get_auth_settings

ALGORITHM = "HS256"
ISSUER = "pms-api"
ACCESS_TOKEN_COOKIE = "pms_access_token"


class InvalidTokenError(Exception):
    """The token is missing claims, malformed, tampered with or expired."""


def create_access_token(
    user_id: int, *, expires_delta: timedelta | None = None
) -> tuple[str, datetime]:
    """Return (token, expires_at) for the given user id."""
    settings = get_auth_settings()
    now = datetime.now(UTC)
    expires_at = now + (
        expires_delta
        if expires_delta is not None
        else timedelta(minutes=settings.access_token_expire_minutes)
    )
    claims = {"sub": str(user_id), "iat": now, "exp": expires_at, "iss": ISSUER}
    return jwt.encode(claims, settings.secret_key, algorithm=ALGORITHM), expires_at


def decode_access_token(token: str) -> int:
    """Validate signature, issuer and expiry; return the user id."""
    try:
        claims = jwt.decode(
            token,
            get_auth_settings().secret_key,
            algorithms=[ALGORITHM],  # pinned: rejects "none" and algorithm swaps
            issuer=ISSUER,
            options={"require": ["sub", "iat", "exp", "iss"]},
        )
        return int(claims["sub"])
    except (jwt.PyJWTError, ValueError) as exc:
        raise InvalidTokenError from exc
