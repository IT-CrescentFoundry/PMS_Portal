"""FastAPI dependencies for authentication and authorization.

Status codes:
  401  no credentials, or an invalid/expired token, or an inactive account
  403  authenticated, but no role grants the capability at all
  404  (raised by services) the record does not exist OR is outside the
       caller's scope; the two are deliberately indistinguishable
"""
from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.auth.permissions import Principal, build_principal
from app.auth.service import is_login_allowed
from app.auth.tokens import ACCESS_TOKEN_COOKIE, InvalidTokenError, decode_access_token
from app.dependencies import get_db
from app.models import User, UserRole
from app.services.audit import AuditActor
from app.services.scope import AccessScope

# Lets Swagger UI's "Authorize" button obtain a bearer token.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token", auto_error=False)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    db: Annotated[Session, Depends(get_db)],
    bearer_token: Annotated[str | None, Depends(oauth2_scheme)],
    cookie_token: Annotated[str | None, Cookie(alias=ACCESS_TOKEN_COOKIE)] = None,
) -> User:
    """Resolve the caller from an `Authorization: Bearer` header (API clients,
    Swagger) or the HttpOnly session cookie (browser frontend)."""
    token = bearer_token or cookie_token
    if not token:
        raise _unauthorized("Not authenticated")
    try:
        user_id = decode_access_token(token)
    except InvalidTokenError:
        raise _unauthorized("Invalid or expired token") from None

    user = db.scalars(
        select(User)
        .where(User.id == user_id)
        .options(
            joinedload(User.employee),
            selectinload(User.user_roles).selectinload(UserRole.role),
            selectinload(User.user_roles).selectinload(UserRole.scopes),
        )
    ).one_or_none()
    # Re-checked on every request, so deactivation is effective immediately.
    if user is None or not is_login_allowed(user):
        raise _unauthorized("Invalid or expired token")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_principal(user: CurrentUser) -> Principal:
    return build_principal(user)


def get_audit_actor(user: CurrentUser) -> AuditActor:
    """The authenticated user as the actor of audited write operations."""
    return AuditActor.from_user(user)


AuditActorDep = Annotated[AuditActor, Depends(get_audit_actor)]


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]


def require_org_scope(principal: CurrentPrincipal) -> AccessScope:
    """Organizational endpoints: the caller needs a non-empty org scope."""
    if principal.org_scope.is_empty:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to organizational data.",
        )
    return principal.org_scope


OrgScope = Annotated[AccessScope, Depends(require_org_scope)]
