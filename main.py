from fastapi import FastAPI, Query
from dateutil import parser
from datetime import datetime
from typing import List
import canvas_client
print(f"DEBUG: canvas_client is being loaded from: {canvas_client.__file__}")

from canvas_client import (
    get_courses,
    get_upcoming_assignments,
    get_course_grades
)
from models import Assignment, CourseGrade, Course, TermGPA

app = FastAPI(title="Canvas Assignment Manager")


@app.get("/")
def root():
    return {
        "service": "Canvas Assignment Manager",
        "status": "running",
        "available_endpoints": [
            "/courses",
            "/assignments",
            "/grades"
        ],
        "docs": "/docs"
    }


# ----------------------------------
# REQUIRED FEATURE: ASSIGNMENTS
# ----------------------------------

@app.get("/assignments", response_model=List[Assignment])
def upcoming_assignments(
    sort: str = Query("soonest", enum=["soonest", "points", "mixed"]),
    alpha: float = 0.7,
    beta: float = 0.3
):
    courses = get_courses()
    course_lookup = {c["id"]: c["name"] for c in courses}

    events = get_upcoming_assignments()

    assignments = []
    now = datetime.utcnow()

    for e in events:
        if not e.get("assignment"):
            continue

        a = e["assignment"]
        due_at = a.get("due_at")

        days_until = (
            (parser.parse(due_at) - now).days
            if due_at else 999
        )

        points = a.get("points_possible") or 0

        priority = (
            alpha * (1 / (days_until + 1)) +
            beta * (points / 100)
        )

        assignments.append(
            Assignment(
                course=course_lookup.get(e["course_id"], "Unknown"),
                name=a["name"],
                due_at=due_at,
                points=points,
                priority_score=priority
            )
        )

    if sort == "soonest":
        assignments.sort(
            key=lambda x: x.due_at or ""
        )
    elif sort == "points":
        assignments.sort(
            key=lambda x: x.points or 0,
            reverse=True
        )
    elif sort == "mixed":
        assignments.sort(
            key=lambda x: x.priority_score or 0,
            reverse=True
        )

    return assignments


# ----------------------------------
# REQUIRED FEATURE: GRADES
# ----------------------------------

@app.get("/grades", response_model=List[CourseGrade])
def grades(term: str | None = None):
    courses = get_courses()
    results = []

    for c in courses:
        course_term_name = c.get("term", {}).get("name")
        if not course_term_name:
            continue

        if term.lower() not in course_term_name.lower():
            continue

        enrollments = get_course_grades(c["id"])

        for e in enrollments:
            if e["type"] != "StudentEnrollment":
                continue

            grades = e.get("grades", {})

            results.append(
                CourseGrade(
                    course_id=c["id"],
                    course=c["name"],
                    term=course_term_name,
                    current_score=grades.get("current_score"),
                    final_score=grades.get("final_score")
                )
            )

    return results

# ----------------------------------
# REQUIRED FEATURE: COURSES
# ----------------------------------

@app.get("/courses", response_model=List[Course])
def courses(term: str | None = None):
    print("🚀 API ROUTE HIT: Processing Course Data...")
    raw_courses = get_courses()
    results = []

    for c in raw_courses:
        # 1. Basic Data
        course_name = c.get("name", "Unknown Course")
        
        # 2. Get Term Name
        term_obj = c.get("term", {})
        course_term_name = term_obj.get("name", "Default Term")

        # 3. Get Enrollment State 
        # (Since we included 'enrollments', it's in a list)
        enrollments = c.get("enrollments", [])
        state = enrollments[0].get("enrollment_state") if enrollments else "unknown"

        # 4. Term Filter
        if term and term.lower() not in course_term_name.lower():
            continue

        results.append(
            Course(
                id=c.get("id"),
                name=course_name,
                enrollment_state=state,
                term=course_term_name,
                course_code=c.get("course_code")
            )
        )

    # Sort by Term descending
    results.sort(key=lambda x: x.term, reverse=True)
    
    print(f"✅ Final filtered count: {len(results)}")
    return results

# ----------------------------------
# TERM GPA CALCULATION
# ----------------------------------

@app.get("/gpa", response_model=TermGPA)
def term_gpa(term: str):
    print(f"DEBUG GPA: Calculating GPA for term: {term}")

    scores: list[float] = []
    matched_courses = 0

    courses = get_courses()
    print(f"DEBUG GPA: Total courses fetched: {len(courses)}")

    for c in courses:
        term_obj = c.get("term", {})
        course_term_name = term_obj.get("name")

        if not course_term_name:
            continue

        if term.lower() not in course_term_name.lower():
            continue

        matched_courses += 1
        print(f"DEBUG GPA: Course '{c['name']}' matched")

        enrollments = get_course_grades(c["id"])

        for e in enrollments:
            if e.get("type") != "StudentEnrollment":
                continue

            grades = e.get("grades", {})
            final_score = grades.get("final_score")
            current_score = grades.get("current_score")

            print(
                f"DEBUG GPA: Course '{c['name']}' "
                f"(final={final_score}, current={current_score})"
            )

            # Preferred: final → fallback: current
            score = None
            if isinstance(final_score, (int, float)):
                score = final_score
            elif isinstance(current_score, (int, float)):
                score = current_score

            if score is not None:
                scores.append(score)
                print(
                    f"DEBUG GPA: Using score {score} "
                    f"(final={final_score}, current={current_score})"
                )

    # GPA scale
    def score_to_gpa(score: float) -> float:
        if score >= 93: return 4.0
        if score >= 90: return 3.7
        if score >= 87: return 3.3
        if score >= 83: return 3.0
        if score >= 80: return 2.7
        if score >= 77: return 2.3
        if score >= 73: return 2.0
        if score >= 70: return 1.7
        if score >= 67: return 1.3
        if score >= 65: return 1.0
        return 0.0

    if not scores:
        print(f"DEBUG GPA: {matched_courses} matched, 0 with usable scores")
        return TermGPA(
            term=term,
            gpa=0.0,
            courses_counted=0
        )

    gpa_values = [score_to_gpa(s) for s in scores]
    avg_gpa = sum(gpa_values) / len(gpa_values)

    print(
        f"DEBUG GPA: matched={matched_courses}, "
        f"counted={len(gpa_values)}, avg_gpa={avg_gpa}"
    )

    return TermGPA(
        term=term,
        gpa=round(avg_gpa, 2),
        courses_counted=len(gpa_values)
    )