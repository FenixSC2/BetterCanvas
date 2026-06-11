// src/pages/MyInformation.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { WorkloadEstimateControl } from "../components/WorkloadEstimateControl";

import { useCachedAsync, clearCachedAsync } from "../hooks/useCachedAsync";
import { makeTodoId, createTodoItem, loadTodos } from "../lib/todoStore";
import { isDemoMode } from "../lib/storagePolicy";
import {
  loadAcceptedGradeKeys,
  acceptedGradeKey,
  hydrateAcceptedGradeKeysFromServer,
  markAssignmentCompletedLocal,
  markAssignmentCompletedRemote,
} from "../lib/acceptedGrades";
import { useAuth } from "../hooks/useAuth";
import { formatCourseTitle } from "../utils/courseUtils";
import {
  loadWidgetConfig,
  saveWidgetConfig,
  makeWidgetId,
  WIDGET_PRESETS,
} from "../lib/widgetConfig";

// desktop notifications
import {
  useDesktopNotifications,
  loadGradeThresholds,
  saveGradeThresholds,
} from "../hooks/useDesktopNotifications";
import {
  requestNotificationPermission,
  clearNotificationHistory,
  notifyOnce,
} from "../lib/notifications";

function fmtDue(dt) {
  if (!dt) return "No due date";
  const d = new Date(dt);
  return d.toLocaleString();
}

function GradeThresholdsPanel({ grades }) {
  const [thresholds, setThresholds] = useState(() => loadGradeThresholds());

  if (!Array.isArray(grades) || grades.length === 0) {
    return (
      <Expandable
        title="Grade-drop thresholds"
        subtitle={
          <span className="muted">No enrolled courses found</span>
        }
      >
        <div className="muted">
          No active courses were found. Check back once you are enrolled in courses.
        </div>
      </Expandable>
    );
  }

  const setThreshold = (courseId, raw) => {
    const next = { ...thresholds };
    const key = String(courseId);
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) {
      delete next[key];
    } else {
      next[key] = Math.max(0, Math.min(100, n));
    }
    setThresholds(next);
    saveGradeThresholds(next);
  };

  const activeCount = Object.keys(thresholds).length;

  return (
    <Expandable
      title="Grade-drop thresholds"
      subtitle={
        <span className="muted">
          {activeCount
            ? `${activeCount} threshold${activeCount === 1 ? "" : "s"} set`
            : "Notify me when a course grade drops below a target"}
        </span>
      }
    >
      <div className="stack">
        <div className="muted">
          You&apos;ll get a one-time notification when a course&apos;s current
          score crosses below your threshold. Leave blank to disable for that
          course.
        </div>
        <ul className="list listSpaced">
          {grades.map((g) => {
            const courseId = g.course_id ?? g.id;
            const key = String(courseId);
            const currentScore = Number(g.current_score);
            const shownGrade = g.display_grade ?? g.current_grade ?? null;
            const isEstimated = !!g.grade_is_estimated;
            return (
              <li key={key} className="rowWrap" style={{ alignItems: "center" }}>
                <div style={{ flex: "1 1 220px", minWidth: 180 }}>
                  <div style={{ fontWeight: 700 }}>
                    {formatCourseTitle(g.course_name) || `Course ${key}`}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Current:{" "}
                    <span className="mono">
                      {Number.isFinite(currentScore)
                        ? `${currentScore.toFixed(1)}%`
                        : "—"}
                    </span>
                    {shownGrade && (
                      <>
                        {" · "}
                        <span
                          className={`gradeBadge ${isEstimated ? "estimated" : "actual"}`}
                          title={isEstimated ? "Estimated from current score" : "Provided by Canvas"}
                        >
                          {shownGrade}
                          {isEstimated ? " (est.)" : ""}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <label
                  className="muted"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                  }}
                >
                  Threshold:
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    placeholder="—"
                    value={thresholds[key] ?? ""}
                    onChange={(e) => setThreshold(courseId, e.target.value)}
                    style={{ width: 80 }}
                  />
                  %
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </Expandable>
  );
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

function fmtPosted(dt) {
  if (!dt) return "Unknown time";
  const d = new Date(dt);
  return d.toLocaleString();
}

function firstLine(text) {
  if (!text) return "";
  const t = stripHtml(text);
  const line =
    t
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean) || "";
  return line.length > 140 ? line.slice(0, 140) + "…" : line;
}

function htmlToPrettyText(html) {
  if (!html) return "";
  let s = String(html);
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
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function greetingBucketFor(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return "lateNight";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

const TIME_BUCKET_GREETINGS = {
  lateNight: [
    "Still up",
    "Burning the midnight oil",
    "Night owl",
    "Running late-night mode",
  ],
  morning: [
    "Good morning",
    "Rise and shine",
    "Top of the morning",
    "Morning sunshine",
  ],
  afternoon: [
    "Good afternoon",
    "Hey",
    "Whats up",
    "Hope your day is going well",
  ],
  evening: [
    "Good evening",
    "Hows your evening going",
    "Evening vibes",
    "Nice to see you again",
  ],
  night: [
    "Late night",
    "Back at it tonight",
    "One more session",
    "Quiet-hours grind",
  ],
};

const ANYTIME_GREETINGS = [
  "Welcome back",
  "Good to see you",
  "You got this",
  "Lets do this",
  "Back in the zone",
  "Ready when you are",
  "Lets make some progress",
];

function greetingOptionsFor(d = new Date()) {
  const bucket = greetingBucketFor(d);
  const timeBased = TIME_BUCKET_GREETINGS[bucket] || [];
  return [...timeBased, ...ANYTIME_GREETINGS];
}

function pickRandomWithoutRepeat(options, lastValue = "") {
  if (!Array.isArray(options) || options.length === 0) return "Welcome back";
  if (options.length === 1) return options[0];

  let pick = options[Math.floor(Math.random() * options.length)];
  let guard = 0;
  while (pick === lastValue && guard < 10) {
    pick = options[Math.floor(Math.random() * options.length)];
    guard += 1;
  }
  return pick;
}

function datelineFor(d = new Date()) {
  try {
    const date = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${date} · ${time}`;
  } catch {
    return d.toDateString();
  }
}

function firstNameOf(p) {
  if (!p) return "there";
  const src = (p.short_name || p.name || "").trim();
  if (!src) return "there";
  return src.split(/\s+/)[0];
}

function avatarInitialOf(p) {
  const src = (p?.short_name || p?.name || "").trim();
  if (!src) return "S";
  return src.charAt(0).toUpperCase();
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}


function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
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

// ===== Hero widget sub-components =====

function gradeBadgeColor(grade) {
  if (!grade) return "";
  const s = String(grade).trim();
  if (!s || s === "—") return "";
  const first = s.charAt(0).toUpperCase();
  if (first === "A") return "good";
  if (first === "B") return "ok";
  return "concern";
}

function widgetSizeClass(config) {
  if (config?.size === "sm") return " heroWidgetSm";
  if (config?.size === "lg") return " heroWidgetLg";
  return "";
}

const HERO_GRADES_VISIBLE_KEY = "heroWidget:gradesVisible";

function GradesSnapshotWidget({ config, overview, loading, gradesVisible, onToggleGrades }) {
  const grades = overview?.grades ?? [];
  const max = config.maxCourses ? Number(config.maxCourses) : null;
  const displayed = max ? grades.slice(0, max) : grades;

  return (
    <div className={`heroWidget heroWidgetGrades${widgetSizeClass(config)}`}>
      <div className="heroWidgetHeader">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="heroWidgetLabel">Grades</span>
          {config.showGpa !== false && overview?.gpa != null && !loading && gradesVisible && (
            <span className="gradesGpaInline">GPA {Number(overview.gpa).toFixed(2)}</span>
          )}
        </div>
        <Toggle
          checked={gradesVisible}
          onChange={onToggleGrades}
          label={gradesVisible ? "Hide grade values" : "Show grade values"}
        />
      </div>
      {loading ? (
        <div className="muted" style={{ fontSize: 12 }}>Loading…</div>
      ) : !displayed.length ? (
        <div className="muted" style={{ fontSize: 12 }}>No courses found</div>
      ) : (
        <div className="gradeSnapshotList">
          {displayed.map((g) => {
            const title = formatCourseTitle(g.course_name) || `Course ${g.course_id}`;
            const isEst = !!g.grade_is_estimated;
            return (
              <div key={g.course_id} className="gradeSnapshotRow">
                <span className="gradeSnapshotName">{title}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  {gradesVisible ? (
                    <>
                      {config.showScore && g.current_score != null && (
                        <span className="muted" style={{ fontSize: 11, letterSpacing: "-0.01em" }}>
                          {Number(g.current_score).toFixed(1)}%
                        </span>
                      )}
                      <span className={`gradeBadge ${isEst ? "estimated" : "actual"} ${gradeBadgeColor(g.display_grade ?? g.current_grade)}`}>
                        {g.display_grade ?? g.current_grade ?? "—"}
                      </span>
                    </>
                  ) : (
                    <span className="gradeSnapshotHidden" aria-label="Grade hidden">••••</span>
                  )}
                </div>
              </div>
            );
          })}
          {max && grades.length > max && (
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              +{grades.length - max} more course{grades.length - max === 1 ? "" : "s"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TodayRingWidget({ config, missingCount, canvasDue24Count }) {
  const r = 18, cx = 25, cy = 25, sw = 5;
  const C = 2 * Math.PI * r;
  const total = missingCount + canvasDue24Count;
  const missingFrac = total === 0 ? 0 : missingCount / total;
  const dueFrac = total === 0 ? 0 : canvasDue24Count / total;
  const s1 = missingFrac * C;
  const s2 = dueFrac * C;

  return (
    <div className={`heroWidget heroWidgetRing${widgetSizeClass(config)}`}>
      <div className="heroWidgetLabel">Today</div>
      <div className="ringWrapper">
        <svg viewBox="0 0 50 50" className="workloadRing" aria-hidden="true">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-strong)" strokeWidth={sw} />
          {total === 0 ? (
            <circle cx={cx} cy={cy} r={r} fill="none"
              stroke="var(--success-color, #22c55e)" strokeWidth={sw}
              strokeDasharray={`${C} 0`}
              transform={`rotate(-90 ${cx} ${cy})`}
              strokeLinecap="round"
              className="ringAllClear" />
          ) : (
            <>
              {missingFrac > 0 && (
                <circle cx={cx} cy={cy} r={r} fill="none"
                  stroke="#ef4444" strokeWidth={sw}
                  strokeDasharray={`${s1} ${C}`}
                  transform={`rotate(-90 ${cx} ${cy})`} />
              )}
              {dueFrac > 0 && (
                <circle cx={cx} cy={cy} r={r} fill="none"
                  stroke="#f59e0b" strokeWidth={sw}
                  strokeDasharray={`${s2} ${C}`}
                  transform={`rotate(${-90 + missingFrac * 360} ${cx} ${cy})`} />
              )}
            </>
          )}
        </svg>
        <div className="ringCenter">
          <span className="ringCount">{total}</span>
          <span className="ringCountLabel">items</span>
        </div>
      </div>
      {config.showLegend !== false && (
        <div className="ringLegend">
          {missingCount > 0 && (
            <span className="ringLegendItem" style={{ color: "#ef4444" }}>
              <span className="ringLegendDot" style={{ background: "#ef4444" }} />
              {missingCount} missing
            </span>
          )}
          {canvasDue24Count > 0 && (
            <span className="ringLegendItem" style={{ color: "#f59e0b" }}>
              <span className="ringLegendDot" style={{ background: "#f59e0b" }} />
              {canvasDue24Count} due soon
            </span>
          )}
          {total === 0 && (
            <span className="ringLegendItem" style={{ color: "var(--muted)" }}>
              All clear
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function QuickStatsWidget({ config, missingCount, canvasDue24Count, gpa, todosDue24h, overviewLoading, gradesVisible }) {
  const showGpa = config.showGpa !== false && gpa != null;
  const gpaNum = showGpa ? Math.max(0, Math.min(4.0, Number(gpa))) : 0;

  // Full circle ring gauge (same technique as Today ring — no endpoint artifacts)
  const r = 14, cx = 20, cy = 20, sw = 4;
  const C = 2 * Math.PI * r;
  const gpaFill = (gpaNum / 4.0) * C;
  const gpaGap = C - gpaFill;
  const gpaColor = gpaNum >= 3.5 ? "#22c55e" : gpaNum >= 2.5 ? "var(--accent)" : "#ef4444";

  const stats = [];
  if (config.showMissing !== false)
    stats.push({
      value: missingCount,
      label: "Missing",
      dotColor: missingCount > 0 ? "#ef4444" : "var(--border-strong)",
      valueColor: missingCount > 0 ? "#ef4444" : undefined,
    });
  if (config.showDueSoon !== false)
    stats.push({
      value: canvasDue24Count,
      label: "Due soon",
      dotColor: canvasDue24Count > 0 ? "#f59e0b" : "var(--border-strong)",
      valueColor: canvasDue24Count > 0 ? "#f59e0b" : undefined,
    });
  if (config.showTodos !== false)
    stats.push({
      value: todosDue24h.length,
      label: "Todos due",
      dotColor: todosDue24h.length > 0 ? "var(--accent)" : "var(--border-strong)",
    });

  const hasContent = showGpa || stats.length > 0;

  return (
    <div className={`heroWidget heroWidgetQuickStats${widgetSizeClass(config)}`}>
      <div className="heroWidgetLabel">Quick Stats</div>
      {overviewLoading ? (
        <div className="muted" style={{ fontSize: 12 }}>Loading…</div>
      ) : !hasContent ? (
        <div className="muted" style={{ fontSize: 12 }}>No stats selected</div>
      ) : (
        <div className="quickStatsBody">
          {showGpa && (
            <div className="ringWrapper" style={{ width: 80, height: 80, flexShrink: 0 }}>
              <svg viewBox="0 0 40 40" style={{ width: 80, height: 80 }}
                aria-label={`GPA ${gpaNum.toFixed(2)} out of 4.0`} role="img">
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-strong)" strokeWidth={sw} />
                <circle cx={cx} cy={cy} r={r} fill="none"
                  stroke={gpaColor}
                  strokeWidth={sw}
                  strokeDasharray={`${gpaFill} ${gpaGap}`}
                  transform={`rotate(-90 ${cx} ${cy})`}
                  strokeLinecap="round" />
              </svg>
              <div className="ringCenter">
                {gradesVisible ? (
                  <span className="gpaRingNumber">{Number(gpa).toFixed(2)}</span>
                ) : (
                  <span className="gpaRingNumber" style={{ fontSize: 9, letterSpacing: "0.12em" }}>••••</span>
                )}
                <span className="ringCountLabel">GPA</span>
              </div>
            </div>
          )}
          {stats.length > 0 && (
            <ul className="quickStatsList">
              {stats.map((s) => (
                <li key={s.label} className="quickStatsRow">
                  <span className="quickStatsDot" style={{ background: s.dotColor }} />
                  <span className="quickStatsValue" style={{ color: s.valueColor }}>{s.value}</span>
                  <span className="quickStatsLabel">{s.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ===== Content widget shell components =====

function WidgetShell({ label, subtitle, badge, badgeVariant = "new", open, onToggle, danger, warning, right, children }) {
  return (
    <div className={`heroWidget heroWidgetContent${open ? " widgetOpen" : ""}${danger ? " heroWidgetDanger" : ""}${warning ? " heroWidgetWarning" : ""}`}>
      <button
        type="button"
        className="widgetToggleHeader"
        onClick={onToggle}
        aria-expanded={open}
      >
        <div className="widgetToggleLeft">
          <span className="heroWidgetLabel">{label}</span>
          {badge != null && badge > 0 && (
            <span className={`widgetCountBadge ${badgeVariant}`}>{badge}</span>
          )}
          {subtitle && <span className="widgetToggleSubtitle">{subtitle}</span>}
        </div>
        <div className="widgetToggleRight">
          {right}
          <svg className={`widgetChevron${open ? " open" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="widgetContentBody">{children}</div>
      )}
    </div>
  );
}

function CollapsibleWidget({ storageKey, label, subtitle, badge, badgeVariant, defaultOpen = false, danger, warning, right, children }) {
  const [open, setOpen] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === null ? defaultOpen : raw === "true";
    } catch { return defaultOpen; }
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, String(open)); } catch {}
  }, [open, storageKey]);

  return (
    <WidgetShell
      label={label}
      subtitle={subtitle}
      badge={badge}
      badgeVariant={badgeVariant}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      danger={danger}
      warning={warning}
      right={right}
    >
      {children}
    </WidgetShell>
  );
}

function DueSoonWidget({ overview, overviewLoading, overviewErr, due24Count, todosDue24h }) {
  const subtitle = overviewLoading
    ? "Loading…"
    : due24Count > 0
    ? `${due24Count} item${due24Count === 1 ? "" : "s"} due in 24 hours`
    : "Nothing due soon";

  return (
    <CollapsibleWidget
      storageKey="widget:due_soon:open"
      label="Due Soon"
      subtitle={subtitle}
      badge={due24Count > 0 ? due24Count : null}
      badgeVariant="warn"
      warning={due24Count > 0}
    >
      {overviewErr ? (
        <ErrorBox error={overviewErr} />
      ) : overviewLoading ? (
        <Loading label="Loading assignments due soon…" />
      ) : due24Count === 0 ? (
        <div className="muted">No assignments due in the next 24 hours that are incomplete.</div>
      ) : (
        <ul className="list">
          {(overview?.due_next_24h || []).map((a) => {
            const titleText = a?.name || "Untitled assignment";
            const itemSubtitle = (
              <span className="muted" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {a.course_name ? <span className="mono">{formatCourseTitle(a.course_name)}</span> : null}
                <span>
                  Due: <span className="mono">{fmtDue(a.due_at)}</span>
                  {typeof a.points_possible === "number" ? ` • Points: ${a.points_possible}` : ""}
                </span>
              </span>
            );
            const right = (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {a.html_url ? (
                  <a className="btn" href={a.html_url} target="_blank" rel="noreferrer">Open in Canvas</a>
                ) : null}
                <WorkloadEstimateControl courseId={a.course_id} assignmentId={a.assignment_id} compactLabels={true} />
              </div>
            );
            return (
              <li key={`${a.course_id}-${a.assignment_id}`} className="listItem">
                <Expandable title={titleText} subtitle={itemSubtitle} right={right}>
                  {a.description ? (
                    <div className="desc preserveWhitespace">{htmlToPrettyText(a.description)}</div>
                  ) : (
                    <div className="muted">No description available.</div>
                  )}
                </Expandable>
              </li>
            );
          })}
          {todosDue24h.map((t) => {
            const itemSubtitle = (
              <span className="muted">
                <span className="mono">TO-DO</span>{" • "}Due: <span className="mono">{fmtDue(t.due_at)}</span>
              </span>
            );
            const right = (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => window.dispatchEvent(new CustomEvent("canvasbetter:navigate", { detail: { tab: "todo" } }))}
                >
                  View to-do
                </button>
                <WorkloadEstimateControl courseId="todo" assignmentId={t.id} compactLabels={true} />
              </div>
            );
            return (
              <li key={`todo-${t.id}`} className="listItem">
                <Expandable title={t.title || "Untitled to-do"} subtitle={itemSubtitle} right={right}>
                  {t.description ? (
                    <div className="desc preserveWhitespace">{t.description}</div>
                  ) : (
                    <div className="muted">No description.</div>
                  )}
                </Expandable>
              </li>
            );
          })}
        </ul>
      )}
    </CollapsibleWidget>
  );
}

function MissingWorkWidget({ overviewLoading, overviewErr, missingCount, filteredMissingItems, markCompleted }) {
  const subtitle = overviewLoading
    ? "Loading…"
    : missingCount > 0
    ? `${missingCount} missing across all courses`
    : "None detected";

  return (
    <CollapsibleWidget
      storageKey="widget:missing_work:open"
      label="Missing Work"
      subtitle={subtitle}
      badge={missingCount > 0 ? missingCount : null}
      badgeVariant="danger"
      danger={missingCount > 0}
    >
      {overviewErr ? (
        <ErrorBox error={overviewErr} />
      ) : overviewLoading ? (
        <Loading label="Loading missing work…" />
      ) : missingCount === 0 ? (
        <div className="muted">No missing work detected across your active courses.</div>
      ) : (
        <ul className="list">
          {filteredMissingItems.map((m) => {
            const titleText = (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {m?.name || "Untitled assignment"}
                <span className="badge badgeDanger">Missing</span>
              </span>
            );
            const itemSubtitle = (
              <span className="muted dangerMuted" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="mono">{formatCourseTitle(m.course_name) ?? `Course ${m.course_id}`}</span>
                <span>
                  Due: <span className="mono">{fmtDue(m.due_at)}</span>
                  {typeof m.points_possible === "number" ? ` • Points: ${m.points_possible}` : ""}
                </span>
              </span>
            );
            const right = (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {m.html_url ? (
                  <a className="btn" href={m.html_url} target="_blank" rel="noreferrer">Open in Canvas</a>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  onClick={() => void markCompleted(m.course_id, m.assignment_id)}
                  title="Mark completed and stop showing this as missing"
                >
                  Mark completed
                </button>
                <WorkloadEstimateControl courseId={m.course_id} assignmentId={m.assignment_id} compactLabels={true} />
              </div>
            );
            return (
              <li key={`${m.course_id}-${m.assignment_id}`} className="listItem dangerItem">
                <Expandable title={titleText} subtitle={itemSubtitle} right={right}>
                  {m.description ? (
                    <div className="desc preserveWhitespace">{htmlToPrettyText(m.description)}</div>
                  ) : (
                    <div className="muted dangerMuted">No description available.</div>
                  )}
                </Expandable>
              </li>
            );
          })}
        </ul>
      )}
    </CollapsibleWidget>
  );
}

function AnnouncementsWidget({
  announcements, annLoading, annErr,
  seenIds, demoMode, lastSeenIdFromDb,
  markAnnouncementSeen, markAllAnnouncementsSeen, newAnnouncementCount,
}) {
  const [open, setOpen] = useState(() => {
    try {
      const raw = localStorage.getItem("widget:announcements:open");
      return raw === null ? false : raw === "true";
    } catch { return false; }
  });
  const [todoFormById, setTodoFormById] = useState({});
  const [addedAnnouncementIds, setAddedAnnouncementIds] = useState(() => {
    const todos = loadTodos();
    const ids = new Set();
    for (const t of todos) {
      if (t.source?.startsWith("announcement:")) {
        ids.add(t.source.slice("announcement:".length));
      }
    }
    return ids;
  });

  useEffect(() => {
    function onTodosChanged() {
      const todos = loadTodos();
      const ids = new Set();
      for (const t of todos) {
        if (t.source?.startsWith("announcement:")) {
          ids.add(t.source.slice("announcement:".length));
        }
      }
      setAddedAnnouncementIds(ids);
    }
    window.addEventListener("canvassist:todos:changed", onTodosChanged);
    return () => window.removeEventListener("canvassist:todos:changed", onTodosChanged);
  }, []);

  /* oxlint-disable react-doctor/no-event-handler */
  useEffect(() => {
    if (open && announcements?.length) markAllAnnouncementsSeen();
  }, [announcements, open]); // oxlint-disable-line react-doctor/exhaustive-deps
  /* oxlint-enable react-doctor/no-event-handler */

  function handleToggle() {
    const nextOpen = !open;
    if (nextOpen) markAllAnnouncementsSeen();
    setOpen(nextOpen);
    try { localStorage.setItem("widget:announcements:open", String(nextOpen)); } catch {}
  }

  const subtitle = annLoading
    ? "Loading…"
    : announcements?.length
    ? `${announcements.length} recent`
    : "None found";

  return (
    <WidgetShell
      label="Announcements"
      subtitle={subtitle}
      badge={newAnnouncementCount > 0 ? newAnnouncementCount : null}
      badgeVariant="new"
      open={open}
      onToggle={handleToggle}
    >
      {annErr ? <ErrorBox error={annErr} /> : null}
      {annLoading ? (
        <Loading label="Loading announcements…" />
      ) : !announcements?.length ? (
        <div className="muted">No recent announcements.</div>
      ) : (
        <>
          <ul className="list">
            {announcements.map((a) => {
              const isNew = demoMode
                ? (a?.id && !seenIds.has(a.id))
                : (a?.id && a.id > lastSeenIdFromDb);
              const titleText = a?.title || "Untitled announcement";
              const todoForm = todoFormById[a.id] || {};

              const itemSubtitle = (
                <span className="muted">
                  {a.course_name ? <span className="mono">{formatCourseTitle(a.course_name)}</span> : null}
                  {a.course_name ? " • " : ""}
                  Posted: <span className="mono">{fmtPosted(a.posted_at)}</span>
                  {isNew ? (
                    <>{" • "}<span className="mono" style={{ padding: "1px 6px", borderRadius: 999, fontWeight: 700, background: "rgba(0, 200, 0, 0.15)", color: "rgb(0, 120, 0)" }}>NEW</span></>
                  ) : null}
                  {a.message ? <>{" • "}Preview: <span className="mono">{firstLine(a.message)}</span></> : null}
                </span>
              );

              const right = (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {a.html_url ? (
                      <a className="btn" href={a.html_url} target="_blank" rel="noreferrer"
                        onClick={() => markAnnouncementSeen(a.id)} title="Open in Canvas">
                        View in Canvas
                      </a>
                    ) : null}
                    {addedAnnouncementIds.has(String(a.id)) ? (
                      <span className="badge badgeSuccess">Added to To-Do</span>
                    ) : todoForm.status === "added" ? (
                      <span className="badge badgeSuccess">Added!</span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setTodoFormById((prev) => ({
                            ...prev,
                            [a.id]: prev[a.id]?.open ? {} : { open: true, date: "" },
                          }));
                        }}
                        title="Add this announcement as a to-do item"
                      >
                        {todoForm.open ? "Cancel" : "Add to To-Do"}
                      </button>
                    )}
                  </div>
                  {todoForm.open ? (
                    <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end" }}>
                      <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        Due date:
                        <input
                          type="date"
                          value={todoForm.date || ""}
                          onChange={(e) => setTodoFormById((prev) => ({ ...prev, [a.id]: { ...prev[a.id], date: e.target.value } }))}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn"
                        disabled={!todoForm.date}
                        onClick={async (e) => {
                          e.stopPropagation();
                          const dueAt = todoForm.date ? new Date(todoForm.date + "T00:00:00").toISOString() : null;
                          const newTodo = {
                            id: makeTodoId(),
                            title: a.title || "Untitled announcement",
                            notes: stripHtml(a.message || "").slice(0, 300),
                            due_at: dueAt,
                            completed: false,
                            recurrence: "none",
                            series_id: null,
                            occurrence_index: 0,
                            anchor_due_at: dueAt,
                            workload_reset_mode: "none",
                            source: `announcement:${a.id}`,
                            createdAt: new Date().toISOString(),
                          };
                          try {
                            await createTodoItem(newTodo);
                            setTodoFormById((prev) => ({ ...prev, [a.id]: { status: "added" } }));
                            setTimeout(() => {
                              setTodoFormById((prev) => {
                                const next = { ...prev };
                                delete next[a.id];
                                return next;
                              });
                            }, 2500);
                          } catch { /* ignore */ }
                        }}
                      >
                        Add
                      </button>
                    </div>
                  ) : null}
                </div>
              );

              return (
                <li key={a.id} className="listItem">
                  <Expandable
                    title={titleText}
                    subtitle={itemSubtitle}
                    right={right}
                    onOpen={() => markAnnouncementSeen(a.id)}
                  >
                    {a.message ? (
                      <div className="desc preserveWhitespace">{htmlToPrettyText(a.message)}</div>
                    ) : (
                      <div className="muted">No message body provided.</div>
                    )}
                  </Expandable>
                </li>
              );
            })}
          </ul>
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Refreshes every ~3 minutes while this tab is open.
          </div>
        </>
      )}
    </WidgetShell>
  );
}

function GradeOverviewWidget({ config, overview, gpa, overviewLoading, overviewErr }) {
  const SHOW_GPA_KEY = "myinfo:showGpaInCollapsed";
  const [showGpa, setShowGpa] = useState(() => {
    if (config.showGpa === false) return false;
    try {
      const raw = localStorage.getItem(SHOW_GPA_KEY);
      return raw == null ? true : raw === "true";
    } catch { return true; }
  });

  useEffect(() => {
    try { localStorage.setItem(SHOW_GPA_KEY, String(showGpa)); } catch {}
  }, [showGpa]);

  const gpaInfoBtnRef = useRef(null);
  const [gpaInfoOpen, setGpaInfoOpen] = useState(false);
  const [gpaInfoPos, setGpaInfoPos] = useState({ top: 0, left: 0 });

  function openGpaInfo() {
    const rect = gpaInfoBtnRef.current?.getBoundingClientRect();
    if (rect) setGpaInfoPos({ top: rect.top + rect.height / 2, left: rect.right + 10 });
    setGpaInfoOpen(true);
  }

  const subtitle = overviewLoading
    ? "Loading…"
    : showGpa && gpa != null
    ? `GPA: ${gpa}`
    : overview?.grades?.length
    ? `${overview.grades.length} course${overview.grades.length === 1 ? "" : "s"}`
    : "No courses found";

  const headerRight = (
    <div className="toggleRow" style={{ marginRight: 4 }}>
      <span className="muted" style={{ fontSize: 12 }}>GPA</span>
      <Toggle
        checked={showGpa}
        onChange={setShowGpa}
        label={showGpa ? "Hide GPA" : "Show GPA"}
      />
    </div>
  );

  return (
    <CollapsibleWidget
      storageKey="widget:grade_overview:open"
      label="Grade Overview"
      subtitle={subtitle}
      right={headerRight}
    >
      {overviewErr ? (
        <ErrorBox error={overviewErr} />
      ) : overviewLoading ? (
        <Loading label="Loading grades…" />
      ) : !overview?.grades?.length ? (
        <div className="muted">No active courses found.</div>
      ) : (
        <>
          {showGpa && gpa != null && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
              <span className="muted">Running GPA:</span>
              <span className="mono" style={{ fontWeight: 600 }}>{gpa}</span>
              <button
                ref={gpaInfoBtnRef}
                type="button"
                className="authInfoBubble authInfoBubbleInfo"
                aria-label="GPA scope: current semester only"
                onMouseEnter={openGpaInfo}
                onMouseLeave={() => setGpaInfoOpen(false)}
                onFocus={openGpaInfo}
                onBlur={() => setGpaInfoOpen(false)}
                style={{ width: 18, height: 18, fontSize: 12, fontWeight: 700, flexShrink: 0 }}
              >
                i
              </button>
              {gpaInfoOpen && createPortal(
                <div className="gpaInfoTooltip" style={{ top: gpaInfoPos.top, left: gpaInfoPos.left }}>
                  This GPA is calculated from your current semester courses only.
                </div>,
                document.body
              )}
            </div>
          )}
          <ul className="list">
            {overview.grades.map((g) => {
              const shownGrade = g.display_grade ?? g.current_grade ?? "—";
              const isEstimated = !!g.grade_is_estimated;
              const titleText = formatCourseTitle(g.course_name) || "Untitled course";
              const itemSubtitle = (
                <span className="muted">
                  Grade:{" "}
                  <span
                    className={`gradeBadge ${isEstimated ? "estimated" : "actual"}`}
                    title={isEstimated ? "Estimated from current score" : "Provided by Canvas"}
                  >
                    {shownGrade}{isEstimated ? " (est.)" : ""}
                  </span>
                  {" • "}Score: <span className="mono">{g.current_score ?? "—"}</span>
                  {g.course_code ? <>{" • "}<span className="mono">{g.course_code}</span></> : null}
                </span>
              );
              return (
                <li key={g.course_id} className="listItem">
                  <Expandable title={titleText} subtitle={itemSubtitle} variant="embedded">
                    <div className="stack" style={{ gap: 8 }}>
                      <div className="muted">Course ID: <span className="mono">{g.course_id}</span></div>
                      <div className="rowWrap" style={{ gap: 10 }}>
                        <div className="muted">Display grade: <span className="mono">{g.display_grade ?? "—"}</span></div>
                        <div className="muted">Current grade: <span className="mono">{g.current_grade ?? "—"}</span></div>
                        <div className="muted">Current score: <span className="mono">{g.current_score ?? "—"}</span></div>
                      </div>
                      <div className="muted">Status: <span className="mono">{isEstimated ? "Estimated" : "Actual"}</span></div>
                    </div>
                  </Expandable>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </CollapsibleWidget>
  );
}

function NotificationsWidget({ notif, overview, isSecureContext, notificationsOn, handleEnableNotifications, handleDisableNotifications }) {
  return (
    <CollapsibleWidget
      storageKey="widget:notifications:open"
      label="Notifications"
      subtitle={notificationsOn ? "Enabled" : "Disabled"}
    >
      {!notif.supported ? (
        <div className="muted">Your browser doesn&apos;t support desktop notifications.</div>
      ) : (
        <div className="stack">
          <div className="muted">
            Permission: <span className="mono">{notif.permission}</span>
            {" • "}
            Notifications: <span className="mono">{notificationsOn ? "ON" : "OFF"}</span>
          </div>
          <div className="rowWrap" style={{ gap: 10 }}>
            {notificationsOn ? (
              <button type="button" className="btn" onClick={handleDisableNotifications}>
                Disable notifications
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={handleEnableNotifications}
                disabled={notif.permission === "denied"}
                title={notif.permission === "denied" ? "Notifications are blocked in browser settings" : "Enable and run checks while this tab is open"}
              >
                Enable notifications
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => clearNotificationHistory()}
              title="Allows alerts to fire again for the same assignments"
            >
              Reset alerts
            </button>
            <button
              type="button"
              className="btn"
              disabled={notif.permission !== "granted"}
              onClick={() => notifyOnce({
                dedupeKey: `notifications:test:${Date.now()}`,
                title: "Test notification",
                body: "If you can see this, notifications are working.",
                url: window.location.href,
                cooldownMs: 0,
              })}
              title={notif.permission !== "granted" ? "Grant permission first" : "Send a test notification"}
            >
              Send test
            </button>
          </div>
          <div className="muted">
            Alerts can trigger for: <span className="mono">Overdue</span>,{" "}
            <span className="mono">Due within 12 hours</span>,{" "}
            <span className="mono">high-point due within 24 hours</span>,{" "}
            <span className="mono">new announcements</span>, and{" "}
            <span className="mono">grade drops below a threshold</span>.
          </div>
          <GradeThresholdsPanel grades={overview?.grades || []} />
          <Expandable
            title="Troubleshooting notifications"
            subtitle={<span className="muted">If permission is granted but nothing appears</span>}
          >
            <div className="stack">
              <div className="muted">
                Live status:
                <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                  <div>Supported: <span className="mono">{String(!!notif.supported)}</span></div>
                  <div>Permission: <span className="mono">{String(notif.permission)}</span></div>
                  <div>
                    Secure context:{" "}
                    <span className="mono">{String(!!isSecureContext)}</span>{" "}
                    <span className="muted">(should be true on <span className="mono">localhost</span> or HTTPS)</span>
                  </div>
                  <div>Enabled in app: <span className="mono">{String(!!notificationsOn)}</span></div>
                </div>
              </div>
              <div className="muted">
                Tip: click <span className="mono">Send test</span>. If you still see nothing, it&apos;s almost always OS/browser-level notification settings (not the app).
              </div>
              {notif.permission === "denied" ? (
                <div className="muted">
                  You&apos;ve blocked notifications for this site in browser settings. Re-enable them there to use this feature.
                </div>
              ) : null}
            </div>
          </Expandable>
        </div>
      )}
    </CollapsibleWidget>
  );
}

function WidgetConfigEditor({ type, config, onChange }) {
  switch (type) {
    case "grades":
      return (
        <div className="widgetConfigGrid">
          <label className="widgetConfigRow">
            <span>Show GPA</span>
            <Toggle
              checked={config.showGpa !== false}
              onChange={(v) => onChange({ showGpa: v })}
              label="Show GPA in header"
            />
          </label>
          <label className="widgetConfigRow">
            <span>Show % score</span>
            <Toggle
              checked={!!config.showScore}
              onChange={(v) => onChange({ showScore: v })}
              label="Show % score"
            />
          </label>
          <label className="widgetConfigRow">
            <span>Max courses shown</span>
            <input
              type="number"
              min="1"
              max="20"
              placeholder="All"
              value={config.maxCourses ?? ""}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({ maxCourses: Number.isFinite(n) && n > 0 ? n : null });
              }}
              style={{ width: 70 }}
            />
          </label>
          <div className="widgetConfigRow">
            <span>Width</span>
            <div className="widgetSizePicker">
              {["sm", "md", "lg"].map((s) => (
                <button key={s} type="button"
                  className={`widgetSizeOption${(config.size ?? "md") === s ? " active" : ""}`}
                  onClick={() => onChange({ size: s })}>
                  {s === "sm" ? "S" : s === "md" ? "M" : "L"}
                </button>
              ))}
            </div>
          </div>
        </div>
      );
    case "today_ring":
      return (
        <div className="widgetConfigGrid">
          <label className="widgetConfigRow">
            <span>Show legend</span>
            <Toggle
              checked={config.showLegend !== false}
              onChange={(v) => onChange({ showLegend: v })}
              label="Show legend"
            />
          </label>
          <div className="widgetConfigRow">
            <span>Width</span>
            <div className="widgetSizePicker">
              {["sm", "md", "lg"].map((s) => (
                <button key={s} type="button"
                  className={`widgetSizeOption${(config.size ?? "md") === s ? " active" : ""}`}
                  onClick={() => onChange({ size: s })}>
                  {s === "sm" ? "S" : s === "md" ? "M" : "L"}
                </button>
              ))}
            </div>
          </div>
        </div>
      );
    case "quick_stats":
      return (
        <div className="widgetConfigGrid">
          {[
            { key: "showMissing", label: "Missing count" },
            { key: "showDueSoon", label: "Due soon count" },
            { key: "showGpa", label: "GPA arc" },
            { key: "showTodos", label: "Todos due today" },
          ].map(({ key, label }) => (
            <label key={key} className="widgetConfigRow">
              <span>{label}</span>
              <Toggle
                checked={config[key] !== false}
                onChange={(v) => onChange({ [key]: v })}
                label={label}
              />
            </label>
          ))}
          <div className="widgetConfigRow">
            <span>Width</span>
            <div className="widgetSizePicker">
              {["sm", "md", "lg"].map((s) => (
                <button key={s} type="button"
                  className={`widgetSizeOption${(config.size ?? "md") === s ? " active" : ""}`}
                  onClick={() => onChange({ size: s })}>
                  {s === "sm" ? "S" : s === "md" ? "M" : "L"}
                </button>
              ))}
            </div>
          </div>
        </div>
      );
    case "grade_overview":
      return (
        <div className="widgetConfigGrid">
          <label className="widgetConfigRow">
            <span>Show GPA</span>
            <Toggle
              checked={config.showGpa !== false}
              onChange={(v) => onChange({ showGpa: v })}
              label="Show GPA"
            />
          </label>
        </div>
      );
    default:
      return <div className="muted" style={{ fontSize: 13 }}>No settings for this widget.</div>;
  }
}

function WidgetManagerModal({ widgets, onUpdate, onAdd, onRemove, onReorder, onClose }) {
  const [editingId, setEditingId] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const usedTypes = new Set(widgets.map((w) => w.type));
  const availablePresets = Object.entries(WIDGET_PRESETS).filter(
    ([type, def]) => !def.unique || !usedTypes.has(type)
  );

  function toggleVisible(id) {
    const w = widgets.find((w) => w.id === id);
    if (w) onUpdate(id, { visible: !w.visible });
  }

  function updateConfig(id, configPatch) {
    const w = widgets.find((w) => w.id === id);
    if (w) onUpdate(id, { config: { ...w.config, ...configPatch } });
  }

  function handleDragStart(e, id) {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }

  function handleDragOver(e, id) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id !== dragOverId) setDragOverId(id);
  }

  function handleDrop(e, targetId) {
    e.preventDefault();
    if (dragId && dragId !== targetId) onReorder(dragId, targetId);
    setDragId(null);
    setDragOverId(null);
  }

  function handleDragEnd() {
    setDragId(null);
    setDragOverId(null);
  }

  return createPortal(
    <div className="modalOverlay" onMouseDown={onClose} role="presentation">
      <div
        className="modalPanel widgetManagerPanel"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Manage widgets"
      >
        <div className="modalHeader">
          <div>
            <div className="h3">Manage Widgets</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              Drag to reorder. Toggle to show or hide.
            </div>
          </div>
          <button type="button" className="iconBtn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="widgetManagerBody">
          <section className="widgetManagerSection">
            <div className="widgetManagerSectionTitle">Active Widgets</div>
            {widgets.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>
                No widgets configured. Add one below.
              </div>
            ) : (
              <ul className="widgetManagerList">
                {widgets.map((w) => {
                  const preset = WIDGET_PRESETS[w.type];
                  const isEditing = editingId === w.id;
                  const isDragging = dragId === w.id;
                  const isDragTarget = dragOverId === w.id && dragId !== w.id;
                  return (
                    <li
                      key={w.id}
                      className={`widgetManagerRow${isDragging ? " widgetRowDragging" : ""}${isDragTarget ? " widgetRowDragTarget" : ""}`}
                      draggable={true}
                      onDragStart={(e) => handleDragStart(e, w.id)}
                      onDragOver={(e) => handleDragOver(e, w.id)}
                      onDrop={(e) => handleDrop(e, w.id)}
                      onDragEnd={handleDragEnd}
                    >
                      <div className="widgetManagerRowMain">
                        <div className="widgetDragHandle" aria-hidden="true">
                          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
                            <circle cx="2.5" cy="2" r="1.5"/>
                            <circle cx="7.5" cy="2" r="1.5"/>
                            <circle cx="2.5" cy="7" r="1.5"/>
                            <circle cx="7.5" cy="7" r="1.5"/>
                            <circle cx="2.5" cy="12" r="1.5"/>
                            <circle cx="7.5" cy="12" r="1.5"/>
                          </svg>
                        </div>
                        <Toggle
                          checked={!!w.visible}
                          onChange={() => toggleVisible(w.id)}
                          label={w.visible ? "Hide widget" : "Show widget"}
                        />
                        <div className="widgetManagerRowInfo">
                          <span className="widgetManagerRowName">
                            {preset?.label ?? w.type}
                          </span>
                          <span className="widgetManagerRowDesc">
                            {!w.visible
                              ? "Hidden from dashboard"
                              : (preset?.description ?? "")}
                          </span>
                        </div>
                        <div className="widgetManagerRowActions">
                          <button
                            type="button"
                            className="widgetEditBtn"
                            onClick={() => setEditingId(isEditing ? null : w.id)}
                            aria-expanded={isEditing}
                          >
                            {isEditing ? "Done ↑" : "Edit ↓"}
                          </button>
                          <button
                            type="button"
                            className="widgetRemoveBtn"
                            onClick={() => {
                              onRemove(w.id);
                              setEditingId(null);
                            }}
                            aria-label={`Remove ${preset?.label ?? w.type}`}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      {isEditing && (
                        <div className="widgetConfigPanel">
                          <WidgetConfigEditor
                            type={w.type}
                            config={w.config}
                            onChange={(patch) => updateConfig(w.id, patch)}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {availablePresets.length > 0 && (
            <section className="widgetManagerSection">
              <div className="widgetManagerSectionTitle">Add Widget</div>
              <ul className="widgetPresetList">
                {availablePresets.map(([type, def]) => (
                  <li key={type} className="widgetPresetRow">
                    <div className="widgetPresetInfo">
                      <span className="widgetManagerRowName">{def.label}</span>
                      <span className="widgetManagerRowDesc">{def.description}</span>
                    </div>
                    <button
                      type="button"
                      className="widgetAddBtn"
                      onClick={() => onAdd(type)}
                    >
                      + Add
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {availablePresets.length === 0 && widgets.length > 0 && (
            <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>
              All available widget types are already added.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ===== Main page component =====

export function MyInformation({ active = true }) {
  const { hasToken } = useAuth();
  const notif = useDesktopNotifications(hasToken);

  // Live clock — updates every minute so date/time display stays current
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const lastGreetingRef = useRef("");
  const heroGreeting = useMemo(() => {
    if (!active) return lastGreetingRef.current;
    const next = pickRandomWithoutRepeat(
      greetingOptionsFor(new Date()),
      lastGreetingRef.current,
    );
    lastGreetingRef.current = next;
    return next;
  }, [active]);

  // ✅ Cached API data (prevents "No info" flash on tab switch)
  const profileQ = useCachedAsync(
    "myinfo:profile",
    ({ signal }) => canvasApi.getProfile({ signal }),
    { ttlMs: 5 * 60 * 1000 }
  );

  const overviewQ = useCachedAsync(
    "myinfo:overview",
    ({ signal }) => canvasApi.getOverview({ signal }),
    { ttlMs: 2 * 60 * 1000 } // a bit fresher is fine
  );

  const profile = profileQ.data;
  const overview = overviewQ.data;

  // ✅ Announcements moved to cached async
  // We keep using cache="fresh" inside the fetcher so refreshes always see new posts.
  const announcementsQ = useCachedAsync(
    "myinfo:announcements:days=14:limit=20",
    async ({ signal }) => {
      const anns = await canvasApi.getAnnouncements(14, 20, "fresh", {
        signal,
      });
      return Array.isArray(anns) ? anns : [];
    },
    { ttlMs: 3 * 60 * 1000 }
  );

  const overviewRefreshRef = useRef(null);
  overviewRefreshRef.current = overviewQ.refresh;

  useEffect(() => {
    function onHiddenChanged() {
      overviewRefreshRef.current?.();
    }
    window.addEventListener("canvassist:hidden:changed", onHiddenChanged);
    return () => window.removeEventListener("canvassist:hidden:changed", onHiddenChanged);
  }, []);

  const annRefreshRef = useRef(null);
  annRefreshRef.current = announcementsQ.refresh;

  // Clear announcements cache once on mount, then kick off the first fetch
  useEffect(() => {
    clearCachedAsync("myinfo:announcements");
    annRefreshRef.current?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const announcements = useMemo(() => announcementsQ.data || [], [announcementsQ.data]);
  const annErr = announcementsQ.error;

  // Show the announcements loading state if we're actively loading OR have never
  // received a response yet (data === null). This prevents a "None found" flash
  // when the fetch is aborted/restarted before the first response arrives.
  const annLoading =
    (announcementsQ.loading || announcementsQ.data == null) && !annErr;

  // Apply same loading logic to overview-dependent sections
  const overviewErr = overviewQ.error;
  const overviewLoading =
    (overviewQ.loading || overviewQ.data == null) && !overviewErr;

  // Seen tracking
  const [seenIds, setSeenIds] = useState(() => new Set());
  const demoMode = isDemoMode();
  const [acceptedGradeKeys, setAcceptedGradeKeys] = useState(() =>
    loadAcceptedGradeKeys(),
  );

  useEffect(() => {
    let active = true;

    hydrateAcceptedGradeKeysFromServer()
      .then((next) => {
        if (active) setAcceptedGradeKeys(next);
      })
      .catch(() => {
        // Keep local fallback if server sync fails.
      });

    function refreshAccepted() {
      setAcceptedGradeKeys(loadAcceptedGradeKeys());
    }

    window.addEventListener("focus", refreshAccepted);
    window.addEventListener("storage", refreshAccepted);
    window.addEventListener("canvassist:accepted-grades:changed", refreshAccepted);
    return () => {
      active = false;
      window.removeEventListener("focus", refreshAccepted);
      window.removeEventListener("storage", refreshAccepted);
      window.removeEventListener("canvassist:accepted-grades:changed", refreshAccepted);
    };
  }, []);

  // Personal todos due within 24 hours
  const [todos, setTodos] = useState(() => loadTodos());
  useEffect(() => {
    function onTodosChanged() { setTodos(loadTodos()); }
    window.addEventListener("canvassist:todos:changed", onTodosChanged);
    return () => window.removeEventListener("canvassist:todos:changed", onTodosChanged);
  }, []);
  const todosDue24h = useMemo(() => {
    const now = Date.now();
    const cutoff = now + 24 * 60 * 60 * 1000;
    return (todos || []).filter((t) => {
      if (t.completed) return false;
      if (!t.due_at) return false;
      const ms = new Date(t.due_at).getTime();
      return Number.isFinite(ms) && ms >= now && ms <= cutoff;
    }).sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
  }, [todos]);

  // Grade visibility (shared by GradesSnapshotWidget and QuickStatsWidget)
  const [gradesVisible, setGradesVisible] = useState(() => {
    try {
      const raw = localStorage.getItem(HERO_GRADES_VISIBLE_KEY);
      return raw === null ? true : raw === "true";
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(HERO_GRADES_VISIBLE_KEY, String(gradesVisible)); } catch {}
  }, [gradesVisible]);

  // Widget config
  const [widgets, setWidgets] = useState(() => loadWidgetConfig());
  const [manageOpen, setManageOpen] = useState(false);

  function handleWidgetUpdate(id, updates) {
    setWidgets((prev) => {
      const next = prev.map((w) => (w.id === id ? { ...w, ...updates } : w));
      saveWidgetConfig(next);
      return next;
    });
  }

  function handleWidgetAdd(type) {
    const preset = WIDGET_PRESETS[type];
    if (!preset) return;
    const newWidget = { id: makeWidgetId(), type, visible: true, config: { ...preset.defaultConfig } };
    setWidgets((prev) => {
      const next = [...prev, newWidget];
      saveWidgetConfig(next);
      return next;
    });
  }

  function handleWidgetRemove(id) {
    setWidgets((prev) => {
      const next = prev.filter((w) => w.id !== id);
      saveWidgetConfig(next);
      return next;
    });
  }

  function handleWidgetReorder(fromId, toId) {
    setWidgets((prev) => {
      const fromIdx = prev.findIndex((w) => w.id === fromId);
      const toIdx = prev.findIndex((w) => w.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [removed] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, removed);
      saveWidgetConfig(next);
      return next;
    });
  }

  const SEEN_KEY = "announcements:seenIds";

  // DB-backed high-water mark: the ID of the newest announcement the user has
  // opened the dropdown to see. Fetched once on mount; only updated when the
  // user opens the Announcements expandable.
  const [lastSeenIdFromDb, setLastSeenIdFromDb] = useState(0);
  const lastSeenIdRef = useRef(0);

  useEffect(() => {
    if (demoMode) {
      setLastSeenIdFromDb(0);
      lastSeenIdRef.current = 0;
      return;
    }
    canvasApi.getAnnouncementLastSeen().then((res) => {
      const id = res?.last_seen_id ?? 0;
      setLastSeenIdFromDb(id);
      lastSeenIdRef.current = id;
    }).catch(() => {});
  }, [demoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const missingItems = useMemo(
    () => (Array.isArray(overview?.missing) ? overview.missing : []),
    [overview?.missing],
  );
  const filteredMissingItems = useMemo(
    () =>
      missingItems.filter(
        (m) =>
          !acceptedGradeKeys.has(
            acceptedGradeKey(m?.course_id, m?.assignment_id),
          ),
      ),
    [missingItems, acceptedGradeKeys],
  );
  const missingCount = filteredMissingItems.length;
  const canvasDue24Count = overview?.due_next_24h_count ?? 0;
  const due24Count = canvasDue24Count + todosDue24h.length;
  const gpa = overview?.gpa;

  const notificationsOn = !!notif.enabled;
  const isSecureContext =
    typeof window !== "undefined"
      ? window.isSecureContext || window.location.hostname === "localhost"
      : false;

  function newestAnnouncementId(items) {
    let newest = 0;
    for (const a of items || []) {
      const id = Number(a?.id);
      if (Number.isFinite(id) && id > newest) newest = id;
    }
    return newest;
  }

  // NEW badge count:
  // - live mode: DB-backed high-water mark (cross-session persistence)
  // - demo mode: local seen set (server intentionally returns no persisted seen state)
  const newAnnouncementCount = useMemo(() => {
    if (!announcements?.length) return 0;
    if (demoMode) {
      return announcements.filter((a) => a?.id && !seenIds.has(Number(a.id))).length;
    }
    return announcements.filter((a) => a?.id && a.id > lastSeenIdFromDb).length;
  }, [announcements, demoMode, seenIds, lastSeenIdFromDb]);

  function persistSeen(nextSet) {
    setSeenIds(new Set(nextSet));
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(nextSet)));
    } catch {
      // ignore
    }
  }

  function markAnnouncementSeen(id) {
    if (!id) return;
    if (seenIds.has(id)) return;

    const next = new Set(seenIds);
    next.add(id);
    persistSeen(next);
  }

  function markAllAnnouncementsSeen() {
    const next = new Set(seenIds);
    for (const a of announcements || []) {
      if (a?.id) next.add(a.id);
    }
    persistSeen(next);

    if (demoMode) return;

    const newestId = newestAnnouncementId(announcements);
    if (newestId && newestId > lastSeenIdRef.current) {
      lastSeenIdRef.current = newestId;
      setLastSeenIdFromDb(newestId);
      canvasApi.setAnnouncementLastSeen(newestId).catch(() => {});
    }
  }

  // If the dropdown is already open when announcements finish loading, mark them seen.
  // This handles the case where the user opens the section before the fetch completes —
  // the onOpen handler can't observe an async fetch that completes later.
  // Load seenIds after mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SEEN_KEY) || "[]";
      const arr = safeJsonParse(raw, []);
      const ids = Array.isArray(arr) ? arr.map(Number).filter(Boolean) : [];
      setSeenIds(new Set(ids));
    } catch {
      // ignore
    }
  }, []);

  // Poll for new announcements every 3 minutes; notifications only fire on poll ticks,
  // not on the initial mount fetch (shouldNotifyRef starts false).
  const shouldNotifyRef = useRef(false);

  useEffect(() => {
    const POLL_MS = 3 * 60 * 1000;

    const t = setInterval(() => {
      shouldNotifyRef.current = true;
      annRefreshRef.current?.();
    }, POLL_MS);

    return () => clearInterval(t);
  }, []);

  // When announcements change after a poll tick, evaluate new announcements + notify
  useEffect(() => {
    if (!shouldNotifyRef.current) return;
    shouldNotifyRef.current = false;

    if (!notif.enabled || notif.permission !== "granted") return;
    if (!announcements?.length) return;

    const lastSeen = lastSeenIdRef.current;
    const newestId = announcements?.[0]?.id ?? 0;
    if (newestId > lastSeen) {
      const newOnes = announcements.filter((a) => a.id > lastSeen).slice(0, 3);

      for (const a of newOnes) {
        notifyOnce({
          dedupeKey: `announcement:${a.id}`,
          title: `New announcement${
            a.course_name ? ` • ${formatCourseTitle(a.course_name)}` : ""
          }`,
          body: a.title,
          url: a.html_url || window.location.href,
          cooldownMs: 0,
        });
      }
    }
  }, [announcements, notif.enabled, notif.permission]);

  async function handleEnableNotifications() {
    const perm = await requestNotificationPermission();
    notif.refreshPermission();

    if (perm === "granted") {
      notif.setEnabled(true);

      notifyOnce({
        dedupeKey: `notifications:enabled:${Date.now()}`,
        title: "Notifications enabled",
        body: "You’ll now receive alerts for overdue and due-soon assignments.",
        url: window.location.href,
        cooldownMs: 0,
      });
    }
  }

  function handleDisableNotifications() {
    notif.setEnabled(false);
  }

  async function markCompleted(courseId, assignmentId) {
    setAcceptedGradeKeys((prev) =>
      markAssignmentCompletedLocal(prev, courseId, assignmentId),
    );
    try {
      await markAssignmentCompletedRemote(
        loadAcceptedGradeKeys(),
        courseId,
        assignmentId,
        "manual_completed",
      );
    } catch {
      // Keep optimistic local state.
    }
  }

  // Error handling for main data
  const mainErr = profileQ.error || overviewQ.error;
  if (mainErr) return <ErrorBox error={mainErr} />;

  // Only show the big loading screen if we have *no* cached data yet
  if ((profileQ.loading && !profile) || (overviewQ.loading && !overview)) {
    return <Loading label="Loading profile…" />;
  }

  // If profile never arrives, show message (but this shouldn’t flash anymore)
  if (!profile) return <div className="muted">Loading...</div>;

  return (
    <div className="stack">
      {/* Welcome hero — typographic moment, not a stats template */}
      <section className="welcomeHero" aria-labelledby="welcomeHeading">
        <div className="welcomeHeroTop">
          {profile.avatar_url ? (
            <img className="welcomeAvatar" src={profile.avatar_url} alt="" />
          ) : (
            <div className="welcomeAvatar welcomeAvatarPlaceholder" aria-hidden="true">
              {avatarInitialOf(profile)}
            </div>
          )}
          <div className="welcomeMeta">
            <span className="welcomeName">{profile.short_name || profile.name || "Student"}</span>
            {(profileQ.refreshing || overviewQ.refreshing || announcementsQ.refreshing) ? (
              <span className="welcomeSyncing"><span className="spinner" />Syncing</span>
            ) : null}
          </div>
        </div>

        <h1 id="welcomeHeading" className="welcomeGreeting">
          {(heroGreeting || "Welcome back")},{" "}
          <span className="welcomeGreetingName">{firstNameOf(profile)}.</span>
        </h1>

        <p className="welcomeSubline">{datelineFor(now)}</p>

        {(profile.primary_email || profile.sortable_name || profile.short_name || profile.id) ? (
          <details className="welcomeAccountDetails">
            <summary>Account details</summary>
            <dl>
              {profile.name ? (<><dt>Name</dt><dd>{profile.name}</dd></>) : null}
              <dt>Canvas ID</dt><dd className="mono">{profile.id}</dd>
              {profile.primary_email ? (<><dt>Email</dt><dd className="mono">{profile.primary_email}</dd></>) : null}
              {profile.sortable_name ? (<><dt>Sortable</dt><dd className="mono">{profile.sortable_name}</dd></>) : null}
              {profile.short_name ? (<><dt>Short</dt><dd className="mono">{profile.short_name}</dd></>) : null}
            </dl>
          </details>
        ) : null}

        {/* Hero widgets */}
        <div className="heroWidgetArea">
          <div className="heroWidgetBar">
            <span className="heroWidgetBarLabel">Widgets</span>
            <button
              type="button"
              className="heroWidgetManageBtn"
              onClick={() => setManageOpen(true)}
            >
              ⚙ Customize
            </button>
          </div>
          <div className="heroWidgetRow">
            {widgets.filter((w) => w.visible).map((w) => {
              switch (w.type) {
                case "grades":
                  return (
                    <GradesSnapshotWidget
                      key={w.id}
                      config={w.config}
                      overview={overview}
                      loading={overviewLoading}
                      gradesVisible={gradesVisible}
                      onToggleGrades={setGradesVisible}
                    />
                  );
                case "today_ring":
                  return (
                    <TodayRingWidget
                      key={w.id}
                      config={w.config}
                      missingCount={missingCount}
                      canvasDue24Count={canvasDue24Count}
                    />
                  );
                case "quick_stats":
                  return (
                    <QuickStatsWidget
                      key={w.id}
                      config={w.config}
                      overviewLoading={overviewLoading}
                      missingCount={missingCount}
                      canvasDue24Count={canvasDue24Count}
                      gpa={gpa}
                      todosDue24h={todosDue24h}
                      gradesVisible={gradesVisible}
                    />
                  );
                case "due_soon":
                  return (
                    <DueSoonWidget
                      key={w.id}
                      overview={overview}
                      overviewLoading={overviewLoading}
                      overviewErr={overviewErr}
                      due24Count={due24Count}
                      todosDue24h={todosDue24h}
                    />
                  );
                case "missing_work":
                  return (
                    <MissingWorkWidget
                      key={w.id}
                      overviewLoading={overviewLoading}
                      overviewErr={overviewErr}
                      missingCount={missingCount}
                      filteredMissingItems={filteredMissingItems}
                      markCompleted={markCompleted}
                    />
                  );
                case "announcements":
                  return (
                    <AnnouncementsWidget
                      key={w.id}
                      announcements={announcements}
                      annLoading={annLoading}
                      annErr={annErr}
                      seenIds={seenIds}
                      demoMode={demoMode}
                      lastSeenIdFromDb={lastSeenIdFromDb}
                      markAnnouncementSeen={markAnnouncementSeen}
                      markAllAnnouncementsSeen={markAllAnnouncementsSeen}
                      newAnnouncementCount={newAnnouncementCount}
                    />
                  );
                case "grade_overview":
                  return (
                    <GradeOverviewWidget
                      key={w.id}
                      config={w.config}
                      overview={overview}
                      gpa={gpa}
                      overviewLoading={overviewLoading}
                      overviewErr={overviewErr}
                    />
                  );
                case "notifications":
                  return (
                    <NotificationsWidget
                      key={w.id}
                      notif={notif}
                      overview={overview}
                      isSecureContext={isSecureContext}
                      notificationsOn={notificationsOn}
                      handleEnableNotifications={handleEnableNotifications}
                      handleDisableNotifications={handleDisableNotifications}
                    />
                  );
                default:
                  return null;
              }
            })}
            {widgets.filter((w) => w.visible).length === 0 && (
              <div className="heroWidgetEmpty">
                <span className="muted">No widgets visible. </span>
                <button
                  type="button"
                  className="linkBtn"
                  onClick={() => setManageOpen(true)}
                >
                  Add some →
                </button>
              </div>
            )}
          </div>
        </div>
      </section>


      {manageOpen && (
        <WidgetManagerModal
          widgets={widgets}
          onUpdate={handleWidgetUpdate}
          onAdd={handleWidgetAdd}
          onRemove={handleWidgetRemove}
          onReorder={handleWidgetReorder}
          onClose={() => setManageOpen(false)}
        />
      )}

    </div>
  );
}
