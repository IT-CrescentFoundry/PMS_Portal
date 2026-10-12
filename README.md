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

## Getting Started

The frontend and backend are developed and run independently during local development.

**Frontend**
```bash
cd PMS_Frontend
npm install
npm run dev
```

**Backend** (Windows PowerShell, from `PMS_Backend/`)

```powershell
python -m venv PMS_venv
.\PMS_venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
Copy-Item .env.example .env        # then set DB_PASSWORD etc. (never commit .env)

alembic upgrade head               # create/upgrade the MySQL schema
python -m app.seed                 # load synthetic demo data (safe to rerun)
python -m pytest                   # run tests (rolled back; leaves no data)
uvicorn app.main:app --reload      # API docs at http://127.0.0.1:8000/docs
```

Schema design and approved business rules: [docs/database-design.md](docs/database-design.md).