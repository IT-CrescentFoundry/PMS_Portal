import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.auth.csrf import CSRF_HEADER, CSRFMiddleware
from app.auth.rate_limit import LoginRateLimiter
from app.config import get_auth_settings, get_security_settings
from app.db import engine
from app.routers import auth, employees, organization, reports
from app.services.errors import NotFoundError

logger = logging.getLogger(__name__)

# Fail at startup, not on the first request, if configuration is invalid.
get_auth_settings()
security = get_security_settings()

app = FastAPI(
    title="PMS Portal API",
    description="Performance Management System API",
    version="0.1.0",
)

# One limiter per process (see app/auth/rate_limit.py for its limitations).
app.state.login_limiter = LoginRateLimiter.from_settings(security)

# Middleware order: the LAST added runs FIRST. CORS is outermost so that
# CSRF rejections still carry CORS headers for trusted frontend origins.
app.add_middleware(CSRFMiddleware, trusted_origins=security.cors_origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(security.cors_origins),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Accept", "Authorization", "Content-Type", CSRF_HEADER],
)

app.include_router(auth.router)
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
