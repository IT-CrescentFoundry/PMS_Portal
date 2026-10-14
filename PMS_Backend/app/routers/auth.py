"""Authentication endpoints.

Browser frontend: POST /login sets an HttpOnly, SameSite=Strict cookie; the
token is never exposed to JavaScript. Swagger UI / API clients: POST /token
(OAuth2 password form) returns a bearer token instead.

Both sign-in endpoints are throttled per client IP and per username (see
app/auth/rate_limit.py) and keep one generic failure message.
"""
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from app.auth.csrf import csrf_token_for
from app.auth.dependencies import CurrentUser, get_principal
from app.auth.rate_limit import LoginRateLimiter
from app.auth.service import authenticate
from app.auth.tokens import ACCESS_TOKEN_COOKIE, create_access_token
from app.config import get_auth_settings
from app.dependencies import get_db
from app.models import User
from app.schemas.auth import (
    CurrentUserRead,
    LoginRequest,
    LoginResponse,
    RoleGrantRead,
    ScopeRead,
    TokenResponse,
)
from app.schemas.employee import EmployeeRef

router = APIRouter(prefix="/api/auth", tags=["auth"])

DbSession = Annotated[Session, Depends(get_db)]
COOKIE_PATH = "/api"
# One message for every login failure: never reveal whether the username
# exists, the password was wrong, or the account is inactive.
LOGIN_FAILED = "Invalid username or password."
# Also generic: the same response whether or not the username exists.
TOO_MANY_ATTEMPTS = "Too many sign-in attempts. Please wait and try again."


def get_login_limiter(request: Request) -> LoginRateLimiter:
    return request.app.state.login_limiter


LoginLimiter = Annotated[LoginRateLimiter, Depends(get_login_limiter)]


def _login_or_raise(
    request: Request, db: Session, limiter: LoginRateLimiter, username: str, password: str
) -> User:
    client_ip = request.client.host if request.client else "unknown"
    wait = limiter.retry_after(client_ip, username)
    if wait is not None:
        # Refused before the password is checked: no hashing work is spent.
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=TOO_MANY_ATTEMPTS,
            headers={"Retry-After": str(wait)},
        )
    user = authenticate(db, username, password)
    if user is None:
        limiter.record_failure(client_ip, username)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=LOGIN_FAILED)
    limiter.record_success(username)
    db.commit()  # last_login_at / hash upgrade
    return user


def to_current_user_read(user: User, csrf_token: str | None = None) -> CurrentUserRead:
    principal = get_principal(user)
    grants = sorted(user.user_roles, key=lambda g: g.role.code)
    return CurrentUserRead(
        id=user.id,
        username=user.username,
        email=user.email,
        employee=EmployeeRef.model_validate(user.employee) if user.employee else None,
        roles=[
            RoleGrantRead(
                code=g.role.code,
                name=g.role.name,
                scopes=[ScopeRead.model_validate(s) for s in g.scopes],
            )
            for g in grants
        ],
        permissions=sorted(principal.permissions),
        csrf_token=csrf_token,
    )


@router.post("/login", response_model=LoginResponse)
def login(
    body: LoginRequest, request: Request, response: Response, db: DbSession, limiter: LoginLimiter
):
    """Browser login: sets the session cookie and returns the user profile."""
    user = _login_or_raise(request, db, limiter, body.username, body.password)
    token, expires_at = create_access_token(user.id)
    settings = get_auth_settings()
    response.set_cookie(
        ACCESS_TOKEN_COOKIE,
        token,
        max_age=int((expires_at - datetime.now(UTC)).total_seconds()),
        path=COOKIE_PATH,
        httponly=True,  # not readable by JavaScript (XSS cannot steal it)
        secure=settings.cookie_secure,
        samesite="strict",  # not sent on cross-site requests (CSRF)
    )
    return LoginResponse(
        user=to_current_user_read(user, csrf_token=csrf_token_for(token)),
        expires_at=expires_at,
    )


@router.post("/token", response_model=TokenResponse)
def token(
    form: Annotated[OAuth2PasswordRequestForm, Depends()],
    request: Request,
    db: DbSession,
    limiter: LoginLimiter,
):
    """OAuth2 password flow for Swagger UI's Authorize button and API clients."""
    user = _login_or_raise(request, db, limiter, form.username, form.password)
    access_token, expires_at = create_access_token(user.id)
    return TokenResponse(
        access_token=access_token,
        expires_in=int((expires_at - datetime.now(UTC)).total_seconds()),
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout() -> Response:
    """Clear the session cookie. Safe to call when not signed in."""
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(
        ACCESS_TOKEN_COOKIE,
        path=COOKIE_PATH,
        httponly=True,
        secure=get_auth_settings().cookie_secure,
        samesite="strict",
    )
    return response


@router.get("/me", response_model=CurrentUserRead)
def me(user: CurrentUser, request: Request):
    """The signed-in user's profile, roles, scopes and permissions, plus the
    CSRF token for the current session cookie (if the session is a cookie)."""
    session_token = request.cookies.get(ACCESS_TOKEN_COOKIE)
    return to_current_user_read(
        user, csrf_token=csrf_token_for(session_token) if session_token else None
    )
