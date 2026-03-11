// src/pages/MyCourses.jsx
import { useEffect, useMemo, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { useCachedAsync } from "../hooks/useCachedAsync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

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

function clampBlankLines(text, maxBlankLines = 2) {
  // maxBlankLines=2 means: at most "\n\n\n" doesn't exist; collapse 3+ to 2
  const max = Math.max(1, maxBlankLines);
  const re = new RegExp(`\\n{${max + 1},}`, "g");
  return text.replace(re, "\n".repeat(max));
}

function htmlToPrettyText(html) {
  if (!html) return "";
  let s = String(html);

  // Common Canvas-ish formatting -> newlines
  s = s.replace(/&nbsp;/gi, " ");
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\/\s*p\s*>/gi, "\n\n");
  s = s.replace(/<\/\s*div\s*>/gi, "\n");
  s = s.replace(/<\/\s*li\s*>/gi, "\n");
  s = s.replace(/<\/\s*tr\s*>/gi, "\n");
  s = s.replace(/<\/\s*h[1-6]\s*>/gi, "\n\n");

  const tmp = document.createElement("div");
  tmp.innerHTML = s;
  let text = tmp.textContent || "";

  text = text.replace(/\r\n/g, "\n");
  text = clampBlankLines(text, 2);

  return text.trim();
}

function courseBaseUrl(course) {
  // Prefer Canvas-provided html_url (usually .../courses/<id>)
  const base = course?.html_url ? course.html_url.replace(/\/$/, "") : "";
  return base;
}

function syllabusUrl(course) {
  const base = courseBaseUrl(course);
  if (base) return `${base}/assignments/syllabus`;
  // fallback if backend provides something else (may be 404, but better than nothing)
  return course?.syllabus_url || "";
}

function modulesUrl(course) {
  const base = courseBaseUrl(course);
  return base ? `${base}/modules` : "";
}

function countUpcomingWithinDays(assignments, days = 10) {
  if (!Array.isArray(assignments) || assignments.length === 0) return 0;

  const now = Date.now();
  const end = now + days * 24 * 60 * 60 * 1000;

  let count = 0;
  for (const a of assignments) {
    const dueAt = a?.due_at ? new Date(a.due_at).getTime() : null;
    if (!dueAt) continue;
    if (dueAt < now || dueAt > end) continue;

    // If we know it's submitted, exclude from "upcoming"
    if (a?.submitted === true) continue;

    count += 1;
  }
  return count;
}

// Simple toggle switch component
function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation(); // don't toggle Expandable
        onChange(!checked);
      }}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className="toggle"
    >
      <span className={`toggleTrack ${checked ? "on" : "off"}`}>
        <span className={`toggleThumb ${checked ? "on" : ""}`} />
      </span>
    </button>
  );
}

// Three-state toggle for all/none/mixed states
function TriStateToggle({ state, onChange, label }) {
  // state can be: "all-on", "all-off", or "mixed"
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange();
      }}
      role="switch"
      aria-checked={state === "all-on" ? true : state === "all-off" ? false : "mixed"}
      aria-label={label}
      title={label}
      className="toggle"
    >
      <span className={`toggleTrack ${state === "all-on" ? "on" : state === "all-off" ? "off" : "mixed"}`}>
        <span className={`toggleThumb ${state === "all-on" ? "on" : state === "all-off" ? "off" : "mixed"}`} />
      </span>
    </button>
  );
}

export function MyCourses() {
  // grade visibility per-course, persisted in localStorage
  const COURSE_GRADE_VIS_KEY = "courses:gradeVisibilityById";

  const [gradeVisibleById, setGradeVisibleById] = useState(() => {
    try {
      const raw = localStorage.getItem(COURSE_GRADE_VIS_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        COURSE_GRADE_VIS_KEY,
        JSON.stringify(gradeVisibleById)
      );
    } catch {
      // ignore
    }
  }, [gradeVisibleById]);

  function isGradeVisible(courseId) {
    // default ON if not set
    const v = gradeVisibleById?.[String(courseId)];
    return v == null ? true : !!v;
  }

  function setGradeVisible(courseId, next) {
    setGradeVisibleById((prev) => ({
      ...(prev || {}),
      [String(courseId)]: !!next,
    }));
  }

  // Request more "next assignments" so we can count upcoming in next ~10 days
  const NEXT_N = 20;
  const MISSING_N = 10;

  const state = useCachedAsync(
    `courses:summary:next=${NEXT_N}:missing=${MISSING_N}`,
    async ({ signal }) => {
      const data = await canvasApi.getCourseSummaries(NEXT_N, MISSING_N, {
        signal,
      });
      return data || [];
    },
    { ttlMs: 2 * 60 * 1000 }
  );

  const summaries = state.data ?? [];
  const loading = state.loading;
  const err = state.error;

  const sorted = useMemo(() => {
    const copy = [...summaries];
    copy.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return copy;
  }, [summaries]);

  // Calculate master toggle state based on all courses
  const masterGradeState = useMemo(() => {
    if (sorted.length === 0) return "all-on"; // default when no courses

    let allOn = true;
    let allOff = true;

    for (const course of sorted) {
      const visible = isGradeVisible(course.id);
      if (visible) allOff = false;
      if (!visible) allOn = false;
    }

    if (allOn) return "all-on";
    if (allOff) return "all-off";
    return "mixed";
  }, [sorted, gradeVisibleById]);

  // Handle master toggle click
  function handleMasterToggle() {
    if (sorted.length === 0) return;

    let nextState;
    if (masterGradeState === "all-on") {
      nextState = false; // turn all off
    } else if (masterGradeState === "all-off") {
      nextState = true; // turn all on
    } else {
      // mixed → all off
      nextState = false;
    }

    const updates = {};
    for (const course of sorted) {
      updates[String(course.id)] = nextState;
    }
    setGradeVisibleById(updates);
  }

  if (loading && summaries.length === 0)
    return <Loading label="Loading course summaries…" />;
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

      {sorted.length > 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="row" style={{ alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <p className="text-sm font-semibold">Grade Visibility</p>
                <div className="muted" style={{ fontSize: "var(--fontSm)" }}>
                  {masterGradeState === "all-on" ? "All grades shown" :
                   masterGradeState === "all-off" ? "All grades hidden" :
                   "Some grades shown, some hidden"}
                </div>
              </div>
              <div className="toggleRow">
                <span className="muted">Show All Grades:</span>
                <TriStateToggle
                  state={masterGradeState}
                  onChange={handleMasterToggle}
                  label={
                    masterGradeState === "all-on" ? "Hide all grades" :
                    masterGradeState === "all-off" ? "Show all grades" :
                    "Set all grades visibility"
                  }
                />
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {err ? <ErrorBox error={err} /> : null}

      {sorted.length === 0 ? (
        <div className="muted">No active courses found.</div>
      ) : null}

      {sorted.map((c) => {
        const nextAsgs = c.next_assignments || [];
        const missing = c.missing || [];
        const missingCount = c.missing_count ?? 0;
        const showGrades = isGradeVisible(c.id);

        const upcomingCount = countUpcomingWithinDays(nextAsgs, 10);

        const subtitleParts = [];

        if (c.course_code)
          subtitleParts.push(<span key="code">Code: {c.course_code}</span>);

        if (showGrades && (c.current_grade || c.current_score != null)) {
          subtitleParts.push(
            <span key="grade">
              Grade: {c.current_grade ?? "—"} ({c.current_score ?? "—"})
            </span>
          );
        } else {
          subtitleParts.push(
            <span key="gradeHidden" className="muted">
              Grade: hidden
            </span>
          );
        }

        subtitleParts.push(
          <span
            key="missing"
            className={missingCount > 0 ? "dangerText" : undefined}
          >
            Missing: {missingCount}
          </span>
        );

        subtitleParts.push(
          <span
            key="upcoming"
            className={upcomingCount > 0 ? undefined : "muted"}
          >
            Upcoming (10d): {upcomingCount}
          </span>
        );

        const subtitle = <BulletRow parts={subtitleParts} />;

        const sylUrl = syllabusUrl(c);
        const modUrl = modulesUrl(c);
        const courseUrl = c.html_url || "";

        return (
          <Expandable
            key={c.id}
            title={c.name}
            subtitle={subtitle}
            right={
              <div className="toggleRow">
                <span className="muted">Show Grade: </span>
                <Toggle
                  checked={showGrades}
                  onChange={(v) => setGradeVisible(c.id, v)}
                  label={showGrades ? "Hide grade" : "Show grade"}
                />
              </div>
            }
          >
            <div className="stack">
              <div className="rowWrap">
                {sylUrl ? (
                  <Button variant="outline" size="sm" asChild><a href={sylUrl} target="_blank" rel="noreferrer">Syllabus</a></Button>
                ) : null}

                {modUrl ? (
                  <Button variant="outline" size="sm" asChild><a href={modUrl} target="_blank" rel="noreferrer">Modules</a></Button>
                ) : null}

                {courseUrl ? (
                  <Button variant="outline" size="sm" asChild><a href={courseUrl} target="_blank" rel="noreferrer">Open Course in Canvas</a></Button>
                ) : null}
              </div>

              {missingCount > 0 ? (
                <div className={missingCount > 0 ? "muted dangerMuted" : "muted"}>
                  <strong>
                    ⚠ Missing work: {missingCount}
                  </strong>
                </div>
              ) : null}

              <div>
                <div className="h3">Next assignments: </div>

                {nextAsgs.length === 0 ? (
                  <div className="muted">No upcoming assignments returned.</div>
                ) : (
                  <ul className="list listSpaced">
                    {nextAsgs.map((a) => {
                      const titleText = a?.name || "Untitled assignment";

                      const subtitleLine = (
                        <span className="muted">
                          Due: <span className="mono">{fmtDue(a.due_at)}</span>
                          {typeof a.points_possible === "number"
                            ? ` • Points: ${a.points_possible}`
                            : ""}
                          {a.submitted ? ` • Submitted` : ""}
                          {a.score != null ? ` • Score: ${a.score}` : ""}
                        </span>
                      );

                      const right = a.html_url ? (
                        <Button variant="outline" size="sm" asChild><a href={a.html_url} target="_blank" rel="noreferrer">Open in Canvas</a></Button>
                      ) : null;

                      return (
                        <li key={a.id} className="listItem">
                          <Expandable
                            title={titleText}
                            subtitle={subtitleLine}
                            right={right}
                          >
                            {a.description ? (
                              <div className="desc preserveWhitespace">
                                {htmlToPrettyText(a.description)}
                              </div>
                            ) : (
                              <div className="muted">
                                No description available.
                              </div>
                            )}
                          </Expandable>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div>
                <div className="h3">Current grade: </div>

                {showGrades ? (
                  <div className="muted">
                    {c.current_grade || c.current_score != null ? (
                      <>
                        Grade:{" "}
                        <span className="mono">{c.current_grade ?? "—"}</span> •
                        Score:{" "}
                        <span className="mono">{c.current_score ?? "—"}</span>
                      </>
                    ) : (
                      "No grade data returned yet."
                    )}
                  </div>
                ) : (
                  <span className="gradeHiddenPill">Grade data hidden</span>
                )}
              </div>

              <div>
                <div className="h3 dangerText">Missing work: </div>

                {missing.length === 0 ? (
                  <div className="muted" style={{ marginTop: 8 }}>
                    No missing work detected.
                  </div>
                ) : (
                  <ul
                    className="list listSpaced"
                  >
                    {missing.map((m) => {
                      const titleText = (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <span>{m.name || "Untitled assignment"}</span>
                          <Badge variant="destructive">Missing</Badge>
                        </span>
                      );

                      const subtitleLine = (
                        <span className="muted dangerMuted">
                          Due: <span className="mono">{fmtDue(m.due_at)}</span>
                          {typeof m.points_possible === "number"
                            ? ` • Points: ${m.points_possible}`
                            : ""}
                        </span>
                      );

                      const right = m.html_url ? (
                        <Button variant="outline" size="sm" asChild><a href={m.html_url} target="_blank" rel="noreferrer">Open in Canvas</a></Button>
                      ) : null;

                      return (
                        <li
                          key={m.assignment_id}
                          className="listItem dangerItem"
                        >
                          <Expandable
                            title={titleText}
                            subtitle={subtitleLine}
                            right={right}
                          >
                            {m.description ? (
                              <div className="desc preserveWhitespace">
                                {htmlToPrettyText(m.description)}
                              </div>
                            ) : (
                              <div className="muted dangerMuted">
                                No description available.
                              </div>
                            )}
                          </Expandable>
                        </li>
                      );
                    })}
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
