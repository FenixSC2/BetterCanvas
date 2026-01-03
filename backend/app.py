# app.py
from __future__ import annotations

import os
import time
import logging
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
from random import randint

import requests
from requests.adapters import HTTPAdapter, Retry
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dateutil import parser as dateparser
from dotenv import load_dotenv

# imports for caching
import asyncio
from threading import Lock

load_dotenv()

# === Configuration ===
CANVAS_BASE_URL = os.getenv("CANVAS_BASE_URL", "https://northeastern.instructure.com/")
CANVAS_API_TOKEN = os.getenv("CANVAS_API_TOKEN", "your_token_here")
MOCK_MODE = os.getenv("MOCK_MODE", "false").lower() in ("1", "true", "yes", "y")

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "120"))
SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL_SECONDS", "180"))

_cache_lock = Lock()
_cache: dict[str, dict[str, Any]] = {}  # key -> {"ts": float, "value": Any}

HEADERS = {
    "Authorization": f"Bearer {CANVAS_API_TOKEN}",
    "Accept": "application/json"
}

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

# Cached getters
def get_profile_cached() -> Profile:
    key = "profile"
    v = cache_get(key)
    if v:
        return v
    p = mock_profile() if MOCK_MODE else get_student_profile()
    cache_set(key, p)
    return p

def get_enrollments_cached() -> List[dict]:
    key = "enrollments"
    v = cache_get(key)
    if v:
        return v
    e = mock_enrollments() if MOCK_MODE else canvas_get_paginated("/users/self/enrollments")
    cache_set(key, e)
    return e

def get_courses_cached() -> List[Course]:
    key = "courses"
    v = cache_get(key)
    if v:
        return v
    courses = mock_courses() if MOCK_MODE else get_active_courses()
    cache_set(key, courses)
    return courses

def get_course_assignments_cached(course_id: int) -> List[Assignment]:
    key = f"assignments:{course_id}"
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

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("canvas_backend")

# === HTTP Session with retries ===
session = requests.Session()
retries = Retry(total=3, backoff_factor=0.4,
                status_forcelist=[429, 500, 502, 503, 504])
session.mount("https://", HTTPAdapter(max_retries=retries))
session.headers.update(HEADERS)

# === FastAPI app ===
app = FastAPI(title="Canvas Better Backend (local)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === Utilities ===

def canvas_get_single(path: str, params: Optional[Dict[str, Any]] = None) -> Any:
    """
    Fetches a single (non-paginated) resource from Canvas.
    Raises HTTPException on non-200 responses (keeps 403 handling up to callers).
    """
    url = f"{CANVAS_BASE_URL}/api/v1{path}"
    r = session.get(url, params=params)
    if r.status_code == 403:
        # Caller may want to handle forbidden specially, so bubble up as HTTPException
        logger.debug(f"403 on {url} -> {r.text}")
        raise HTTPException(status_code=403, detail="Forbidden")
    r.raise_for_status()
    return r.json()

def canvas_get_paginated(path: str, params: Optional[Dict[str, Any]] = None) -> List[Any]:
    """
    Fetch all pages for a Canvas GET endpoint using Link headers.
    If an individual request returns 403, raises HTTPException(403).
    """
    url = f"{CANVAS_BASE_URL}/api/v1{path}"
    results: List[Any] = []
    local_params = params.copy() if params else None

    while url:
        r = session.get(url, params=local_params)
        if r.status_code == 403:
            logger.debug(f"403 on {url} -> skipping/page aborted")
            raise HTTPException(status_code=403, detail="Forbidden")
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list):
            results.extend(data)
        else:
            # single object — return it directly (but we prefer lists for pagination)
            return [data]

        # parse next link from Link header
        link = r.headers.get("Link", "")
        next_url = None
        if link:
            # Link header format: <url1>; rel="first", <url2>; rel="next", ...
            parts = link.split(",")
            for p in parts:
                if 'rel="next"' in p:
                    left = p.find("<")
                    right = p.find(">")
                    if left != -1 and right != -1:
                        next_url = p[left + 1:right]
                        break
        url = next_url
        local_params = None  # params only apply on the first request

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

# === Pydantic models for endpoint responses ===

class Profile(BaseModel):
    id: int
    name: Optional[str] = None
    sortable_name: Optional[str] = None
    short_name: Optional[str] = None
    primary_email: Optional[str] = None
    avatar_url: Optional[str] = None
    # raw: Optional[Dict[str,Any]] = Field(None, description="Original Canvas object")  # optional

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
    name: str
    due_at: Optional[datetime]
    points_possible: Optional[float]
    description: Optional[str]
    submission_types: Optional[List[str]] = None
    html_url: Optional[str] = None
    submitted: Optional[bool] = None
    score: Optional[float] = None

# === Grade aggregation and missing detection ===

# Models
class MissingItem(BaseModel):
    assignment_id: int
    course_id: int
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

# Course summary function
def build_course_summaries(next_limit: int = 3, missing_limit: int = 10) -> List[CourseSummary]:
    courses = get_courses_cached()
    enrollments = get_enrollments_cached()

    # Map course_id -> grades
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

        asgs = get_course_assignments_cached(cid)

        # "Next assignments": due dates in the future, sorted
        future = [a for a in asgs if a.due_at and a.due_at >= now]
        future.sort(key=lambda a: a.due_at)
        next_asgs = future[:next_limit]

        # Missing detection: due date in past + not submitted
        missing = []
        for a in asgs:
            if not a.due_at:
                continue
            if a.due_at >= now:
                continue
            # If Canvas returned submission info, we can use it:
            if a.submitted:
                continue
            # Skip "none" submission types (some items aren’t actually submittable)
            if a.submission_types and "none" in a.submission_types:
                continue
            missing.append(MissingItem(
                assignment_id=a.id,
                course_id=cid,
                name=a.name,
                due_at=a.due_at,
                points_possible=a.points_possible,
                html_url=a.html_url
            ))

        missing.sort(key=lambda m: (m.due_at is None, m.due_at or datetime.min.replace(tzinfo=timezone.utc)))

        summaries.append(CourseSummary(
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
        ))

    summaries.sort(key=lambda s: s.name.lower())
    return summaries

# Cache course summaries 
def get_course_summaries_cached(next_limit: int, missing_limit: int) -> List[CourseSummary]:
    key = f"course_summaries:next={next_limit}:miss={missing_limit}"
    v = cache_get(key)
    if v:
        return v
    s = build_course_summaries(next_limit=next_limit, missing_limit=missing_limit)
    cache_set(key, s)
    return s

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
    ]

def mock_course_assignments(course_id: int, limit: Optional[int] = None) -> List[Assignment]:
    now = datetime.now(timezone.utc).replace(microsecond=0)

    base = [
        # One intentionally overdue + unsubmitted assignment (tests "missing")
        Assignment(
            id=999 + course_id * 1000,
            course_id=course_id,
            name="Overdue: Reading Check (Missing)",
            due_at=now - timedelta(days=2),
            points_possible=5,
            description="<p>This is intentionally overdue + unsubmitted to test missing detection.</p>",
            submission_types=["online_text_entry"],
            html_url=f"{CANVAS_BASE_URL}/courses/{course_id}/assignments/{999 + course_id * 1000}",
            submitted=False,
            score=None,
        ),

        # Upcoming items
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
            name="Quiz 1 (Submitted)",
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

    # Stagger due dates to look realistic
    now = datetime.now(timezone.utc)
    base[0].due_at = now.replace(microsecond=0)  # due now-ish
    base[1].due_at = (now.replace(microsecond=0) )  # will tweak below
    base[2].due_at = (now.replace(microsecond=0) )

    # Actually stagger by days/hours
    base[0].due_at = now.replace(microsecond=0) + timedelta(days=3, hours=randint(0, 6))
    base[1].due_at = now.replace(microsecond=0) + timedelta(days=7, hours=randint(0, 6))
    base[2].due_at = now.replace(microsecond=0) + timedelta(days=1, hours=randint(0, 6))

    base.sort(key=lambda a: a.due_at or datetime.max.replace(tzinfo=timezone.utc))
    return base[:limit] if limit else base

def mock_upcoming(limit: int = 50) -> List[Assignment]:
    courses = mock_courses()
    all_asgs: List[Assignment] = []
    for c in courses:
        all_asgs.extend(mock_course_assignments(c.id))
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
    ]

def mock_course_summaries(next_limit: int = 3, missing_limit: int = 10) -> List[CourseSummary]:
    # Use the same aggregation logic, but fed by mock data through cached getters.
    # Because get_courses_cached/get_enrollments_cached/get_course_assignments_cached are mock-aware,
    # this will produce consistent mock summaries.
    return build_course_summaries(next_limit=next_limit, missing_limit=missing_limit)

# === Canvas-specific getters used by the app ===

def get_student_profile() -> Profile:
    data = canvas_get_single("/users/self/profile") if True else canvas_get_single("/users/self")
    # Some Canvas instances return different fields in /users/self vs /users/self/profile
    # We attempt /users/self/profile first since it often includes email
    if data is None:
        raise HTTPException(status_code=500, detail="No profile returned from Canvas")
    return Profile(
        id=data.get("id"),
        name=data.get("name") or data.get("sortable_name"),
        sortable_name=data.get("sortable_name"),
        short_name=data.get("short_name"),
        primary_email=data.get("primary_email") or data.get("login_id"),
        avatar_url=data.get("avatar_url")
    )

def get_active_student_course_ids() -> List[int]:
    """
    Uses enrollments to determine active student course IDs.
    """
    enrollments = canvas_get_paginated("/users/self/enrollments")
    active_ids = []
    for e in enrollments:
        # Guard against missing keys
        typ = e.get("type")
        state = e.get("enrollment_state")
        course_id = e.get("course_id")
        if typ == "StudentEnrollment" and state == "active" and course_id:
            active_ids.append(course_id)
    return active_ids

def get_active_courses() -> List[Course]:
    """
    Return cleaned active course objects for the current (authenticated) student.
    We consult enrollments for "active" status, then fetch course details for syllabus/html_url.
    """
    # First call: list of course contexts (may be partial)
    raw_courses = canvas_get_paginated("/users/self/courses")
    active_ids = set(get_active_student_course_ids())

    cleaned: List[Course] = []
    for rc in raw_courses:
        cid = rc.get("id")
        if not cid or cid not in active_ids:
            continue
        # Try to fetch full course details for syllabus and html link (optional)
        try:
            details = canvas_get_single(f"/courses/{cid}")
        except HTTPException as exc:
            # If forbidden for course details, skip extras but still include a minimal course item
            logger.info(f"Couldn't fetch details for course {cid}: {exc.detail}")
            details = rc

        # Resolve fields defensively
        name = details.get("name") or rc.get("name") or details.get("original_name") or rc.get("course_code") or f"Course {cid}"
        course_code = details.get("course_code") or rc.get("course_code")
        term_id = details.get("enrollment_term_id") or rc.get("enrollment_term_id")
        published = (details.get("workflow_state") == "available") or (rc.get("workflow_state") == "available")
        syllabus = details.get("syllabus_body") or details.get("syllabus") or None
        syllabus_url = details.get("syllabus_url") or f"{CANVAS_BASE_URL}/courses/{cid}/syllabus"
        html_url = details.get("html_url") or f"{CANVAS_BASE_URL}/courses/{cid}"

        cleaned.append(Course(
            id=cid,
            name=name,
            course_code=course_code,
            term_id=term_id,
            published=published,
            syllabus=syllabus,
            syllabus_url=syllabus_url,
            html_url=html_url
        ))
    return cleaned

def get_course_assignments(course_id: int, include_submission=True, limit: Optional[int] = None) -> List[Assignment]:
    """
    Return assignments for a specific course. Optionally include submission info (score/submitted).
    This function will skip a course if Canvas returns 403 for it (returns empty list).
    """
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
        desc = ra.get("description") or ra.get("html_url") # description often present
        html_url = ra.get("html_url") or f"{CANVAS_BASE_URL}/courses/{course_id}/assignments/{ra.get('id')}"
        # submission info (if included)
        sub = ra.get("submission", {}) if isinstance(ra.get("submission", {}), dict) else {}
        submitted = bool(sub.get("submitted_at"))
        score = sub.get("score")

        parsed.append(Assignment(
            id=ra.get("id"),
            course_id=course_id,
            name=name,
            due_at=due_dt,
            points_possible=points,
            description=desc,
            submission_types=ra.get("submission_types"),
            html_url=html_url,
            submitted=submitted,
            score=score
        ))

    # Sort by due date ascending (None at end)
    parsed.sort(key=lambda a: (a.due_at is None, a.due_at or datetime.max.replace(tzinfo=timezone.utc)))
    if limit:
        return parsed[:limit]
    return parsed

def get_upcoming_assignments(limit: int = 50) -> List[Assignment]:
    """
    Aggregates assignments from all active courses, filters future or soon due ones,
    sorts by due date and returns up to `limit`.
    """
    courses = get_active_courses()
    assignments_agg: List[Assignment] = []
    now = datetime.now(timezone.utc)

    # Fetch assignments per course, skip forbidden per-course
    for c in courses:
        asgs = get_course_assignments(c.id, include_submission=True)
        for a in asgs:
            if a.due_at is None:
                # include assignments without due date? For "upcoming" we generally skip them
                continue
            # Option: only include assignments due in the future or within a small window
            # We'll include ones due now or in the future (>= now)
            if a.due_at >= now:
                # annotate the course name for the frontend easily
                a_dict = a
                assignments_agg.append(a_dict)

    # sort and trim
    assignments_agg.sort(key=lambda a: a.due_at)
    return assignments_agg[:limit]

# === FastAPI endpoints ===

@app.get("/api/profile", response_model=Profile)
def api_profile():
    try:
        if MOCK_MODE:
            return mock_profile()
        return get_student_profile()
    except HTTPException as e:
        raise e
    except Exception as exc:
        logger.exception("Error fetching profile")
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/courses", response_model=List[Course])
def api_courses():
    try:
        if MOCK_MODE:
            return mock_courses()
        return get_active_courses()
    except HTTPException as e:
        raise e
    except Exception as exc:
        logger.exception("Error fetching courses")
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/courses/{course_id}/assignments", response_model=List[Assignment])
def api_course_assignments(course_id: int, limit: Optional[int] = None):
    try:
        if MOCK_MODE:
            return mock_course_assignments(course_id, limit=limit)
        return get_course_assignments(course_id, include_submission=True, limit=limit)
    except HTTPException as e:
        # forward 403 as 403 so front end can handle gracefully
        raise e
    except Exception as exc:
        logger.exception("Error fetching assignments")
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/upcoming", response_model=List[Assignment])
def api_upcoming(limit: Optional[int] = 50):
    try:
        if MOCK_MODE:
            return mock_upcoming(limit=limit or 50)
        return get_upcoming_assignments(limit=limit)
    except Exception as exc:
        logger.exception("Error fetching upcoming")
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/dashboard")
def api_dashboard(upcoming_limit: int = 20):
    """
    Convenience endpoint returning combined profile + course list + upcoming assignments.
    """
    try:
        if MOCK_MODE:
            return {
                "profile": mock_profile().dict(),
                "courses": [c.dict() for c in mock_courses()],
                "upcoming": [a.dict() for a in mock_upcoming(limit=upcoming_limit)]
            }

        profile = get_student_profile()
        courses = get_active_courses()
        upcoming = get_upcoming_assignments(limit=upcoming_limit)
        return {
            "profile": profile.dict(),
            "courses": [c.dict() for c in courses],
            "upcoming": [a.dict() for a in upcoming]
        }
    except Exception as exc:
        logger.exception("Error building dashboard")
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/courses/summary", response_model=List[CourseSummary])
def api_courses_summary(next_limit: int = 3, missing_limit: int = 10):
    if MOCK_MODE:
        # optional: bypass cache in mock mode so changes show instantly while debugging
        return mock_course_summaries(next_limit=next_limit, missing_limit=missing_limit)
    return get_course_summaries_cached(next_limit=next_limit, missing_limit=missing_limit)

# === Background sync loop ===
_sync_task: Optional[asyncio.Task] = None

async def sync_loop():
    while True:
        try:
            logger.info("Background sync: refreshing cached Canvas data…")

            # Refresh “core” cache keys
            cache_clear(prefix="course_summaries")
            cache_clear(prefix="assignments:")
            cache_clear(prefix=None)  # or keep selective; simplest for now

            # Warm the cache
            _ = get_profile_cached()
            _ = get_enrollments_cached()
            courses = get_courses_cached()
            for c in courses:
                _ = get_course_assignments_cached(c.id)

            # Precompute common summaries
            _ = get_course_summaries_cached(next_limit=3, missing_limit=10)

            logger.info("Background sync: done.")
        except Exception:
            logger.exception("Background sync failed (will retry)")

        await asyncio.sleep(SYNC_INTERVAL_SECONDS)

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