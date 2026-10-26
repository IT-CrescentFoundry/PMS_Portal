# PMS Portal

A demo **Performance Management System (PMS)** designed to digitize the employee performance evaluation and budget allocation lifecycle, from Job Description (JD) and Key Result Area (KRA) management to annual performance reviews, budget distribution, approvals, and reporting.

## Tech Stack

- **Frontend:** React, TypeScript, Vite
- **Backend:** Python, FastAPI
- **Database:** MySQL
- **Version Control:** Git

## Planned Features

- JD management and department-wise KRA configuration
- Monthly performance data processing and score calculation
- Quarterly reviews, feedback, and performance normalization
- Annual performance evaluation and score deviation tracking
- Performance matrix, compa-ratio (CR), and budget management
- Role-based approvals and filtered reports

## Project Status

Currently under development as a demonstration project using synthetic data. SAP integration and cloud storage will be considered in later phases.

Implemented so far: organization structure (plants, shared departments,
employees working in several plants), secured sign-in with role- and
scope-based access, headcount reporting, an audit trail, and **JD & KPI
setup**: role-specific job descriptions with a three-step sign-off, a shared
KPI library with plant/department applicability, quarterly KPI sheets with
weightages totalling 100%, Excel upload for Department Heads, locking when
quarterly scoring starts, and deviations approved by both the HR Head and the
Plant Head.

Stage K adds **configurable matrices and monthly scoring**: versioned decision
tables that the HR Head defines in the portal or in generated Excel templates
and the CHRO approves before publication; KPI sheets frozen to the exact
approved version; monthly KPI data imports (CSV or Excel, preview before
saving); and quarterly scores with a per-KPI explanation, review and
dual-approved manual overrides. KRA, compa-ratio and increment matrix types
are prepared but carry no values until their configuration is approved.

Stage L adds the **quarterly review**: a company-wide quarter lifecycle
(data collection → department review → normalization → ready → published)
with explicit gates; one consolidated score per employee (explicit
contribution weights for cross-plant employees, never an unweighted
average); configurable, CHRO-approved normalization policies (for example
20/60/20) with target and actual counts per cohort, ties never split
silently and a configured group-to-rating table; optional review comments
and feedback; and one audited, transactional publication by the HR Head or
CHRO, after which nothing in the quarter changes. Employees see their own
sheets and published outcome under **My KPI sheets**. Annual scores and
budgets come in later stages.

## Getting Started

The frontend and backend run as two local servers. Always open the portal at
**http://localhost:5173** (not `127.0.0.1`): the secure session cookie depends on it.

**Frontend** (from `PMS_Frontend/`, with the backend running on `localhost:8000`)
```powershell
npm install
npm run dev            # http://localhost:5173
npm test               # component/unit tests (mocked API)
npm run test:e2e       # browser tests against an isolated backend and database (pms_e2e_test)
```
See [PMS_Frontend/README.md](PMS_Frontend/README.md) for configuration and structure.

**Backend** (Windows PowerShell, from `PMS_Backend/`)

```powershell
python -m venv PMS_venv
.\PMS_venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
Copy-Item .env.example .env        # then set DB_PASSWORD, AUTH_SECRET_KEY, DEMO_USER_PASSWORD
                                   # (never commit .env)

alembic upgrade head               # create/upgrade the MySQL schema
python -m app.seed                 # synthetic demo data + demo passwords (safe to rerun)
python -m pytest                   # tests run against TEST_DB_NAME (pms_test), rolled back
uvicorn app.main:app --reload --host localhost --port 8000   # API docs at http://localhost:8000/docs
```

One-time MySQL setup for the two test databases (as an administrator):

```sql
CREATE DATABASE pms_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;      -- backend tests
GRANT ALL PRIVILEGES ON pms_test.* TO 'pms_app'@'localhost';
CREATE DATABASE pms_e2e_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;  -- browser tests
GRANT ALL PRIVILEGES ON pms_e2e_test.* TO 'pms_app'@'localhost';
```

Each suite uses only its own database. The backend tests use `TEST_DB_NAME`,
which must end with `_test`. The browser tests use `E2E_DB_NAME`, which must
end with `_e2e_test`. Both refuse to run unless the name differs from
`DB_NAME` and the live connection confirms the database. Each suite migrates
its own database; the development database `pms` is never used by tests.

- Authentication, authorization, endpoints and demo accounts: [docs/api.md](docs/api.md)
- Schema design and approved business rules: [docs/database-design.md](docs/database-design.md)
- Configurable matrices, scoring and how to extend them: [docs/matrix-framework.md](docs/matrix-framework.md)
- What the JD and KPI workbooks established (Stage J): [docs/JD_KPI_Scoring.md](docs/JD_KPI_Scoring.md)