"""Password hashing with Argon2id (argon2-cffi defaults, RFC 9106 profile).

Hashes are self-describing (algorithm, parameters and salt are encoded in
the stored string), so parameters can be strengthened later and old hashes
upgraded transparently on the next successful login (see needs_rehash).
"""
import secrets
from functools import cache

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 256  # bounds hashing work per request

_hasher = PasswordHasher()


class PasswordPolicyError(ValueError):
    pass


def validate_new_password(password: str) -> None:
    if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
        raise PasswordPolicyError(
            f"Password must be {MIN_PASSWORD_LENGTH}-{MAX_PASSWORD_LENGTH} characters long."
        )


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """True only for a correct password; never raises for bad input."""
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


@cache
def _dummy_hash() -> str:
    return _hasher.hash(secrets.token_urlsafe(16))


def burn_verification_time(password: str) -> None:
    """Spend the same effort as a real check when the account doesn't exist,
    so response timing does not reveal which usernames are valid."""
    verify_password(_dummy_hash(), password)
