// src/pages/UpcomingAssignments.jsx
import { useEffect, useMemo, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";

function fmtDue(dt) {
  if (!dt) return "No due date";
  const d = new Date(dt);
  return d.toLocaleString();
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

function isOverdue(assignment) {
  if (!assignment?.due_at) return false;
  const due = new Date(assignment.due_at);
  const now = new Date();
  // "missing work" heuristic: overdue + not submitted
  return due < now && !assignment.submitted;
}

export function UpcomingAssignments() {
  const [upcoming, setUpcoming] = useState([]);
  const [courses, setCourses] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  // We fetch courses too, so we can map course_id -> course name
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setErr(null);

    Promise.all([
      canvasApi.getUpcoming(40, { signal: ac.signal }),
      canvasApi.getCourses({ signal: ac.signal }),
    ])
      .then(([u, c]) => {
        setUpcoming(u || []);
        setCourses(c || []);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setErr(e);
      })
      .finally(() => setLoading(false));

    return () => ac.abort();
  }, []);

  const courseNameById = useMemo(() => {
    const map = new Map();
    for (const c of courses) map.set(c.id, c.name);
    return map;
  }, [courses]);

  // Sort: overdue first, then earliest due date
  const sortedUpcoming = useMemo(() => {
    const copy = [...upcoming];
    copy.sort((a, b) => {
      const ao = isOverdue(a) ? 1 : 0;
      const bo = isOverdue(b) ? 1 : 0;
      if (ao !== bo) return bo - ao; // overdue first
      const ad = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
      const bd = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
      return ad - bd;
    });
    return copy;
  }, [upcoming]);

  if (loading) return <Loading label="Loading upcoming assignments…" />;
  if (err) return <ErrorBox error={err} />;

  const overdueCount = sortedUpcoming.filter(isOverdue).length;

  return (
    <div className="stack">
      <div className="muted">
        Powered by <span className="mono">GET /api/upcoming</span> (and{" "}
        <span className="mono">GET /api/courses</span> for course names).
      </div>

      {overdueCount > 0 ? (
        <div className="dangerBadge">⚠ Overdue / missing: {overdueCount}</div>
      ) : null}

      {sortedUpcoming.length === 0 ? (
        <div className="muted">No upcoming assignments found.</div>
      ) : null}

      {sortedUpcoming.map((a) => {
        const courseName = courseNameById.get(a.course_id) || `Course ${a.course_id}`;
        const descText = stripHtml(a.description);
        const overdue = isOverdue(a);

        return (
          <Expandable
            key={`${a.course_id}-${a.id}`}
            title={a.name}
            subtitle={
              <span>
                <span className={overdue ? "dangerText" : undefined}>
                  {overdue ? "Overdue" : "Due"}: {fmtDue(a.due_at)}
                </span>
                {" • "}
                <span>{courseName}</span>
                {typeof a.points_possible === "number" ? (
                  <>
                    {" • "}
                    <span>Points: {a.points_possible}</span>
                  </>
                ) : null}
                {overdue ? (
                  <>
                    {" • "}
                    <span className="dangerText">Missing</span>
                  </>
                ) : null}
              </span>
            }
          >
            <div className="stack">
              {overdue ? <div className="dangerBadge">⚠ This assignment appears overdue / missing</div> : null}

              {a.html_url ? (
                <a className="btn" href={a.html_url} target="_blank" rel="noreferrer">
                  Open Assignment / Submission Page in Canvas
                </a>
              ) : null}

              {descText ? (
                <div>
                  <div className="h3">Description</div>
                  <div className="desc">{descText}</div>
                </div>
              ) : (
                <div className="muted">No description provided.</div>
              )}

              {/* Light extra info */}
              <div className={overdue ? "muted dangerMuted" : "muted"}>
                Submitted: <span className="mono">{a.submitted ? "true" : "false"}</span>
                {a.score != null ? (
                  <>
                    {" • "}Score: <span className="mono">{a.score}</span>
                  </>
                ) : null}
              </div>
            </div>
          </Expandable>
        );
      })}
    </div>
  );
}
