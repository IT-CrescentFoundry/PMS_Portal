"""Login throttling: an in-memory sliding window of FAILED sign-in attempts.

Two independent limits apply; exceeding either blocks further attempts
(HTTP 429) until old failures leave the window:

  * per client IP        slows password guessing across many accounts;
  * per submitted username  slows guessing against one account.

The username counter is keyed by the submitted (normalized) text, whether or
not such an account exists, so throttling behaves identically for real and
unknown usernames and does not reveal which accounts exist. Successful
sign-ins clear that username's counter.

LIMITATIONS (see docs/api.md):
  * State lives in this process's memory. It resets on restart and is NOT
    shared between multiple API processes/servers; a multi-instance
    deployment needs a shared store (e.g. Redis) or gateway rate limiting.
  * The client IP is the direct peer address. Behind a reverse proxy all
    users share the proxy's IP unless trusted forwarding is configured.
  * Per-username throttling can be used to temporarily delay a specific
    user's sign-in (by failing on purpose); the window is short and no
    account is permanently locked.
"""
import math
import threading
import time
from collections import deque
from collections.abc import Callable

from app.config import SecuritySettings


def normalize_username(username: str) -> str:
    return username.strip().casefold()


class LoginRateLimiter:
    def __init__(
        self,
        *,
        max_failures_per_ip: int,
        max_failures_per_account: int,
        window_seconds: int,
        enabled: bool = True,
        clock: Callable[[], float] = time.monotonic,
        max_tracked_keys: int = 10_000,
    ) -> None:
        self._limits = {"ip": max_failures_per_ip, "account": max_failures_per_account}
        self._window = window_seconds
        self._enabled = enabled
        self._clock = clock
        self._max_tracked_keys = max_tracked_keys
        self._failures: dict[tuple[str, str], deque[float]] = {}
        self._lock = threading.Lock()

    @classmethod
    def from_settings(cls, settings: SecuritySettings) -> "LoginRateLimiter":
        return cls(
            max_failures_per_ip=settings.login_max_failures_per_ip,
            max_failures_per_account=settings.login_max_failures_per_account,
            window_seconds=settings.login_rate_limit_window_seconds,
            enabled=settings.login_rate_limit_enabled,
        )

    def _keys(self, client_ip: str, username: str) -> list[tuple[str, str]]:
        return [("ip", client_ip), ("account", normalize_username(username))]

    def _recent(self, key: tuple[str, str], now: float) -> deque[float]:
        entries = self._failures.get(key, deque())
        while entries and entries[0] <= now - self._window:
            entries.popleft()
        if not entries:
            self._failures.pop(key, None)
        return entries

    def retry_after(self, client_ip: str, username: str) -> int | None:
        """Seconds to wait if this attempt must be refused, else None."""
        if not self._enabled:
            return None
        with self._lock:
            now = self._clock()
            waits = []
            for key in self._keys(client_ip, username):
                entries = self._recent(key, now)
                if len(entries) >= self._limits[key[0]]:
                    waits.append(entries[0] + self._window - now)
            return max(1, math.ceil(max(waits))) if waits else None

    def record_failure(self, client_ip: str, username: str) -> None:
        if not self._enabled:
            return
        with self._lock:
            now = self._clock()
            for key in self._keys(client_ip, username):
                self._recent(key, now)
                self._failures.setdefault(key, deque()).append(now)
            self._bound_memory(now)

    def record_success(self, username: str) -> None:
        with self._lock:
            self._failures.pop(("account", normalize_username(username)), None)

    def reset(self) -> None:
        with self._lock:
            self._failures.clear()

    def _bound_memory(self, now: float) -> None:
        if len(self._failures) <= self._max_tracked_keys:
            return
        for key in list(self._failures):
            self._recent(key, now)
        while len(self._failures) > self._max_tracked_keys:
            self._failures.pop(next(iter(self._failures)))  # oldest-inserted first
