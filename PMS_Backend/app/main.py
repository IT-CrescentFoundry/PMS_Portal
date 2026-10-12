import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.db import engine
from app.routers import employees, organization, reports
from app.services.errors import NotFoundError

logger = logging.getLogger(__name__)

app = FastAPI(
    title="PMS Portal API",
    description="Performance Management System API",
    version="0.1.0",
)

# Allow our local React frontend to communicate with the API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(organization.router)
app.include_router(employees.router)
app.include_router(reports.router)


@app.exception_handler(NotFoundError)
def not_found_handler(request: Request, exc: NotFoundError) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.get("/")
def root():
    return {
        "message": "PMS Portal API is running",
        "version": "0.1.0",
    }


@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "service": "pms-api",
    }


@app.get("/api/health/db")
def database_health_check():
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))

        return {
            "status": "ok",
            "database": "connected",
        }

    except SQLAlchemyError as exc:
        logger.exception("PMS database connection check failed")

        raise HTTPException(
            status_code=503,
            detail="Database connection failed. "
                   "Check the MySQL service and backend configuration.",
        ) from exc
