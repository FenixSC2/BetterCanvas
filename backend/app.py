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

# imports for caching / background sync
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
    "Accept": "application/json",
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

    current_grade: Optional[str] = None  # actual Canvas letter if present
    current_score: Optional[float] = None

    display_grade: Optional[str] = None  # actual OR estimated letter
    grade_is_estimated: bool = False     # True if display_grade came from score


class OverviewResponse(BaseModel):
    missing: List[MissingItem] = Field(default_factory=list)
    missing_count: int = 0

    due_next_24h: List[DueSoonItem] = Field(default_factory=list)
    due_next_24h_count: int = 0

    gpa: Optional[float] = None
    grades: List[GradeItem] = Field(default_factory=list)

    any_estimated_grades: bool = False


# === Cached getters ===
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
retries = Retry(
    total=3,
    backoff_factor=0.4,
    status_forcelist=[429, 500, 502, 503, 504],
)
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
            return [data]

        link = r.headers.get("Link", "")
        next_url = None
        if link:
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


# === Course summaries ===
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

        # "Next assignments": future due dates sorted
        future = [a for a in asgs if a.due_at and a.due_at >= now]
        future.sort(key=lambda a: a.due_at)
        next_asgs = future[:next_limit]

        # Missing detection: past due + not submitted
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

        missing.sort(
            key=lambda m: (m.due_at is None, m.due_at or datetime.min.replace(tzinfo=timezone.utc))
        )

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


def get_course_summaries_cached(next_limit: int, missing_limit: int) -> List[CourseSummary]:
    key = f"course_summaries:next={next_limit}:miss={missing_limit}"
    v = cache_get(key)
    if v:
        return v
    s = build_course_summaries(next_limit=next_limit, missing_limit=missing_limit)
    cache_set(key, s)
    return s


# === GPA helpers ===
def score_to_letter(score: Optional[float]) -> Optional[str]:
    """
    Estimate letter grade from percentage score (0-100).
    Default scale (common):
      A: 93+, A-: 90-92.99
      B+: 87-89.99, B: 83-86.99, B-: 80-82.99
      C+: 77-79.99, C: 73-76.99, C-: 70-72.99
      D+: 67-69.99, D: 63-66.99, D-: 60-62.99
      F: <60
    """
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

    # Handle +/- (cap A+ at 4.0)
    if len(s) >= 2:
        if s[1] == "+" and s[0] != "A":
            base += 0.33
        elif s[1] == "-":
            base -= 0.33

    base = max(0.0, min(4.0, base))
    return base


def get_course_summaries_for_overview(next_limit: int = 3, missing_limit: int = 50) -> List[CourseSummary]:
    """
    Overview should be stable and fresh in MOCK_MODE.
    In MOCK_MODE we bypass caching so new mock edits show immediately and we don't
    accidentally reuse stale cached summaries.
    """
    if MOCK_MODE:
        return build_course_summaries(next_limit=next_limit, missing_limit=missing_limit)
    return get_course_summaries_cached(next_limit=next_limit, missing_limit=missing_limit)


def build_overview() -> OverviewResponse:
    summaries = get_course_summaries_for_overview(next_limit=3, missing_limit=50)

    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=24)

    # 1) All missing work across all classes
    all_missing: List[MissingItem] = []
    for s in summaries:
        all_missing.extend(s.missing or [])
    all_missing.sort(
        key=lambda m: (m.due_at is None, m.due_at or datetime.min.replace(tzinfo=timezone.utc))
    )

    # 2) Next 24 hours: due soon + not submitted
    due_soon: List[DueSoonItem] = []
    for s in summaries:
        asgs = get_course_assignments_cached(s.id)
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

    # 3) Grade overview + running GPA (with estimation fallback)
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
            name="Overdue: Reading Check (Missing)",
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


def mock_upcoming(limit: int = 50) -> List[Assignment]:
    courses = mock_courses()
    all_asgs: List[Assignment] = []

    for c in courses:
        asgs = mock_course_assignments(c.id)
        for a in asgs:
            a.course_name = c.name  # <-- IMPORTANT
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
            "grades": {
                "current_score": 78.5,
                "current_grade": None,  # triggers estimation => C+
            },
        },
    ]


def mock_course_summaries(next_limit: int = 3, missing_limit: int = 10) -> List[CourseSummary]:
    return build_course_summaries(next_limit=next_limit, missing_limit=missing_limit)


# === Canvas-specific getters used by the app ===
def get_student_profile() -> Profile:
    data = canvas_get_single("/users/self/profile") if True else canvas_get_single("/users/self")
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
    enrollments = canvas_get_paginated("/users/self/enrollments")
    active_ids = []
    for e in enrollments:
        typ = e.get("type")
        state = e.get("enrollment_state")
        course_id = e.get("course_id")
        if typ == "StudentEnrollment" and state == "active" and course_id:
            active_ids.append(course_id)
    return active_ids


def get_active_courses() -> List[Course]:
    raw_courses = canvas_get_paginated("/users/self/courses")
    active_ids = set(get_active_student_course_ids())

    cleaned: List[Course] = []
    for rc in raw_courses:
        cid = rc.get("id")
        if not cid or cid not in active_ids:
            continue

        try:
            details = canvas_get_single(f"/courses/{cid}")
        except HTTPException as exc:
            logger.info(f"Couldn't fetch details for course {cid}: {exc.detail}")
            details = rc

        name = (
            details.get("name")
            or rc.get("name")
            or details.get("original_name")
            or rc.get("course_code")
            or f"Course {cid}"
        )
        course_code = details.get("course_code") or rc.get("course_code")
        term_id = details.get("enrollment_term_id") or rc.get("enrollment_term_id")
        published = (details.get("workflow_state") == "available") or (rc.get("workflow_state") == "available")
        syllabus = details.get("syllabus_body") or details.get("syllabus") or None
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
    if limit:
        return parsed[:limit]
    return parsed

def get_upcoming_assignments(limit: int = 50) -> List[Assignment]:
    courses = get_active_courses()
    assignments_agg: List[Assignment] = []
    now = datetime.now(timezone.utc)

    for c in courses:
        asgs = get_course_assignments(c.id, include_submission=True)
        for a in asgs:
            if not a.due_at:
                continue
            if a.submitted:
                continue
            if a.due_at >= now:
                a.course_name = c.name  # <-- IMPORTANT
                assignments_agg.append(a)

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
        raise e
    except Exception as exc:
        logger.exception("Error fetching assignments")
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/upcoming", response_model=List[Assignment])
def api_upcoming(limit: Optional[int] = 50):
    try:
        if MOCK_MODE:
            return mock_upcoming(limit=limit or 50)
        return get_upcoming_assignments(limit=limit or 50)
    except Exception as exc:
        logger.exception("Error fetching upcoming")
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/dashboard")
def api_dashboard(upcoming_limit: int = 20):
    try:
        if MOCK_MODE:
            return {
                "profile": mock_profile().dict(),
                "courses": [c.dict() for c in mock_courses()],
                "upcoming": [a.dict() for a in mock_upcoming(limit=upcoming_limit)],
            }

        profile = get_student_profile()
        courses = get_active_courses()
        upcoming = get_upcoming_assignments(limit=upcoming_limit)
        return {
            "profile": profile.dict(),
            "courses": [c.dict() for c in courses],
            "upcoming": [a.dict() for a in upcoming],
        }
    except Exception as exc:
        logger.exception("Error building dashboard")
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/courses/summary", response_model=List[CourseSummary])
def api_courses_summary(next_limit: int = 3, missing_limit: int = 10):
    if MOCK_MODE:
        return mock_course_summaries(next_limit=next_limit, missing_limit=missing_limit)
    return get_course_summaries_cached(next_limit=next_limit, missing_limit=missing_limit)


@app.get("/api/overview", response_model=OverviewResponse)
def api_overview():
    return build_overview()


# === Background sync loop ===
_sync_task: Optional[asyncio.Task] = None


async def sync_loop():
    while True:
        try:
            logger.info("Background sync: refreshing cached Canvas data…")

            cache_clear(prefix="course_summaries")
            cache_clear(prefix="assignments:")
            cache_clear(prefix=None)  # simplest for now

            # Warm the cache
            _ = get_profile_cached()
            _ = get_enrollments_cached()
            courses = get_courses_cached()
            for c in courses:
                _ = get_course_assignments_cached(c.id)

            # Precompute common summaries (real mode)
            if not MOCK_MODE:
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
