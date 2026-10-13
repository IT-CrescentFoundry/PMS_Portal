"""Authentication endpoints.

Browser frontend: POST /login sets an HttpOnly, SameSite=Strict cookie; the
token is never exposed to JavaScript. Swagger UI / API clients: POST /token
(OAuth2 password form) returns a bearer token instead.
"""
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from app.auth.dependencies import CurrentUser, get_principal
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


def _login_or_401(db: Session, username: str, password: str) -> User:
    user = authenticate(db, username, password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=LOGIN_FAILED)
    db.commit()  # last_login_at / hash upgrade
    return user


def to_current_user_read(user: User) -> CurrentUserRead:
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
    )


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, response: Response, db: DbSession):
    """Browser login: sets the session cookie and returns the user profile."""
    user = _login_or_401(db, body.username, body.password)
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
    return LoginResponse(user=to_current_user_read(user), expires_at=expires_at)


@router.post("/token", response_model=TokenResponse)
def token(form: Annotated[OAuth2PasswordRequestForm, Depends()], db: DbSession):
    """OAuth2 password flow for Swagger UI's Authorize button and API clients."""
    user = _login_or_401(db, form.username, form.password)
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
def me(user: CurrentUser):
    """The signed-in user's profile, roles, scopes and permissions."""
    return to_current_user_read(user)
