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

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8000` | Backend origin. A trailing `/` or `/api` is removed automatically. |

Override it in `.env.local` (git-ignored); see `.env.example`. Only `VITE_*`
values reach the browser bundle, so never put secrets in them.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on `localhost:5173` (strict port) |
| `npm run build` | Type-check (`tsc -b`) and production build to `dist/` |
| `npm run lint` | ESLint |
| `npm test` | Component and unit tests (Vitest + Testing Library, mocked API) |
| `npm run test:e2e` | Browser tests (Playwright, installed Google Chrome) against the real backend |

`test:e2e` starts the backend and the dev server if they are not already
running. It uses the **development database with the demo seed**
(`python -m app.seed`), and it reads the demo password from
`PMS_Backend/.env` or `E2E_DEMO_PASSWORD`. Signing in updates the demo
accounts' `last_login_at`; no other data is written. Traces, videos and
screenshots are disabled, so credentials are never written to disk.

## How it works

```
src/
  app/            App shell and route table
  components/     layout (sidebar, header), common UI (buttons, states, fields), tables
  features/       auth, dashboard, plants, departments, employees, reports, account
  services/       apiClient.ts (the only HTTP client) and one module per API area
  hooks/          useApiQuery (cancellable, race-safe data loading)
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

### Authorization

The backend is the only authority. The UI uses the `permissions` from
`/me` (`org:read`, `self:read`) only to decide which navigation to show.
Every request is still filtered and enforced by the API:
- 403 is shown as "Access denied";
- 404 is shown as "not found, or you do not have access" (the two are never
  told apart).

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
