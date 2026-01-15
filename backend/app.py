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
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dateutil import parser as dateparser
from dotenv import load_dotenv

# imports for caching / background sync
import asyncio
from threading import Lock

load_dotenv()

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("canvas_backend")

# === Configuration ===
CANVAS_BASE_URL = os.getenv("CANVAS_BASE_URL", "https://northeastern.instructure.com").rstrip("/")
CANVAS_API_TOKEN = os.getenv("CANVAS_API_TOKEN", "your_token_here")
MOCK_MODE = os.getenv("MOCK_MODE", "false").lower() in ("1", "true", "yes", "y")

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "600"))
SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL_SECONDS", "180"))

if not MOCK_MODE and (not CANVAS_API_TOKEN or CANVAS_API_TOKEN == "your_token_here"):
    logger.warning("CANVAS_API_TOKEN looks unset and MOCK_MODE is off. Canvas calls may fail.")

_cache_lock = Lock()
_cache: dict[str, dict[str, Any]] = {}  # key -> {"ts": float, "value": Any}

HEADERS = {
    "Authorization": f"Bearer {CANVAS_API_TOKEN}",
    "Accept": "application/json",
}

# === Cache mode ===
class CacheMode(str, Enum):
    auto = "auto"    # use cache if valid, otherwise fetch
    fresh = "fresh"  # bypass cache and fetch now (updates cache)

def _use_cache(mode: CacheMode) -> bool:
    # In MOCK_MODE we prefer fresh so edits show immediately
    if MOCK_MODE:
        return False
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

def get_assignment_detail(course_id: int, assignment_id: int, mode: CacheMode) -> dict[str, Any]:
    key = f"assignment_detail:{course_id}:{assignment_id}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v

    data = canvas_get_single(
        f"/courses/{course_id}/assignments/{assignment_id}",
        params={"include[]": ["submission"]},
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
session.headers.update(HEADERS)

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
app = FastAPI(title="Canvas Better Backend (local)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === Utilities ===
def canvas_get_single(path: str, params: Optional[Dict[str, Any]] = None) -> Any:
    url = f"{CANVAS_BASE_URL}/api/v1{path}"
    r = session.get(url, params=params, timeout=20)
    if not r.ok:
        _raise_canvas_http(r, url)
    return r.json()

def canvas_get_paginated(path: str, params: Optional[Dict[str, Any]] = None) -> List[Any]:
    url = f"{CANVAS_BASE_URL}/api/v1{path}"
    results: List[Any] = []

    local_params = (params.copy() if params else {})
    local_params.setdefault("per_page", 100)

    while url:
        r = session.get(url, params=local_params, timeout=20)
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
) -> List[Announcement]:
    # Cache key
    key = f"announcements:days_back={days_back}:limit={limit}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v

    # Only current courses (your get_courses() already filters to latest term)
    courses = get_courses(mode=mode)
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
            description="<p>This is intentionally overdue + unsubmitted to test missing detection.</p>",
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
def get_student_profile() -> Profile:
    data = canvas_get_single("/users/self/profile")
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

def get_active_student_course_ids() -> List[int]:
    enrollments = canvas_get_paginated("/users/self/enrollments", params={"per_page": 100})

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

def get_active_courses() -> List[Course]:
    active_ids = get_active_student_course_ids()
    cleaned: List[Course] = []

    for cid in active_ids:
        details = canvas_get_single(f"/courses/{cid}")

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

def get_course_assignments(course_id: int, include_submission=True, limit: Optional[int] = None) -> List[Assignment]:
    params = {"include[]": "submission"} if include_submission else None
    try:
        raw_assignments = canvas_get_paginated(f"/courses/{course_id}/assignments", params=params)
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

def get_upcoming_assignments(limit: int = 50, days_ahead: int = 30, mode: CacheMode = CacheMode.auto) -> List[Assignment]:
    now = datetime.now(timezone.utc)
    end = now + timedelta(days=days_ahead)

    # Only keep courses you consider "current"
    courses = get_courses(mode=mode)
    course_map = {c.id: c for c in courses}
    allowed_course_ids = set(course_map.keys())

    # Fast “index” call
    items = canvas_get_paginated(
        "/planner/items",
        params={
            "start_date": now.isoformat(),
            "end_date": end.isoformat(),
            "per_page": 100,
        },
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
        if not due or due < now:
            continue

        upcoming_refs.append((cid, pid, due))

    # Sort by due date and cap
    upcoming_refs.sort(key=lambda t: sort_key_due_at(t[2]))
    upcoming_refs = upcoming_refs[:limit]

    # Enrich: fetch details only for these few items (cached)
    out: list[Assignment] = []
    for cid, aid, due in upcoming_refs:
        d = get_assignment_detail(cid, aid, mode=mode)

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
def get_profile(mode: CacheMode = CacheMode.auto) -> Profile:
    key = "profile"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    p = mock_profile() if MOCK_MODE else get_student_profile()
    cache_set(key, p)
    return p

def get_enrollments(mode: CacheMode = CacheMode.auto) -> List[dict]:
    key = "enrollments"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    e = mock_enrollments() if MOCK_MODE else canvas_get_paginated("/users/self/enrollments")
    cache_set(key, e)
    return e

def get_courses(mode: CacheMode = CacheMode.auto) -> List[Course]:
    key = "courses"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    courses = mock_courses() if MOCK_MODE else get_active_courses()
    cache_set(key, courses)
    return courses

def get_course_assignments_for(course_id: int, mode: CacheMode = CacheMode.auto) -> List[Assignment]:
    key = f"assignments:{course_id}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    asgs = (
        mock_course_assignments(course_id, limit=None)
        if MOCK_MODE
        else get_course_assignments(course_id, include_submission=True, limit=None)
    )
    cache_set(key, asgs)
    return asgs

def get_course_summaries(next_limit: int, missing_limit: int, mode: CacheMode = CacheMode.auto) -> List[CourseSummary]:
    key = f"course_summaries:next={next_limit}:miss={missing_limit}"
    if _use_cache(mode):
        v = cache_get(key)
        if v:
            return v
    s = build_course_summaries(next_limit=next_limit, missing_limit=missing_limit, mode=mode)
    cache_set(key, s)
    return s

# === Course summaries ===
def build_course_summaries(next_limit: int = 3, missing_limit: int = 10, mode: CacheMode = CacheMode.auto) -> List[CourseSummary]:
    courses = get_courses(mode=mode)
    enrollments = get_enrollments(mode=mode)

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
        asgs = get_course_assignments_for(cid, mode=mode)

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

def build_overview(mode: CacheMode = CacheMode.auto) -> OverviewResponse:
    summaries = get_course_summaries(next_limit=3, missing_limit=50, mode=mode)

    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=24)

    all_missing: List[MissingItem] = []
    for s in summaries:
        all_missing.extend(s.missing or [])
    all_missing.sort(key=lambda m: (m.due_at is None, m.due_at or datetime.min.replace(tzinfo=timezone.utc)))

    due_soon: List[DueSoonItem] = []
    for s in summaries:
        asgs = get_course_assignments_for(s.id, mode=mode)
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
def api_profile(cache: CacheMode = Query(CacheMode.auto)):
    return get_profile(mode=cache)

@app.get("/api/courses", response_model=List[Course])
def api_courses(cache: CacheMode = Query(CacheMode.auto)):
    return get_courses(mode=cache)

@app.get("/api/courses/{course_id}/assignments", response_model=List[Assignment])
def api_course_assignments(course_id: int, limit: Optional[int] = None, cache: CacheMode = Query(CacheMode.auto)):
    asgs = get_course_assignments_for(course_id, mode=cache)
    return asgs[:limit] if limit else asgs

@app.get("/api/upcoming", response_model=List[Assignment])
def api_upcoming(
    limit: Optional[int] = 50,
    days_ahead: int = 30,
    cache: CacheMode = Query(CacheMode.auto),
):
    lim = limit or 50
    key = f"upcoming:v2:limit={lim}:days={days_ahead}"

    if _use_cache(cache):
        v = cache_get(key)
        if v:
            return v

    if MOCK_MODE:
        out = mock_upcoming(limit=lim)
    else:
        out = get_upcoming_assignments(limit=lim, days_ahead=days_ahead, mode=cache)

    cache_set(key, out)
    return out

@app.get("/api/dashboard")
def api_dashboard(upcoming_limit: int = 20, cache: CacheMode = Query(CacheMode.auto)):
    # Dashboard is a "bundle": respect cache mode.
    profile = get_profile(mode=cache)
    courses = get_courses(mode=cache)
    upcoming = api_upcoming(limit=upcoming_limit, cache=cache)
    return {
        "profile": profile.dict(),
        "courses": [c.dict() for c in courses],
        "upcoming": [a.dict() for a in upcoming],
    }

@app.get("/api/courses/summary", response_model=List[CourseSummary])
def api_courses_summary(next_limit: int = 3, missing_limit: int = 10, cache: CacheMode = Query(CacheMode.auto)):
    return get_course_summaries(next_limit=next_limit, missing_limit=missing_limit, mode=cache)

@app.get("/api/overview", response_model=OverviewResponse)
def api_overview(cache: CacheMode = Query(CacheMode.auto)):
    return build_overview(mode=cache)

@app.post("/api/cache/clear")
def api_cache_clear():
    cache_clear(prefix=None)
    return {"ok": True}

@app.get("/api/announcements", response_model=List[Announcement])
def api_announcements(
    days_back: int = 14,
    limit: int = 30,
    cache: CacheMode = Query(CacheMode.auto),
):
    if MOCK_MODE:
        return []  # or add a mock_announcements() later
    return get_announcements(days_back=days_back, limit=limit, mode=cache)

# === Background sync loop ===
_sync_task: Optional[asyncio.Task] = None

async def sync_loop():
    while True:
        try:
            logger.info("Background sync: refreshing cached Canvas data…")

            _ = get_profile(mode=CacheMode.fresh)
            _ = get_enrollments(mode=CacheMode.fresh)
            _ = get_courses(mode=CacheMode.fresh)

            # Only refresh summaries periodically (it will pull assignments anyway)
            if not MOCK_MODE:
                _ = get_course_summaries(next_limit=3, missing_limit=10, mode=CacheMode.fresh)

            logger.info("Background sync: done.")
        except Exception:
            logger.exception("Background sync failed (will retry)")

        await asyncio.sleep(SYNC_INTERVAL_SECONDS)

@app.get("/api/debug/canvas")
def debug_canvas():
    return {
        "mock_mode": MOCK_MODE,
        "canvas_base_url": CANVAS_BASE_URL,
        "token_present": bool(CANVAS_API_TOKEN and CANVAS_API_TOKEN != "your_token_here"),
        "profile_probe": canvas_get_single("/users/self/profile"),
    }

@app.get("/api/debug/cache")
def debug_cache():
    with _cache_lock:
        keys = list(_cache.keys())
    return {
        "mock_mode": MOCK_MODE,
        "ttl_seconds": CACHE_TTL_SECONDS,
        "keys": keys,
        "count": len(keys),
    }

@app.get("/api/debug/terms")
def debug_terms():
    courses = get_courses(mode=CacheMode.fresh)
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
