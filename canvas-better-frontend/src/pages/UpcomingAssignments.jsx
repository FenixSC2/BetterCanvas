// src/pages/UpcomingAssignments.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { WorkloadEstimateControl } from "../components/WorkloadEstimateControl";

function fmtDue(dt) {
  if (!dt) return "No due date";
  const d = new Date(dt);
  return d.toLocaleString();
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

function hoursUntil(dt) {
  if (!dt) return null;
  const t = new Date(dt).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / (1000 * 60 * 60);
}

// Basic urgency badge
function getUrgencyBadge(a) {
  if (a.submitted) return { label: "Completed", variant: "success" };

  if (a.due_at) {
    const h = hoursUntil(a.due_at);
    if (h != null && h < 0) return { label: "Missing", variant: "danger" };
    if (h != null && h <= 12) return { label: "Due soon", variant: "warning" };
    if (h != null && h <= 48) return { label: "Upcoming", variant: "neutral" };
    return { label: "Scheduled", variant: "neutral" };
  }

  return { label: "Undated", variant: "neutral" };
}

/**
 * Simple popover (overlay) that does NOT push layout.
 * - anchors to the trigger
 * - closes on outside click + Escape
 * - uses position: fixed + getBoundingClientRect for reliable alignment
 */
function Popover({ open, onClose, anchorRef, children, align = "right", width = 320 }) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;

    function recompute() {
      const anchor = anchorRef?.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect(); // viewport coords
      const margin = 8;

      let left;
      if (align === "left") {
        left = rect.left;
      } else {
        left = rect.right - width; // align right edges
      }

      // clamp into viewport
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

      // prefer below anchor; clamp if near bottom
      let top = rect.bottom + margin;
      const maxTop = window.innerHeight - margin;
      top = Math.max(margin, Math.min(top, maxTop));

      setPos({ top, left });
    }

    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);

    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    function onClick(e) {
      const panel = panelRef.current;
      const anchor = anchorRef?.current;
      if (!panel || !anchor) return;

      const t = e.target;
      if (panel.contains(t)) return;
      if (anchor.contains(t)) return;

      onClose?.();
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);

    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open, onClose, anchorRef, align, width]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        zIndex: 9999,
        width,
      }}
    >
      <div ref={panelRef} className="card" style={{ boxShadow: "0 10px 30px rgba(0,0,0,0.18)" }}>
        <div className="cardBody">{children}</div>
      </div>
    </div>
  );
}

function parseUpcomingTarget(raw) {
  if (!raw) return null;

  // Accept "courseId:assignmentId"
  if (typeof raw === "string" && raw.includes(":") && !raw.trim().startsWith("{")) {
    const [c, a] = raw.split(":");
    const courseId = Number(c);
    const assignmentId = Number(a);
    if (Number.isFinite(courseId) && Number.isFinite(assignmentId)) return { courseId, assignmentId };
  }

  // Accept JSON: {"courseId":...,"assignmentId":...} or variants
  try {
    const obj = JSON.parse(raw);
    const courseId = Number(obj.courseId ?? obj.course_id ?? obj.cid ?? obj.course);
    const assignmentId = Number(obj.assignmentId ?? obj.assignment_id ?? obj.id ?? obj.aid ?? obj.assignment);
    if (Number.isFinite(courseId) && Number.isFinite(assignmentId)) return { courseId, assignmentId };
  } catch {
    // ignore
  }

  return null;
}

export function UpcomingAssignments() {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  // Filter: all | missing | upcoming | undated
  const [filterMode, setFilterMode] = useState("all");

  // Sorting blend: 0 = date only, 1 = points only
  const [blend, setBlend] = useState(0.35);

  // Popover state
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const filterBtnRef = useRef(null);
  const sortBtnRef = useRef(null);

  // Focus/highlight state (for WeeklyPlanner -> UpcomingAssignments navigation)
  const [focusKey, setFocusKey] = useState(null); // `${courseId}-${assignmentId}`
  const focusTimerRef = useRef(null);
  const pendingFocusRef = useRef(null); // stores target until DOM is ready

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setErr(null);

    canvasApi
      .getUpcoming({ signal: ac.signal })
      .then((data) => setItems(data || []))
      .catch((e) => {
        if (e.name !== "AbortError") setErr(e);
      })
      .finally(() => setLoading(false));

    return () => ac.abort();
  }, []);

  const filteredSorted = useMemo(() => {
    const now = Date.now();

    const normalizePoints = (p) => {
      const n = typeof p === "number" ? p : Number(p);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(300, n));
    };

    // timeScore: higher means more urgent (time-heavy)
    const timeScore = (a) => {
      if (!a?.due_at) return 0;
      const t = new Date(a.due_at).getTime();
      if (!Number.isFinite(t)) return 0;
      const hours = (t - now) / (1000 * 60 * 60);
      if (hours < 0) return 10_000; // overdue
      return 1200 / Math.max(1, hours); // time-heavy curve
    };

    const weightScore = (a) => normalizePoints(a?.points_possible);

    const isMissing = (a) => {
      if (a.submitted) return false;
      const h = hoursUntil(a.due_at);
      return h != null && h < 0;
    };

    const isUndated = (a) => !a?.due_at;

    const isUpcoming = (a) => {
      if (!a?.due_at) return false;
      const h = hoursUntil(a.due_at);
      return h != null && h >= 0;
    };

    // 1) filter
    let list = [...items];
    if (filterMode === "missing") list = list.filter(isMissing);
    if (filterMode === "upcoming") list = list.filter(isUpcoming);
    if (filterMode === "undated") list = list.filter(isUndated);

    // 2) sorting with invariants: missing first, completed last
    list.sort((a, b) => {
      const aMissing = isMissing(a);
      const bMissing = isMissing(b);
      if (aMissing !== bMissing) return aMissing ? -1 : 1;

      const aCompleted = !!a.submitted;
      const bCompleted = !!b.submitted;
      if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;

      const aScore = (1 - blend) * timeScore(a) + blend * weightScore(a);
      const bScore = (1 - blend) * timeScore(b) + blend * weightScore(b);
      if (bScore !== aScore) return bScore - aScore;

      // tie-break: earlier due first
      const at = a?.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bt = b?.due_at ? new Date(b.due_at).getTime() : Infinity;
      return at - bt;
    });

    return list;
  }, [items, filterMode, blend]);

  // === Auto-focus target assignment ===
  useEffect(() => {
    if (loading) return;
    if (!items?.length) return;

    const raw = localStorage.getItem("nav:upcoming:target");
    const target = parseUpcomingTarget(raw);
    if (!target) return;

    const key = `${target.courseId}-${target.assignmentId}`;
    const exists = items.some(
      (a) => Number(a.course_id) === target.courseId && Number(a.id) === target.assignmentId
    );

    // Clear storage regardless (avoid infinite jumping)
    localStorage.removeItem("nav:upcoming:target");

    if (!exists) return;

    // Make sure it's visible
    if (filterMode !== "all") setFilterMode("all");

    // Close popovers (nice UX)
    setFilterOpen(false);
    setSortOpen(false);

    // Mark pending focus; we’ll execute scroll when DOM is present
    pendingFocusRef.current = key;
  }, [loading, items, filterMode]);

  // After list renders (filteredSorted changes), perform scroll if pending
  useEffect(() => {
    const key = pendingFocusRef.current;
    if (!key) return;

    const elId = `asg-${key}`;
    const run = () => {
      const el = document.getElementById(elId);
      if (!el) return false;

      // highlight
      setFocusKey(key);

      // scroll into view
      el.scrollIntoView({ behavior: "smooth", block: "center" });

      // clear pending
      pendingFocusRef.current = null;

      // clear highlight after a bit
      if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = window.setTimeout(() => setFocusKey(null), 2500);

      return true;
    };

    // Give React/layout a moment
    requestAnimationFrame(() => {
      if (run()) return;
      // sometimes needs a second frame
      requestAnimationFrame(() => run());
    });

    return () => {
      if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
    };
  }, [filteredSorted]);

  if (loading) return <Loading label="Loading upcoming assignments…" />;
  if (err) return <ErrorBox error={err} />;

  const filterLabel =
    filterMode === "all"
      ? "All"
      : filterMode === "missing"
      ? "Missing"
      : filterMode === "upcoming"
      ? "Upcoming"
      : "Undated";

  return (
    <div className="stack" style={{ position: "relative" }}>
      <div className="rowWrap" style={{ justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div className="muted">
          Powered by <span className="mono">GET /api/upcoming</span>.
        </div>

        {/* Controls */}
        <div className="rowWrap" style={{ gap: 10, alignItems: "center", flexWrap: "nowrap" }}>
          <button
            ref={filterBtnRef}
            className="btn"
            onClick={() => {
              setFilterOpen((v) => !v);
              setSortOpen(false);
            }}
            title="Filter assignments"
            style={{ whiteSpace: "nowrap" }}
          >
            Filter: <span className="mono">{filterLabel}</span>
          </button>

          <button
            ref={sortBtnRef}
            className="btn"
            onClick={() => {
              setSortOpen((v) => !v);
              setFilterOpen(false);
            }}
            title="Sort by time and/or points"
            style={{ whiteSpace: "nowrap" }}
          >
            Sorting
          </button>
        </div>
      </div>

      {/* Filter popover — stack options vertically */}
      <Popover open={filterOpen} onClose={() => setFilterOpen(false)} anchorRef={filterBtnRef} align="right" width={260}>
        <div className="stack">
          <div className="h3" style={{ marginBottom: 2 }}>
            Filter
          </div>
          <div className="muted">Show only assignments matching:</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
            {[
              ["all", "All"],
              ["missing", "Missing"],
              ["upcoming", "Upcoming"],
              ["undated", "Undated"],
            ].map(([key, label]) => (
              <button
                key={key}
                className="btn"
                onClick={() => {
                  setFilterMode(key);
                  setFilterOpen(false);
                }}
                title={`Show ${label.toLowerCase()} assignments`}
                style={{ textAlign: "left", width: "100%" }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="muted" style={{ marginTop: 8 }}>
            Missing items stay at the top regardless of sorting.
          </div>
        </div>
      </Popover>

      {/* Sorting popover — prevent wrapping of "Points" */}
      <Popover open={sortOpen} onClose={() => setSortOpen(false)} anchorRef={sortBtnRef} align="right" width={360}>
        <div className="stack">
          <div className="h3" style={{ marginBottom: 2 }}>
            Sorting blend
          </div>
          <div className="muted">Left = prioritize due date • Right = prioritize points</div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "nowrap",
              marginTop: 6,
            }}
          >
            <span className="mono" style={{ minWidth: 44 }}>
              Time
            </span>

            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={blend}
              onChange={(e) => setBlend(Number(e.target.value))}
              style={{ flex: 1, minWidth: 160 }}
            />

            <span className="mono" style={{ minWidth: 52, textAlign: "right" }}>
              Points
            </span>
          </div>

          <div className="rowWrap" style={{ gap: 10, alignItems: "center", marginTop: 4 }}>
            <span className="muted">Blend</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={blend}
              onChange={(e) => setBlend(Number(e.target.value))}
              style={{ width: 90 }}
            />
            <span className="muted">(0–1)</span>
          </div>

          <div className="muted">
            Tip: keep this around <span className="mono">0.25–0.45</span> to stay time-heavy.
          </div>
        </div>
      </Popover>

      {filteredSorted.length === 0 ? <div className="muted">No assignments found for the selected filter.</div> : null}

      <ul className="list">
        {filteredSorted.map((a) => {
          const badge = getUrgencyBadge(a);

          const isMissing =
            !a.submitted && a.due_at && hoursUntil(a.due_at) != null && hoursUntil(a.due_at) < 0;

          const courseLabel = a.course_name ?? "Unknown Course";
          const dueLabel = fmtDue(a.due_at);

          const desc = stripHtml(a.description);
          const hasDesc = !!desc;

          const focusId = `${a.course_id}-${a.id}`;
          const isFocused = focusKey === focusId;

          return (
            <li
              id={`asg-${focusId}`}
              key={`${a.course_id}-${a.id}`}
              className={`listItem ${isMissing ? "dangerItem" : ""}`}
              style={
                isFocused
                  ? {
                      outline: "2px solid rgba(255, 200, 0, 0.9)",
                      boxShadow: "0 0 0 6px rgba(255, 200, 0, 0.18)",
                      borderRadius: 12,
                      transition: "box-shadow 200ms ease, outline 200ms ease",
                    }
                  : undefined
              }
            >
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  width: "100%",
                }}
              >
                <div className="listMain" style={{ width: "100%" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <div
                      className="listTitle"
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      {a.name}

                      <span className={`badge badge-${badge.variant}`}>{badge.label}</span>

                      {typeof a.points_possible === "number" ? (
                        <span className="muted">
                          <span className="mono">{a.points_possible}</span> pts
                        </span>
                      ) : null}
                    </div>

                    <div className={`muted ${isMissing ? "dangerText" : ""}`} style={{ whiteSpace: "nowrap" }}>
                      Due: <span className="mono">{dueLabel}</span>
                    </div>
                  </div>

                  <div className={`muted ${isMissing ? "dangerMuted" : ""}`} style={{ marginTop: 4 }}>
                    <span className="mono">{courseLabel}</span>
                  </div>

                  <div style={{ marginTop: 8 }}>
                    <WorkloadEstimateControl courseId={a.course_id} assignmentId={a.id} />
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <Expandable
                      title="Details"
                      subtitle={
                        hasDesc ? (
                          <span className="muted">Description available</span>
                        ) : (
                          <span className="muted">No description</span>
                        )
                      }
                    >
                      <div className="stack">
                        {hasDesc ? (
                          <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
                            {desc}
                          </div>
                        ) : (
                          <div className="muted">No description provided.</div>
                        )}
                      </div>
                    </Expandable>
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {a.html_url ? (
                    <a
                      className="btn"
                      href={a.html_url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open assignment in Canvas"
                      style={{ whiteSpace: "nowrap" }}
                    >
                      Open in Canvas
                    </a>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="muted">Tip: effort estimates are stored locally in your browser (per assignment).</div>
    </div>
  );
}
