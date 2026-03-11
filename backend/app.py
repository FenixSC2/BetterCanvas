# app.py
from __future__ import annotations

import os
import time
import logging
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
from random import randint
from enum import Enum
from typing import Tuple

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

# imports for caching / background sync
import asyncio
from threading import Lock

# Auth imports
from auth import (
    User,
    CanvasToken,
    HiddenAssignment,
    WorkloadEstimate,
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
    upsert_workload_estimate,
    delete_workload_estimate,
    UserCreate,
    UserLogin,
    UserResponse,
    CanvasTokenRequest,
    CanvasTokenStatus,
)

load_dotenv()

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("canvas_backend")

# === Configuration ===
CANVAS_BASE_URL = os.getenv("CANVAS_BASE_URL", "https://northeastern.instructure.com").rstrip("/")

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "600"))
SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL_SECONDS", "180"))
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")]
SECURE_COOKIES = os.getenv("SECURE_COOKIES", "false").lower() == "true"

_cache_lock = Lock()
_cache: dict[str, dict[str, Any]] = {}  # key -> {"ts": float, "value": Any}
_demo_sessions: Dict[str, Dict[str, Any]] = {}  # session_id -> {"expires": float} for demo mode
_demo_sessions_lock = Lock()

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

    if r.status_code in (401, 403):
        logger.error(f"Canvas auth error {r.status_code} on {url}: {detail}")
        raise HTTPException(status_code=r.status_code, detail=detail)

    logger.error(f"Canvas error {r.status_code} on {url}: {detail}")
    raise HTTPException(status_code=r.status_code, detail=detail)

# === FastAPI app ===
limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="Canvas Better Backend (local)")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === Session management ===

# In-memory session store (dict: session_id -> {"user_id": int, "expires": float})
_sessions: Dict[str, Dict[str, Any]] = {}
_sessions_lock = Lock()

def create_session(user_id: int) -> str:
    """Create a new session for a user."""
    import secrets
    session_id = secrets.token_urlsafe(32)
    expires_at = time.time() + (30 * 24 * 60 * 60)  # 30 days
    
    with _sessions_lock:
        _sessions[session_id] = {"user_id": user_id, "expires": expires_at}
    
    return session_id

def create_demo_session() -> str:
    """Create a demo session for unauthenticated mock mode access."""
    import secrets
    session_id = secrets.token_urlsafe(32)
    expires_at = time.time() + (24 * 60 * 60)  # 1 day for demo
    
    with _demo_sessions_lock:
        _demo_sessions[session_id] = {"expires": expires_at}
    
    return session_id

def is_demo_session(session_id: str) -> bool:
    """Check if a session is in demo mode."""
    with _demo_sessions_lock:
        session = _demo_sessions.get(session_id)
        if not session:
            return False
        if time.time() > session["expires"]:
            _demo_sessions.pop(session_id, None)
            return False
        return True

def get_session_user_id(session_id: str) -> Optional[int]:
    """Retrieve user_id from a valid session."""
    with _sessions_lock:
        session = _sessions.get(session_id)
        if not session:
            return None
        if time.time() > session["expires"]:
            _sessions.pop(session_id, None)
            return None
        return session["user_id"]

def invalidate_session(session_id: str) -> None:
    """Invalidate a session."""
    with _sessions_lock:
        _sessions.pop(session_id, None)

def get_session_id(session_id: Optional[str] = Cookie(None)) -> Optional[str]:
    """Helper dependency to get session ID from the httponly session cookie."""
    return session_id

def get_current_user(session_id: Optional[str] = Depends(get_session_id), db: Session = Depends(get_db)) -> User:
    """Dependency to get the currently logged-in user from the session cookie."""
    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    user_id = get_session_user_id(session_id)
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
        name="Mock Student",
        sortable_name="Student, Mock",
        short_name="Mock",
        primary_email="mock.student@example.com",
        avatar_url=None,
    )

def mock_courses() -> List[Course]:
    return [
        Course(
            id=101,
            name="CS 3000 — Algorithms (Mock)",
            course_code="CS3000",
            term_id=202601,
            published=True,
            syllabus="Mock syllabus: This course covers graphs, flows, and dynamic programming.",
            syllabus_url=f"{CANVAS_BASE_URL}/courses/101/syllabus",
            html_url=f"{CANVAS_BASE_URL}/courses/101",
        ),
        Course(
            id=202,
            name="MATH 2001 — Discrete Structures (Mock)",
            course_code="MATH2001",
            term_id=202601,
            published=True,
            syllabus="Mock syllabus: Proofs, combinatorics, and discrete probability.",
            syllabus_url=f"{CANVAS_BASE_URL}/courses/202/syllabus",
            html_url=f"{CANVAS_BASE_URL}/courses/202",
        ),
        Course(
            id=303,
            name="ENGW 1111 — Writing (Score Only Mock)",
            course_code="ENGW1111",
            term_id=202601,
            published=True,
            syllabus="Mock syllabus: Writing and revision.",
            syllabus_url=f"{CANVAS_BASE_URL}/courses/303/syllabus",
            html_url=f"{CANVAS_BASE_URL}/courses/303",
        ),
    ]

def mock_course_assignments(course_id: int, limit: Optional[int] = None) -> List[Assignment]:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    base = [
        Assignment(
            id=999 + course_id * 1000,
            course_id=course_id,
            name="Reading Check 1",
            due_at=now - timedelta(days=2),
            points_possible=5,
            description="<p>This is intentionally overdue + unsubmitted to test missing detection.\n\nMore text a couple lines below</p>",
            submission_types=["online_text_entry"],
            html_url=f"{CANVAS_BASE_URL}/courses/{course_id}/assignments/{999 + course_id * 1000}",
            submitted=False,
            score=None,
        ),
        Assignment(
            id=1 + course_id * 1000,
            course_id=course_id,
            name="Homework 1: Warm-up",
            due_at=now + timedelta(days=3, hours=randint(0, 6)),
            points_possible=50,
            description="<p>Answer the questions in the PDF. Show work.</p>",
            submission_types=["online_upload"],
            html_url=f"{CANVAS_BASE_URL}/courses/{course_id}/assignments/{1 + course_id * 1000}",
            submitted=False,
            score=None,
        ),
        Assignment(
            id=2 + course_id * 1000,
            course_id=course_id,
            name="Project Proposal",
            due_at=now + timedelta(days=7, hours=randint(0, 6)),
            points_possible=25,
            description="<p>Submit a 1-page proposal describing your project idea.</p>",
            submission_types=["online_text_entry"],
            html_url=f"{CANVAS_BASE_URL}/courses/{course_id}/assignments/{2 + course_id * 1000}",
            submitted=False,
            score=None,
        ),
        Assignment(
            id=3 + course_id * 1000,
            course_id=course_id,
            name="Quiz 1",
            due_at=now + timedelta(days=1, hours=randint(0, 6)),
            points_possible=10,
            description="",
            submission_types=["online_quiz"],
            html_url=f"{CANVAS_BASE_URL}/courses/{course_id}/assignments/{3 + course_id * 1000}",
            submitted=True,
            score=9.0,
        ),
    ]
    base.sort(key=lambda a: (a.due_at is None, a.due_at or datetime.max.replace(tzinfo=timezone.utc)))
    return base[:limit] if limit else base

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

        sub = ra.get("submission", {}) if isinstance(ra.get("submission", {}), dict) else {}
        submitted = bool(sub.get("submitted_at"))
        score = sub.get("score")

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
        if it.get("plannable_type") != "assignment":
            continue

        cid = it.get("course_id")
        pid = it.get("plannable_id")
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

        sub = d.get("submission") if isinstance(d.get("submission"), dict) else {}
        submitted = bool(sub.get("submitted_at"))
        score = sub.get("score")

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
            )
        )

    out.sort(key=lambda a: sort_key_due_at(a.due_at))
    return out

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

def get_course_assignments_for(course_id: int, mode: CacheMode = CacheMode.auto, token: Optional[str] = None, user_id: int = 0, db: Optional[Session] = None) -> List[Assignment]:
    key = f"assignments:{user_id}:{course_id}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    asgs = get_course_assignments(course_id, include_submission=True, limit=None, token=token)
    
    # Filter out hidden assignments
    if user_id and db:
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
            uid = get_session_user_id(session_id)
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
            uid = get_session_user_id(session_id)
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
            uid = get_session_user_id(session_id)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass

    asgs = get_course_assignments_for(course_id, mode=cache, token=token, user_id=user_id, db=db)
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
            user_id = get_session_user_id(session_id)
            if user_id:
                token = get_canvas_token(user_id, db)
        except Exception:
            pass
    
    lim = limit or 50
    key = f"upcoming:{user_id or 0}:v2:limit={lim}:days={days_ahead}"

    if _use_cache(cache):
        v = cache_get(key)
        if v:
            return v

    out = get_upcoming_assignments(limit=lim, days_ahead=days_ahead, mode=cache, token=token, user_id=user_id, db=db)

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
            user_id = get_session_user_id(session_id)
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
    course_map = {c.id: c for c in courses}
    
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
def api_demo_enable():
    """Enable demo mode - returns a demo session ID."""
    session_id = create_demo_session()
    response = JSONResponse({"success": True, "demo": True})
    response.set_cookie(
        "session_id",
        session_id,
        max_age=24 * 60 * 60,  # 1 day
        path="/",
        secure=SECURE_COOKIES,
        httponly=True,
        samesite="lax"
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
            uid = get_session_user_id(session_id)
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
            uid = get_session_user_id(session_id)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass
    return get_course_summaries(next_limit=next_limit, missing_limit=missing_limit, mode=cache, token=token, user_id=user_id, db=db)

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
            uid = get_session_user_id(session_id)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass
    return build_overview(mode=cache, token=token, user_id=user_id, db=db)

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
    """Get announcements. Demo mode returns empty list, authenticated mode uses real data."""
    # Check for demo mode
    if session_id and is_demo_session(session_id):
        return []
    
    token = None
    user_id = 0
    if session_id:
        try:
            uid = get_session_user_id(session_id)
            if uid:
                user_id = uid
                token = get_canvas_token(user_id, db)
        except Exception:
            pass
    return get_announcements(days_back=days_back, limit=limit, mode=cache, token=token, user_id=user_id)

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

@app.get("/api/debug/canvas")
def debug_canvas():
    return {
        "canvas_base_url": CANVAS_BASE_URL,
        "auth_mode": "per-user token",
    }

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
    
    session_id = create_session(user.id)
    response = JSONResponse({"success": True, "user": UserResponse.model_validate(user).model_dump(mode='json')})
    response.set_cookie(
        "session_id",
        session_id,
        max_age=30 * 24 * 60 * 60,  # 30 days
        path="/",
        secure=SECURE_COOKIES,
        httponly=True,
        samesite="lax"
    )
    return response

@app.post("/api/auth/logout")
def auth_logout(session_id: Optional[str] = Depends(get_session_id)):
    """Logout the current user."""
    if session_id:
        invalidate_session(session_id)
    
    response = JSONResponse({"success": True})
    response.delete_cookie("session_id")
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
            response = requests.get(
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

@app.get("/api/debug/cache")
def debug_cache():
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
    _sync_task = asyncio.create_task(sync_loop())

@app.on_event("shutdown")
async def on_shutdown():
    global _sync_task
    if _sync_task:
        _sync_task.cancel()

# Run with: uvicorn app:app --reload --port 8000
