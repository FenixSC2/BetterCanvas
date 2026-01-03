# app.py
import os
import time
import logging
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone

import requests
from requests.adapters import HTTPAdapter, Retry
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dateutil import parser as dateparser
from dotenv import load_dotenv

load_dotenv()

# === Configuration ===
CANVAS_BASE_URL = os.getenv("CANVAS_BASE_URL", "https://northeastern.instructure.com/")
CANVAS_API_TOKEN = os.getenv("CANVAS_API_TOKEN", "your_token_here")

HEADERS = {
    "Authorization": f"Bearer {CANVAS_API_TOKEN}",
    "Accept": "application/json"
}

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
        return get_student_profile()
    except HTTPException as e:
        raise e
    except Exception as exc:
        logger.exception("Error fetching profile")
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/courses", response_model=List[Course])
def api_courses():
    try:
        return get_active_courses()
    except HTTPException as e:
        raise e
    except Exception as exc:
        logger.exception("Error fetching courses")
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/courses/{course_id}/assignments", response_model=List[Assignment])
def api_course_assignments(course_id: int, limit: Optional[int] = None):
    try:
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


# Run with: uvicorn app:app --reload --port 8000