# app.py
from __future__ import annotations

import os
import hashlib
import hmac
import secrets
import time
import logging
import smtplib
import ssl
from pathlib import Path
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from enum import Enum
from email.message import EmailMessage
from urllib.parse import quote_plus

import requests
from requests.adapters import HTTPAdapter, Retry
from fastapi import FastAPI, HTTPException, Query, Depends, Cookie, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from pydantic import BaseModel, Field
from dateutil import parser as dateparser
from dotenv import load_dotenv
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError

# imports for caching / background sync
import asyncio
from threading import Lock

load_dotenv(Path(__file__).resolve().with_name(".env"))

# Auth imports
from auth import (
    TOKEN_ENCRYPTION_KEY,
    User,
    CanvasToken,
    TodoItemPayload,
    describe_database_target,
    get_db,
    create_user,
    get_user_by_email,
    get_user_by_id,
    get_canvas_token,
    store_canvas_token,
    revoke_canvas_token,
    verify_password,
    hide_assignment,
    unhide_assignment,
    get_hidden_assignments,
    get_workload_estimates,
    get_todos,
    create_todo,
    update_todo_with_recurrence,
    delete_todo,
    prune_stale_workload_estimates,
    SessionLocal,
    upsert_workload_estimate,
    delete_workload_estimate,
    get_completed_assignment_flags,
    upsert_completed_assignment_flag,
    delete_completed_assignment_flag,
    get_assignment_weight_overrides,
    upsert_assignment_weight_override,
    delete_assignment_weight_override,
    get_assignment_group_weight_overrides,
    upsert_assignment_group_weight_override,
    delete_assignment_group_weight_override,
    get_personal_assignment_dates,
    upsert_personal_assignment_date,
    delete_personal_assignment_date,
    get_grade_scale_preferences,
    upsert_grade_scale_preference,
    UserCreate,
    UserLogin,
    UserResponse,
    CanvasTokenRequest,
    CanvasTokenStatus,
    ForgotPasswordRequest,
    ResetPasswordRequest,
    create_password_reset_token,
    get_valid_password_reset_token,
    mark_password_reset_token_used,
    update_user_password,
    create_session,
    get_session_user_id,
    invalidate_session,
    invalidate_user_sessions,
)

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("canvas_backend")


def _is_cloud_runtime() -> bool:
    return bool(os.getenv("AWS_REGION") or os.getenv("AWS_EXECUTION_ENV"))


def _validate_required_cloud_env() -> None:
    """Fail fast in cloud deployments when required configuration is missing."""
    if not _is_cloud_runtime():
        return

    required = [
        "DATABASE_URL",
        "TOKEN_ENCRYPTION_KEY",
        "CANVAS_BASE_URL",
        "CACHE_TTL_SECONDS",
        "SYNC_INTERVAL_SECONDS",
        "ALLOWED_ORIGINS",
        "SECURE_COOKIES",
        "FRONTEND_BASE_URL",
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_USERNAME",
        "SMTP_PASSWORD",
        "SMTP_USE_TLS",
        "MAIL_FROM",
    ]

    missing = [name for name in required if not (os.getenv(name) or "").strip()]
    errors = []

    for key in ("CACHE_TTL_SECONDS", "SYNC_INTERVAL_SECONDS", "SMTP_PORT"):
        value = (os.getenv(key) or "").strip()
        if not value:
            continue
        try:
            parsed = int(value)
            if parsed <= 0:
                errors.append(f"{key} must be a positive integer")
        except ValueError:
            errors.append(f"{key} must be an integer")

    for key in ("SECURE_COOKIES", "SMTP_USE_TLS"):
        value = (os.getenv(key) or "").strip().lower()
        if not value:
            continue
        if value not in {"true", "false"}:
            errors.append(f"{key} must be 'true' or 'false'")

    if missing or errors:
        details = []
        if missing:
            details.append("missing=" + ",".join(sorted(missing)))
        if errors:
            details.append("invalid=" + "; ".join(errors))
        message = "Invalid cloud runtime configuration: " + " | ".join(details)
        logger.critical(message)
        raise RuntimeError(message)

# === Configuration ===
_validate_required_cloud_env()

CANVAS_BASE_URL = os.getenv("CANVAS_BASE_URL", "https://northeastern.instructure.com").rstrip("/")

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "600"))
SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL_SECONDS", "180"))
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")]
SECURE_COOKIES = os.getenv("SECURE_COOKIES", "false").lower() == "true"
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173").rstrip("/")

# Optional SMTP config for password reset email delivery.
SMTP_HOST = os.getenv("SMTP_HOST")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD")
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").lower() == "true"
MAIL_FROM = os.getenv("MAIL_FROM", "no-reply@canvassist.local")

_cache_lock = Lock()
_cache: dict[str, dict[str, Any]] = {}  # key -> {"ts": float, "value": Any}

# === Cache mode ===
class CacheMode(str, Enum):
    auto = "auto"    # use cache if valid, otherwise fetch
    fresh = "fresh"  # bypass cache and fetch now (updates cache)

def _use_cache(mode: CacheMode) -> bool:
    return mode != CacheMode.fresh

# === Caching ===
def cache_get(key: str):
    with _cache_lock:
        item = _cache.get(key)
        if not item:
            return None
        if time.time() - item["ts"] > CACHE_TTL_SECONDS:
            return None
        return item["value"]

def cache_set(key: str, value: Any):
    with _cache_lock:
        _cache[key] = {"ts": time.time(), "value": value}

def cache_clear(prefix: str | None = None):
    with _cache_lock:
        if prefix is None:
            _cache.clear()
            return
        for k in list(_cache.keys()):
            if k.startswith(prefix):
                _cache.pop(k, None)

def get_assignment_detail(course_id: int, assignment_id: int, mode: CacheMode, token: Optional[str] = None, user_id: int = 0) -> dict[str, Any]:
    key = f"assignment_detail:{user_id}:{course_id}:{assignment_id}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v

    data = canvas_get_single(
        f"/courses/{course_id}/assignments/{assignment_id}",
        params={"include[]": ["submission"]},
        token=token,
    )
    cache_set(key, data)
    return data

# === Pydantic models for endpoint responses ===
class Profile(BaseModel):
    id: int
    name: Optional[str] = None
    sortable_name: Optional[str] = None
    short_name: Optional[str] = None
    primary_email: Optional[str] = None
    avatar_url: Optional[str] = None

class Course(BaseModel):
    id: int
    name: str
    course_code: Optional[str]
    term_id: Optional[int]
    published: Optional[bool]
    syllabus: Optional[str] = None
    syllabus_url: Optional[str] = None
    html_url: Optional[str] = None

class Assignment(BaseModel):
    id: int
    course_id: int
    course_name: Optional[str] = None
    name: str
    due_at: Optional[datetime]
    points_possible: Optional[float]
    description: Optional[str]
    submission_types: Optional[List[str]] = None
    html_url: Optional[str] = None
    submitted: Optional[bool] = None
    score: Optional[float] = None
    graded_at: Optional[datetime] = None
    assignment_group_id: Optional[int] = None
    attachments: Optional[List[Dict[str, Any]]] = None

# === Grade aggregation and missing detection models ===
class MissingItem(BaseModel):
    assignment_id: int
    course_id: int
    course_name: str
    name: str
    due_at: Optional[datetime]
    points_possible: Optional[float]
    html_url: Optional[str]

class CourseSummary(BaseModel):
    id: int
    name: str
    course_code: Optional[str] = None
    syllabus_url: Optional[str] = None
    html_url: Optional[str] = None

    current_score: Optional[float] = None
    current_grade: Optional[str] = None

    next_assignments: List[Assignment] = Field(default_factory=list)

    missing_count: int = 0
    missing: List[MissingItem] = Field(default_factory=list)

# === Overview models ===
class DueSoonItem(BaseModel):
    assignment_id: int
    course_id: int
    course_name: str
    name: str
    due_at: datetime
    points_possible: Optional[float] = None
    html_url: Optional[str] = None

class GradeItem(BaseModel):
    course_id: int
    course_name: str
    course_code: Optional[str] = None

    current_grade: Optional[str] = None
    current_score: Optional[float] = None

    display_grade: Optional[str] = None
    grade_is_estimated: bool = False

class OverviewResponse(BaseModel):
    missing: List[MissingItem] = Field(default_factory=list)
    missing_count: int = 0

    due_next_24h: List[DueSoonItem] = Field(default_factory=list)
    due_next_24h_count: int = 0

    gpa: Optional[float] = None
    grades: List[GradeItem] = Field(default_factory=list)

    any_estimated_grades: bool = False

class WorkloadEstimateRequest(BaseModel):
    estimate_hours: float = Field(default=0.0, ge=0.0, le=500.0)
    completed_hours: float = Field(default=0.0, ge=0.0, le=500.0)
    completed: bool = False


class CompletedAssignmentFlagRequest(BaseModel):
    status_source: str = Field(default="manual_completed")

class AssignmentWeightOverrideRequest(BaseModel):
    weight_points: float = Field(default=0.0, ge=0.0, le=100000.0)


class AssignmentGroupWeightRequest(BaseModel):
    weight_pct: float = Field(default=0.0, ge=0.0, le=1000.0)


class PersonalAssignmentDateRequest(BaseModel):
    due_at: str


class GradeScalePreferenceRequest(BaseModel):
    mode: str = Field(default="standard")
    thresholds: Optional[Dict[str, float]] = None
    pass_threshold: Optional[float] = Field(default=None, ge=0.0, le=100.0)


class AnnouncementSeenRequest(BaseModel):
    announcement_id: int = 0

# Annoucnement model
class Announcement(BaseModel):
    id: int
    title: str
    message: Optional[str] = None
    posted_at: Optional[datetime] = None
    html_url: Optional[str] = None

    course_id: Optional[int] = None
    course_name: Optional[str] = None

# === HTTP Session with retries ===
session = requests.Session()
retries = Retry(
    total=3,
    backoff_factor=0.4,
    status_forcelist=[429, 500, 502, 503, 504],
)
session.mount("https://", HTTPAdapter(max_retries=retries))

def _raise_canvas_http(r: requests.Response, url: str):
    detail: Any
    try:
        detail = r.json()
    except Exception:
        detail = r.text

    if r.status_code == 401:
        logger.warning("Canvas returned 401 for %s; token invalid or expired", url)
        raise HTTPException(status_code=403, detail="Canvas token invalid or expired. Please re-submit your Canvas API token.")
    if r.status_code == 403:
        logger.warning("Canvas returned 403 for %s", url)
        raise HTTPException(status_code=403, detail=detail)

    logger.error(f"Canvas error {r.status_code} on {url}: {detail}")
    raise HTTPException(status_code=r.status_code, detail=detail)

# === FastAPI app ===
limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="CanvAssist API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _cors_safe_500_handler(request: Request, exc: Exception):
    """Return a CORS-annotated 500 for any unhandled exception.

    Starlette's CORSMiddleware does not add Access-Control-Allow-Origin to
    responses that bypass the middleware (i.e. unhandled exceptions that
    produce a raw 500).  This handler catches those and manually attaches
    CORS headers so the browser sees a real 500 rather than a fake CORS error.
    """
    origin = request.headers.get("origin", "")
    headers: Dict[str, str] = {}
    if origin and (origin in ALLOWED_ORIGINS or "*" in ALLOWED_ORIGINS):
        headers["access-control-allow-origin"] = origin
        headers["access-control-allow-credentials"] = "true"
    logger.exception("Unhandled server error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=headers,
    )


@app.exception_handler(HTTPException)
async def _cors_safe_http_handler(request: Request, exc: HTTPException):
    """Ensure HTTPExceptions also carry CORS headers."""
    origin = request.headers.get("origin", "")
    headers: Dict[str, str] = dict(exc.headers or {})
    if origin and (origin in ALLOWED_ORIGINS or "*" in ALLOWED_ORIGINS):
        headers["access-control-allow-origin"] = origin
        headers["access-control-allow-credentials"] = "true"
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=headers,
    )


@app.exception_handler(SQLAlchemyError)
async def _database_error_handler(request: Request, exc: SQLAlchemyError):
    """Surface database failures as 503s instead of generic 500s."""
    origin = request.headers.get("origin", "")
    headers: Dict[str, str] = {}
    if origin and (origin in ALLOWED_ORIGINS or "*" in ALLOWED_ORIGINS):
        headers["access-control-allow-origin"] = origin
        headers["access-control-allow-credentials"] = "true"
    logger.exception("Database error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=503,
        content={"detail": "Database unavailable"},
        headers=headers,
    )

# === Session management ===

# Demo sessions are stateless signed tokens ("demo.<expiry>.<nonce>.<sig>") so they
# survive restarts/redeploys and work across workers without shared storage.
DEMO_SESSION_TTL_SECONDS = 24 * 60 * 60
_DEMO_SIGNING_KEY = hashlib.sha256(b"canvassist-demo-session:" + TOKEN_ENCRYPTION_KEY.encode()).digest()

def _sign_demo_payload(payload: str) -> str:
    return hmac.new(_DEMO_SIGNING_KEY, payload.encode(), hashlib.sha256).hexdigest()

def create_demo_session() -> str:
    """Create a demo session for unauthenticated demo access."""
    payload = f"{int(time.time()) + DEMO_SESSION_TTL_SECONDS}.{secrets.token_urlsafe(16)}"
    return f"demo.{payload}.{_sign_demo_payload(payload)}"

def is_demo_session(session_id: str) -> bool:
    """Check whether a session ID is a valid, unexpired demo token."""
    if not session_id or not session_id.startswith("demo."):
        return False
    parts = session_id.split(".")
    if len(parts) != 4:
        return False
    _, expires, nonce, sig = parts
    payload = f"{expires}.{nonce}"
    if not hmac.compare_digest(sig, _sign_demo_payload(payload)):
        return False
    try:
        return time.time() < int(expires)
    except ValueError:
        return False

def get_session_id(session_id: Optional[str] = Cookie(None)) -> Optional[str]:
    """Helper dependency to get session ID from the httponly session cookie."""
    return session_id

def _build_password_reset_url(raw_token: str) -> str:
    encoded = quote_plus(raw_token)
    return f"{FRONTEND_BASE_URL}/#reset-password?token={encoded}"

def _send_password_reset_email(to_email: str, reset_url: str) -> bool:
    """Attempt to send a password reset email. Returns True when sent."""
    if not SMTP_HOST:
        logger.warning("SMTP not configured. Password reset link for %s: %s", to_email, reset_url)
        return False

    msg = EmailMessage()
    msg["Subject"] = "CanvAssist Password Reset"
    msg["From"] = MAIL_FROM
    msg["To"] = to_email
    msg.set_content(
        "You requested a password reset for your CanvAssist account.\n\n"
        f"Use this link to set a new password (valid for 30 minutes):\n{reset_url}\n\n"
        "If you did not request this reset, you can safely ignore this email — "
        "your password will not be changed.\n\n"
        "If you have any questions or need help, contact us at support@canvassist.com."
    )

    try:
        if SMTP_USE_TLS:
            context = ssl.create_default_context()
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
                server.starttls(context=context)
                if SMTP_USERNAME and SMTP_PASSWORD:
                    server.login(SMTP_USERNAME, SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
                if SMTP_USERNAME and SMTP_PASSWORD:
                    server.login(SMTP_USERNAME, SMTP_PASSWORD)
                server.send_message(msg)
        return True
    except Exception:
        logger.exception("Failed to send password reset email to %s", to_email)
        return False

def get_current_user(session_id: Optional[str] = Depends(get_session_id), db: Session = Depends(get_db)) -> User:
    """Dependency to get the currently logged-in user from the session cookie."""
    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    user_id = get_session_user_id(session_id, db)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Session invalid or expired")
    
    user = get_user_by_id(user_id, db)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    
    return user

# === Utilities ===
def canvas_get_single(path: str, params: Optional[Dict[str, Any]] = None, token: Optional[str] = None) -> Any:
    """Make a single Canvas API request. Requires a user token."""
    if not token:
        raise HTTPException(status_code=403, detail="Canvas token required. Please submit your Canvas API token.")
    
    url = f"{CANVAS_BASE_URL}/api/v1{path}"
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    
    r = session.get(url, params=params, timeout=20, headers=headers)
    if not r.ok:
        _raise_canvas_http(r, url)
    return r.json()

def canvas_get_paginated(path: str, params: Optional[Dict[str, Any]] = None, token: Optional[str] = None) -> List[Any]:
    """Make a paginated Canvas API request. Requires a user token."""
    if not token:
        raise HTTPException(status_code=403, detail="Canvas token required. Please submit your Canvas API token.")
    
    url = f"{CANVAS_BASE_URL}/api/v1{path}"
    results: List[Any] = []

    local_params = (params.copy() if params else {})
    local_params.setdefault("per_page", 100)
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    while url:
        r = session.get(url, params=local_params, timeout=20, headers=headers)
        if not r.ok:
            _raise_canvas_http(r, url)

        data = r.json()
        if isinstance(data, list):
            results.extend(data)
        else:
            return [data]

        link = r.headers.get("Link", "")
        next_url = None
        if link:
            for p in link.split(","):
                if 'rel="next"' in p:
                    left = p.find("<")
                    right = p.find(">")
                    if left != -1 and right != -1:
                        next_url = p[left + 1:right]
                        break

        url = next_url
        local_params = None

    return results

def parse_iso(dt_str: Optional[str]) -> Optional[datetime]:
    if not dt_str:
        return None
    try:
        d = dateparser.parse(dt_str)
        if not d.tzinfo:
            d = d.replace(tzinfo=timezone.utc)
        return d
    except Exception:
        return None
    
def filter_courses_to_latest_term(courses: List[Course]) -> List[Course]:
    # keep only courses that have a term_id
    with_term = [c for c in courses if c.term_id is not None]
    if not with_term:
        return courses  # fallback if term info missing everywhere

    latest_term = max(c.term_id for c in with_term if c.term_id is not None)
    return [c for c in courses if c.term_id == latest_term]

def sort_key_due_at(dt: Optional[datetime]) -> datetime:
    # Always return a valid, tz-aware datetime
    return dt if dt is not None else datetime.max.replace(tzinfo=timezone.utc)

# get announcements for current courses, sorted by posted_at desc, limited to recent ones
def get_announcements(
    days_back: int = 14,
    limit: int = 30,
    mode: CacheMode = CacheMode.auto,
    token: Optional[str] = None,
    user_id: int = 0,
) -> List[Announcement]:
    # Cache key
    key = f"announcements:{user_id}:days_back={days_back}:limit={limit}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v

    # Only current courses (your get_courses() already filters to latest term)
    courses = get_courses(mode=mode, token=token, user_id=user_id)
    course_map = {c.id: c for c in courses}

    if not course_map:
        out: List[Announcement] = []
        cache_set(key, out)
        return out

    # Canvas expects context codes like "course_123"
    context_codes = [f"course_{cid}" for cid in course_map.keys()]

    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days_back)

    # Canvas announcements endpoint
    raw = canvas_get_paginated(
        "/announcements",
        params={
            "context_codes[]": context_codes,  # requests will encode list properly
            "start_date": start.isoformat(),
            "end_date": now.isoformat(),
            "active_only": "true",
            "per_page": 100,
        },
        token=token,
    )

    out: List[Announcement] = []
    for a in raw:
        # Canvas fields commonly include: id, title, message, posted_at, html_url, context_code
        context_code = a.get("context_code")  # e.g. "course_123"
        course_id: Optional[int] = None
        if isinstance(context_code, str) and context_code.startswith("course_"):
            try:
                course_id = int(context_code.split("_", 1)[1])
            except Exception:
                course_id = None

        c = course_map.get(course_id) if course_id else None

        out.append(
            Announcement(
                id=a.get("id"),
                title=a.get("title") or "(untitled)",
                message=a.get("message"),
                posted_at=parse_iso(a.get("posted_at")),
                html_url=a.get("html_url"),
                course_id=course_id,
                course_name=(c.name if c else None),
            )
        )

    # Newest first
    out.sort(key=lambda x: sort_key_due_at(x.posted_at), reverse=True)
    out = out[:limit]

    cache_set(key, out)
    return out

# === Mock Generators ===
def mock_profile() -> Profile:
    return Profile(
        id=999999,
        name="Alex Rivera",
        sortable_name="Rivera, Alex",
        short_name="Alex",
        primary_email="alex.rivera@example.com",
        avatar_url=None,
    )

def mock_courses() -> List[Course]:
    return [
        Course(
            id=101,
            name="CS 3000 — Algorithms",
            course_code="CS3000",
            term_id=202601,
            published=True,
            syllabus="This course covers graphs, flows, and dynamic programming.",
            syllabus_url=f"{CANVAS_BASE_URL}/courses/101/syllabus",
            html_url=f"{CANVAS_BASE_URL}/courses/101",
        ),
        Course(
            id=202,
            name="MATH 2001 — Discrete Structures",
            course_code="MATH2001",
            term_id=202601,
            published=True,
            syllabus="Proofs, combinatorics, and discrete probability.",
            syllabus_url=f"{CANVAS_BASE_URL}/courses/202/syllabus",
            html_url=f"{CANVAS_BASE_URL}/courses/202",
        ),
        Course(
            id=303,
            name="ENGW 1111 — First-Year Writing",
            course_code="ENGW1111",
            term_id=202601,
            published=True,
            syllabus="Writing and revision.",
            syllabus_url=f"{CANVAS_BASE_URL}/courses/303/syllabus",
            html_url=f"{CANVAS_BASE_URL}/courses/303",
        ),
    ]

_DEMO_TZ = ZoneInfo("America/New_York")

# Per-course names/descriptions for the demo assignments; the schedule shape
# (overdue, due soon, upcoming, undated, graded) is shared across courses.
_DEMO_ASSIGNMENT_COPY: Dict[int, Dict[str, tuple]] = {
    101: {
        "missing": ("Reading Check: Asymptotic Notation", "Short check on chapter 3 — Big-O, Big-Θ, and Big-Ω."),
        "homework": ("Problem Set 2: Divide and Conquer", "Solve recurrences with the Master Theorem and analyze merge-sort variants. Show all work."),
        "due_soon": ("Lecture Reflection: Graph Traversals", "Two paragraphs comparing BFS and DFS on the examples from lecture."),
        "project": ("Project Proposal: Route Planner", "One-page proposal for your shortest-path project: dataset, algorithm, and evaluation plan."),
        "optional": ("Optional: Mid-Semester Feedback Survey", "Anonymous survey — tell us what's working and what isn't."),
        "graded": ("Problem Set 1: Proof Warm-up", "Induction and loop-invariant proofs."),
        "quiz": ("Quiz 2: Sorting", "Timed quiz on comparison sorts and lower bounds."),
    },
    202: {
        "missing": ("Reading Check: Propositional Logic", "Truth tables, equivalences, and normal forms (sections 1.1–1.3)."),
        "homework": ("Homework 3: Combinatorics", "Counting with permutations, combinations, and the pigeonhole principle."),
        "due_soon": ("Weekly Proof Journal", "Write up one proof from this week in your own words."),
        "project": ("Group Project Checkpoint", "Submit your group's outline and division of work."),
        "optional": ("Optional: Extra Practice Set", "Ungraded practice problems for the upcoming exam."),
        "graded": ("Homework 2: Induction", "Weak and strong induction proofs."),
        "quiz": ("Quiz 2: Set Theory", "Short quiz on sets, relations, and functions."),
    },
    303: {
        "missing": ("Reading Response: Bird by Bird", "Respond to the assigned Lamott chapter in 300 words."),
        "homework": ("Annotated Bibliography", "Five annotated sources for your research essay, in MLA format."),
        "due_soon": ("Peer Review: Essay 2 Draft", "Leave margin comments and an end note on two classmates' drafts."),
        "project": ("Essay 2: Final Draft", "Submit your revised essay with a short reflection on the changes you made."),
        "optional": ("Optional: Writing Center Visit Reflection", "Earn participation credit by reflecting on a Writing Center session."),
        "graded": ("Essay 1: Literacy Narrative", "Final draft of your literacy narrative."),
        "quiz": ("Grammar Quiz: Comma Usage", "Quick quiz on comma splices and restrictive clauses."),
    },
}

def mock_course_assignments(course_id: int, limit: Optional[int] = None) -> List[Assignment]:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    copy = _DEMO_ASSIGNMENT_COPY.get(course_id, _DEMO_ASSIGNMENT_COPY[101])

    def due(delta: timedelta) -> datetime:
        # Land on 11:59 PM Eastern so demo deadlines look like real ones rather than "now + n".
        local = (now + delta).astimezone(_DEMO_TZ)
        return local.replace(hour=23, minute=59, second=0).astimezone(timezone.utc)

    def due_soon(hours: int) -> datetime:
        return (now + timedelta(hours=hours)).replace(minute=59, second=0)

    def make(offset: int, kind: str, **fields: Any) -> Assignment:
        name, desc = copy[kind]
        aid = offset + course_id * 1000
        return Assignment(
            id=aid,
            course_id=course_id,
            name=name,
            description=f"<p>{desc}</p>",
            html_url=f"{CANVAS_BASE_URL}/courses/{course_id}/assignments/{aid}",
            **fields,
        )

    base = [
        make(999, "missing", due_at=due(-timedelta(days=2)), points_possible=5,
             submission_types=["online_text_entry"], submitted=False, score=None),
        make(1, "homework", due_at=due(timedelta(days=3, hours=course_id % 7)), points_possible=50,
             submission_types=["online_upload"], submitted=False, score=None),
        make(4, "due_soon", due_at=due_soon(12), points_possible=15,
             submission_types=["online_text_entry"], submitted=False, score=None),
        make(2, "project", due_at=due(timedelta(days=7, hours=course_id % 5)), points_possible=25,
             submission_types=["online_text_entry"], submitted=False, score=None),
        make(5, "optional", due_at=None, points_possible=2,
             submission_types=["online_url"], submitted=False, score=None),
        make(6, "graded", due_at=due(-timedelta(days=6, hours=(course_id % 3) + 2)), points_possible=20,
             submission_types=["online_upload"], submitted=True, score=16.0 + float(course_id % 3),
             graded_at=now - timedelta(days=5, hours=(course_id % 4) + 1)),
        make(3, "quiz", due_at=due(timedelta(days=1, hours=course_id % 4)), points_possible=10,
             submission_types=["online_quiz"], submitted=True, score=9.0,
             graded_at=now - timedelta(hours=(course_id % 5) + 6)),
    ]
    base.sort(key=lambda a: (a.due_at is None, a.due_at or datetime.max.replace(tzinfo=timezone.utc)))
    return base[:limit] if limit else base

def mock_discussions(course_id: int) -> List[Dict[str, Any]]:
    now = datetime.now(timezone.utc).replace(microsecond=0)

    def iso(dt: datetime) -> str:
        return dt.isoformat()

    by_course: Dict[int, List[Dict[str, Any]]] = {
        101: [
            {
                "id": 1001,
                "title": "Week 4 Discussion: Greedy vs Dynamic Programming",
                "message_html": "<p>Pick a problem from the practice set and argue whether a greedy approach works, or whether DP is required. Reply to at least one classmate with a counterexample or refinement.</p>",
                "posted_at": iso(now - timedelta(days=2)),
                "last_reply_at": iso(now - timedelta(hours=5)),
                "html_url": f"{CANVAS_BASE_URL}/courses/101/discussion_topics/1001",
                "pinned": True,
                "locked": False,
                "read_state": "unread",
                "unread_count": 4,
                "discussion_subentry_count": 12,
                "author_id": 9001,
                "author_name": "Prof. Alvarez",
            },
            {
                "id": 1002,
                "title": "Office hours scheduling poll",
                "message_html": "<p>Vote on the times that work best for additional office hours this week. Comments welcome.</p>",
                "posted_at": iso(now - timedelta(days=6)),
                "last_reply_at": iso(now - timedelta(days=1, hours=3)),
                "html_url": f"{CANVAS_BASE_URL}/courses/101/discussion_topics/1002",
                "pinned": False,
                "locked": False,
                "read_state": "read",
                "unread_count": 0,
                "discussion_subentry_count": 8,
                "author_id": 9001,
                "author_name": "Prof. Alvarez",
            },
        ],
        202: [
            {
                "id": 2001,
                "title": "Proof technique check-in",
                "message_html": "<p>Share one proof from this week's reading you'd like to walk through together. Photos of handwritten work are fine.</p>",
                "posted_at": iso(now - timedelta(days=1, hours=4)),
                "last_reply_at": iso(now - timedelta(hours=2)),
                "html_url": f"{CANVAS_BASE_URL}/courses/202/discussion_topics/2001",
                "pinned": True,
                "locked": False,
                "read_state": "unread",
                "unread_count": 2,
                "discussion_subentry_count": 5,
                "author_id": 9002,
                "author_name": "Dr. Chen",
            },
            {
                "id": 2002,
                "title": "Study group for Friday's quiz",
                "message_html": "<p>Anyone want to meet at the library Thursday evening to review combinatorics?</p>",
                "posted_at": iso(now - timedelta(days=3)),
                "last_reply_at": iso(now - timedelta(hours=18)),
                "html_url": f"{CANVAS_BASE_URL}/courses/202/discussion_topics/2002",
                "pinned": False,
                "locked": False,
                "read_state": "read",
                "unread_count": 0,
                "discussion_subentry_count": 3,
                "author_id": 9102,
                "author_name": "Jordan Lee",
            },
        ],
        303: [
            {
                "id": 3001,
                "title": "Draft swap — short essay round 2",
                "message_html": "<p>Post your draft as an attachment or pasted text. Pair up in the replies and exchange feedback by Sunday night.</p>",
                "posted_at": iso(now - timedelta(hours=20)),
                "last_reply_at": iso(now - timedelta(hours=3)),
                "html_url": f"{CANVAS_BASE_URL}/courses/303/discussion_topics/3001",
                "pinned": True,
                "locked": False,
                "read_state": "unread",
                "unread_count": 1,
                "discussion_subentry_count": 2,
                "author_id": 9003,
                "author_name": "Prof. Okafor",
            },
        ],
    }

    return by_course.get(course_id, [])


def mock_discussion_replies(topic_id: int) -> List[Dict[str, Any]]:
    now = datetime.now(timezone.utc).replace(microsecond=0)

    def iso(dt: datetime) -> str:
        return dt.isoformat()

    by_topic: Dict[int, List[Dict[str, Any]]] = {
        1001: [
            {
                "id": 50011,
                "parent_id": None,
                "author_id": 9101,
                "author_name": "Sam Patel",
                "created_at": iso(now - timedelta(hours=10)),
                "updated_at": iso(now - timedelta(hours=10)),
                "message_html": "<p>For problem 3 greedy doesn't work — counterexample with a coin denomination set {1, 3, 4} where target = 6 forces 4+1+1 instead of 3+3.</p>",
                "read_state": "unread",
            },
            {
                "id": 50012,
                "parent_id": 50011,
                "author_id": 9102,
                "author_name": "Jordan Lee",
                "created_at": iso(now - timedelta(hours=8)),
                "updated_at": iso(now - timedelta(hours=8)),
                "message_html": "<p>Good catch — same shape shows up in the change-making subproblem from lecture.</p>",
                "read_state": "read",
            },
            {
                "id": 50014,
                "parent_id": 50012,
                "author_id": 9104,
                "author_name": "Maya Iyer",
                "created_at": iso(now - timedelta(hours=7)),
                "updated_at": iso(now - timedelta(hours=7)),
                "message_html": "<p>+1 — and the textbook proof on p. 184 uses the same denominations.</p>",
                "read_state": "read",
            },
            {
                "id": 50013,
                "parent_id": None,
                "author_id": 9103,
                "author_name": "Riya Shah",
                "created_at": iso(now - timedelta(hours=5)),
                "updated_at": iso(now - timedelta(hours=5)),
                "message_html": "<p>I argued the opposite for problem 5; DP is overkill there since the items are sorted and the greedy choice is provably optimal.</p>",
                "read_state": "unread",
            },
        ],
        2001: [
            {
                "id": 60011,
                "parent_id": None,
                "author_id": 9201,
                "author_name": "Chris Kim",
                "created_at": iso(now - timedelta(hours=4)),
                "updated_at": iso(now - timedelta(hours=4)),
                "message_html": "<p>Bring the induction proof from Thursday — the step case still doesn't click for me.</p>",
                "read_state": "unread",
            },
        ],
    }
    return by_topic.get(topic_id, [])


def mock_announcements(days_back: int = 14, limit: int = 30) -> List[Announcement]:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    earliest = now - timedelta(days=days_back)

    items = [
        Announcement(
            id=90001,
            title="Tip: Customize Your View with Hidden Assignments",
            message=(
                "<p>Testing the dashboard in demo mode? You can preview where hidden assignments would appear in your workflow. "
                "To actually hide assignments, sign in first, then open Settings and use the Hidden Assignments tools.</p>"
            ),
            posted_at=now - timedelta(hours=6),
            html_url=f"{CANVAS_BASE_URL}/courses/101/discussion_topics/90001",
            course_id=101,
            course_name="CS 3000 — Algorithms",
        ),
        Announcement(
            id=90002,
            title="Plan Ahead with Workload Estimates",
            message=(
                "<p>You can estimate hours per assignment and track completed time. "
                "This helps the Weekly Planner prioritize urgent work due in the next 24 hours.</p>"
            ),
            posted_at=now - timedelta(days=1, hours=2),
            html_url=f"{CANVAS_BASE_URL}/courses/202/discussion_topics/90002",
            course_id=202,
            course_name="MATH 2001 — Discrete Structures",
        ),
        Announcement(
            id=90003,
            title="Welcome to the CanvAssist demo",
            message=(
                "<p>This demo includes overdue items, due-soon assignments, and undated work so you can test filtering and planning behavior before connecting Canvas.</p>"
            ),
            posted_at=now - timedelta(days=3),
            html_url=f"{CANVAS_BASE_URL}/courses/303/discussion_topics/90003",
            course_id=303,
            course_name="ENGW 1111 — First-Year Writing",
        ),
    ]

    # Keep recent items only, newest first, matching real endpoint behavior.
    out = [a for a in items if (a.posted_at is not None and a.posted_at >= earliest)]
    out.sort(key=lambda x: sort_key_due_at(x.posted_at), reverse=True)
    return out[:limit]

def mock_upcoming(limit: int = 50) -> List[Assignment]:
    courses = mock_courses()
    all_asgs: List[Assignment] = []
    for c in courses:
        asgs = mock_course_assignments(c.id)
        for a in asgs:
            a.course_name = c.name
        all_asgs.extend(asgs)
    all_asgs.sort(key=lambda a: a.due_at or datetime.max.replace(tzinfo=timezone.utc))
    return all_asgs[:limit]

def mock_enrollments() -> List[dict]:
    return [
        {
            "course_id": 101,
            "type": "StudentEnrollment",
            "enrollment_state": "active",
            "grades": {"current_score": 92.4, "current_grade": "A-"},
        },
        {
            "course_id": 202,
            "type": "StudentEnrollment",
            "enrollment_state": "active",
            "grades": {"current_score": 87.1, "current_grade": "B+"},
        },
        {
            "course_id": 303,
            "type": "StudentEnrollment",
            "enrollment_state": "active",
            "grades": {"current_score": 78.5, "current_grade": None},
        },
    ]

# === Canvas-specific getters used by the app ===
def get_student_profile(token: Optional[str] = None) -> Profile:
    data = canvas_get_single("/users/self/profile", token=token)
    if data is None:
        raise HTTPException(status_code=500, detail="No profile returned from Canvas")
    return Profile(
        id=data.get("id"),
        name=data.get("name") or data.get("sortable_name"),
        sortable_name=data.get("sortable_name"),
        short_name=data.get("short_name"),
        primary_email=data.get("primary_email") or data.get("login_id"),
        avatar_url=data.get("avatar_url"),
    )

def get_active_student_course_ids(token: Optional[str] = None) -> List[int]:
    enrollments = canvas_get_paginated("/users/self/enrollments", params={"per_page": 100}, token=token)

    active_ids: List[int] = []
    for e in enrollments:
        # These fields ARE on enrollment objects
        if e.get("type") != "StudentEnrollment":
            continue
        if e.get("enrollment_state") != "active":
            continue
        cid = e.get("course_id")
        if cid:
            active_ids.append(cid)

    # de-dupe preserve order
    seen = set()
    out: List[int] = []
    for cid in active_ids:
        if cid not in seen:
            seen.add(cid)
            out.append(cid)
    return out

def get_active_courses(token: Optional[str] = None) -> List[Course]:
    active_ids = get_active_student_course_ids(token=token)
    cleaned: List[Course] = []

    for cid in active_ids:
        details = canvas_get_single(f"/courses/{cid}", token=token)

        name = (
            details.get("name")
            or details.get("course_code")
            or f"Course {cid}"
        )

        course_code = details.get("course_code")
        term_id = details.get("enrollment_term_id")
        published = (details.get("workflow_state") == "available")
        syllabus = details.get("syllabus_body") or None
        syllabus_url = details.get("syllabus_url") or f"{CANVAS_BASE_URL}/courses/{cid}/syllabus"
        html_url = details.get("html_url") or f"{CANVAS_BASE_URL}/courses/{cid}"

        cleaned.append(
            Course(
                id=cid,
                name=name,
                course_code=course_code,
                term_id=term_id,
                published=published,
                syllabus=syllabus,
                syllabus_url=syllabus_url,
                html_url=html_url,
            )
        )

    cleaned.sort(key=lambda c: (c.name or "").lower())
    cleaned = filter_courses_to_latest_term(cleaned)
    return cleaned

def _parse_attachments(raw_attachments: Any) -> Optional[List[Dict[str, Any]]]:
    if not isinstance(raw_attachments, list):
        return None
    out: List[Dict[str, Any]] = []
    for att in raw_attachments:
        if not isinstance(att, dict):
            continue
        url = att.get("url") or att.get("preview_url")
        if not url:
            continue
        out.append({
            "display_name": att.get("display_name") or att.get("filename") or "Attachment",
            "filename": att.get("filename"),
            "url": url,
            "content_type": att.get("content-type") or att.get("content_type"),
        })
    return out or None


def get_course_assignments(course_id: int, include_submission=True, limit: Optional[int] = None, token: Optional[str] = None) -> List[Assignment]:
    params = {"include[]": "submission"} if include_submission else None
    try:
        raw_assignments = canvas_get_paginated(f"/courses/{course_id}/assignments", params=params, token=token)
    except HTTPException as exc:
        if exc.status_code == 403:
            logger.info(f"403 when fetching assignments for course {course_id} — skipping")
            return []
        raise

    parsed: List[Assignment] = []
    for ra in raw_assignments:
        due_dt = parse_iso(ra.get("due_at"))
        name = ra.get("name") or ra.get("title") or f"Assignment {ra.get('id')}"
        points = ra.get("points_possible")
        desc = ra.get("description") or ra.get("html_url")
        html_url = ra.get("html_url") or f"{CANVAS_BASE_URL}/courses/{course_id}/assignments/{ra.get('id')}"

        sub_raw = ra.get("submission")
        sub = sub_raw if isinstance(sub_raw, dict) else {}
        submitted = bool(sub.get("submitted_at"))
        score = sub.get("score")
        graded_at = parse_iso(sub.get("graded_at"))

        parsed.append(
            Assignment(
                id=ra.get("id"),
                course_id=course_id,
                name=name,
                due_at=due_dt,
                points_possible=points,
                description=desc,
                submission_types=ra.get("submission_types"),
                html_url=html_url,
                submitted=submitted,
                score=score,
                graded_at=graded_at,
                assignment_group_id=ra.get("assignment_group_id"),
                attachments=_parse_attachments(ra.get("attachments")),
            )
        )

    parsed.sort(key=lambda a: (a.due_at is None, a.due_at or datetime.max.replace(tzinfo=timezone.utc)))
    return parsed[:limit] if limit else parsed

def get_upcoming_assignments(limit: int = 50, days_ahead: int = 30, mode: CacheMode = CacheMode.auto, token: Optional[str] = None, user_id: int = 0, db: Optional[Session] = None) -> List[Assignment]:
    now = datetime.now(timezone.utc)
    end = now + timedelta(days=days_ahead)
    # Include past assignments (up to 90 days) to capture missing/overdue assignments
    start = now - timedelta(days=90)

    # Only keep courses you consider "current"
    courses = get_courses(mode=mode, token=token, user_id=user_id)
    course_map = {c.id: c for c in courses}
    allowed_course_ids = set(course_map.keys())

    # Fast “index” call
    items = canvas_get_paginated(
        "/planner/items",
        params={
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "per_page": 100,
        },
        token=token,
    )

    # Extract upcoming assignment IDs for current courses
    upcoming_refs: list[tuple[int, int, datetime]] = []  # (course_id, assignment_id, due_at)
    for it in items:
        ptype = it.get("plannable_type")
        cid = it.get("course_id")

        if ptype == "assignment":
            pid = it.get("plannable_id")
        elif ptype in ("quiz", "discussion_topic"):
            # Graded quizzes and discussions appear in the planner under their own type.
            # Their plannable object carries assignment_id pointing to the underlying assignment.
            pid = (it.get("plannable") or {}).get("assignment_id")
        else:
            continue

        if not cid or not pid:
            continue
        if cid not in allowed_course_ids:
            continue

        due = parse_iso(it.get("plannable_date"))
        if not due:
            continue

        upcoming_refs.append((cid, pid, due))

    # Sort by due date and cap
    upcoming_refs.sort(key=lambda t: sort_key_due_at(t[2]))
    upcoming_refs = upcoming_refs[:limit]

    # Enrich: fetch details only for these few items (cached)
    out: list[Assignment] = []
    hidden_set = set(get_hidden_assignments(user_id, db)) if user_id and db else set()
    
    for cid, aid, due in upcoming_refs:
        # Skip if hidden
        if (cid, aid) in hidden_set:
            continue
            
        d = get_assignment_detail(cid, aid, mode=mode, token=token, user_id=user_id)

        sub_raw = d.get("submission")
        sub = sub_raw if isinstance(sub_raw, dict) else {}
        submitted = bool(sub.get("submitted_at"))
        score = sub.get("score")
        graded_at = parse_iso(sub.get("graded_at"))

        c = course_map.get(cid)
        out.append(
            Assignment(
                id=d.get("id") or aid,
                course_id=cid,
                course_name=(c.name if c else None),
                name=d.get("name") or f"Assignment {aid}",
                due_at=parse_iso(d.get("due_at")) or due,
                points_possible=d.get("points_possible"),
                description=d.get("description"),
                submission_types=d.get("submission_types"),
                html_url=d.get("html_url") or f"{CANVAS_BASE_URL}/courses/{cid}/assignments/{aid}",
                submitted=submitted,
                score=score,
                graded_at=graded_at,
                assignment_group_id=d.get("assignment_group_id"),
                attachments=_parse_attachments(d.get("attachments")),
            )
        )

    # Planner items can occasionally miss assignment-backed objects for some Canvas setups.
    # Backfill from per-course assignment lists so upcoming/weekly stays complete.
    seen_refs = {(a.course_id, a.id) for a in out}
    for course in courses:
        cid = course.id
        asgs = get_course_assignments_for(
            cid,
            mode=mode,
            token=token,
            user_id=user_id,
            db=db,
        )
        for a in asgs:
            if not a.due_at:
                continue
            if a.due_at < start or a.due_at > end:
                continue
            key = (cid, a.id)
            if key in hidden_set or key in seen_refs:
                continue

            out.append(
                a.copy(
                    update={"course_name": (course_map.get(cid).name if course_map.get(cid) else a.course_name)}
                )
            )
            seen_refs.add(key)

    out.sort(key=lambda a: sort_key_due_at(a.due_at))
    return out[:limit] if limit else out

def get_upcoming_cross_check_assignments(limit: int = 200, days_ahead: int = 30, mode: CacheMode = CacheMode.auto, token: Optional[str] = None, user_id: int = 0, db: Optional[Session] = None) -> List[Assignment]:
    now = datetime.now(timezone.utc)
    end = now + timedelta(days=days_ahead)
    start = now - timedelta(days=90)

    courses = get_courses(mode=mode, token=token, user_id=user_id)
    hidden_set = set(get_hidden_assignments(user_id, db)) if user_id and db else set()

    out: List[Assignment] = []
    seen_refs: set[tuple[int, int]] = set()

    for course in courses:
        cid = course.id
        asgs = get_course_assignments_for(
            cid,
            mode=mode,
            token=token,
            user_id=user_id,
            db=db,
        )

        for a in asgs:
            if not a.due_at:
                continue
            if a.due_at < start or a.due_at > end:
                continue

            ref = (cid, a.id)
            if ref in hidden_set or ref in seen_refs:
                continue

            course_name = course.name or a.course_name

            out.append(
                a.copy(update={"course_name": course_name})
            )
            seen_refs.add(ref)

    out.sort(key=lambda a: sort_key_due_at(a.due_at))
    return out[:limit] if limit else out

# === Unified getters with cache policy ===
def get_profile(mode: CacheMode = CacheMode.auto, token: Optional[str] = None, user_id: int = 0) -> Profile:
    key = f"profile:{user_id}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    p = get_student_profile(token=token)
    cache_set(key, p)
    return p

def get_enrollments(mode: CacheMode = CacheMode.auto, token: Optional[str] = None, user_id: int = 0) -> List[dict]:
    key = f"enrollments:{user_id}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    e = canvas_get_paginated("/users/self/enrollments", token=token)
    cache_set(key, e)
    return e

def get_courses(mode: CacheMode = CacheMode.auto, token: Optional[str] = None, user_id: int = 0) -> List[Course]:
    key = f"courses:{user_id}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    courses = get_active_courses(token=token)
    cache_set(key, courses)
    return courses

def get_course_assignments_for(
    course_id: int,
    mode: CacheMode = CacheMode.auto,
    token: Optional[str] = None,
    user_id: int = 0,
    db: Optional[Session] = None,
    include_hidden: bool = False,
) -> List[Assignment]:
    key = f"assignments:{user_id}:{course_id}:include_hidden={int(include_hidden)}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    asgs = get_course_assignments(course_id, include_submission=True, limit=None, token=token)
    
    # Filter out hidden assignments unless explicitly requested.
    if not include_hidden and user_id and db:
        hidden_set = set(get_hidden_assignments(user_id, db))
        asgs = [a for a in asgs if (a.course_id, a.id) not in hidden_set]
    
    cache_set(key, asgs)
    return asgs

def get_course_summaries(next_limit: int, missing_limit: int, mode: CacheMode = CacheMode.auto, token: Optional[str] = None, user_id: int = 0, db: Optional[Session] = None) -> List[CourseSummary]:
    key = f"course_summaries:{user_id}:next={next_limit}:miss={missing_limit}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    s = build_course_summaries(next_limit=next_limit, missing_limit=missing_limit, mode=mode, token=token, user_id=user_id, db=db)
    cache_set(key, s)
    return s

# === Course summaries ===
def build_course_summaries(next_limit: int = 3, missing_limit: int = 10, mode: CacheMode = CacheMode.auto, token: Optional[str] = None, user_id: int = 0, db: Optional[Session] = None) -> List[CourseSummary]:
    courses = get_courses(mode=mode, token=token, user_id=user_id)
    enrollments = get_enrollments(mode=mode, token=token, user_id=user_id)

    grades_by_course: dict[int, dict[str, Any]] = {}
    for e in enrollments:
        if e.get("type") != "StudentEnrollment":
            continue
        cid = e.get("course_id")
        if not cid:
            continue
        g = e.get("grades") or {}
        grades_by_course[cid] = {
            "current_score": g.get("current_score"),
            "current_grade": g.get("current_grade"),
        }

    now = datetime.now(timezone.utc)
    summaries: List[CourseSummary] = []

    for c in courses:
        cid = c.id
        grade = grades_by_course.get(cid, {})
        asgs = get_course_assignments_for(cid, mode=mode, token=token, user_id=user_id, db=db)

        future = [a for a in asgs if a.due_at and a.due_at >= now]
        future.sort(key=lambda a: sort_key_due_at(a.due_at))
        next_asgs = future[:next_limit]

        missing: List[MissingItem] = []
        for a in asgs:
            if not a.due_at:
                continue
            if a.due_at >= now:
                continue
            if a.submitted:
                continue
            if a.submission_types and "none" in a.submission_types:
                continue
            missing.append(
                MissingItem(
                    assignment_id=a.id,
                    course_id=cid,
                    course_name=c.name,
                    name=a.name,
                    due_at=a.due_at,
                    points_possible=a.points_possible,
                    html_url=a.html_url,
                )
            )

        missing.sort(key=lambda m: (m.due_at is None, m.due_at or datetime.min.replace(tzinfo=timezone.utc)))

        summaries.append(
            CourseSummary(
                id=cid,
                name=c.name,
                course_code=c.course_code,
                syllabus_url=c.syllabus_url,
                html_url=c.html_url,
                current_score=grade.get("current_score"),
                current_grade=grade.get("current_grade"),
                next_assignments=next_asgs,
                missing_count=len(missing),
                missing=missing[:missing_limit],
            )
        )

    summaries.sort(key=lambda s: (s.name or "").lower())
    return summaries

# === GPA helpers ===
def score_to_letter(score: Optional[float]) -> Optional[str]:
    if score is None:
        return None
    s = float(score)
    if s >= 93:
        return "A"
    if s >= 90:
        return "A-"
    if s >= 87:
        return "B+"
    if s >= 83:
        return "B"
    if s >= 80:
        return "B-"
    if s >= 77:
        return "C+"
    if s >= 73:
        return "C"
    if s >= 70:
        return "C-"
    if s >= 67:
        return "D+"
    if s >= 63:
        return "D"
    if s >= 60:
        return "D-"
    return "F"

def letter_to_points(letter: Optional[str]) -> Optional[float]:
    if not letter:
        return None
    s = letter.strip().upper()
    if not s:
        return None
    base_map = {"A": 4.0, "B": 3.0, "C": 2.0, "D": 1.0, "F": 0.0}
    base = base_map.get(s[0])
    if base is None:
        return None
    if len(s) >= 2:
        if s[1] == "+" and s[0] != "A":
            base += 0.33
        elif s[1] == "-":
            base -= 0.33
    return max(0.0, min(4.0, base))

def build_overview(mode: CacheMode = CacheMode.auto, token: Optional[str] = None, user_id: int = 0, db: Optional[Session] = None) -> OverviewResponse:
    summaries = get_course_summaries(next_limit=3, missing_limit=50, mode=mode, token=token, user_id=user_id, db=db)

    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=24)

    all_missing: List[MissingItem] = []
    for s in summaries:
        all_missing.extend(s.missing or [])
    all_missing.sort(key=lambda m: (m.due_at is None, m.due_at or datetime.min.replace(tzinfo=timezone.utc)))

    due_soon: List[DueSoonItem] = []
    for s in summaries:
        asgs = get_course_assignments_for(s.id, mode=mode, token=token, user_id=user_id, db=db)
        for a in asgs:
            if not a.due_at:
                continue
            if a.submitted:
                continue
            if now <= a.due_at <= cutoff:
                due_soon.append(
                    DueSoonItem(
                        assignment_id=a.id,
                        course_id=s.id,
                        course_name=s.name,
                        name=a.name,
                        due_at=a.due_at,
                        points_possible=a.points_possible,
                        html_url=a.html_url,
                    )
                )
    due_soon.sort(key=lambda x: x.due_at)

    grade_items: List[GradeItem] = []
    points: List[float] = []
    any_estimated = False

    for s in summaries:
        actual_letter = s.current_grade
        score = s.current_score

        display_letter = actual_letter
        grade_is_estimated = False

        if not display_letter and score is not None:
            est = score_to_letter(score)
            if est:
                display_letter = est
                grade_is_estimated = True
                any_estimated = True

        grade_items.append(
            GradeItem(
                course_id=s.id,
                course_name=s.name,
                course_code=s.course_code,
                current_grade=actual_letter,
                current_score=score,
                display_grade=display_letter,
                grade_is_estimated=grade_is_estimated,
            )
        )

        p = letter_to_points(display_letter)
        if p is not None:
            points.append(p)

    gpa = round(sum(points) / len(points), 2) if points else None

    return OverviewResponse(
        missing=all_missing,
        missing_count=len(all_missing),
        due_next_24h=due_soon,
        due_next_24h_count=len(due_soon),
        gpa=gpa,
        grades=grade_items,
        any_estimated_grades=any_estimated,
    )

# === FastAPI endpoints (cache-aware) ===
@app.get("/api/profile", response_model=Profile)
def api_profile(
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get user profile. Uses user token if authenticated, otherwise returns mock data if in demo mode."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        return mock_profile()
    
    token = None
    user_id = 0
    if session_id:
        try:
            uid = get_session_user_id(session_id, db)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass

    return get_profile(mode=cache, token=token, user_id=user_id)

@app.get("/api/courses", response_model=List[Course])
def api_courses(
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get user courses. Uses user token if authenticated, otherwise returns mock data if in demo mode."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        return mock_courses()
    
    token = None
    user_id = 0
    if session_id:
        try:
            uid = get_session_user_id(session_id, db)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass

    return get_courses(mode=cache, token=token, user_id=user_id)

@app.get("/api/courses/{course_id}/assignments", response_model=List[Assignment])
def api_course_assignments(
    course_id: int,
    limit: Optional[int] = None,
    include_hidden: bool = Query(False),
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get assignments for a course. Uses user token if authenticated, otherwise returns mock data if in demo mode."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        asgs = mock_course_assignments(course_id, limit=None)
        return asgs[:limit] if limit else asgs
    
    token = None
    user_id = 0
    if session_id:
        try:
            uid = get_session_user_id(session_id, db)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass

    asgs = get_course_assignments_for(
        course_id,
        mode=cache,
        token=token,
        user_id=user_id,
        db=db,
        include_hidden=include_hidden,
    )
    return asgs[:limit] if limit else asgs

@app.get("/api/upcoming", response_model=List[Assignment])
def api_upcoming(
    limit: Optional[int] = 50,
    days_ahead: int = 30,
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get upcoming assignments. Uses user token if authenticated, otherwise returns mock data if in demo mode."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        return mock_upcoming(limit=limit or 50)

    token = None
    user_id = None
    if session_id:
        try:
            user_id = get_session_user_id(session_id, db)
            if user_id:
                token = get_canvas_token(user_id, db)
        except Exception:
            pass

    lim = limit or 50
    key = f"upcoming:{user_id or 0}:v3:limit={lim}:days={days_ahead}"

    if _use_cache(cache):
        v = cache_get(key)
        if v:
            return v

    out = get_upcoming_assignments(limit=lim, days_ahead=days_ahead, mode=cache, token=token, user_id=user_id, db=db)

    cache_set(key, out)
    return out

@app.get("/api/upcoming-cross-check", response_model=List[Assignment])
def api_upcoming_cross_check(
    limit: Optional[int] = 200,
    days_ahead: int = 30,
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get upcoming assignments directly from per-course assignment lists for cross-checking."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        return mock_upcoming(limit=limit or 200)

    token = None
    user_id = None
    if session_id:
        try:
            user_id = get_session_user_id(session_id, db)
            if user_id:
                token = get_canvas_token(user_id, db)
        except Exception:
            pass

    lim = limit or 200
    key = f"upcoming_cross_check:{user_id or 0}:v1:limit={lim}:days={days_ahead}"

    if _use_cache(cache):
        v = cache_get(key)
        if v:
            return v

    out = get_upcoming_cross_check_assignments(
        limit=lim,
        days_ahead=days_ahead,
        mode=cache,
        token=token,
        user_id=user_id or 0,
        db=db,
    )

    cache_set(key, out)
    return out

@app.get("/api/undated-assignments", response_model=List[Assignment])
def api_undated_assignments(
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get all assignments without a due date. Uses user token if authenticated, otherwise returns empty list if in demo mode."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        return []  # Demo mode doesn't have undated assignments
    
    token = None
    user_id = None
    if session_id:
        try:
            user_id = get_session_user_id(session_id, db)
            if user_id:
                token = get_canvas_token(user_id, db)
        except Exception:
            pass
    
    key = f"undated_assignments:{user_id or 0}:v1"

    if _use_cache(cache):
        v = cache_get(key)
        if v:
            return v

    # Get all courses
    courses = get_courses(mode=cache, token=token, user_id=user_id or 0)

    # Get hidden assignments if user is authenticated
    hidden_set = set(get_hidden_assignments(user_id, db)) if user_id and db else set()
    
    # Collect all undated assignments across all courses
    undated: List[Assignment] = []
    
    for course in courses:
        cid = course.id
        asgs = get_course_assignments_for(cid, mode=cache, token=token, user_id=user_id, db=db)
        
        for a in asgs:
            # Only include if no due_at and not hidden
            if not a.due_at and (cid, a.id) not in hidden_set:
                # Add course_name to the assignment
                a_with_course = a.copy(update={"course_name": course.name})
                undated.append(a_with_course)
    
    # Sort by name for consistency
    undated.sort(key=lambda a: a.name.lower() if a.name else "")
    
    cache_set(key, undated)
    return undated

@app.get("/api/demo/enable")
@limiter.limit("5/minute")
def api_demo_enable(request: Request):
    """Enable demo mode - returns a demo session ID."""
    session_id = create_demo_session()
    response = JSONResponse({"success": True, "demo": True})
    response.set_cookie(
        "session_id",
        session_id,
        max_age=DEMO_SESSION_TTL_SECONDS,
        path="/",
        secure=SECURE_COOKIES,
        httponly=True,
        samesite="none" if SECURE_COOKIES else "lax"
    )
    return response

@app.get("/api/mock-mode/enabled")
def api_mock_mode_status(session_id: Optional[str] = Depends(get_session_id)):
    """Check if current session is in demo mode."""
    if session_id and is_demo_session(session_id):
        return {"mock_mode": True, "demo": True}
    return {"mock_mode": False, "demo": False}

@app.get("/api/dashboard")
def api_dashboard(
    upcoming_limit: int = 20,
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Dashboard bundle. Uses user token if authenticated, otherwise returns mock data if in demo mode."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        return {
            "profile": mock_profile().model_dump(mode='json'),
            "courses": [c.model_dump(mode='json') for c in mock_courses()],
            "upcoming": [a.model_dump(mode='json') for a in mock_upcoming(limit=upcoming_limit)],
        }
    
    token = None
    user_id = 0
    if session_id:
        try:
            uid = get_session_user_id(session_id, db)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass

    profile = get_profile(mode=cache, token=token, user_id=user_id)
    courses = get_courses(mode=cache, token=token, user_id=user_id)
    upcoming = api_upcoming(limit=upcoming_limit, cache=cache, session_id=session_id, db=db)
    return {
        "profile": profile.model_dump(mode='json'),
        "courses": [c.model_dump(mode='json') for c in courses],
        "upcoming": [a.model_dump(mode='json') for a in upcoming],
    }

@app.get("/api/courses/summary", response_model=List[CourseSummary])
def api_courses_summary(
    next_limit: int = 3,
    missing_limit: int = 10,
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get course summaries. Uses user token if authenticated, otherwise returns mock data if in demo mode."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        # Return mock summaries for demo
        courses = mock_courses()
        enrollments = mock_enrollments()
        
        grades_by_course: dict[int, dict[str, Any]] = {}
        for e in enrollments:
            cid = e.get("course_id")
            if cid:
                g = e.get("grades") or {}
                grades_by_course[cid] = {
                    "current_score": g.get("current_score"),
                    "current_grade": g.get("current_grade"),
                }
        
        now = datetime.now(timezone.utc)
        summaries: List[CourseSummary] = []
        for c in courses:
            cid = c.id
            grade = grades_by_course.get(cid, {})
            asgs = mock_course_assignments(cid, limit=None)
            
            future = [a for a in asgs if a.due_at and a.due_at >= now]
            future.sort(key=lambda a: sort_key_due_at(a.due_at))
            next_asgs = future[:next_limit]
            
            missing: List[MissingItem] = []
            for a in asgs:
                if not a.due_at or a.due_at >= now or a.submitted:
                    continue
                if a.submission_types and "none" in a.submission_types:
                    continue
                missing.append(
                    MissingItem(
                        assignment_id=a.id,
                        course_id=cid,
                        course_name=c.name,
                        name=a.name,
                        due_at=a.due_at,
                        points_possible=a.points_possible,
                        html_url=a.html_url,
                    )
                )
            
            missing.sort(key=lambda m: (m.due_at is None, m.due_at or datetime.min.replace(tzinfo=timezone.utc)))
            
            summaries.append(
                CourseSummary(
                    id=cid,
                    name=c.name,
                    course_code=c.course_code,
                    syllabus_url=c.syllabus_url,
                    html_url=c.html_url,
                    current_score=grade.get("current_score"),
                    current_grade=grade.get("current_grade"),
                    next_assignments=next_asgs,
                    missing_count=len(missing),
                    missing=missing[:missing_limit],
                )
            )
        
        summaries.sort(key=lambda s: (s.name or "").lower())
        return summaries
    
    token = None
    user_id = 0
    if session_id:
        try:
            uid = get_session_user_id(session_id, db)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass
    return get_course_summaries(next_limit=next_limit, missing_limit=missing_limit, mode=cache, token=token, user_id=user_id, db=db)

@app.get("/api/courses/attendance-tabs")
def api_courses_attendance_tabs(
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Return which of the user's active courses have an enabled attendance tab in Canvas."""
    if session_id and is_demo_session(session_id):
        return {"attendance": {}}
    current_user = get_current_user(session_id, db)
    token = get_canvas_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=403, detail="Canvas token required")

    courses = get_courses(mode=CacheMode.auto, token=token, user_id=current_user.id)

    def get_attendance_url(course_id: int) -> Optional[str]:
        try:
            tabs = canvas_get_paginated(f"/courses/{course_id}/tabs", token=token)
            for tab in tabs:
                if "attendance" in tab.get("label", "").lower() and not tab.get("hidden", False):
                    return tab.get("full_url") or tab.get("html_url") or None
            return None
        except Exception:
            return None

    from concurrent.futures import ThreadPoolExecutor
    course_ids = [c.id for c in courses]
    with ThreadPoolExecutor(max_workers=10) as executor:
        urls = list(executor.map(get_attendance_url, course_ids))

    return {
        "attendance": {
            str(cid): url for cid, url in zip(course_ids, urls) if url
        }
    }


@app.get("/api/overview", response_model=OverviewResponse)
def api_overview(
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get dashboard overview. Uses user token if authenticated, otherwise returns mock data if in demo mode."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        # Return mock overview for demo
        courses = mock_courses()
        enrollments = mock_enrollments()
        
        grades_by_course: dict[int, dict[str, Any]] = {}
        for e in enrollments:
            if e.get("type") != "StudentEnrollment":
                continue
            cid = e.get("course_id")
            if not cid:
                continue
            g = e.get("grades") or {}
            grades_by_course[cid] = {
                "current_score": g.get("current_score"),
                "current_grade": g.get("current_grade"),
            }
        
        now = datetime.now(timezone.utc)
        summaries: List[CourseSummary] = []
        for c in courses:
            cid = c.id
            grade = grades_by_course.get(cid, {})
            asgs = mock_course_assignments(cid, limit=None)
            
            future = [a for a in asgs if a.due_at and a.due_at >= now]
            future.sort(key=lambda a: sort_key_due_at(a.due_at))
            next_asgs = future[:3]
            
            missing: List[MissingItem] = []
            for a in asgs:
                if not a.due_at or a.due_at >= now or a.submitted:
                    continue
                if a.submission_types and "none" in a.submission_types:
                    continue
                missing.append(
                    MissingItem(
                        assignment_id=a.id,
                        course_id=cid,
                        course_name=c.name,
                        name=a.name,
                        due_at=a.due_at,
                        points_possible=a.points_possible,
                        html_url=a.html_url,
                    )
                )
            
            missing.sort(key=lambda m: (m.due_at is None, m.due_at or datetime.min.replace(tzinfo=timezone.utc)))
            
            summaries.append(
                CourseSummary(
                    id=cid,
                    name=c.name,
                    course_code=c.course_code,
                    syllabus_url=c.syllabus_url,
                    html_url=c.html_url,
                    current_score=grade.get("current_score"),
                    current_grade=grade.get("current_grade"),
                    next_assignments=next_asgs,
                    missing_count=len(missing),
                    missing=missing[:50],
                )
            )
        
        summaries.sort(key=lambda s: (s.name or "").lower())
        
        cutoff = now + timedelta(hours=24)
        all_missing: List[MissingItem] = []
        for s in summaries:
            all_missing.extend(s.missing or [])
        all_missing.sort(key=lambda m: (m.due_at is None, m.due_at or datetime.min.replace(tzinfo=timezone.utc)))
        
        due_soon: List[DueSoonItem] = []
        for s in summaries:
            asgs = mock_course_assignments(s.id, limit=None)
            for a in asgs:
                if not a.due_at or a.submitted or not (now <= a.due_at <= cutoff):
                    continue
                due_soon.append(
                    DueSoonItem(
                        assignment_id=a.id,
                        course_id=s.id,
                        course_name=s.name,
                        name=a.name,
                        due_at=a.due_at,
                        points_possible=a.points_possible,
                        html_url=a.html_url,
                    )
                )
        due_soon.sort(key=lambda x: x.due_at)
        
        grade_items: List[GradeItem] = []
        points: List[float] = []
        
        for s in summaries:
            actual_letter = s.current_grade
            score = s.current_score
            display_letter = actual_letter
            grade_is_estimated = False
            
            if not display_letter and score is not None:
                est = score_to_letter(score)
                if est:
                    display_letter = est
                    grade_is_estimated = True
            
            grade_items.append(
                GradeItem(
                    course_id=s.id,
                    course_name=s.name,
                    course_code=s.course_code,
                    current_grade=actual_letter,
                    current_score=score,
                    display_grade=display_letter,
                    grade_is_estimated=grade_is_estimated,
                )
            )
            
            p = letter_to_points(display_letter)
            if p is not None:
                points.append(p)
        
        gpa = round(sum(points) / len(points), 2) if points else None
        
        return OverviewResponse(
            missing=all_missing,
            missing_count=len(all_missing),
            due_next_24h=due_soon,
            due_next_24h_count=len(due_soon),
            gpa=gpa,
            grades=grade_items,
            any_estimated_grades=False,
        )
    
    token = None
    user_id = 0
    if session_id:
        try:
            uid = get_session_user_id(session_id, db)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass
    return build_overview(mode=cache, token=token, user_id=user_id, db=db)

@app.get("/")
def root_health_check():
    """Default health endpoint for platforms that probe the root path."""
    return {"status": "ok", "service": "canvassist-backend"}

@app.get("/health")
def health_check():
    """Health check endpoint for load balancers and uptime monitors."""
    return {"status": "ok"}

@app.post("/api/cache/clear")
def api_cache_clear(current_user: User = Depends(get_current_user)):
    """Clear the server-side cache. Requires an authenticated session."""
    cache_clear(prefix=None)
    return {"ok": True}

@app.get("/api/announcements", response_model=List[Announcement])
def api_announcements(
    days_back: int = 14,
    limit: int = 30,
    cache: CacheMode = Query(CacheMode.auto),
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get announcements. Demo mode returns mock announcements, authenticated mode uses real data."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        return mock_announcements(days_back=days_back, limit=limit)
    
    token = None
    user_id = 0
    if session_id:
        try:
            uid = get_session_user_id(session_id, db)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass
    return get_announcements(days_back=days_back, limit=limit, mode=cache, token=token, user_id=user_id)


@app.get("/api/announcements/last-seen")
def api_get_announcement_last_seen(
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Return the ID of the last announcement the user opened the dropdown to see."""
    if not session_id or is_demo_session(session_id):
        return {"last_seen_id": 0}
    try:
        uid = get_session_user_id(session_id, db)
        if not uid:
            return {"last_seen_id": 0}
        user = db.query(User).filter(User.id == uid).first()
        raw = getattr(user, "last_seen_announcement_id", None) if user else None
        return {"last_seen_id": raw if isinstance(raw, int) else 0}
    except Exception:
        return {"last_seen_id": 0}


@app.post("/api/announcements/last-seen")
def api_set_announcement_last_seen(
    payload: AnnouncementSeenRequest,
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Update the last-seen announcement ID when the user opens the announcements dropdown."""
    if not session_id or is_demo_session(session_id):
        return {"ok": True}
    try:
        uid = get_session_user_id(session_id, db)
        if not uid:
            return {"ok": True}
        announcement_id = payload.announcement_id
        user = db.query(User).filter(User.id == uid).first()
        if user:
            current = getattr(user, "last_seen_announcement_id", None)
            current_int = current if isinstance(current, int) else 0
            if announcement_id > current_int:
                db.query(User).filter(User.id == uid).update({"last_seen_announcement_id": announcement_id})
                db.commit()
    except Exception:
        db.rollback()
    return {"ok": True}


# === Background sync loop ===
_sync_task: Optional[asyncio.Task] = None

async def sync_loop():
    while True:
        try:
            logger.info("Background sync: refreshing cached Canvas data…")
            
            # Only sync if we have authenticated users with tokens
            # This is a background job that doesn't have user context, so we skip it
            # Users will sync when they make requests

            logger.info("Background sync: skipped (no global token available)")
        except Exception:
            logger.exception("Background sync failed (will retry)")

        await asyncio.sleep(SYNC_INTERVAL_SECONDS)

# === Auth endpoints ===
@app.post("/api/auth/register", response_model=UserResponse)
@limiter.limit("5/minute")
def auth_register(request: Request, payload: UserCreate, db: Session = Depends(get_db)):
    """Register a new user."""
    existing = get_user_by_email(payload.email, db)
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    
    try:
        user = create_user(payload.email, payload.password, db)
    except Exception as e:
        logger.error(f"Registration error: {e}")
        raise HTTPException(status_code=400, detail="Registration failed")
    
    return user

@app.post("/api/auth/login")
@limiter.limit("10/minute")
def auth_login(request: Request, payload: UserLogin, db: Session = Depends(get_db)):
    """Login with email and password. Returns session cookie."""
    user = get_user_by_email(payload.email, db)
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    session_id = create_session(user.id, db)
    response = JSONResponse({"success": True, "user": UserResponse.model_validate(user).model_dump(mode='json')})
    response.set_cookie(
        "session_id",
        session_id,
        max_age=30 * 24 * 60 * 60,  # 30 days
        path="/",
        secure=SECURE_COOKIES,
        httponly=True,
        samesite="none" if SECURE_COOKIES else "lax"
    )
    return response

@app.post("/api/auth/forgot-password")
@limiter.limit("5/minute")
def auth_forgot_password(request: Request, payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """Request a password reset email. Always returns a generic response."""
    user = get_user_by_email(payload.email, db)
    if user:
        raw_token = create_password_reset_token(user.id, db)
        reset_url = _build_password_reset_url(raw_token)
        _send_password_reset_email(user.email, reset_url)

    # Do not reveal whether a user exists for the submitted email.
    return {
        "success": True,
        "message": "If an account with that email exists, a reset link has been sent."
    }

@app.post("/api/auth/reset-password")
@limiter.limit("10/minute")
def auth_reset_password(request: Request, payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Reset password using a one-time token from email."""
    token_row = get_valid_password_reset_token(payload.token, db)
    if not token_row:
        raise HTTPException(status_code=400, detail="Invalid or expired reset link")

    user = get_user_by_id(token_row.user_id, db)
    if not user:
        raise HTTPException(status_code=400, detail="Invalid reset request")

    update_user_password(user, payload.new_password, db)
    mark_password_reset_token_used(token_row, db)
    invalidate_user_sessions(user.id, db)

    return {"success": True, "message": "Password reset successful. Please sign in."}

@app.post("/api/auth/logout")
def auth_logout(
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Logout the current user."""
    if session_id:
        invalidate_session(session_id, db)
    
    response = JSONResponse({"success": True})
    response.delete_cookie(
        "session_id",
        path="/",
        secure=SECURE_COOKIES,
        httponly=True,
        samesite="none" if SECURE_COOKIES else "lax",
    )
    return response

@app.get("/api/auth/me", response_model=UserResponse)
def auth_me(current_user: User = Depends(get_current_user)):
    """Get the currently logged-in user."""
    return current_user

@app.post("/api/auth/token")
def auth_token_submit(payload: CanvasTokenRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Submit or update Canvas token for the user."""
    try:
        # Validate the token by attempting a simple Canvas API call
        try:
            response = session.get(
                f"{CANVAS_BASE_URL}/api/v1/users/self",
                headers={"Authorization": f"Bearer {payload.token}"},
                timeout=10
            )
            if response.status_code == 401:
                raise HTTPException(status_code=400, detail="Invalid Canvas token. Please check your token and try again.")
            elif response.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Canvas API error: {response.status_code}. Please try again.")
        except requests.RequestException as e:
            raise HTTPException(status_code=400, detail=f"Failed to validate token: {str(e)}")

        store_canvas_token(current_user.id, payload.token, db)
        return {"success": True, "message": "Token saved successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Token storage error for user {current_user.id}: {e}")
        raise HTTPException(status_code=400, detail="Failed to store token")

@app.get("/api/auth/token/status", response_model=CanvasTokenStatus)
def auth_token_status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Check if user has a Canvas token saved."""
    db_token = db.query(CanvasToken).filter(CanvasToken.user_id == current_user.id).first()
    
    if not db_token:
        return CanvasTokenStatus(has_token=False)
    
    # If decryption fails (e.g., stale key from earlier run), treat as missing token.
    token = get_canvas_token(current_user.id, db)
    if not token:
        revoke_canvas_token(current_user.id, db)
        return CanvasTokenStatus(has_token=False)

    return CanvasTokenStatus(has_token=True, updated_at=db_token.updated_at)

@app.delete("/api/auth/token")
def auth_token_revoke(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Revoke the user's Canvas token."""
    revoke_canvas_token(current_user.id, db)
    return {"success": True, "message": "Token revoked"}

# === Hidden Assignments Management ===
@app.get("/api/hidden-assignments")
def get_hidden_assignments_endpoint(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get all hidden assignments for the current user with full details."""
    token = get_canvas_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=403, detail="Canvas token required")
    
    hidden = get_hidden_assignments(current_user.id, db)
    courses = get_courses(mode=CacheMode.auto, token=token, user_id=current_user.id)
    course_map = {c.id: c for c in courses}
    
    hidden_details = []
    for course_id, assignment_id in hidden:
        try:
            assignment_detail = get_assignment_detail(course_id, assignment_id, mode=CacheMode.auto, token=token, user_id=current_user.id)
            course = course_map.get(course_id)
            course_name = course.name if course else "Unknown course"
            
            hidden_details.append({
                "id": assignment_id,
                "course_id": course_id,
                "course_name": course_name,
                "name": assignment_detail.get("name") or f"Assignment {assignment_id}",
                "due_at": parse_iso(assignment_detail.get("due_at")).isoformat() if parse_iso(assignment_detail.get("due_at")) else None,
                "points_possible": assignment_detail.get("points_possible"),
            })
        except Exception as e:
            logger.warning(f"Failed to fetch details for hidden assignment {course_id}:{assignment_id}: {e}")
            # Fallback with minimal info
            course = course_map.get(course_id)
            course_name = course.name if course else "Unknown course"
            hidden_details.append({
                "id": assignment_id,
                "course_id": course_id,
                "course_name": course_name,
                "name": f"Assignment {assignment_id}",
                "due_at": None,
                "points_possible": None,
            })
    
    return {"hidden_assignments": hidden_details}

@app.post("/api/hidden-assignments")
def add_hidden_assignment(
    course_id: int = Query(...),
    assignment_id: int = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Hide an assignment from the user's view."""
    hide_assignment(current_user.id, course_id, assignment_id, db)
    uid = current_user.id
    for prefix in (f"upcoming:{uid}", f"upcoming_cross_check:{uid}", f"undated_assignments:{uid}", f"assignments:{uid}", f"course_summaries:{uid}"):
        cache_clear(prefix)
    return {"success": True, "message": "Assignment hidden"}

@app.delete("/api/hidden-assignments/{course_id}/{assignment_id}")
def remove_hidden_assignment(
    course_id: int,
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Unhide an assignment."""
    success = unhide_assignment(current_user.id, course_id, assignment_id, db)
    uid = current_user.id
    for prefix in (f"upcoming:{uid}", f"upcoming_cross_check:{uid}", f"undated_assignments:{uid}", f"assignments:{uid}", f"course_summaries:{uid}"):
        cache_clear(prefix)
    return {
        "success": success,
        "message": "Assignment unhidden" if success else "Assignment not found in hidden list"
    }

@app.get("/api/candidates-for-hiding")
def get_candidates_for_hiding(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get incomplete/unsubmitted assignments that could be hidden."""
    token = get_canvas_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=403, detail="Canvas token required")
    
    # Get all assignments from all courses
    courses = get_courses(mode=CacheMode.auto, token=token, user_id=current_user.id)
    candidates = []

    for course in courses:
        assignments = get_course_assignments_for(course.id, mode=CacheMode.auto, token=token, user_id=current_user.id)
        for a in assignments:
            # Only include unsubmitted assignments
            if not a.submitted:
                candidates.append({
                    "id": a.id,
                    "course_id": a.course_id,
                    "course_name": course.name,
                    "name": a.name,
                    "due_at": a.due_at.isoformat() if a.due_at else None,
                    "points_possible": a.points_possible,
                })
    
    return {"candidates": candidates}

# === Workload Estimates ===

@app.get("/api/workload-estimates")
def get_workload_estimates_endpoint(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all workload estimates for the authenticated user."""
    return {"estimates": get_workload_estimates(current_user.id, db)}

@app.put("/api/workload-estimates/{course_id}/{assignment_id}")
def upsert_workload_estimate_endpoint(
    course_id: int,
    assignment_id: int,
    body: WorkloadEstimateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create or update a workload estimate for a specific assignment."""
    upsert_workload_estimate(
        current_user.id,
        course_id,
        assignment_id,
        body.estimate_hours,
        body.completed_hours,
        body.completed,
        db,
    )
    return {"success": True}

@app.delete("/api/workload-estimates/{course_id}/{assignment_id}")
def delete_workload_estimate_endpoint(
    course_id: int,
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete the workload estimate for a specific assignment."""
    delete_workload_estimate(current_user.id, course_id, assignment_id, db)
    return {"success": True}


@app.get("/api/completed-assignments")
def get_completed_assignments_endpoint(
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get all assignment completion flags for the authenticated user."""
    if session_id and is_demo_session(session_id):
        return {"flags": []}
    current_user = get_current_user(session_id, db)
    return {"flags": get_completed_assignment_flags(current_user.id, db)}


@app.put("/api/completed-assignments/{course_id}/{assignment_id}")
def upsert_completed_assignment_endpoint(
    course_id: int,
    assignment_id: int,
    body: CompletedAssignmentFlagRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create or update an assignment completion flag for one assignment."""
    upsert_completed_assignment_flag(
        current_user.id,
        course_id,
        assignment_id,
        body.status_source,
        db,
    )
    return {"success": True}


@app.delete("/api/completed-assignments/{course_id}/{assignment_id}")
def delete_completed_assignment_endpoint(
    course_id: int,
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete an assignment completion flag for one assignment."""
    delete_completed_assignment_flag(current_user.id, course_id, assignment_id, db)
    return {"success": True}


@app.get("/api/assignment-weight-overrides")
def get_assignment_weight_overrides_endpoint(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all saved assignment weight overrides for the authenticated user."""
    return {"overrides": get_assignment_weight_overrides(current_user.id, db)}


@app.put("/api/assignment-weight-overrides/{course_id}/{assignment_id}")
def upsert_assignment_weight_override_endpoint(
    course_id: int,
    assignment_id: int,
    body: AssignmentWeightOverrideRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create or update a saved effective weight/points override for one assignment."""
    upsert_assignment_weight_override(
        current_user.id,
        course_id,
        assignment_id,
        body.weight_points,
        db,
    )
    return {"success": True}


@app.delete("/api/assignment-weight-overrides/{course_id}/{assignment_id}")
def delete_assignment_weight_override_endpoint(
    course_id: int,
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a saved effective weight/points override for one assignment."""
    delete_assignment_weight_override(current_user.id, course_id, assignment_id, db)
    return {"success": True}


@app.get("/api/courses/{course_id}/discussions")
def get_course_discussions_endpoint(
    course_id: int,
    limit: int = 30,
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Fetch active discussion topics for a course. Demo mode returns mock data."""
    if session_id and is_demo_session(session_id):
        return {"discussions": mock_discussions(course_id)[: max(1, int(limit))]}

    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    uid = get_session_user_id(session_id, db)
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = get_canvas_token(uid, db)

    raw = canvas_get_paginated(
        f"/courses/{course_id}/discussion_topics",
        params={"per_page": min(100, max(1, int(limit)))},
        token=token,
    )
    out: List[Dict[str, Any]] = []
    for entry in raw or []:
        if not isinstance(entry, dict):
            continue
        tid = entry.get("id")
        if tid is None:
            continue
        author = entry.get("author") if isinstance(entry.get("author"), dict) else {}
        out.append({
            "id": tid,
            "title": entry.get("title") or "Untitled discussion",
            "message_html": entry.get("message"),
            "posted_at": entry.get("posted_at") or entry.get("created_at"),
            "last_reply_at": entry.get("last_reply_at"),
            "html_url": entry.get("html_url"),
            "pinned": bool(entry.get("pinned")),
            "locked": bool(entry.get("locked")),
            "read_state": entry.get("read_state"),
            "unread_count": entry.get("unread_count"),
            "discussion_subentry_count": entry.get("discussion_subentry_count"),
            "author_id": author.get("id") if author else entry.get("user_id"),
            "author_name": (author.get("display_name") if author else None)
                or entry.get("user_name"),
        })
    return {"discussions": out[: max(1, int(limit))]}


@app.get("/api/courses/{course_id}/discussions/{topic_id}/replies")
def get_discussion_replies_endpoint(
    course_id: int,
    topic_id: int,
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Fetch replies (entries) for a single discussion topic.

    Uses Canvas's /view endpoint which returns participants + entries in one call,
    so we can resolve author names without a per-entry user lookup.
    """
    if session_id and is_demo_session(session_id):
        return {"replies": mock_discussion_replies(topic_id)}

    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    uid = get_session_user_id(session_id, db)
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = get_canvas_token(uid, db)

    raw = canvas_get_single(
        f"/courses/{course_id}/discussion_topics/{topic_id}/view",
        token=token,
    )
    if not isinstance(raw, dict):
        return {"replies": []}

    participants = {}
    for p in raw.get("participants") or []:
        if isinstance(p, dict) and p.get("id") is not None:
            participants[p["id"]] = p.get("display_name") or p.get("name")

    out: List[Dict[str, Any]] = []

    def walk(entry: Dict[str, Any], parent_id: Optional[int]):
        if not isinstance(entry, dict):
            return
        eid = entry.get("id")
        if eid is None:
            return
        uid_ = entry.get("user_id")
        out.append({
            "id": eid,
            "parent_id": parent_id,
            "author_id": uid_,
            "author_name": participants.get(uid_) or entry.get("user_name"),
            "created_at": entry.get("created_at"),
            "updated_at": entry.get("updated_at"),
            "message_html": entry.get("message"),
            "read_state": entry.get("read_state"),
        })
        for child in entry.get("replies") or []:
            walk(child, eid)

    for top in raw.get("view") or []:
        walk(top, None)

    return {"replies": out}


@app.get("/api/courses/{course_id}/assignment-groups")
def get_course_assignment_groups_endpoint(
    course_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Fetch Canvas assignment groups (with group_weight) for a course."""
    token = get_canvas_token(current_user.id, db)
    raw = canvas_get_paginated(
        f"/courses/{course_id}/assignment_groups",
        params={"per_page": 100},
        token=token,
    )
    groups = []
    for entry in raw or []:
        if not isinstance(entry, dict):
            continue
        gid = entry.get("id")
        if gid is None:
            continue
        groups.append({
            "id": gid,
            "name": entry.get("name") or "Group",
            "group_weight": entry.get("group_weight"),
            "position": entry.get("position"),
        })
    return {"groups": groups}


@app.get("/api/assignment-group-weight-overrides")
def get_assignment_group_weight_overrides_endpoint(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all saved per-group weight overrides for the authenticated user."""
    return {"overrides": get_assignment_group_weight_overrides(current_user.id, db)}


@app.put("/api/assignment-group-weight-overrides/{course_id}/{group_id}")
def upsert_assignment_group_weight_override_endpoint(
    course_id: int,
    group_id: int,
    body: AssignmentGroupWeightRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create or update a per-group weight override (%) for one assignment group."""
    upsert_assignment_group_weight_override(
        current_user.id,
        course_id,
        group_id,
        body.weight_pct,
        db,
    )
    return {"success": True}


@app.delete("/api/assignment-group-weight-overrides/{course_id}/{group_id}")
def delete_assignment_group_weight_override_endpoint(
    course_id: int,
    group_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a per-group weight override for one assignment group."""
    delete_assignment_group_weight_override(current_user.id, course_id, group_id, db)
    return {"success": True}


@app.get("/api/personal-assignment-dates")
def get_personal_assignment_dates_endpoint(
    session_id: Optional[str] = Depends(get_session_id),
    db: Session = Depends(get_db),
):
    """Get all personal due dates set by the authenticated user for undated assignments."""
    if session_id and is_demo_session(session_id):
        return {"dates": []}
    current_user = get_current_user(session_id, db)
    return {"dates": get_personal_assignment_dates(current_user.id, db)}


@app.put("/api/personal-assignment-dates/{course_id}/{assignment_id}")
def upsert_personal_assignment_date_endpoint(
    course_id: int,
    assignment_id: int,
    body: PersonalAssignmentDateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create or update a personal due date for an undated assignment."""
    try:
        due_at = dateparser.parse(body.due_at)
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid due_at format.")
    if due_at is None:
        raise HTTPException(status_code=422, detail="Could not parse due_at.")
    upsert_personal_assignment_date(current_user.id, course_id, assignment_id, due_at, db)
    return {"success": True}


@app.delete("/api/personal-assignment-dates/{course_id}/{assignment_id}")
def delete_personal_assignment_date_endpoint(
    course_id: int,
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a personal due date for an undated assignment."""
    delete_personal_assignment_date(current_user.id, course_id, assignment_id, db)
    return {"success": True}


@app.get("/api/grade-scale-preferences")
def get_grade_scale_preferences_endpoint(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all per-course grade scale preferences for the authenticated user."""
    return {"scales": get_grade_scale_preferences(current_user.id, db)}


@app.put("/api/grade-scale-preferences/{course_id}")
def upsert_grade_scale_preference_endpoint(
    course_id: int,
    body: GradeScalePreferenceRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create or update grade scale preference for one course."""
    upsert_grade_scale_preference(
        current_user.id,
        course_id,
        body.mode,
        body.thresholds,
        body.pass_threshold,
        db,
    )
    return {"success": True}


# === Personal Todos ===

@app.get("/api/todos")
@limiter.limit("60/minute")
def get_todos_endpoint(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all personal todo items for the authenticated user."""
    return {"todos": get_todos(current_user.id, db)}


@app.post("/api/todos")
@limiter.limit("30/minute")
def create_todo_endpoint(
    request: Request,
    body: TodoItemPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create one personal todo item for the authenticated user."""
    try:
        row = create_todo(
            current_user.id,
            body.id,
            body.title,
            body.notes,
            body.due_at,
            body.completed,
            db,
            recurrence=body.recurrence,
            series_id=body.series_id,
            occurrence_index=body.occurrence_index,
            anchor_due_at=body.anchor_due_at,
            workload_reset_mode=body.workload_reset_mode,
            source=body.source,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "success": True,
        "todo": {
            "id": row.todo_id,
            "title": row.title,
            "notes": row.notes or "",
            "due_at": row.due_at,
            "completed": bool(row.completed),
            "recurrence": row.recurrence or "none",
            "series_id": row.series_id,
            "occurrence_index": int(row.occurrence_index or 0),
            "anchor_due_at": row.anchor_due_at,
            "workload_reset_mode": row.workload_reset_mode or "none",
            "source": getattr(row, "source", None),
            "createdAt": row.created_at.isoformat() if row.created_at else None,
            "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
        },
    }


@app.put("/api/todos/{todo_id}")
@limiter.limit("30/minute")
def update_todo_endpoint(
    request: Request,
    todo_id: str,
    body: TodoItemPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update one personal todo item for the authenticated user."""
    row, generated_row = update_todo_with_recurrence(
        current_user.id,
        todo_id,
        body.title,
        body.notes,
        body.due_at,
        body.completed,
        db,
        recurrence=body.recurrence,
        series_id=body.series_id,
        occurrence_index=body.occurrence_index,
        anchor_due_at=body.anchor_due_at,
        edit_scope=body.edit_scope,
        workload_reset_mode=body.workload_reset_mode,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Todo item not found")
    return {
        "success": True,
        "todo": {
            "id": row.todo_id,
            "title": row.title,
            "notes": row.notes or "",
            "due_at": row.due_at,
            "completed": bool(row.completed),
            "recurrence": row.recurrence or "none",
            "series_id": row.series_id,
            "occurrence_index": int(row.occurrence_index or 0),
            "anchor_due_at": row.anchor_due_at,
            "workload_reset_mode": row.workload_reset_mode or "none",
            "source": getattr(row, "source", None),
            "createdAt": row.created_at.isoformat() if row.created_at else None,
            "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
        },
        "generated_todo": {
            "id": generated_row.todo_id,
            "title": generated_row.title,
            "notes": generated_row.notes or "",
            "due_at": generated_row.due_at,
            "completed": bool(generated_row.completed),
            "recurrence": generated_row.recurrence or "none",
            "series_id": generated_row.series_id,
            "occurrence_index": int(generated_row.occurrence_index or 0),
            "anchor_due_at": generated_row.anchor_due_at,
            "workload_reset_mode": generated_row.workload_reset_mode or "none",
            "source": getattr(generated_row, "source", None),
            "createdAt": generated_row.created_at.isoformat() if generated_row.created_at else None,
            "updatedAt": generated_row.updated_at.isoformat() if generated_row.updated_at else None,
        } if generated_row else None,
    }


@app.delete("/api/todos/{todo_id}")
@limiter.limit("30/minute")
def delete_todo_endpoint(
    request: Request,
    todo_id: str,
    delete_scope: str = Query(default="this-occurrence"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete one personal todo item for the authenticated user."""
    deleted_ids = delete_todo(
        current_user.id,
        todo_id,
        db,
        delete_scope=delete_scope,
    )
    return {"success": bool(deleted_ids), "deleted_ids": deleted_ids}

@app.get("/api/debug/cache")
def debug_cache(current_user: User = Depends(get_current_user)):
    with _cache_lock:
        keys = list(_cache.keys())
    return {
        "ttl_seconds": CACHE_TTL_SECONDS,
        "keys": keys,
        "count": len(keys),
    }

@app.get("/api/debug/terms")
def debug_terms(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    token = get_canvas_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=400, detail="No Canvas token found")
    courses = get_courses(mode=CacheMode.fresh, token=token, user_id=current_user.id)
    counts: dict[int, int] = {}
    for c in courses:
        if c.term_id is None:
            continue
        counts[c.term_id] = counts.get(c.term_id, 0) + 1
    top = sorted(counts.items(), key=lambda kv: kv[0], reverse=True)[:10]
    return {"term_counts_top10": top, "total_courses": len(courses)}

@app.on_event("startup")
async def on_startup():
    global _sync_task

    # Re-run table creation in a thread pool so a brief DB hiccup at import time
    # doesn't leave the app without its tables.  This is a no-op when tables
    # already exist.
    try:
        loop = asyncio.get_event_loop()
        from auth import _initialize_database
        logger.info("Verifying database connectivity for %s", describe_database_target())
        await loop.run_in_executor(None, _initialize_database)
        with SessionLocal() as db:
            prune_stale_workload_estimates(db)
        logger.info("Database tables verified/created successfully.")
    except Exception as exc:
        logger.critical("Startup DB init failed: %s", exc)
        if _is_cloud_runtime():
            raise RuntimeError("Database initialization failed during cloud startup") from exc

    _sync_task = asyncio.create_task(sync_loop())

@app.on_event("shutdown")
async def on_shutdown():
    global _sync_task
    if _sync_task:
        _sync_task.cancel()

# Run with: uvicorn app:app --reload --port 8000
