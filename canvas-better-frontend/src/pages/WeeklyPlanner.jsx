// src/pages/WeeklyPlanner.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { WorkloadEstimateControl } from "../components/WorkloadEstimateControl";

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function startOfWeekMonday(date) {
  const d = startOfDay(date);
  const day = d.getDay(); // 0=Sun ... 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // move to Monday
  return addDays(d, diff);
}

function fmtDayHeader(d) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fmtTime(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function hoursUntil(dt) {
  if (!dt) return null;
  const t = new Date(dt).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / (1000 * 60 * 60);
}

function isMissing(a) {
  if (a?.submitted) return false;
  const h = hoursUntil(a?.due_at);
  return h != null && h < 0;
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

/**
 * We read effort estimates from localStorage for summary totals.
 * This is intentionally tolerant of a few possible key formats.
 * If you know the exact key your WorkloadEstimateControl uses,
 * we can simplify this to one key.
 */
function getEstimateHours(courseId, assignmentId) {
  const candidates = [
    `workload:${courseId}:${assignmentId}`,
    `effort:${courseId}:${assignmentId}`,
    `bettercanvas:workload:${courseId}:${assignmentId}`,
    `bettercanvas:effort:${courseId}:${assignmentId}`,
  ];

  for (const k of candidates) {
    const raw = localStorage.getItem(k);
    if (!raw) continue;

    const direct = Number(raw);
    if (Number.isFinite(direct)) return Math.max(0, Math.min(200, direct));

    try {
      const obj = JSON.parse(raw);
      if (typeof obj === "number" && Number.isFinite(obj)) return Math.max(0, Math.min(200, obj));
      if (typeof obj?.value === "number" && Number.isFinite(obj.value)) return Math.max(0, Math.min(200, obj.value));

      const h = typeof obj?.hours === "number" && Number.isFinite(obj.hours) ? obj.hours : 0;
      const m = typeof obj?.minutes === "number" && Number.isFinite(obj.minutes) ? obj.minutes : 0;
      const total = h + m / 60;
      if (Number.isFinite(total) && total > 0) return Math.max(0, Math.min(200, total));
    } catch {
      // ignore
    }
  }

  return 0;
}

function loadPlannerSettings() {
  try {
    const raw = localStorage.getItem("weeklyPlanner:settings");
    if (!raw) return { dailyCapacityHours: 3.0, showCompleted: false };
    const obj = JSON.parse(raw);
    return {
      dailyCapacityHours: Number.isFinite(Number(obj?.dailyCapacityHours)) ? Number(obj.dailyCapacityHours) : 3.0,
      showCompleted: !!obj?.showCompleted,
    };
  } catch {
    return { dailyCapacityHours: 3.0, showCompleted: false };
  }
}

function savePlannerSettings(settings) {
  localStorage.setItem("weeklyPlanner:settings", JSON.stringify(settings));
}

/**
 * Navigate to Upcoming Assignments and target an assignment.
 * Works with a small App.jsx listener (provided below).
 */
function navigateToAssignment(courseId, assignmentId) {
  // store for UpcomingAssignments page to optionally highlight/scroll/open details
  localStorage.setItem(
    "nav:upcoming:target",
    JSON.stringify({ courseId, assignmentId, ts: Date.now() })
  );

  // tell App to switch tabs
  window.dispatchEvent(
    new CustomEvent("canvasbetter:navigate", {
      detail: { tab: "upcoming" },
    })
  );
}

export function WeeklyPlanner() {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  // week cursor
  const [weekStart, setWeekStart] = useState(() => startOfWeekMonday(new Date()));

  // settings
  const [settings, setSettings] = useState(() => loadPlannerSettings());

  // force recompute when localStorage effort changes
  const [storageTick, setStorageTick] = useState(0);

  // horizontal scroll helpers
  const scrollerRef = useRef(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  const refresh = () => {
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
  };

  useEffect(() => {
    const abort = refresh();
    return () => abort?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onStorage(e) {
      if (!e?.key) return;
      if (
        e.key.startsWith("workload:") ||
        e.key.startsWith("effort:") ||
        e.key.startsWith("bettercanvas:workload:") ||
        e.key.startsWith("bettercanvas:effort:")
      ) {
        setStorageTick((t) => t + 1);
      }
      if (e.key === "weeklyPlanner:settings") {
        setSettings(loadPlannerSettings());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    savePlannerSettings(settings);
  }, [settings]);

  // scroll indicators (arrows + gradients)
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    function compute() {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      const maxLeft = scrollWidth - clientWidth;
      setCanScroll({
        left: scrollLeft > 2,
        right: maxLeft - scrollLeft > 2,
      });
    }

    compute();
    el.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", compute);
    return () => {
      el.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, [items, weekStart]);

  const view = useMemo(() => {
    const start = startOfDay(weekStart);
    const end = addDays(start, 7); // exclusive
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

    const buckets = new Map();
    for (let i = 0; i < 7; i++) buckets.set(i, []);

    const undated = [];

    for (const a of items || []) {
      if (!settings.showCompleted && a.submitted) continue;

      if (!a?.due_at) {
        undated.push(a);
        continue;
      }

      const due = new Date(a.due_at);
      if (!Number.isFinite(due.getTime())) {
        undated.push(a);
        continue;
      }

      if (due >= start && due < end) {
        const dayIdx = Math.floor(
          (startOfDay(due).getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
        const list = buckets.get(dayIdx) || [];
        list.push(a);
        buckets.set(dayIdx, list);
      }
    }

    // sort each day: missing first, then due time
    for (let i = 0; i < 7; i++) {
      const list = buckets.get(i) || [];
      list.sort((a, b) => {
        const am = isMissing(a);
        const bm = isMissing(b);
        if (am !== bm) return am ? -1 : 1;

        const at = a?.due_at ? new Date(a.due_at).getTime() : Infinity;
        const bt = b?.due_at ? new Date(b.due_at).getTime() : Infinity;
        return at - bt;
      });
      buckets.set(i, list);
    }

    const dayTotals = days.map((_, i) => {
      const list = buckets.get(i) || [];
      let total = 0;
      for (const a of list) total += getEstimateHours(a.course_id, a.id);
      return total;
    });

    const weekTotal = dayTotals.reduce((s, x) => s + x, 0);

    undated.sort((a, b) => {
      const am = isMissing(a);
      const bm = isMissing(b);
      if (am !== bm) return am ? -1 : 1;

      const ap = typeof a.points_possible === "number" ? a.points_possible : 0;
      const bp = typeof b.points_possible === "number" ? b.points_possible : 0;
      if (bp !== ap) return bp - ap;

      return (a.name || "").localeCompare(b.name || "");
    });

    return { start, end, days, buckets, undated, dayTotals, weekTotal };
  }, [items, weekStart, settings.showCompleted, storageTick]);

  if (loading) return <Loading label="Loading planner…" />;
  if (err) return <ErrorBox error={err} />;

  const capacity = settings.dailyCapacityHours;
  const weekLabel = `${view.days[0].toLocaleDateString()} – ${view.days[6].toLocaleDateString()}`;

  const scrollByPx = (dir) => {
    const el = scrollerRef.current;
    if (!el) return;
    const delta = Math.round(el.clientWidth * 0.85) * dir;
    el.scrollBy({ left: delta, behavior: "smooth" });
  };

  return (
    <div className="stack" style={{ width: "100%" }}>
      {/* Header + controls */}
      <div className="card">
        <div className="cardBody">
          <div className="rowWrap" style={{ justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div>
              <div className="h2">Weekly Planner</div>
              <div className="muted">
                Week of <span className="mono">{weekLabel}</span> • Total planned:{" "}
                <span className="mono">{view.weekTotal.toFixed(1)}h</span>
              </div>
            </div>

            <div className="rowWrap" style={{ gap: 10, alignItems: "center" }}>
              <button className="btn" onClick={() => setWeekStart((d) => addDays(d, -7))}>
                ← Prev
              </button>
              <button className="btn" onClick={() => setWeekStart(startOfWeekMonday(new Date()))}>
                Today
              </button>
              <button className="btn" onClick={() => setWeekStart((d) => addDays(d, 7))}>
                Next →
              </button>
              <button className="btn" onClick={refresh} title="Refresh from Canvas">
                Refresh
              </button>
            </div>
          </div>

          <div className="rowWrap" style={{ gap: 14, alignItems: "center", marginTop: 12 }}>
            <div className="muted">
              Daily capacity:{" "}
              <span className="mono" title="Used to warn about overloaded days">
                {capacity.toFixed(1)}h/day
              </span>
            </div>

            <input
              type="range"
              min="0.5"
              max="12"
              step="0.5"
              value={capacity}
              onChange={(e) => setSettings((s) => ({ ...s, dailyCapacityHours: Number(e.target.value) }))}
              style={{ width: 260 }}
              aria-label="Daily capacity hours"
            />

            <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.showCompleted}
                onChange={(e) => setSettings((s) => ({ ...s, showCompleted: e.target.checked }))}
              />
              Show completed
            </label>

            <div className="muted" style={{ marginLeft: "auto" }}>
              Tip: use <span className="mono">Effort</span> to estimate workload.
            </div>
          </div>
        </div>
      </div>

      {/* Week grid wrapper with scroll arrows + gradients */}
      <div style={{ position: "relative" }}>
        {/* left gradient cue */}
        {canScroll.left ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 28,
              pointerEvents: "none",
              background: "linear-gradient(to right, rgba(0,0,0,0.08), rgba(0,0,0,0))",
              borderRadius: 12,
              zIndex: 2,
            }}
          />
        ) : null}

        {/* right gradient cue */}
        {canScroll.right ? (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: 28,
              pointerEvents: "none",
              background: "linear-gradient(to left, rgba(0,0,0,0.08), rgba(0,0,0,0))",
              borderRadius: 12,
              zIndex: 2,
            }}
          />
        ) : null}

        {/* left arrow */}
        {canScroll.left ? (
          <button
            className="btn"
            onClick={() => scrollByPx(-1)}
            title="Scroll left"
            style={{
              position: "absolute",
              left: 8,
              top: 8,
              zIndex: 3,
              padding: "6px 10px",
              borderRadius: 999,
              opacity: 0.95,
            }}
          >
            ←
          </button>
        ) : null}

        {/* right arrow */}
        {canScroll.right ? (
          <button
            className="btn"
            onClick={() => scrollByPx(1)}
            title="Scroll right"
            style={{
              position: "absolute",
              right: 8,
              top: 8,
              zIndex: 3,
              padding: "6px 10px",
              borderRadius: 999,
              opacity: 0.95,
            }}
          >
            →
          </button>
        ) : null}

        {/* scroller */}
        <div
          ref={scrollerRef}
          style={{
            overflowX: "auto",
            paddingBottom: 6,
          }}
        >
          {/* 7 columns that try to fill the page; will scroll on small screens */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gap: 12,
              minWidth: 980, // helps avoid ultra-squished columns on small screens; scroll kicks in
              width: "100%",
            }}
          >
            {view.days.map((day, idx) => {
              const list = view.buckets.get(idx) || [];
              const total = view.dayTotals[idx];
              const overloaded = total > capacity + 1e-9;

              return (
                <div key={day.toISOString()} className="card">
                  <div className="cardBody" style={{ padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                      <div className="h3" style={{ margin: 0 }}>
                        {fmtDayHeader(day)}
                      </div>
                      <div className={`muted ${overloaded ? "dangerText" : ""}`} style={{ whiteSpace: "nowrap" }}>
                        <span className="mono">{total.toFixed(1)}h</span>
                        {overloaded ? <span> • Over</span> : null}
                      </div>
                    </div>

                    {list.length === 0 ? (
                      <div className="muted" style={{ marginTop: 8 }}>
                        No due items.
                      </div>
                    ) : (
                      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                        {list.map((a) => {
                          const missing = isMissing(a);
                          const courseLabel = a.course_name ?? "Unknown Course";
                          const dueTime = fmtTime(a.due_at);
                          const est = getEstimateHours(a.course_id, a.id);

                          return (
                            <div
                              key={`${a.course_id}-${a.id}`}
                              className={`card ${missing ? "dangerItem" : ""}`}
                              style={{
                                padding: 10,
                                borderRadius: 12,
                              }}
                            >
                              {/* top row: name + due time */}
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  gap: 10,
                                  alignItems: "baseline",
                                }}
                              >
                                <div
                                  style={{
                                    fontWeight: 600,
                                    lineHeight: 1.15,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                  title={a.name}
                                >
                                  {a.name}
                                </div>

                                <div
                                  className={`muted ${missing ? "dangerText" : ""}`}
                                  style={{ whiteSpace: "nowrap", fontSize: 12 }}
                                  title="Due time"
                                >
                                  {dueTime || "—"}
                                </div>
                              </div>

                              {/* course name */}
                              <div
                                className={`muted ${missing ? "dangerMuted" : ""}`}
                                style={{
                                  marginTop: 4,
                                  fontSize: 12,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={courseLabel}
                              >
                                {courseLabel}
                              </div>

                              {/* effort summary + control */}
                              <div style={{ marginTop: 8 }}>
                                <div className="muted" style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  <span>Effort:</span>
                                  <span className="mono">{est > 0 ? `${est.toFixed(1)}h` : "—"}</span>
                                </div>

                                <div style={{ marginTop: 6 }}>
                                  <WorkloadEstimateControl courseId={a.course_id} assignmentId={a.id} />
                                </div>
                              </div>

                              {/* actions */}
                              <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
                                <button
                                  className="btn"
                                  onClick={() => navigateToAssignment(a.course_id, a.id)}
                                  title="View this assignment in Upcoming assignments"
                                  style={{ whiteSpace: "nowrap" }}
                                >
                                  View assignment
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Undated assignments (kept lightweight) */}
      <div className="card">
        <div className="cardBody">
          <div className="h3" style={{ marginTop: 0 }}>
            Undated assignments
          </div>
          {view.undated.length === 0 ? (
            <div className="muted">None</div>
          ) : (
            <div className="muted">
              Count: <span className="mono">{view.undated.length}</span> • (These don’t appear in the calendar columns.)
            </div>
          )}

          {view.undated.length ? (
            <ul className="list" style={{ marginTop: 10 }}>
              {view.undated.slice(0, 10).map((a) => {
                const courseLabel = a.course_name ?? "Unknown Course";
                const missing = isMissing(a);
                const hasDesc = !!stripHtml(a.description);

                return (
                  <li key={`und-${a.course_id}-${a.id}`} className={`listItem ${missing ? "dangerItem" : ""}`}>
                    <div className="listMain">
                      <div className="listTitle">{a.name}</div>
                      <div className={`muted ${missing ? "dangerMuted" : ""}`}>
                        <span className="mono">{courseLabel}</span>
                        {hasDesc ? " • Description available" : ""}
                      </div>
                    </div>

                    <button className="btn" onClick={() => navigateToAssignment(a.course_id, a.id)}>
                      View
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {view.undated.length > 10 ? (
            <div className="muted" style={{ marginTop: 8 }}>
              Showing first 10 undated items.
            </div>
          ) : null}
        </div>
      </div>

      <div className="muted">
        Tip: if you see left/right arrows, you can scroll sideways to view the full week on smaller screens.
      </div>
    </div>
  );
}
