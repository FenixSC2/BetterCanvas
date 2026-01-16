// src/pages/MyCourses.jsx
import { useMemo } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { useCachedAsync } from "../hooks/useCachedAsync";

function fmtDue(dt) {
  if (!dt) return "No due date";
  const d = new Date(dt);
  return d.toLocaleString();
}

function BulletRow({ parts }) {
  return (
    <span>
      {parts.map((p, idx) => (
        <span key={idx}>
          {idx > 0 ? " • " : ""}
          {p}
        </span>
      ))}
    </span>
  );
}

export function MyCourses() {
  // Cache key includes params so if you change them later, it won’t collide
  const state = useCachedAsync(
    "courses:summary:next=3:missing=10",
    async ({ signal }) => {
      const data = await canvasApi.getCourseSummaries(3, 10, { signal });
      return data || [];
    },
    { ttlMs: 2 * 60 * 1000 } // ~2 minutes feels right for courses/grades
  );

  const summaries = state.data ?? [];
  const loading = state.loading;
  const err = state.error;

  const sorted = useMemo(() => {
    const copy = [...summaries];
    copy.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return copy;
  }, [summaries]);

  // Important behavior change:
  // - If we have cached data, we do NOT show a full-page loading screen.
  // - We show cached content immediately (no flash), while it refreshes in background.
  if (loading && summaries.length === 0) return <Loading label="Loading course summaries…" />;
  if (err && summaries.length === 0) return <ErrorBox error={err} />;

  return (
    <div className="stack">
      <div className="muted">
        Powered by <span className="mono">GET /api/courses/summary</span>.
        {state.refreshing ? (
          <span className="muted" style={{ marginLeft: 10 }}>
            Refreshing…
          </span>
        ) : null}
      </div>

      {err ? <ErrorBox error={err} /> : null}

      {sorted.length === 0 ? <div className="muted">No active courses found.</div> : null}

      {sorted.map((c) => {
        const nextAsgs = c.next_assignments || [];
        const missing = c.missing || [];
        const missingCount = c.missing_count ?? 0;

        const subtitleParts = [];

        if (c.course_code) subtitleParts.push(<span key="code">Code: {c.course_code}</span>);

        if (c.current_grade || c.current_score != null) {
          subtitleParts.push(
            <span key="grade">
              Grade: {c.current_grade ?? "—"} ({c.current_score ?? "—"})
            </span>
          );
        }

        subtitleParts.push(
          <span key="missing" className={missingCount > 0 ? "dangerText" : undefined}>
            Missing: {missingCount}
          </span>
        );

        const subtitle = <BulletRow parts={subtitleParts} />;

        return (
          <Expandable key={c.id} title={c.name} subtitle={subtitle}>
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

              {missingCount > 0 ? <div className="dangerBadge">⚠ Missing work: {missingCount}</div> : null}

              <div>
                <div className="h3">Next assignments</div>
                {nextAsgs.length === 0 ? (
                  <div className="muted">No upcoming assignments returned.</div>
                ) : (
                  <ul className="list">
                    {nextAsgs.map((a) => (
                      <li key={a.id} className="listItem">
                        <div className="listMain">
                          <div className="listTitle">{a.name}</div>
                          <div className="muted">
                            Due: <span className="mono">{fmtDue(a.due_at)}</span>
                            {typeof a.points_possible === "number" ? ` • Points: ${a.points_possible}` : ""}
                            {a.submitted ? ` • Submitted` : ""}
                            {a.score != null ? ` • Score: ${a.score}` : ""}
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
                  {c.current_grade || c.current_score != null ? (
                    <>
                      Grade: <span className="mono">{c.current_grade ?? "—"}</span> • Score:{" "}
                      <span className="mono">{c.current_score ?? "—"}</span>
                    </>
                  ) : (
                    "No grade data returned yet."
                  )}
                </div>
              </div>

              <div>
                <div className="h3 dangerText">Missing work</div>
                <div className={missingCount > 0 ? "muted dangerMuted" : "muted"}>
                  Missing count: <span className="mono">{missingCount}</span>
                </div>

                {missing.length === 0 ? (
                  <div className="muted" style={{ marginTop: 8 }}>
                    No missing work detected.
                  </div>
                ) : (
                  <ul className="list" style={{ marginTop: 8 }}>
                    {missing.map((m) => (
                      <li key={m.assignment_id} className="listItem dangerItem">
                        <div className="listMain">
                          <div className="listTitle">{m.name}</div>
                          <div className="muted dangerMuted">
                            Due: <span className="mono">{fmtDue(m.due_at)}</span>
                            {typeof m.points_possible === "number" ? ` • Points: ${m.points_possible}` : ""}
                          </div>
                        </div>
                        {m.html_url ? (
                          <a className="link" href={m.html_url} target="_blank" rel="noreferrer">
                            View
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Expandable>
        );
      })}
    </div>
  );
}
