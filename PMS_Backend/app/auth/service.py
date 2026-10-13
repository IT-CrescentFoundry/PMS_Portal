"""Login and password management (database operations)."""
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.auth.passwords import (
    burn_verification_time,
    hash_password,
    needs_rehash,
    validate_new_password,
    verify_password,
)
from app.models import User


class UnknownUserError(LookupError):
    pass


def is_login_allowed(user: User) -> bool:
    """Inactive accounts, and accounts of exited employees, cannot sign in."""
    if not user.is_active:
        return False
    return user.employee is None or user.employee.is_active


def authenticate(db: Session, username: str, password: str) -> User | None:
    """Return the user for valid credentials, otherwise None.

    Every failure (unknown user, no password set, wrong password, inactive
    account) returns None so the caller can give one generic error. The
    caller commits: a successful login records last_login_at and upgrades the
    hash if the hashing parameters have changed.
    """
    user = db.scalars(
        select(User).where(User.username == username).options(joinedload(User.employee))
    ).one_or_none()

    if user is None or user.password_hash is None:
        burn_verification_time(password)
        return None
    if not verify_password(user.password_hash, password):
        return None
    if not is_login_allowed(user):
        return None

    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    user.last_login_at = func.now()
    return user


def set_password(db: Session, username: str, password: str) -> User:
    """Validate and store a new password hash (caller commits)."""
    validate_new_password(password)
    user = db.scalars(select(User).where(User.username == username)).one_or_none()
    if user is None:
        raise UnknownUserError(username)
    user.password_hash = hash_password(password)
    return user
