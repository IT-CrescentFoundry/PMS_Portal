from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.auth.passwords import MAX_PASSWORD_LENGTH
from app.models.enums import ScopeType
from app.schemas.employee import EmployeeRef
from app.schemas.organization import DepartmentRef, ORMModel, PlantRef


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


class ScopeRead(ORMModel):
    scope_type: ScopeType
    plant: PlantRef | None
    department: DepartmentRef | None


class RoleGrantRead(BaseModel):
    code: str
    name: str
    scopes: list[ScopeRead]


class CurrentUserRead(BaseModel):
    """The signed-in user's profile and access. Never includes credentials."""

    id: int
    username: str
    email: str | None
    employee: EmployeeRef | None
    roles: list[RoleGrantRead]
    permissions: list[str]
    # Send as X-CSRF-Token on state-changing requests made with the session
    # cookie. Null when the request was not cookie-authenticated.
    csrf_token: str | None = None


class LoginResponse(BaseModel):
    user: CurrentUserRead
    expires_at: datetime  # when the session cookie's token expires (UTC)


class TokenResponse(BaseModel):
    """OAuth2 password-flow response (Swagger UI and non-browser clients)."""

    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int  # seconds
