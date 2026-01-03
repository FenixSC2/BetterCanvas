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
  // very simple strip for display; keep raw HTML out of the UI for now
  return html.replace(/<[^>]*>/g, "").trim();
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

  if (loading) return <Loading label="Loading upcoming assignments…" />;
  if (err) return <ErrorBox error={err} />;

  return (
    <div className="stack">
      <div className="muted">
        Powered by <span className="mono">GET /api/upcoming</span> (and{" "}
        <span className="mono">GET /api/courses</span> for course names).
      </div>

      {upcoming.length === 0 ? <div className="muted">No upcoming assignments found.</div> : null}

      {upcoming.map((a) => {
        const courseName = courseNameById.get(a.course_id) || `Course ${a.course_id}`;
        const descText = stripHtml(a.description);

        return (
          <Expandable
            key={`${a.course_id}-${a.id}`}
            title={a.name}
            subtitle={`${courseName} • Due: ${fmtDue(a.due_at)}${
              typeof a.points_possible === "number" ? ` • Points: ${a.points_possible}` : ""
            }`}
          >
            <div className="stack">
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
            </div>
          </Expandable>
        );
      })}
    </div>
  );
}
