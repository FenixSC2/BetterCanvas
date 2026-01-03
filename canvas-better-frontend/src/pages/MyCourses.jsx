import { useEffect, useMemo, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";

// Format due date nicely
function fmtDue(dt) {
  if (!dt) return "No due date";
  const d = new Date(dt);
  return d.toLocaleString();
}

export function MyCourses() {
  const [courses, setCourses] = useState([]);
  const [assignmentsByCourse, setAssignmentsByCourse] = useState({});
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  // Loads course list
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setErr(null);

    canvasApi
      .getCourses({ signal: ac.signal })
      .then((data) => setCourses(data || []))
      .catch((e) => {
        if (e.name !== "AbortError") setErr(e);
      })
      .finally(() => setLoading(false));

    return () => ac.abort();
  }, []);

  // For each course, load "next couple assignments"
  useEffect(() => {
    if (!courses.length) return;
    const ac = new AbortController();

    (async () => {
      const nextMap = {};
      for (const c of courses) {
        try {
          const a = await canvasApi.getCourseAssignments(c.id, 3, {
            signal: ac.signal,
          });
          nextMap[c.id] = a || [];
        } catch (e) {
          if (e.name === "AbortError") return;
          // If a course endpoint 403s (rare after active filter), show empty but don’t crash UI
          nextMap[c.id] = [];
        }
      }
      setAssignmentsByCourse(nextMap);
    })();

    return () => ac.abort();
  }, [courses]);

  const sortedCourses = useMemo(() => {
    const copy = [...courses];
    copy.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return copy;
  }, [courses]);

  if (loading) return <Loading label="Loading courses…" />;
  if (err) return <ErrorBox error={err} />;

  return (
    <div className="stack">
      <div className="muted">
        This tab uses <span className="mono">GET /api/courses</span> and per-course{" "}
        <span className="mono">GET /api/courses/:id/assignments?limit=3</span>.
      </div>

      {sortedCourses.length === 0 ? (
        <div className="muted">No active courses found.</div>
      ) : null}

      {sortedCourses.map((c) => {
        const nextAsgs = assignmentsByCourse[c.id] || [];
        return (
          <Expandable
            key={c.id}
            title={c.name}
            subtitle={[
              c.course_code ? `Code: ${c.course_code}` : null,
              c.term_id ? `Term: ${c.term_id}` : null,
            ]
              .filter(Boolean)
              .join(" • ")}
          >
            <div className="stack">
              <div className="rowWrap">
                {c.syllabus_url ? (
                  <a className="btn" href={c.syllabus_url} target="_blank" rel="noreferrer">
                    Syllabus
                  </a>
                ) : null}
                {c.html_url ? (
                  <a className="btn" href={c.html_url} target="_blank" rel="noreferrer">
                    Open Course in Canvas
                  </a>
                ) : null}
              </div>

              <div>
                <div className="h3">Next assignments</div>
                {nextAsgs.length === 0 ? (
                  <div className="muted">No upcoming assignments returned (or none have due dates).</div>
                ) : (
                  <ul className="list">
                    {nextAsgs.map((a) => (
                      <li key={a.id} className="listItem">
                        <div className="listMain">
                          <div className="listTitle">{a.name}</div>
                          <div className="muted">
                            Due: <span className="mono">{fmtDue(a.due_at)}</span>
                            {typeof a.points_possible === "number"
                              ? ` • Points: ${a.points_possible}`
                              : ""}
                          </div>
                        </div>
                        {a.html_url ? (
                          <a className="link" href={a.html_url} target="_blank" rel="noreferrer">
                            View
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <div className="h3">Current grade</div>
                <div className="muted">
                  Placeholder (next step). We’ll wire this in when we do grade aggregation.
                </div>
              </div>
            </div>
          </Expandable>
        );
      })}
    </div>
  );
}
