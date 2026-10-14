"""Cross-site request forgery (CSRF) protection.

The browser session is an HttpOnly, SameSite=Strict cookie. SameSite alone
is a good first defence, but it depends on browser behaviour and treats all
ports/subdomains of a site as "same-site". Two explicit layers are added for
every state-changing request (POST, PUT, PATCH, DELETE):

1. Origin validation. The request's Origin (or, if absent, Referer) must be
   a trusted frontend origin (CORS_ORIGINS) or the API's own origin (e.g.
   Swagger UI). A request that carries the session cookie but neither header
   is refused: browsers always send Origin on such requests, so its absence
   means the request is not from our frontend.

2. Session-bound token (synchronizer pattern). A cookie-authenticated write
   must send X-CSRF-Token, an HMAC of the session cookie under the server
   secret. The frontend gets it from GET /api/auth/me, whose response other
   origins cannot read (CORS), and keeps it in memory only. A new session
   gets a new token; the token alone grants nothing without the cookie.

Exemptions:
  * Requests authenticated with an Authorization: Bearer header (API
    clients, Swagger). Browsers never attach that header on their own, so
    such requests cannot be forged cross-site.
  * Login, token and logout need no token (there is no session yet, or it
    is being ended) but are still subject to the Origin check, which blocks
    login CSRF and forced logout from other sites.
"""
import base64
import hashlib
import hmac
from collections.abc import Iterable
from urllib.parse import urlsplit

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.auth.tokens import ACCESS_TOKEN_COOKIE
from app.config import get_auth_settings

CSRF_HEADER = "X-CSRF-Token"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
TOKEN_EXEMPT_PATHS = frozenset({"/api/auth/login", "/api/auth/token", "/api/auth/logout"})

CROSS_SITE_BLOCKED = "Cross-site request blocked."
TOKEN_INVALID = "CSRF token missing or invalid."


def csrf_token_for(session_token: str) -> str:
    """Derive the CSRF token bound to one session cookie value."""
    digest = hmac.new(
        get_auth_settings().secret_key.encode(),
        b"pms-csrf|" + session_token.encode(),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def csrf_token_valid(session_token: str, candidate: str) -> bool:
    return hmac.compare_digest(csrf_token_for(session_token), candidate)


def _origin_of(url: str) -> str | None:
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}".lower()


class CSRFMiddleware:
    """Pure ASGI middleware; add it INSIDE the CORS middleware so that its
    403 responses still carry CORS headers for trusted origins."""

    def __init__(self, app: ASGIApp, trusted_origins: Iterable[str]) -> None:
        self.app = app
        self.trusted = frozenset(o.lower().rstrip("/") for o in trusted_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] in UNSAFE_METHODS:
            problem = self.check(Request(scope))
            if problem is not None:
                await JSONResponse({"detail": problem}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)

    def check(self, request: Request) -> str | None:
        """None when the request may proceed, else the reason it is refused."""
        session = request.cookies.get(ACCESS_TOKEN_COOKIE)

        origin = request.headers.get("origin")
        if origin is None and request.headers.get("referer"):
            origin = _origin_of(request.headers["referer"]) or "invalid"
        if origin is not None:
            own_origin = f"{request.url.scheme}://{request.headers.get('host', '')}".lower()
            if origin.lower() not in self.trusted and origin.lower() != own_origin:
                return CROSS_SITE_BLOCKED
        elif session is not None:
            return CROSS_SITE_BLOCKED

        if session is None or request.url.path in TOKEN_EXEMPT_PATHS:
            return None
        if request.headers.get("authorization", "").lower().startswith("bearer "):
            return None
        candidate = request.headers.get(CSRF_HEADER)
        if not candidate or not csrf_token_valid(session, candidate):
            return TOKEN_INVALID
        return None
