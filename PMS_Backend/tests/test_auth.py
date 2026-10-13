"""Authentication: login, sessions, tokens and safe failure responses."""
import base64
import json
from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.auth.passwords import PasswordPolicyError, verify_password
from app.auth.service import set_password
from app.auth.tokens import ACCESS_TOKEN_COOKIE, ISSUER, create_access_token
from app.config import get_auth_settings
from app.models.enums import ScopeType

PASSWORD = "synthetic-test-password-1"  # test-only credential
LOGIN_FAILED = {"detail": "Invalid username or password."}
PROTECTED_PATHS = [
    "/api/auth/me",
    "/api/plants",
    "/api/plants/1",
    "/api/departments",
    "/api/departments/1",
    "/api/employees",
    "/api/employees/1",
    "/api/reports/headcount",
]


@pytest.fixture
def admin(make_user):
    return make_user(
        "tst.login", password=PASSWORD, roles=[("ADMIN", [(ScopeType.GLOBAL, None, None)])]
    )


def login(client, username="tst.login", password=PASSWORD):
    return client.post("/api/auth/login", json={"username": username, "password": password})


# --- successful login ---------------------------------------------------------

def test_login_sets_secure_session_cookie_and_authenticates(anon_client, admin):
    resp = login(anon_client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["user"]["username"] == "tst.login"
    assert "access_token" not in body  # browser JavaScript never sees the token

    cookie = resp.headers["set-cookie"].lower()
    assert cookie.startswith(f"{ACCESS_TOKEN_COOKIE}=")
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert "path=/api" in cookie

    me = anon_client.get("/api/auth/me")  # cookie is sent automatically
    assert me.status_code == 200
    assert me.json()["username"] == "tst.login"


def test_login_records_last_login(anon_client, admin, db):
    assert admin.last_login_at is None
    login(anon_client)
    db.refresh(admin)
    assert admin.last_login_at is not None


def test_token_endpoint_returns_usable_bearer_token(anon_client, admin):
    resp = anon_client.post(
        "/api/auth/token", data={"username": "tst.login", "password": PASSWORD}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["token_type"] == "bearer"
    assert 0 < body["expires_in"] <= get_auth_settings().access_token_expire_minutes * 60
    assert "set-cookie" not in resp.headers
    plants = anon_client.get(
        "/api/plants", headers={"Authorization": f"Bearer {body['access_token']}"}
    )
    assert plants.status_code == 200


def test_passwords_are_stored_as_argon2id_hashes(admin):
    assert admin.password_hash.startswith("$argon2id$")
    assert PASSWORD not in admin.password_hash


# --- failed login -------------------------------------------------------------

@pytest.mark.parametrize(
    "username,password",
    [("tst.login", "wrong-password-123"), ("tst.nobody", PASSWORD)],
)
def test_bad_credentials_get_one_generic_error(anon_client, admin, username, password):
    resp = login(anon_client, username, password)
    assert resp.status_code == 401
    assert resp.json() == LOGIN_FAILED
    assert "set-cookie" not in resp.headers


def test_inactive_account_cannot_log_in(anon_client, make_user):
    make_user("tst.inactive", password=PASSWORD, is_active=False)
    resp = login(anon_client, "tst.inactive")
    assert resp.status_code == 401 and resp.json() == LOGIN_FAILED


def test_account_without_password_cannot_log_in(anon_client, make_user):
    make_user("tst.nopassword")
    resp = login(anon_client, "tst.nopassword", "anything-at-all-123")
    assert resp.status_code == 401 and resp.json() == LOGIN_FAILED


def test_exited_employee_cannot_log_in(anon_client, make_user, org, db):
    employee = org.employees["002"]
    employee.is_active = False
    db.flush()
    make_user("tst.exited", password=PASSWORD, employee=employee, roles=[("EMPLOYEE", [])])
    resp = login(anon_client, "tst.exited")
    assert resp.status_code == 401 and resp.json() == LOGIN_FAILED


@pytest.mark.parametrize("body", [{}, {"username": "x"}, {"username": "", "password": "x"}])
def test_malformed_login_body_is_rejected(anon_client, body):
    assert anon_client.post("/api/auth/login", json=body).status_code == 422


# --- protected endpoints and tokens --------------------------------------------

@pytest.mark.parametrize("path", PROTECTED_PATHS)
def test_protected_endpoints_reject_anonymous_requests(anon_client, path):
    resp = anon_client.get(path)
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Not authenticated"}
    assert resp.headers["www-authenticate"] == "Bearer"


def test_health_endpoints_stay_public(anon_client):
    assert anon_client.get("/api/health").status_code == 200
    assert anon_client.get("/api/health/db").status_code == 200


def _b64(data: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()


def _claims(user_id, **overrides):
    now = datetime.now(UTC)
    claims = {"sub": str(user_id), "iat": now, "exp": now + timedelta(minutes=5), "iss": ISSUER}
    claims.update(overrides)
    return {k: v for k, v in claims.items() if v is not None}


INVALID_TOKENS = {
    "garbage": lambda uid, key: "not-a-jwt",
    "wrong_signature": lambda uid, key: jwt.encode(_claims(uid), "x" * 48, algorithm="HS256"),
    "expired": lambda uid, key: create_access_token(uid, expires_delta=timedelta(seconds=-5))[0],
    "alg_none": lambda uid, key: (
        f"{_b64({'alg': 'none', 'typ': 'JWT'})}."
        f"{_b64({'sub': str(uid), 'iss': ISSUER, 'iat': 0, 'exp': 4102444800})}."
    ),
    "wrong_issuer": lambda uid, key: jwt.encode(_claims(uid, iss="other"), key, algorithm="HS256"),
    "missing_exp": lambda uid, key: jwt.encode(_claims(uid, exp=None), key, algorithm="HS256"),
    "non_numeric_subject": lambda uid, key: jwt.encode(_claims("abc"), key, algorithm="HS256"),
    "unknown_user": lambda uid, key: create_access_token(999_999_999)[0],
    "tampered_subject": lambda uid, key: (
        lambda t: f"{t.split('.')[0]}.{_b64(_claims(uid + 1, iat=0, exp=4102444800))}.{t.split('.')[2]}"
    )(create_access_token(uid)[0]),
}


@pytest.mark.parametrize("kind", INVALID_TOKENS)
def test_invalid_tokens_are_rejected(anon_client, admin, kind):
    token = INVALID_TOKENS[kind](admin.id, get_auth_settings().secret_key)
    resp = anon_client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid or expired token"}


def test_invalid_cookie_token_is_rejected(anon_client, admin):
    resp = anon_client.get(
        "/api/auth/me", headers={"Cookie": f"{ACCESS_TOKEN_COOKIE}=not-a-jwt"}
    )
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid or expired token"}


def test_deactivation_takes_effect_on_the_next_request(client_for, admin, db):
    client = client_for(admin)
    assert client.get("/api/auth/me").status_code == 200
    admin.is_active = False
    db.flush()
    assert client.get("/api/auth/me").status_code == 401


def test_logout_clears_the_session_cookie(anon_client, admin):
    login(anon_client)
    assert anon_client.get("/api/auth/me").status_code == 200
    resp = anon_client.post("/api/auth/logout")
    assert resp.status_code == 204
    assert ACCESS_TOKEN_COOKIE in resp.headers["set-cookie"]
    assert anon_client.get("/api/auth/me").status_code == 401


def test_responses_never_contain_credentials(anon_client, admin):
    for resp in (login(anon_client), anon_client.get("/api/auth/me")):
        text = resp.text.lower()
        assert "password" not in text
        assert "$argon2" not in text


def test_me_reports_roles_scopes_and_permissions(client_for, make_user, org):
    user = make_user(
        "tst.multi",
        employee=org.employees["001"],
        roles=[
            ("DEPT_HEAD", [(ScopeType.DEPARTMENT, None, org.departments["Q"])]),
            ("EMPLOYEE", []),
        ],
    )
    body = client_for(user).get("/api/auth/me").json()
    assert body["employee"]["employee_code"] == "TST001"
    assert [r["code"] for r in body["roles"]] == ["DEPT_HEAD", "EMPLOYEE"]
    dept_head_scope = body["roles"][0]["scopes"][0]
    assert dept_head_scope["scope_type"] == "DEPARTMENT"
    assert dept_head_scope["plant"] is None
    assert dept_head_scope["department"]["code"] == "TST-Q"
    assert body["permissions"] == ["org:read", "self:read"]


# --- password management --------------------------------------------------------

def test_set_password_enforces_policy_and_hashes(db, make_user):
    make_user("tst.reset")
    with pytest.raises(PasswordPolicyError):
        set_password(db, "tst.reset", "too-short")
    user = set_password(db, "tst.reset", "a-long-enough-password")
    assert verify_password(user.password_hash, "a-long-enough-password")


def test_short_signing_secret_is_rejected(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "short")
    get_auth_settings.cache_clear()
    try:
        with pytest.raises(RuntimeError, match="at least 32"):
            get_auth_settings()
    finally:
        get_auth_settings.cache_clear()  # recomputed from the restored env
