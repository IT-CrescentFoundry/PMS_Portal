"""CSRF protection: Origin validation and the session-bound X-CSRF-Token."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth.csrf import CSRFMiddleware, csrf_token_for, csrf_token_valid
from app.auth.tokens import ACCESS_TOKEN_COOKIE, create_access_token
from app.models.enums import ScopeType

TRUSTED = "http://localhost:5173"
BLOCKED = {"detail": "Cross-site request blocked."}
TOKEN_INVALID = {"detail": "CSRF token missing or invalid."}
PASSWORD = "synthetic-test-password-1"  # test-only credential


# --- the middleware in isolation (a future write endpoint) --------------------------

@pytest.fixture
def write_api() -> TestClient:
    """A tiny app with write routes behind the real CSRF middleware."""
    api = FastAPI()
    api.add_middleware(CSRFMiddleware, trusted_origins=[TRUSTED])

    @api.post("/api/things")
    @api.put("/api/things")
    @api.patch("/api/things")
    @api.delete("/api/things")
    def write():
        return {"ok": True}

    @api.get("/api/things")
    def read():
        return {"ok": True}

    return TestClient(api)


@pytest.fixture
def session_token() -> str:
    return create_access_token(1)[0]


def call(client, session=None, method="POST", **headers):
    if session:
        headers["Cookie"] = f"{ACCESS_TOKEN_COOKIE}={session}"  # as a browser would send it
    return client.request(method, "/api/things", headers=headers)


def test_valid_token_from_trusted_origin_is_accepted(write_api, session_token):
    resp = call(write_api, session_token, Origin=TRUSTED, **{"X-CSRF-Token": csrf_token_for(session_token)})
    assert resp.status_code == 200


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_missing_token_is_rejected_for_every_write_method(write_api, session_token, method):
    resp = call(write_api, session_token, method=method, Origin=TRUSTED)
    assert resp.status_code == 403 and resp.json() == TOKEN_INVALID


def test_token_from_another_session_is_rejected(write_api, session_token):
    other = csrf_token_for(create_access_token(2)[0])
    resp = call(write_api, session_token, Origin=TRUSTED, **{"X-CSRF-Token": other})
    assert resp.status_code == 403 and resp.json() == TOKEN_INVALID


def test_garbage_token_is_rejected(write_api, session_token):
    resp = call(write_api, session_token, Origin=TRUSTED, **{"X-CSRF-Token": "not-a-token"})
    assert resp.status_code == 403 and resp.json() == TOKEN_INVALID


@pytest.mark.parametrize("origin", ["http://evil.example", "null", "http://localhost:5173.evil.example"])
def test_untrusted_origin_is_rejected_even_with_a_valid_token(write_api, session_token, origin):
    resp = call(write_api, session_token, Origin=origin, **{"X-CSRF-Token": csrf_token_for(session_token)})
    assert resp.status_code == 403 and resp.json() == BLOCKED


def test_cookie_request_without_origin_or_referer_is_rejected(write_api, session_token):
    resp = call(write_api, session_token, **{"X-CSRF-Token": csrf_token_for(session_token)})
    assert resp.status_code == 403 and resp.json() == BLOCKED


def test_trusted_referer_is_accepted_when_origin_is_absent(write_api, session_token):
    resp = call(
        write_api,
        session_token,
        Referer=f"{TRUSTED}/employees?x=1",
        **{"X-CSRF-Token": csrf_token_for(session_token)},
    )
    assert resp.status_code == 200
    resp = call(write_api, session_token, Referer="http://evil.example/page")
    assert resp.status_code == 403 and resp.json() == BLOCKED


def test_api_own_origin_is_trusted(write_api, session_token):
    # e.g. Swagger UI served by the API itself.
    resp = call(
        write_api, session_token, Origin="http://testserver", **{"X-CSRF-Token": csrf_token_for(session_token)}
    )
    assert resp.status_code == 200


def test_bearer_requests_need_no_csrf_token(write_api, session_token):
    resp = call(write_api, session_token, Origin=TRUSTED, Authorization=f"Bearer {session_token}")
    assert resp.status_code == 200
    # Typical API client: bearer header, no cookie, no Origin.
    resp = write_api.post("/api/things", headers={"Authorization": f"Bearer {session_token}"})
    assert resp.status_code == 200


def test_reads_are_not_affected(write_api, session_token):
    assert call(write_api, session_token, method="GET", Origin="http://evil.example").status_code == 200


def test_token_is_bound_to_the_session():
    a, b = create_access_token(1)[0], create_access_token(2)[0]
    assert csrf_token_valid(a, csrf_token_for(a))
    assert not csrf_token_valid(b, csrf_token_for(a))


# --- the real application -------------------------------------------------------------

@pytest.fixture
def account(make_user):
    return make_user("tst.csrf", password=PASSWORD, roles=[("ADMIN", [(ScopeType.GLOBAL, None, None)])])


def login(client, **headers):
    return client.post("/api/auth/login", json={"username": "tst.csrf", "password": PASSWORD}, headers=headers)


def test_login_from_another_site_is_blocked(anon_client, account):
    resp = login(anon_client, Origin="http://evil.example")
    assert resp.status_code == 403 and resp.json() == BLOCKED
    assert "set-cookie" not in resp.headers


def test_login_from_the_frontend_and_session_restore_still_work(anon_client, account):
    resp = login(anon_client, Origin=TRUSTED)
    assert resp.status_code == 200
    me = anon_client.get("/api/auth/me", headers={"Origin": TRUSTED})
    assert me.status_code == 200
    token = me.json()["csrf_token"]
    assert token == resp.json()["user"]["csrf_token"]
    session = anon_client.cookies.get(ACCESS_TOKEN_COOKIE)
    assert csrf_token_valid(session, token)


def test_me_returns_no_csrf_token_for_bearer_clients(client_for, account):
    assert client_for(account).get("/api/auth/me").json()["csrf_token"] is None


@pytest.mark.parametrize("headers", [{}, {"Origin": "http://evil.example"}])
def test_logout_requires_a_trusted_origin_when_a_session_exists(anon_client, account, headers):
    login(anon_client)
    resp = anon_client.post("/api/auth/logout", headers=headers)
    assert resp.status_code == 403 and resp.json() == BLOCKED
    assert anon_client.get("/api/auth/me").status_code == 200  # still signed in


def test_every_route_is_covered_and_rejections_keep_cors_headers(anon_client, account):
    """The middleware runs before routing, so future write routes are covered;
    CORS headers let the frontend read the error."""
    login(anon_client)
    resp = anon_client.post("/api/plants", headers={"Origin": TRUSTED})
    assert resp.status_code == 403 and resp.json() == TOKEN_INVALID
    assert resp.headers["access-control-allow-origin"] == TRUSTED


def test_cors_preflight_allows_the_csrf_header(anon_client):
    resp = anon_client.options(
        "/api/plants",
        headers={
            "Origin": TRUSTED,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-csrf-token",
        },
    )
    assert resp.status_code == 200
    assert "x-csrf-token" in resp.headers["access-control-allow-headers"].lower()
