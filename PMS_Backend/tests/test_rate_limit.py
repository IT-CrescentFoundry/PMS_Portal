"""Login throttling: per client IP and per submitted username."""
import pytest

from app.auth.rate_limit import LoginRateLimiter
from app.main import app
from app.models.enums import ScopeType

PASSWORD = "synthetic-test-password-1"  # test-only credential
TOO_MANY = {"detail": "Too many sign-in attempts. Please wait and try again."}
LOGIN_FAILED = {"detail": "Invalid username or password."}


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def limiter(clock=None, **overrides) -> LoginRateLimiter:
    settings = {"max_failures_per_ip": 5, "max_failures_per_account": 3, "window_seconds": 60}
    settings.update(overrides)
    return LoginRateLimiter(clock=clock or FakeClock(), **settings)


# --- the limiter itself ----------------------------------------------------------

def test_account_limit_blocks_until_the_window_passes():
    clock = FakeClock()
    lim = limiter(clock)
    for _ in range(3):
        assert lim.retry_after("1.1.1.1", "alice") is None
        lim.record_failure("1.1.1.1", "alice")
    assert lim.retry_after("1.1.1.1", "alice") == 60
    clock.now += 30
    assert lim.retry_after("1.1.1.1", "alice") == 30
    clock.now += 30
    assert lim.retry_after("1.1.1.1", "alice") is None


def test_usernames_are_normalized():
    lim = limiter()
    for name in ("Alice", " alice ", "ALICE"):
        lim.record_failure("1.1.1.1", name)
    assert lim.retry_after("2.2.2.2", "alice") is not None  # different IP, same account


def test_ip_limit_spans_usernames():
    lim = limiter()
    for i in range(5):
        lim.record_failure("9.9.9.9", f"user{i}")
    assert lim.retry_after("9.9.9.9", "someone-new") is not None
    assert lim.retry_after("8.8.8.8", "someone-new") is None


def test_success_clears_the_account_counter_only():
    lim = limiter()
    for _ in range(2):
        lim.record_failure("1.1.1.1", "alice")
    lim.record_success("alice")
    for _ in range(2):
        lim.record_failure("1.1.1.1", "alice")
    assert lim.retry_after("1.1.1.1", "alice") is None  # 2 < 3 after the reset


def test_disabled_limiter_never_blocks():
    lim = limiter(enabled=False)
    for _ in range(50):
        lim.record_failure("1.1.1.1", "alice")
    assert lim.retry_after("1.1.1.1", "alice") is None


def test_memory_is_bounded():
    lim = limiter(max_tracked_keys=100)
    for i in range(500):
        lim.record_failure(f"10.0.{i // 250}.{i % 250}", f"user{i}")
    assert len(lim._failures) <= 100


# --- the sign-in endpoints ----------------------------------------------------------

@pytest.fixture
def small_limits(monkeypatch):
    lim = limiter(clock=FakeClock())
    monkeypatch.setattr(app.state, "login_limiter", lim)
    return lim


@pytest.fixture
def account(make_user):
    return make_user("tst.ratelimit", password=PASSWORD, roles=[("ADMIN", [(ScopeType.GLOBAL, None, None)])])


def attempt(client, username, password, endpoint="login"):
    if endpoint == "login":
        return client.post("/api/auth/login", json={"username": username, "password": password})
    return client.post("/api/auth/token", data={"username": username, "password": password})


def test_generic_401_is_unchanged_below_the_limit(anon_client, small_limits, account):
    for _ in range(3):
        resp = attempt(anon_client, "tst.ratelimit", "wrong-password-123")
        assert resp.status_code == 401 and resp.json() == LOGIN_FAILED


def test_throttled_account_is_refused_even_with_the_right_password(anon_client, small_limits, account):
    for _ in range(3):
        attempt(anon_client, "tst.ratelimit", "wrong-password-123")
    resp = attempt(anon_client, "tst.ratelimit", PASSWORD)
    assert resp.status_code == 429
    assert resp.json() == TOO_MANY
    assert int(resp.headers["retry-after"]) > 0
    assert "set-cookie" not in resp.headers


def test_throttling_does_not_reveal_whether_an_account_exists(anon_client, small_limits, account):
    responses = {}
    for name in ("tst.ratelimit", "tst.does-not-exist"):
        for _ in range(3):
            attempt(anon_client, name, "wrong-password-123")
        resp = attempt(anon_client, name, "wrong-password-123")
        responses[name] = (resp.status_code, resp.json())
    assert responses["tst.ratelimit"] == responses["tst.does-not-exist"] == (429, TOO_MANY)


def test_ip_limit_applies_across_usernames(anon_client, small_limits):
    for i in range(5):
        attempt(anon_client, f"tst.nobody{i}", "wrong-password-123")
    resp = attempt(anon_client, "tst.fresh-name", "wrong-password-123")
    assert resp.status_code == 429 and resp.json() == TOO_MANY


def test_successful_login_resets_the_account_counter(anon_client, small_limits, account):
    for _ in range(2):
        attempt(anon_client, "tst.ratelimit", "wrong-password-123")
    assert attempt(anon_client, "tst.ratelimit", PASSWORD).status_code == 200
    anon_client.cookies.clear()
    for _ in range(2):
        assert attempt(anon_client, "tst.ratelimit", "wrong-password-123").status_code == 401


def test_token_endpoint_is_throttled_too(anon_client, small_limits, account):
    for _ in range(3):
        attempt(anon_client, "tst.ratelimit", "wrong-password-123", endpoint="token")
    resp = attempt(anon_client, "tst.ratelimit", PASSWORD, endpoint="token")
    assert resp.status_code == 429 and resp.json() == TOO_MANY
