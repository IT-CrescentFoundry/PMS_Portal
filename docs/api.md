# PMS API — Authentication, Authorization and Endpoints

Audience: developers integrating the React frontend or other clients with the
FastAPI backend. Interactive docs: `http://localhost:8000/docs`.

## Authentication

### Browser flow (React frontend)

1. `POST /api/auth/login` with JSON `{"username": "...", "password": "..."}`.
2. On success the API sets the session cookie `pms_access_token`:
   - `HttpOnly`: JavaScript cannot read it, so an XSS bug cannot steal it.
   - `SameSite=Strict`: the browser won't send it on cross-site requests
     (CSRF protection).
   - `Path=/api` and `Max-Age` equal to the token lifetime (default 60 min).
   - `Secure` when `AUTH_COOKIE_SECURE=true` (required for HTTPS).
3. Call every other endpoint with `credentials: "include"`. The browser
   sends the cookie automatically.
4. `GET /api/auth/me` returns the signed-in user, roles, scopes and
   permissions. Call it on app start to restore the session after a page
   reload. A 401 means "show the login page".
5. `POST /api/auth/logout` clears the cookie.

The token is never returned to the browser in the response body. The frontend
must not store credentials or tokens in `localStorage` or `sessionStorage`.
The session expires after `AUTH_ACCESS_TOKEN_EXPIRE_MINUTES`. There is no
refresh token yet, so the user signs in again.

```ts
// Example: sign in, then call a protected endpoint.
await fetch("http://localhost:8000/api/auth/login", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
const me = await fetch("http://localhost:8000/api/auth/me", { credentials: "include" });
```

Local development: open the frontend at `http://localhost:5173` and call the
API at `http://localhost:8000`. Use the same host name (`localhost`) for
both: `127.0.0.1` vs `localhost` counts as cross-site, and the `Strict`
cookie would not be sent. CORS allows credentials only from
`http://localhost:5173` and `http://127.0.0.1:5173`.

### API clients and Swagger UI

`POST /api/auth/token` (OAuth2 password form: `username`, `password`)
returns `{"access_token", "token_type": "bearer", "expires_in"}`. Send it as
`Authorization: Bearer <token>`. Swagger's **Authorize** button uses this.
If both a header and a cookie are present, the header wins.

### Tokens

- JWT signed with HS256 using `AUTH_SECRET_KEY` (≥ 32 characters, from
  `.env`).
- Claims: `sub` (user id), `iat`, `exp`, `iss=pms-api`. The algorithm is
  pinned, so `none` or swapped algorithms are rejected.
- Tokens carry identity only. Roles, scopes and the active flag are read
  from the database on every request, so deactivating an account or
  changing its access takes effect immediately.
- Passwords are stored only as Argon2id hashes. They are upgraded
  automatically on login if the hashing parameters change.

## Authorization model

There is one permission system: **roles**, which say what a user may do,
plus the **scope rows** on each role grant, which say where.

| Role | Capability |
|---|---|
| ADMIN, CHRO, HR, DEPT_HEAD, BUDGET_USER | `org:read`: plants, departments, employees, headcount, **within their scopes** |
| EMPLOYEE | `self:read`: their own employee record only |

Scopes (`user_role_scopes`):

| Scope | Grants |
|---|---|
| `GLOBAL` | every plant and department |
| `PLANT` | every department at one plant |
| `DEPARTMENT` | one department at every plant, including plants mapped later |
| `PLANT_DEPARTMENT` | exactly one department at one plant |

Rules:

- **Union for multiple roles.** A capability's effective scope is the union of
  the scopes on grants of roles that carry it.
- **Grants without the capability add nothing.** Scope rows on a grant whose
  role lacks the capability are ignored; an EMPLOYEE grant never widens
  organizational access. Unknown role codes grant nothing.
- **Deny by default.** A role grant with no scope rows grants no data.
- **Plant and department are matched as a pair.** Quality at Plant B never
  grants Quality at Plant A.
- **Every query applies requested filter ∩ access.** Out-of-scope rows are
  removed even from mixed results. For example, a Quality head viewing
  Plant A sees only Quality, not Maintenance.
- **Employees at more than one plant keep one identity.** Callers see only
  the assignments inside their access. `has_primary_assignment` still shows
  whether a primary exists elsewhere, and `primary_assignment` is `null` when
  it is outside access.
- **Employee detail is visible if any assignment, past or current, is in
  scope.** A plant keeps access to the history of people who worked there.
  Only in-scope assignments are returned. Employees reading their own record
  see all of it.
- **Headcount counts only accessible units.** `scope.access_limited` is
  `true` when access narrowed the requested scope.

## Status codes

| Code | Meaning | Body |
|---|---|---|
| 401 | No credentials, invalid/expired token, or inactive account (`WWW-Authenticate: Bearer`) | `{"detail": "Not authenticated"}` or `{"detail": "Invalid or expired token"}` |
| 401 | Login failed: unknown user, wrong password, no password set, or inactive | `{"detail": "Invalid username or password."}` (deliberately identical) |
| 403 | Signed in, but no role grants the capability | `{"detail": "You do not have access to organizational data."}` |
| 404 | Record does not exist **or** is outside your access (indistinguishable by design) | `{"detail": "Plant 7 not found"}` |
| 422 | Invalid request body or query parameter | FastAPI validation detail |

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health`, `/api/health/db` | public | liveness / database check |
| POST | `/api/auth/login` | public | JSON login; sets session cookie |
| POST | `/api/auth/token` | public | OAuth2 form; returns bearer token |
| POST | `/api/auth/logout` | public | clears session cookie (204) |
| GET | `/api/auth/me` | signed in | profile, roles, scopes, permissions |
| GET | `/api/plants` | `org:read` | `include_inactive` |
| GET | `/api/plants/{id}` | `org:read` | units at the plant, within access |
| GET | `/api/departments` | `org:read` | `plant_id`, `include_inactive` |
| GET | `/api/departments/{id}` | `org:read` | plants where it exists, within access |
| GET | `/api/employees` | `org:read` | `plant_id`, `department_id`, `primary_only`, `include_inactive`, `as_of`, `limit` (1–200), `offset` |
| GET | `/api/employees/{id}` | `org:read` or own record | `as_of` |
| GET | `/api/reports/headcount` | `org:read` | `plant_id`, `department_id`, `as_of` |

## Local demo accounts

The seed creates these synthetic accounts. They share one password, set by
`DEMO_USER_PASSWORD` in `PMS_Backend/.env`; it is never stored in source
code.

| Username | Role and scope |
|---|---|
| `demo.admin` | ADMIN, GLOBAL |
| `demo.chro` | CHRO, GLOBAL |
| `demo.hr.plant-a` | HR, PLANT (Plant A) |
| `demo.quality.head` | DEPT_HEAD, DEPARTMENT (Quality, all plants) + EMPLOYEE |
| `demo.production.head.a` | DEPT_HEAD, PLANT_DEPARTMENT (Production at Plant A) + EMPLOYEE |
| `demo.budget` | BUDGET_USER, GLOBAL |
| `demo.employee` | EMPLOYEE (own record only) |

```powershell
# from PMS_Backend, with DEMO_USER_PASSWORD set in .env
python -m app.seed                          # (re)applies the demo password hash
python -m app.auth set-password demo.admin  # or set one account at a hidden prompt
```
