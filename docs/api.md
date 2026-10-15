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
cookie would not be sent. CORS allows credentials only from the origins in
`CORS_ORIGINS` (default `http://localhost:5173` and `http://127.0.0.1:5173`).
For writes, also send the `csrf_token` from `/api/auth/me` as `X-CSRF-Token`
(see "CSRF protection" below).

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

### Sign-in rate limiting

`POST /api/auth/login` and `/api/auth/token` count **failed** attempts in a
sliding window (default 15 minutes):

- **Per client IP** (default 20). This slows guessing across many accounts.
- **Per submitted username** (default 10). This slows guessing against one
  account. A successful sign-in clears that username's count.

Beyond either limit the API answers **429** with
`{"detail": "Too many sign-in attempts. Please wait and try again."}` and a
`Retry-After` header. It does so before checking the password, even a
correct one. The per-username count applies to any submitted text, so
throttling behaves identically for real and unknown usernames, and a 429
never reveals whether an account exists. Below the limit, failures still
return the single generic 401. Configure with the `LOGIN_*` settings in
`.env`.

Limitations, which must be addressed before production:

- The counts are **in memory, per API process**. They reset on restart and
  are not shared between several processes or servers. A multi-instance
  deployment needs a shared store (e.g. Redis) or rate limiting at the
  gateway or WAF.
- The client IP is the direct peer address. Behind a reverse proxy every user
  would share the proxy's IP, so trusted forwarding (`X-Forwarded-For` from
  known proxies only) must be configured.
- An attacker who knows a username can delay that user's sign-in for up to
  one window by failing on purpose. No account is ever locked permanently.

### CSRF protection

Every state-changing request (POST, PUT, PATCH, DELETE) is checked by the
`CSRFMiddleware`, which runs before routing and so covers future endpoints
automatically. There are two layers.

1. **Origin check.** The `Origin` header (or the origin of `Referer`) must be
   one of `CORS_ORIGINS` or the API's own origin (for example Swagger UI).
   Requests that carry the session cookie but neither header are refused,
   because browsers always send `Origin` on such requests.
2. **Session-bound token.** A write sent with the session cookie must include
   `X-CSRF-Token`. The token is an HMAC of the session cookie under the
   server secret, returned as `csrf_token` by `GET /api/auth/me` (and by
   login). Other origins can't read that response, because of CORS. The
   frontend keeps the token in memory only; each new session has a new
   token, and the token is useless without the cookie.

Exemptions:

- Requests authenticated with `Authorization: Bearer` (API clients and
  Swagger) need no token. Browsers never attach that header on their own,
  so such requests can't be forged cross-site.
- `login`, `token` and `logout` need no token (there is no session yet, or it
  is ending), but the Origin check still applies. That blocks login CSRF and
  forced logout from other sites.

A refused request gets **403** with `{"detail": "Cross-site request blocked."}`
or `{"detail": "CSRF token missing or invalid."}`. Responses to trusted
origins keep their CORS headers, so the frontend can read the error.

## Authorization model

There is one permission system: **roles**, which say what a user may do,
plus the **scope rows** on each role grant, which say where.

| Role | Capability |
|---|---|
| ADMIN, CHRO, HR_HEAD, HR, PLANT_HEAD, DEPT_HEAD, BUDGET_USER | `org:read`: plants, departments, employees, headcount, JDs, KPI library and KPI sheets, **within their scopes** |
| EMPLOYEE | `self:read`: their own employee record and their own KPI sheets only |

JD and KPI management (Stage J) adds these capabilities; each uses the
scopes of the role grants that carry it:

| Capability | Roles | Allows |
|---|---|---|
| `jd:write` | ADMIN, HR_HEAD, HR, DEPT_HEAD | create and edit draft JDs, propose (the HOD step), start a revision |
| `jd:authorise` | PLANT_HEAD | authorise a proposed JD, or return it to draft |
| `jd:approve` | CHRO | approve an authorised JD, or return it to draft |
| `kpi:write` | ADMIN, HR_HEAD, HR, DEPT_HEAD | KPI library, quarterly KPI sheets, Excel upload, deviation requests |
| `quarter:start` | ADMIN, HR_HEAD, CHRO | start quarterly scoring (locks the quarter's sheets); needs **GLOBAL** scope |
| `deviation:approve_hr` | HR_HEAD, CHRO | the HR Head approval of a deviation |
| `deviation:approve_plant` | PLANT_HEAD | the Plant Head approval of a deviation |

Separation of duties is enforced by the API and, for deviations, also by
database CHECK constraints: the three JD signatories must be different
people; a deviation's two approvers must be different people and neither
may be the requester. "Available budget for the department" on a JD is
filled by HR roles (HR, HR_HEAD, CHRO, ADMIN) only. Company-wide KPIs and
scoring policies need GLOBAL `kpi:write`.

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
| 403 | Write refused by CSRF protection | `{"detail": "Cross-site request blocked."}` or `{"detail": "CSRF token missing or invalid."}` |
| 429 | Too many failed sign-ins (`Retry-After` header) | `{"detail": "Too many sign-in attempts. Please wait and try again."}` |
| 403 | The record is visible but this action is not yours (wrong role, scope, or separation of duties) | `{"detail": "The requester cannot approve their own deviation."}` |
| 404 | Record does not exist **or** is outside your access (indistinguishable by design) | `{"detail": "Plant 7 not found"}` |
| 409 | Not allowed in the record's current state (e.g. editing a published sheet, any change after scoring started, duplicate role title) | `{"detail": "Only a draft sheet can be edited; reopen it first."}` |
| 422 | Invalid request body or query parameter | FastAPI validation detail |
| 422 | Business rules not met (weightage total, applicability, upload rows) | `{"detail": "Please correct the problems listed.", "issues": [{"message", "field", "row"}]}`; `row` is the spreadsheet row for uploads |

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
| GET | `/api/org-units` | `org:read` | every accessible plant-department unit in one call; `plant_id`, `department_id`, `include_inactive` |
| GET | `/api/employees` | `org:read` | `plant_id`, `department_id`, `primary_only`, `include_inactive`, `search` (code or name contains, ≤ 100 chars), `as_of`, `limit` (1–200), `offset` |
| GET | `/api/employees/{id}` | `org:read` or own record | `as_of` |
| GET | `/api/reports/headcount` | `org:read` | `plant_id`, `department_id`, `as_of` |
| GET | `/api/designations` | `org:read` | active job titles (company-wide master) |

### Job descriptions (Stage J)

One JD per unique role (department + plant, or all plants, + title); several
roles may share a designation. Versions: DRAFT → PROPOSED → AUTHORISED →
APPROVED; the previous approved version becomes SUPERSEDED.

| Method | Path | Capability | Notes |
|---|---|---|---|
| GET | `/api/jds` | `org:read` | `department_id`, `plant_id`, `search`, `include_inactive` |
| POST | `/api/jds` | `jd:write` | creates the JD with a DRAFT version 1; 409 for a duplicate role title |
| GET | `/api/jds/{id}` | `org:read` | with all versions |
| GET, PUT | `/api/jds/{id}/versions/{version_id}` | `org:read` / `jd:write` | PUT only while DRAFT; every current-format field |
| POST | `/api/jds/{id}/versions/{version_id}/propose` | `jd:write` | HOD step |
| POST | `…/authorise` | `jd:authorise` | Plant Head step; not the proposer |
| POST | `…/approve` | `jd:approve` | COO/CHRO step; not an earlier signatory |
| POST | `…/return` | reviewer of the current step | `{"reason"}`; back to DRAFT |
| POST | `/api/jds/{id}/revisions` | `jd:write` | new DRAFT from the approved version |

### KPI management (Stage J)

| Method | Path | Capability | Notes |
|---|---|---|---|
| GET | `/api/kpi/policies` | `org:read` | scoring policies (achievement bands → 0–5) |
| POST, PUT | `/api/kpi/policies[/{id}]` | GLOBAL `kpi:write` | direction is fixed after creation |
| POST | `/api/kpi/policies/{id}/preview` | `org:read` | `{"achievement_percent"}` or, for zero tolerance, `{"actual"}` → `{"score"}` |
| GET | `/api/kpi/library` | `org:read` | `plant_id` + `department_id` = KPIs usable there; `search`, `include_inactive` |
| POST, PUT | `/api/kpi/library[/{id}]` | `kpi:write` | applicability must lie within the writer's scope; 409 for a duplicate name |
| GET | `/api/kpi/quarters` | `org:read` | status DRAFT = KPI setup open; OPEN = scoring started |
| POST | `/api/kpi/quarters/{id}/start-scoring` | GLOBAL `quarter:start` | locks every PUBLISHED sheet of the quarter; DRAFT sheets stay unscorable |
| GET | `/api/kpi/sheets` | `org:read` | `quarter_id` (required), `plant_id`, `department_id`, `search`: one row per assignment active in the quarter, with its sheet if any |
| POST | `/api/kpi/sheets` | `kpi:write` | `{"assignment_id", "quarter_id"}`; one sheet per assignment per quarter |
| GET | `/api/kpi/sheets/{id}` | `org:read` or own sheet | |
| PUT | `/api/kpi/sheets/{id}` | `kpi:write` | DRAFT only, quarter not started; weightages as text with ≤ 2 decimals |
| POST | `/api/kpi/sheets/{id}/publish` | `kpi:write` | weightages must total exactly 100.00; freezes each item's scoring policy |
| POST | `/api/kpi/sheets/{id}/reopen` | `kpi:write` | `{"reason"}`; before scoring starts only |
| POST | `/api/kpi/sheets/{id}/copy` | `kpi:write` | `{"target_quarter_id"}` → new DRAFT sheet |
| GET | `/api/kpi/uploads/template` | `org:read` | .xlsx with the KPIs and policies visible to the caller |
| POST | `/api/kpi/uploads/preview` | `kpi:write` | multipart `quarter_id` + `file` (.xlsx ≤ 1 MB, ≤ 1000 rows); validates, saves nothing |
| POST | `/api/kpi/uploads/confirm` | `kpi:write` | same form; re-validates and saves every sheet as DRAFT in one transaction, or nothing |
| GET | `/api/kpi/deviations` | `org:read` | `status` |
| POST | `/api/kpi/deviations` | `kpi:write` | `{"sheet_id", "reason" (≥ 10 chars), "items"}`; only after scoring started; one pending per sheet |
| GET | `/api/kpi/deviations/{id}` | `org:read` | original and proposed items |
| POST | `/api/kpi/deviations/{id}/approve` | `deviation:approve_hr` / `_plant` | `{"as": "HR_HEAD" \| "PLANT_HEAD"}`; applies when both sides have approved |
| POST | `/api/kpi/deviations/{id}/reject` | either approver | `{"reason"}` |

Every change above is written to the audit trail in the same transaction
as the change itself (deviations record the original and revised KPIs,
the reason, both approvers and the times).

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
| `demo.hrhead.a` | HR_HEAD, PLANT (Plant A) |
| `demo.planthead.a` | PLANT_HEAD, PLANT (Plant A) |

```powershell
# from PMS_Backend, with DEMO_USER_PASSWORD set in .env
python -m app.seed                          # (re)applies the demo password hash
python -m app.auth set-password demo.admin  # or set one account at a hidden prompt
```
