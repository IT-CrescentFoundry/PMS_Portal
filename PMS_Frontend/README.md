# PMS Portal — Frontend

React 19 + TypeScript + Vite, styled with Tailwind CSS v4, routed with
React Router. It talks only to the FastAPI backend (never to MySQL).

## Run locally (Windows PowerShell)

```powershell
# 1. Backend (separate terminal, from PMS_Backend)
.\PMS_venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --host localhost --port 8000

# 2. Frontend (from PMS_Frontend)
npm install
npm run dev            # http://localhost:5173
```

Open **http://localhost:5173**, not `127.0.0.1:5173`. The session cookie is
`SameSite=Strict`, and the API allows credentialed requests only from this
origin. Sign in with a demo account (see [docs/api.md](../docs/api.md#local-demo-accounts));
the shared demo password is `DEMO_USER_PASSWORD` in `PMS_Backend/.env`.

### Configuration

| Variable            | Default                 | Purpose                                                            |
| ------------------- | ----------------------- | ------------------------------------------------------------------ |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Backend origin. A trailing `/` or `/api` is removed automatically. |

Override it in `.env.local` (git-ignored); see `.env.example`. Only `VITE_*`
values reach the browser bundle, so never put secrets in them.

## Scripts

| Command                | What it does                                                    |
| ---------------------- | --------------------------------------------------------------- |
| `npm run dev`          | Dev server on `localhost:5173` (strict port)                    |
| `npm run build`        | Type-check (`tsc -b`) and production build to `dist/`           |
| `npm run lint`         | ESLint                                                          |
| `npm run format`       | Format all frontend files with Prettier                         |
| `npm run format:check` | Fail if any file is not Prettier-formatted                      |
| `npm test`             | Component and unit tests (Vitest + Testing Library, mocked API) |
| `npm run test:e2e`     | Browser tests (Playwright, installed Google Chrome), isolated   |

### Browser tests

`npm run test:e2e` never touches the development stack or database. It starts
its own two servers, and never reuses running ones:

- **API on `localhost:8001`:** `python -m tests.e2e_server`. Before writing
  anything, the launcher checks that `E2E_DB_NAME` (in `PMS_Backend/.env`)
  ends with `_e2e_test` and differs from `DB_NAME` and `TEST_DB_NAME`, and
  that the live connection is to that database. Only then does it migrate
  the schema and seed synthetic data, which is safe to repeat.
- **Frontend on `localhost:5174`:** pointed at that API.

The synthetic accounts get a random password for each run, so the tests never
use your demo password. Traces, videos and screenshots are disabled, so
credentials never reach the disk.

One-time setup (MySQL administrator):

```sql
CREATE DATABASE pms_e2e_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON pms_e2e_test.* TO 'pms_app'@'localhost';
```

Ports 8001 and 5174 must be free when the tests start.

The e2e database keeps its data between runs, so specs must be repeatable:
`e2e/jd-kpi.spec.ts` gives each JD a unique title and reopens the KPI sheet
an earlier run published. `e2e/matrix-scoring.spec.ts` creates its own matrix
and KPI on every run, swaps the KPI into the locked demo sheet through a
deviation, and imports and calculates October data without publishing a
final score. Neither touches the demo quarters' lifecycle, which would freeze
demo data for good.

`e2e/quarterly.spec.ts` (Stage L) needs a quarter it can take all the way to
publication. The e2e server therefore seeds a **fresh quarter for every
run** (`E2E Q <timestamp>`, April–June 2026, in data collection, with locked
sheets for five Quality assignments; `seed_run_quarter` in
`PMS_Backend/tests/e2e_server.py`). The spec imports three months of
synthetic values designed to give known scores (including a cross-plant
employee weighted 70/30 and a tie at a group boundary), moves the quarter
through department review and normalization, places the tied employees,
has the CHRO approve the cohort and publish, and checks the employee's
**My KPI sheets**. Earlier run quarters stay in the e2e database; the pages'
default quarter ignores them because they start before the demo quarters.

`e2e/annual.spec.ts` (Stage M) works the same way: the e2e server also seeds a
fresh **annual cycle** per run (`E2E-A<timestamp>`: four one-month quarters,
April–July 2026, each with a locked sheet for DEMO0005, the `demo.employee`
account; `seed_annual_cycle` in `PMS_Backend/tests/e2e_server.py`). The spec
publishes the four quarters through the API (the quarterly workflow itself is
covered in the browser by `quarterly.spec.ts`), then, in the browser,
calculates the annual score, has an Admin request a deviation that the CHRO
approves, approves the annual result, corrects a published quarter through a
new reviewed version, recalculates and re-approves the annual result, and
checks that both versions stay visible and that the employee sees only the
approved outcome. Values are designed so every score is known in advance.

`e2e/compensation.spec.ts` (Stage N) gets its own cycle of the same shape
(`E2E-C<timestamp>`, quarters `E2E C1`–`E2E C4`). It publishes the year and
approves the annual result through the API, authors **synthetic** KRA
performance and increment matrices in force for a single day unique to the
run (so runs never overlap; these are test values, not company policy) and
has the CHRO approve one in the browser. In the browser it then creates the
compensation cycle, imports a synthetic salary baseline that exists only in
the spec file, calculates and submits a scenario, checks the per-employee
explanation, has the budget owner record an approved budget (seeing totals but
no employee amounts) and the CHRO approve the final budget, and checks that an
employee is denied. No salary is seeded or written to test artifacts.
API helpers shared by the specs (`apiAs`, `ok`, `findRunCycle`,
`publishDemoQuarter`) live in `e2e/helpers.ts`.

Stage O continues the same spec after the budget is approved: the budget owner
distributes 70,000.00 to Production at Demo Plant A in the browser, the HR
Head allows changes with a reason, the Production head's proposal is refused
over budget and then reduced with a reason, an Admin forwards it and the CHRO
approves it.

## How it works

```
src/
  app/            App shell and route table
  components/     layout (sidebar, header), common UI (buttons, states, fields), tables
  features/       auth, dashboard, plants, departments, employees, reports, account,
                  jd (job descriptions), kpi (library, sheets, upload, deviations),
                  matrix (configurable matrices: list, editor, versions, Excel upload),
                  scores (monthly data import, quarterly results, overrides),
                  quarterly (quarter overview and steps, employee results and
                  contribution weights, normalization cohorts, comments and
                  feedback, My KPI sheets),
                  annual (annual results, deviations, CHRO approval, versions),
                  corrections (requesting, deciding and completing corrections
                  of published quarters; result versions)
  services/       apiClient.ts (the only HTTP client) and one module per API area
  hooks/          useApiQuery (cancellable, race-safe data loading),
                  useAction (one save or sign-off at a time, with its error)
  types/api.ts    response types mirroring the backend schemas
  utils/          dates, labels, URL parameters
  test/           test setup, fetch mock, fixtures
e2e/              Playwright specs
```

### Authentication

- `POST /api/auth/login` sets an **HttpOnly** session cookie. JavaScript never
  sees or stores the token: no `localStorage`, no `sessionStorage`, no
  `Authorization` header.
- Every request uses `credentials: "include"`. On start-up the app calls
  `GET /api/auth/me` to restore the session:
     - 401 shows the sign-in page;
     - an unreachable server shows "unavailable" with Retry, and the user is
       **not** signed out.
- After login the app calls `/me` again, to confirm the browser kept the
  cookie. If it didn't, the user sees an explanation (most often caused by
  using `127.0.0.1`).
- Any later 401 means the session expired. The user is sent to sign-in with
  a message, then returned to the page they were on.
- Sign-out calls `POST /api/auth/logout`. If the server can't be reached, the
  UI says so and does not claim the user is signed out.
- **CSRF.** `/me` also returns the session's `csrf_token`. The API client keeps
  it in memory and sends it as `X-CSRF-Token` on every POST, PUT, PATCH and
  DELETE. It is cleared on sign-out or expiry and replaced on each new
  session. Future write features need nothing extra: use `apiRequest`.

### Authorization

The backend is the only authority. The UI uses the `permissions` from
`/me` (`org:read`, `self:read`, `jd:write`, `kpi:write`, …; see
[docs/api.md](../docs/api.md)) only to decide which navigation and buttons to
show. Every request is still filtered and enforced by the API:

- 403 on a page load is shown as "Access denied";
- 404 is shown as "not found, or you do not have access" (the two are never
  told apart);
- a refused change (403/409 on a write) shows the API's own reason, e.g.
  "Only a draft sheet can be edited; reopen it first.", and a 422 lists every
  problem the API found (with the spreadsheet row for Excel uploads).

### Weightages

KPI weightages are entered and sent as text and added up in whole hundredths
(`features/kpi/weightage.ts`), so 33.33 + 33.33 + 33.34 is exactly 100 and
33.33 × 3 is 99.99. Floating point never decides whether a sheet may be
published, and the API checks the same rule again.

### Configurable matrices

The matrix editor is generated from `GET /api/matrix-types`: the type's
standard fields, the data types and value source allowed for custom fields,
and its limits. A field added in the editor appears at once in every rule,
test case and preview (`features/matrix/matrixDraft.ts` keys everything by a
stable field id, so renaming a key keeps conditions attached). The browser
never decides whether a configuration is valid: **Check the rules** sends the
unsaved content to the API's rule engine, the same code that validates
uploads, and shows its report. Range bounds start with no inclusivity
chosen, so "more than" versus "at least" is always an explicit decision.
A type with `settings` (normalization policies) also gets a settings editor;
renaming a group there updates the allowed values of the `group` input, and
types without Excel templates offer no download or upload.

The quarterly pages (`features/quarterly`) show only what the API returns:
counts, blockers, distributions and allowed actions all come from the
overview, employee and cohort responses, so a button appears only when the
backend would accept the action, and the backend still checks it.

### Compensation and budget

The compensation pages (`features/compensation`) are reachable only with
`budget:read`; the navigation hides them otherwise, and the API enforces every
rule again. What each person sees comes from the API: a budget owner's
scenario response has no employee lines, and small plant/department groups
arrive with their amounts already removed. Amounts and percentages are shown
from the API's decimal strings (`compensationLabels.ts` groups digits as
text, never through floating point), and each proposal's explanation is the
trace stored with the scenario, so it shows exactly what was calculated.
Buttons (submit, approve, record the budget) appear only when the response's
`actions` allow them.

### Increment allocations

`features/allocation` holds the Stage O pages: the allocation dashboard and
final report per cycle, the distribution editor, and the department proposal
with its review steps. Department Heads reach them through **Increment
allocations** without any access to the Stage N budget pages. The editor sends
percentages and amounts as typed text; the API resolves, rounds and validates
them, and every button appears only when the response's `actions` allow it.

### Data and figures

- Every number on screen comes from an API response. Headcount totals are
  always the API's `headcount` (each person counted once), never a sum
  computed in the browser.
- Lists filter, search and paginate on the server using only the documented
  query parameters. The full plant and department lists are small and
  complete, so they are searched in the browser.
- Filters live in the URL, so links, refreshes and the Back button keep them.
  When filters change, the previous results stay visible, dimmed and marked
  "Updating…", until the new results arrive. A slower, older response can
  never replace a newer one.
