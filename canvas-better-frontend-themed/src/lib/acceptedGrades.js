// Shared store for "user accepted this graded-but-unsubmitted assignment's grade".
// Originally lived in UpcomingAssignments under "upcoming:acceptedGrades"; kept
// the same localStorage key so existing user state migrates seamlessly when the
// Accept-grade action moved over to the Grades tab.

const KEY = "upcoming:acceptedGrades";

export function acceptedGradeKey(courseId, assignmentId) {
  return `${courseId}:${assignmentId}`;
}

export function loadAcceptedGradeKeys() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export function persistAcceptedGradeKeys(set) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    // localStorage may be unavailable in some browser modes; silent fallback.
  }
}

export function markGradeAccepted(set, courseId, assignmentId) {
  const next = new Set(set);
  next.add(acceptedGradeKey(courseId, assignmentId));
  persistAcceptedGradeKeys(next);
  return next;
}
