from pydantic import BaseModel
from typing import Optional

# ----------------------------------
# Assignment Model
# ----------------------------------
class Assignment(BaseModel):
    course: str
    name: str
    due_at: Optional[str]
    points: Optional[float]
    priority_score: Optional[float] = None

# ----------------------------------
# Course Grade Model
# ----------------------------------
class CourseGrade(BaseModel):
    course_id: int
    course: str
    term: Optional[str]
    current_score: Optional[float]
    final_score: Optional[float]

# ----------------------------------
# Term GPA Model
# ----------------------------------
class TermGPA(BaseModel):
    term: str
    gpa: float
    courses_counted: int

# ----------------------------------
# Course Model
# ----------------------------------
class Course(BaseModel):
    id: int
    name: str
    enrollment_state: str | None
    term: str | None
    course_code: str | None

