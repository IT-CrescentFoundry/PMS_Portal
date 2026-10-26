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
| `quarter:start` | ADMIN, HR_HEAD, CHRO | start quarterly scoring (locks the quarter's sheets) and move the quarter through its review steps (Stage L); needs **GLOBAL** scope |
| `deviation:approve_hr` | HR_HEAD, CHRO | the HR Head approval of a deviation |
| `deviation:approve_plant` | PLANT_HEAD | the Plant Head approval of a deviation |

Configurable matrices and scoring (Stage K) add:

| Capability | Roles | Allows |
|---|---|---|
| `matrix:read` | ADMIN, CHRO, HR_HEAD, HR, PLANT_HEAD, DEPT_HEAD, BUDGET_USER | view KPI-scoring and KRA matrices and their versions |
| `matrix:read_compensation` | ADMIN, CHRO, HR_HEAD | also view compa-ratio and increment matrix types |
| `matrix:write` | HR_HEAD | create matrices, edit drafts (portal or Excel), submit, withdraw, publish; the writer's scope must cover the version's applicability (company-wide needs GLOBAL) |
| `matrix:approve` | CHRO | approve or reject a submitted version (not its author or submitter), publish |
| `score:publish` | HR_HEAD, CHRO | contribution weights of cross-plant employees, normalization placements and cohort approval (scope covering everyone concerned); publish a whole quarter (GLOBAL only) |

Score overrides use the deviation capabilities: `kpi:write` requests,
`deviation:approve_hr` and `deviation:approve_plant` approve (two different
people, neither the requester).

Separation of duties is enforced by the API and, for deviations, also by
database CHECK constraints: the three JD signatories must be different
people; a deviation's two approvers must be different people and neither
may be the requester. Nobody marks their own KPI result as reviewed, places
themselves in a normalization cohort, or approves a cohort they belong to or
placed anyone in (Stage L). "Available budget for the department" on a JD is
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
| 409 | Not allowed in the record's current state (e.g. editing a published sheet, any change after scoring started, duplicate role title, editing a submitted or published matrix version, publishing an overlapping version, an action outside its quarter step) | `{"detail": "Only a draft sheet can be edited; reopen it first."}` |
| 422 | Invalid request body or query parameter | FastAPI validation detail |
| 422 | Business rules not met (weightage total, applicability, upload rows, a quarter step's gate) | `{"detail": "Please correct the problems listed.", "issues": [{"message", "field", "row"}]}`; `row` is the spreadsheet row for uploads |

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
| GET, PUT | `/api/jds/{id}/versions/{version_id}` | `org:read` / `jd:write` | PUT only while DRAFT; every current-format field except age band and gender: these are not collected until HR and legal confirm a lawful need, a value is refused (422), and saving or revising clears an earlier one |
| POST | `/api/jds/{id}/versions/{version_id}/propose` | `jd:write` | HOD step |
| POST | `…/authorise` | `jd:authorise` | Plant Head step; not the proposer |
| POST | `…/approve` | `jd:approve` | COO/CHRO step; not an earlier signatory |
| POST | `…/return` | reviewer of the current step | `{"reason"}`; back to DRAFT |
| POST | `/api/jds/{id}/revisions` | `jd:write` | new DRAFT from the approved version |

### KPI management (Stage J)

| Method | Path | Capability | Notes |
|---|---|---|---|
| GET | `/api/kpi/policies` | `org:read` | scoring policies; since Stage K each carries `matrix` (code, version in force today, latest version) |
| POST, PUT | `/api/kpi/policies[/{id}]` | GLOBAL `matrix:write` | creates the policy's KPI-scoring matrix, or a new draft of it, from bands; it scores nothing until the CHRO approves it and it is published; direction is fixed after creation |
| POST | `/api/kpi/policies/{id}/preview` | `org:read` | `{"achievement_percent"}` or, for zero tolerance, `{"actual"}` → `{"score", "matrix_version_id", "version_no", "status"}` (the version in force today, else the latest) |
| GET | `/api/kpi/library` | `org:read` | `plant_id` + `department_id` = KPIs usable there; `search`, `include_inactive` |
| POST, PUT | `/api/kpi/library[/{id}]` | `kpi:write` | applicability must lie within the writer's scope; 409 for a duplicate name; `reporting_frequency` (MONTHLY, QUARTERLY), `aggregation` (SUM, AVERAGE, LAST, MIN, MAX) and `measurement_method` are needed before a sheet using the KPI is published |
| GET | `/api/kpi/quarters` | `org:read` | status DRAFT = KPI setup open; OPEN = scoring started (data collection); then DEPARTMENT_REVIEW, NORMALIZATION, READY, PUBLISHED (Stage L) |
| POST | `/api/kpi/quarters/{id}/start-scoring` | GLOBAL `quarter:start` | locks every PUBLISHED sheet of the quarter; DRAFT sheets stay unscorable |
| GET | `/api/kpi/sheets` | `org:read` | `quarter_id` (required), `plant_id`, `department_id`, `search`: one row per assignment active in the quarter, with its sheet if any |
| POST | `/api/kpi/sheets` | `kpi:write` | `{"assignment_id", "quarter_id"}`; one sheet per assignment per quarter |
| GET | `/api/kpi/sheets/{id}` | `org:read` or own sheet | |
| PUT | `/api/kpi/sheets/{id}` | `kpi:write` | DRAFT only, quarter not started; weightages as text with ≤ 2 decimals |
| POST | `/api/kpi/sheets/{id}/publish` | `kpi:write` | weightages must total exactly 100.00; binds each item to the approved matrix version in force on the quarter's start date and freezes it with the KPI's measurement (`matrix_version`, `measurement` on each item); 422 when a policy has no such version or a measurement is undefined |
| POST | `/api/kpi/sheets/{id}/reopen` | `kpi:write` | `{"reason"}`; before scoring starts only |
| POST | `/api/kpi/sheets/{id}/copy` | `kpi:write` | `{"target_quarter_id"}` → new DRAFT sheet |
| GET | `/api/kpi/uploads/template` | `org:read` | .xlsx with the KPIs and policies visible to the caller |
| POST | `/api/kpi/uploads/preview` | `kpi:write` | multipart `quarter_id` + `file` (.xlsx ≤ 1 MB, ≤ 1000 rows); validates, saves nothing |
| POST | `/api/kpi/uploads/confirm` | `kpi:write` | same form; re-validates and saves every sheet as DRAFT in one transaction, or nothing |
| GET | `/api/kpi/deviations` | `org:read` | `status` |
| POST | `/api/kpi/deviations` | `kpi:write` | `{"sheet_id", "reason" (≥ 10 chars), "items"}`; only while the quarter is in data collection (OPEN); one pending per sheet |
| GET | `/api/kpi/deviations/{id}` | `org:read` | original and proposed items |
| POST | `/api/kpi/deviations/{id}/approve` | `deviation:approve_hr` / `_plant` | `{"as": "HR_HEAD" \| "PLANT_HEAD"}`; applies when both sides have approved |
| POST | `/api/kpi/deviations/{id}/reject` | either approver | `{"reason"}` |

Every change above is written to the audit trail in the same transaction
as the change itself (deviations record the original and revised KPIs,
the reason, both approvers and the times).

### Configurable matrices (Stage K)

Concepts, validation rules and how to extend the framework are in
[matrix-framework.md](matrix-framework.md). A version's `definition` is
JSON validated by the rule engine. Content with errors can only be saved as
a DRAFT, and the API never evaluates code or spreadsheet formulas.

| Method | Path | Capability | Notes |
|---|---|---|---|
| GET | `/api/matrix-types` | `matrix:read` | the types the caller may read, with every field, data type, source, aggregation and limit needed to render forms; `policy_note` while a type awaits approved configuration |
| GET | `/api/matrix-types/{code}/template` | `matrix:write` | blank generated workbook (.xlsx) for a new matrix of the type |
| POST | `/api/matrix-types/{code}/check` | read access to the type | `{"definition", "attributes", "inputs"?}` → `{"check", "rule_summaries", "preview", "preview_error"}`; validates (and previews) unsaved content, stores nothing |
| GET | `/api/matrices` | `matrix:read` | `matrix_type`, `status` (latest version), `search`; compensation types only with `matrix:read_compensation` |
| POST | `/api/matrices` | `matrix:write` | `{"matrix_type", "name", "description", "attributes", "applicability": [{"plant_id", "department_id"}]}` → the matrix with an empty DRAFT version 1; a KPI-scoring matrix also gets its scoring policy |
| GET, PUT | `/api/matrices/{id}` | `matrix:read` / `matrix:write` | detail with every version, `can_write`, `can_revise`; PUT changes the name and description |
| POST | `/api/matrices/{id}/revisions` | `matrix:write` | new DRAFT copied from the latest version; 409 while a draft or submitted version is open |
| GET | `/api/matrices/{id}/versions/{vid}` | `matrix:read` | definition, `definition_hash`, `check` (errors, warnings, test results, gaps, readiness, `ready_to_submit`), rules in words, allowed `actions` |
| PUT | `/api/matrices/{id}/versions/{vid}` | `matrix:write` | `{"definition", "effective_from", "effective_to", "applicability", "change_summary"}`; DRAFT only (409 otherwise); saved even with errors, which the response's `check` lists; ≤ 200 KB |
| POST | `…/versions/{vid}/preview` | `matrix:read` | `{"inputs"}` → `{"outputs", "rule", "used_default", "inputs"}`; 422 for invalid input, an ambiguous match or "stop with an error" |
| POST | `…/versions/{vid}/submit` | `matrix:write` | needs a clean check, an effective date and applicability (422 lists what is missing) |
| POST | `…/versions/{vid}/withdraw` | `matrix:write` | SUBMITTED → DRAFT |
| POST | `…/versions/{vid}/approve` | `matrix:approve` | `{"note"?}`; not the author or submitter (403) |
| POST | `…/versions/{vid}/reject` | `matrix:approve` | `{"reason"}` (required) |
| POST | `…/versions/{vid}/publish` | `matrix:write` or `matrix:approve` | APPROVED only; puts it in force from `effective_from` and ends the version it replaces the day before |
| GET | `…/versions/{vid}/template` | `matrix:read` | the version as a workbook, to edit and upload again |
| POST | `/api/matrices/uploads/preview` | `matrix:write` | multipart `file` (.xlsx ≤ 1 MB, generated by the portal) → action (create, update_draft, new_version), content, problems with their sheet and row, warnings, test results, `ready`; saves nothing |
| POST | `/api/matrices/uploads/confirm` | `matrix:write` | same form; re-validates and saves a DRAFT in one transaction, or nothing; records the uploader, file name, SHA-256 and template version |

### Monthly KPI data and quarterly results (Stage K)

Import contract: CSV with a header row (UTF-8, with or without BOM) or
.xlsx, at most 2 MB and 5000 rows. Columns are matched by name, or by an
explicit `mapping`.

| Column | Required | Meaning |
|---|---|---|
| Employee Code | yes | the employee's code in the PMS |
| Plant Code, Department Code | when the employee has more than one assignment | identifies the KPI sheet |
| KPI | yes | the KPI's code or name, as on the sheet |
| Period | no | `YYYY-MM`; must equal the month being imported |
| Actual | when the scoring matrix uses the actual | the month's value in the KPI's unit |
| Unit | no | must match the sheet's unit |
| one column per imported matrix input | when the matrix needs it | e.g. a category or count the matrix reads |

Rules for an import:

- Only published or locked sheets in the caller's `kpi:write` scope receive
  data.
- The month must have started and must lie in the quarter.
- Only while the quarter is in data collection (DRAFT or OPEN); later steps
  refuse imports and calculation until HR returns the quarter to data
  collection.
- Results that are already published refuse new data.
- A value already stored is replaced only with `replace_existing=true`.
- A file identical to an earlier import of the same month is flagged.
- Formulas in .xlsx files are read as their cached values and never
  evaluated.
- No data comes from SAP in this stage.

| Method | Path | Capability | Notes |
|---|---|---|---|
| GET | `/api/kpi/data/template` | `org:read` | `quarter_id`, `period` (`YYYY-MM`) → .xlsx pre-filled with the KPIs needing data |
| POST | `/api/kpi/data/preview` | `kpi:write` | multipart `quarter_id`, `period`, `file`, `mapping`? (JSON: field key → column), `replace_existing` → lines (new, replace, unchanged), issues with rows, warnings, `ready`; saves nothing |
| POST | `/api/kpi/data/confirm` | `kpi:write` | same form; stores every value or none, with an import record (file name, size, SHA-256, who, when; not the file) |
| GET | `/api/kpi/data/imports` | `org:read` | `quarter_id`; imports within the caller's scope |
| GET | `/api/kpi/sheets/{id}/values` | readers of the sheet | stored monthly source values with their import and row |
| POST | `/api/kpi/results/calculate` | `kpi:write` | `{"quarter_id", "sheet_ids"?}` → `{"calculated", "unchanged", "published", "complete"}`; published results are never recalculated |
| GET | `/api/kpi/results` | `org:read` | `quarter_id`, `plant_id`, `department_id`, `search` |
| GET | `/api/kpi/results/{sheet_id}` | readers of the sheet | calculated (exact), final (2 decimals), override and published scores; per-KPI explanation; allowed actions |
| POST | `/api/kpi/results/{sheet_id}/review` | `kpi:write` | a complete, current result of a locked sheet with no pending override, while the quarter is OPEN or in DEPARTMENT_REVIEW; never one's own sheet (403) |
| POST | `/api/kpi/results/{sheet_id}/publish` | — | retired in Stage L (409): scores are published with their whole quarter |
| POST | `/api/kpi/results/{sheet_id}/overrides` | `kpi:write` | `{"proposed_score" (0–5, ≤ 2 decimals), "reason" (≥ 10 chars)}`; the calculated score is kept; while the quarter is OPEN or in DEPARTMENT_REVIEW |
| GET | `/api/kpi/overrides[/{id}]` | `org:read` | `status` (PENDING, APPLIED, REJECTED, VOIDED) |
| POST | `/api/kpi/overrides/{id}/approve` | `deviation:approve_hr` / `_plant` | `{"as": "HR_HEAD" \| "PLANT_HEAD"}`; applied when both sides have approved |
| POST | `/api/kpi/overrides/{id}/reject` | either approver | `{"reason"}` |

### Quarterly review, normalization and publication (Stage L)

The quarter moves DRAFT → OPEN (data collection) → DEPARTMENT_REVIEW →
NORMALIZATION → READY → PUBLISHED. Each forward step checks a company-wide
gate (422 lists every blocker); each step can be undone one step back with a
reason of at least 10 characters. Lifecycle, gates, consolidation and the
normalization policy are described in
[database-design.md](database-design.md#quarterly-review-normalization-and-publication-stage-l).

| Method | Path | Capability | Notes |
|---|---|---|---|
| GET | `/api/kpi/quarters/{id}/overview` | `org:read` | status, next and previous step, company-wide counts (sheets, employees, cohorts), `blockers` of the next step, `unscorable_sheets`, who published it, allowed `actions` |
| POST | `/api/kpi/quarters/{id}/transition` | GLOBAL `quarter:start` | `{"to", "reason"?}`; one step forward (gate checked) or back (`reason` required); entering NORMALIZATION freezes employee scores and computes the cohorts |
| POST | `/api/kpi/quarters/{id}/publish` | GLOBAL `score:publish` | READY only; publishes every sheet result, employee result and cohort in one transaction, re-verifying hashes; final |
| GET | `/api/kpi/quarters/{id}/employees` | `org:read` | `plant_id`, `department_id`, `search`; one row per employee (counted once), visible when the caller covers the employee's home unit or every scored assignment |
| GET | `/api/kpi/quarters/{id}/employees/{eid}` | as above | components (assignment, sheet, score used, weight, contribution), exact and final score, issues, normalization outcome |
| PUT | `/api/kpi/quarters/{id}/employees/{eid}/weights` | `score:publish` covering every scored assignment | `{"weights": [{"assignment_id", "weight"}]}`; exactly the scored assignments, each > 0, total exactly 100.00; OPEN or DEPARTMENT_REVIEW only |
| GET | `/api/kpi/quarters/{id}/normalization` | `org:read` | the cohorts the caller covers entirely: policy version, population, eligible, target and actual counts and percentages per group, `matches_targets`, unresolved placements |
| GET | `/api/kpi/normalization-runs/{id}` | `org:read` covering every member | settings, ranked members with group, placement, reason, normalized rating and its rule, exceptions, allowed `actions` |
| POST | `/api/kpi/normalization-runs/{id}/placements` | `score:publish` covering the cohort | `{"employee_id", "group", "reason" (≥ 10 chars)}`; only a tied employee or a small-cohort member, only one of their offered groups, never oneself |
| POST | `/api/kpi/normalization-runs/{id}/approve` | `score:publish` covering the cohort | `{"note"?}`; nothing unresolved; not by anyone who placed a member or is a member |
| POST | `/api/kpi/normalization-runs/{id}/reopen` | `score:publish` covering the cohort | `{"reason"}`; APPROVED → DRAFT, while the quarter is in NORMALIZATION |
| GET | `/api/kpi/sheets/{id}/comments` | readers of the sheet | `{"comments", "can_comment"}`; the employee sees FEEDBACK only |
| POST | `/api/kpi/sheets/{id}/comments` | `kpi:write` | `{"kind": "REVIEW_COMMENT" or "FEEDBACK", "body" (1–2000 chars)}`; locked sheets, quarter between OPEN and READY; optional, never required by any step |
| GET | `/api/kpi/my/kpi-sheets` | `self:read` | the caller's own published or locked sheets with their KPIs; scores, group, normalized rating and feedback only once the quarter is published |

Every step, weight change, placement, approval, reopening, comment and the
publication is audited in the same transaction as the change.

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
| `demo.hrhead` | HR_HEAD, GLOBAL (authors company-wide matrices) |

```powershell
# from PMS_Backend, with DEMO_USER_PASSWORD set in .env
python -m app.seed                          # (re)applies the demo password hash
python -m app.auth set-password demo.admin  # or set one account at a hidden prompt
```
