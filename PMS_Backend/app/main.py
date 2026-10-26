import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.auth.csrf import CSRF_HEADER, CSRFMiddleware
from app.auth.rate_limit import LoginRateLimiter
from app.config import get_auth_settings, get_security_settings
from app.db import engine
from app.routers import (
    auth,
    employees,
    jd,
    kpi,
    kpi_scores,
    matrix,
    organization,
    quarterly,
    reports,
)
from app.services.errors import (
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)

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
app.include_router(jd.router)
app.include_router(kpi.router)
app.include_router(kpi_scores.router)
app.include_router(matrix.router)
app.include_router(quarterly.router)


@app.exception_handler(NotFoundError)
def not_found_handler(request: Request, exc: NotFoundError) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(PermissionDeniedError)
def permission_handler(request: Request, exc: PermissionDeniedError) -> JSONResponse:
    return JSONResponse(status_code=403, content={"detail": str(exc)})


@app.exception_handler(ConflictError)
def conflict_handler(request: Request, exc: ConflictError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(ValidationFailedError)
def validation_handler(request: Request, exc: ValidationFailedError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "detail": "Please correct the problems listed.",
            "issues": [{"message": i.message, "field": i.field, "row": i.row} for i in exc.issues],
        },
    )


@app.exception_handler(IntegrityError)
def integrity_handler(request: Request, exc: IntegrityError) -> JSONResponse:
    # A race with another user's change; never echo SQL details.
    logger.warning("Integrity error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=409,
        content={"detail": "This change conflicts with existing data. Reload and try again."},
    )


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
