// src/pages/WeeklyPlanner.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { WorkloadEstimateControl } from "../components/WorkloadEstimateControl";
import { useCachedAsync } from "../hooks/useCachedAsync";

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
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtTime(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtShortDate(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

function clampHours(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(200, x));
}

function parseMaybeHours(raw) {
  if (raw == null) return null;

  const direct = Number(raw);
  if (Number.isFinite(direct)) return clampHours(direct);

  try {
    const obj = JSON.parse(raw);

    if (typeof obj === "number" && Number.isFinite(obj)) return clampHours(obj);
    if (typeof obj?.value === "number" && Number.isFinite(obj.value))
      return clampHours(obj.value);

    const h = typeof obj?.hours === "number" && Number.isFinite(obj.hours) ? obj.hours : 0;
    const m = typeof obj?.minutes === "number" && Number.isFinite(obj.minutes) ? obj.minutes : 0;
    const total = h + m / 60;
    if (Number.isFinite(total)) return clampHours(total);
  } catch {
    // ignore
  }

  return null;
}

function isoDay(d) {
  const x = startOfDay(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `split_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function loadPlannerSettings() {
  try {
    const raw = localStorage.getItem("weeklyPlanner:settings");
    if (!raw) return { dailyCapacityHours: 3.0, showCompleted: false, showCompletedSplits: true };

    const obj = JSON.parse(raw);
    return {
      dailyCapacityHours: Number.isFinite(Number(obj?.dailyCapacityHours))
        ? Number(obj.dailyCapacityHours)
        : 3.0,
      showCompleted: !!obj?.showCompleted,
      showCompletedSplits:
        typeof obj?.showCompletedSplits === "boolean" ? obj.showCompletedSplits : true,
    };
  } catch {
    return { dailyCapacityHours: 3.0, showCompleted: false, showCompletedSplits: true };
  }
}

function savePlannerSettings(settings) {
  localStorage.setItem("weeklyPlanner:settings", JSON.stringify(settings));
}

function loadSplits() {
  try {
    const raw = localStorage.getItem("weeklyPlanner:splits");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (s) =>
          s &&
          s.id &&
          s.courseId != null &&
          s.assignmentId != null &&
          s.dateISO &&
          s.hours != null
      )
      .map((s) => ({
        id: String(s.id),
        courseId: Number(s.courseId),
        assignmentId: Number(s.assignmentId),
        dateISO: String(s.dateISO),
        hours: Number(s.hours),
        completed: !!s.completed,
      }))
      .filter(
        (s) =>
          Number.isFinite(s.courseId) &&
          Number.isFinite(s.assignmentId) &&
          Number.isFinite(s.hours)
      );
  } catch {
    return [];
  }
}

function saveSplits(splits) {
  localStorage.setItem("weeklyPlanner:splits", JSON.stringify(splits));
}

function loadEffortKeyMap() {
  try {
    const raw = localStorage.getItem("weeklyPlanner:effortKeyMap");
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function saveEffortKeyMap(map) {
  localStorage.setItem("weeklyPlanner:effortKeyMap", JSON.stringify(map));
}

function navigateToAssignment(courseId, assignmentId) {
  localStorage.setItem(
    "nav:upcoming:target",
    JSON.stringify({ courseId, assignmentId, ts: Date.now() })
  );

  window.dispatchEvent(
    new CustomEvent("canvasbetter:navigate", { detail: { tab: "upcoming" } })
  );
}

function getPlannerBarVariant({ isSplit, splitCompleted, assignment }) {
  if (isSplit && splitCompleted) return "submitted";
  if (assignment?.submitted) return "submitted";
  if (isMissing(assignment)) return "missing";
  if (isSplit) return "split";
  return "original";
}

export function WeeklyPlanner() {
  // ✅ Cached upcoming (hydration prevents tab flash)
  const plannerQ = useCachedAsync(
    "planner:upcoming",
    ({ signal }) => canvasApi.getUpcoming({ signal }),
    { ttlMs: 60 * 1000 } // refresh-friendly
  );

  const items = Array.isArray(plannerQ.data) ? plannerQ.data : [];

  const [weekStart, setWeekStart] = useState(() => startOfWeekMonday(new Date()));
  const [settings, setSettings] = useState(() => loadPlannerSettings());

  const [splits, setSplits] = useState(() => loadSplits());
  const [splitDrafts, setSplitDrafts] = useState({});
  const [splitErrors, setSplitErrors] = useState({});

  const [effortKeyMap, setEffortKeyMap] = useState(() => loadEffortKeyMap());
  const [storageTick, setStorageTick] = useState(0);

  const scrollerRef = useRef(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  useEffect(() => saveSplits(splits), [splits]);
  useEffect(() => saveEffortKeyMap(effortKeyMap), [effortKeyMap]);

  useEffect(() => {
    function onStorage(e) {
      if (!e?.key) return;

      if (e.key.toLowerCase().includes("effort") || e.key.toLowerCase().includes("workload")) {
        setStorageTick((t) => t + 1);
      }

      if (e.key === "weeklyPlanner:settings") setSettings(loadPlannerSettings());
      if (e.key === "weeklyPlanner:splits") setSplits(loadSplits());
      if (e.key === "weeklyPlanner:effortKeyMap") setEffortKeyMap(loadEffortKeyMap());
    }

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Patch localStorage.setItem so same-tab changes tick the planner
  useEffect(() => {
    const original = localStorage.setItem;

    localStorage.setItem = function patchedSetItem(key, value) {
      original.call(this, key, value);

      try {
        if (typeof key === "string") {
          const lk = key.toLowerCase();
          if (lk.includes("effort") || lk.includes("workload")) {
            setStorageTick((t) => t + 1);
          }
          if (key === "weeklyPlanner:settings") setSettings(loadPlannerSettings());
        }
      } catch {
        // ignore
      }
    };

    return () => {
      localStorage.setItem = original;
    };
  }, []);

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
  }, [items, weekStart, splits]);

  const effortMapKey = (courseId, assignmentId) => `${String(courseId)}:${String(assignmentId)}`;

  const discoverEffortKeyFor = (courseId, assignmentId) => {
    const cid = String(courseId);
    const aid = String(assignmentId);

    const mapKey = effortMapKey(cid, aid);
    if (effortKeyMap[mapKey]) return effortKeyMap[mapKey];

    const candidates = [
      `workload:${cid}:${aid}`,
      `effort:${cid}:${aid}`,
      `bettercanvas:workload:${cid}:${aid}`,
      `bettercanvas:effort:${cid}:${aid}`,
      `workloadEstimate:${cid}:${aid}`,
      `workload_estimate:${cid}:${aid}`,
      `effortEstimate:${cid}:${aid}`,
      `effort_estimate:${cid}:${aid}`,
    ];

    for (const k of candidates) {
      const raw = localStorage.getItem(k);
      const v = parseMaybeHours(raw);
      if (v != null) {
        setEffortKeyMap((prev) => ({ ...prev, [mapKey]: k }));
        return k;
      }
    }

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;

        const lk = key.toLowerCase();
        if (!lk.includes("effort") && !lk.includes("workload")) continue;
        if (!key.includes(cid) || !key.includes(aid)) continue;

        const raw = localStorage.getItem(key);
        const v = parseMaybeHours(raw);
        if (v != null) {
          setEffortKeyMap((prev) => ({ ...prev, [mapKey]: key }));
          return key;
        }
      }
    } catch {
      // ignore
    }

    return null;
  };

  const getEstimateHours = (courseId, assignmentId) => {
    const mapKey = effortMapKey(courseId, assignmentId);
    const knownKey = effortKeyMap[mapKey] || discoverEffortKeyFor(courseId, assignmentId);
    if (!knownKey) return 0;

    const raw = localStorage.getItem(knownKey);
    const v = parseMaybeHours(raw);
    return v == null ? 0 : v;
  };

  const keyFor = (courseId, assignmentId) => `${courseId}:${assignmentId}`;

  const getDraft = (courseId, assignmentId) => {
    const key = keyFor(courseId, assignmentId);
    const d = splitDrafts[key] || {};
    return { dateISO: d.dateISO || "", hours: d.hours ?? "" };
  };

  const setDraft = (courseId, assignmentId, patch) => {
    const key = keyFor(courseId, assignmentId);
    setSplitDrafts((prev) => ({
      ...prev,
      [key]: { ...(prev[key] || {}), ...patch },
    }));
  };

  const setErrMsg = (courseId, assignmentId, msg) => {
    const key = keyFor(courseId, assignmentId);
    setSplitErrors((prev) => ({ ...prev, [key]: msg }));
  };

  const clearErrMsg = (courseId, assignmentId) => {
    const key = keyFor(courseId, assignmentId);
    setSplitErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const addSplit = (assignment) => {
    const courseId = assignment.course_id;
    const assignmentId = assignment.id;

    const draft = getDraft(courseId, assignmentId);
    const hours = Number(draft.hours);

    const todayISO = isoDay(new Date());
    const dueISO = assignment?.due_at ? isoDay(new Date(assignment.due_at)) : null;

    const defaultDateISO = dueISO && todayISO <= dueISO ? todayISO : dueISO || "";
    const targetISO = draft.dateISO || defaultDateISO;

    const totalEffort = getEstimateHours(courseId, assignmentId);

    const alreadySplit = splits
      .filter((s) => s.courseId === courseId && s.assignmentId === assignmentId)
      .reduce((acc, s) => acc + (Number.isFinite(s.hours) ? s.hours : 0), 0);

    const remaining = Math.max(0, totalEffort - alreadySplit);

    if (!targetISO) return setErrMsg(courseId, assignmentId, "Pick a split date.");
    if (!Number.isFinite(hours) || hours <= 0) return setErrMsg(courseId, assignmentId, "Enter split hours > 0.");

    if (hours > remaining + 1e-9)
      return setErrMsg(courseId, assignmentId, `Can't split more than remaining (${remaining.toFixed(1)}h).`);

    if (targetISO < todayISO) return setErrMsg(courseId, assignmentId, "Can't split into a past date.");
    if (dueISO && targetISO > dueISO) return setErrMsg(courseId, assignmentId, `Can't split after due date (${dueISO}).`);

    clearErrMsg(courseId, assignmentId);

    const existingIdx = splits.findIndex(
      (s) => s.courseId === courseId && s.assignmentId === assignmentId && s.dateISO === targetISO
    );

    if (existingIdx >= 0) {
      setSplits((prev) => {
        const next = [...prev];
        const cur = next[existingIdx];
        const newHours = Math.round((cur.hours + hours) * 100) / 100;
        next[existingIdx] = { ...cur, hours: newHours };
        return next;
      });
    } else {
      setSplits((prev) => [
        ...prev,
        {
          id: makeId(),
          courseId,
          assignmentId,
          dateISO: targetISO,
          hours: Math.round(hours * 100) / 100,
          completed: false,
        },
      ]);
    }

    setDraft(courseId, assignmentId, { hours: "" });
  };

  const removeSplit = (splitId) => {
    setSplits((prev) => prev.filter((s) => s.id !== splitId));
  };

  const toggleSplitCompleted = (splitId, checked) => {
    setSplits((prev) => prev.map((s) => (s.id === splitId ? { ...s, completed: !!checked } : s)));
  };

  const view = useMemo(() => {
    const start = startOfDay(weekStart);
    const end = addDays(start, 7);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

    const buckets = new Map();
    for (let i = 0; i < 7; i++) buckets.set(i, []);
    const undated = [];

    const splitsByKey = new Map();
    for (const s of splits) {
      const key = `${s.courseId}:${s.assignmentId}`;
      const list = splitsByKey.get(key) || [];
      list.push(s);
      splitsByKey.set(key, list);
    }

    const splitSum = (courseId, assignmentId) => {
      const key = `${courseId}:${assignmentId}`;
      const list = splitsByKey.get(key) || [];
      return list.reduce((acc, s) => acc + (Number.isFinite(s.hours) ? s.hours : 0), 0);
    };

    // split entries
    for (const s of splits) {
      if (!settings.showCompletedSplits && s.completed) continue;

      const splitDay = new Date(`${s.dateISO}T00:00:00`);
      if (!Number.isFinite(splitDay.getTime())) continue;

      if (splitDay >= start && splitDay < end) {
        const dayIdx = Math.floor((splitDay.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        const list = buckets.get(dayIdx) || [];
        list.push({ __kind: "split", split: s });
        buckets.set(dayIdx, list);
      }
    }

    // base entries
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
        const dayIdx = Math.floor((startOfDay(due).getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        const list = buckets.get(dayIdx) || [];
        list.push({ __kind: "base", assignment: a, splitAway: splitSum(a.course_id, a.id) });
        buckets.set(dayIdx, list);
      }
    }

    for (let i = 0; i < 7; i++) {
      const list = buckets.get(i) || [];
      list.sort((x, y) => {
        if (x.__kind !== y.__kind) return x.__kind === "base" ? -1 : 1;

        if (x.__kind === "base") {
          const a = x.assignment;
          const b = y.assignment;
          const am = isMissing(a);
          const bm = isMissing(b);
          if (am !== bm) return am ? -1 : 1;

          const at = a?.due_at ? new Date(a.due_at).getTime() : Infinity;
          const bt = b?.due_at ? new Date(b.due_at).getTime() : Infinity;
          return at - bt;
        }

        if (!!x.split.completed !== !!y.split.completed) return x.split.completed ? 1 : -1;
        if ((y.split.hours || 0) !== (x.split.hours || 0)) return (y.split.hours || 0) - (x.split.hours || 0);
        return String(x.split.id).localeCompare(String(y.split.id));
      });
      buckets.set(i, list);
    }

    const dayTotals = days.map((_, i) => {
      const list = buckets.get(i) || [];
      let total = 0;

      for (const entry of list) {
        if (entry.__kind === "split") {
          total += Number.isFinite(entry.split.hours) ? entry.split.hours : 0;
        } else {
          const a = entry.assignment;
          const totalEffort = getEstimateHours(a.course_id, a.id);
          const remaining = Math.max(0, totalEffort - (entry.splitAway || 0));
          total += remaining;
        }
      }

      return total;
    });

    const weekTotal = dayTotals.reduce((s, x) => s + x, 0);

    undated.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    return { days, buckets, undated, dayTotals, weekTotal };
  }, [items, weekStart, settings.showCompleted, settings.showCompletedSplits, storageTick, splits, effortKeyMap]);

  // ✅ Errors/loading based on cached query
  if (plannerQ.error) return <ErrorBox error={plannerQ.error} />;

  // Only show big loading when we have nothing cached yet
  if (plannerQ.loading && items.length === 0) return <Loading label="Loading planner…" />;

  const capacity = settings.dailyCapacityHours;
  const weekLabel =
    view.days.length >= 7
      ? `${view.days[0].toLocaleDateString()} – ${view.days[6].toLocaleDateString()}`
      : "";

  const scrollByPx = (dir) => {
    const el = scrollerRef.current;
    if (!el) return;
    const delta = Math.round(el.clientWidth * 0.85) * dir;
    el.scrollBy({ left: delta, behavior: "smooth" });
  };

  const setCapacityFromInput = (val) => {
    const n = Number(val);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0.5, Math.min(12, n));
    setSettings((s) => {
      const next = { ...s, dailyCapacityHours: clamped };
      savePlannerSettings(next);
      return next;
    });
  };

  return (
    <div className="stack" style={{ width: "100%" }}>
      <div className="card">
        <div className="cardBody">
          <div className="rowWrap" style={{ justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div>
              <div className="h2">Weekly Planner</div>
              <div className="muted">
                Week of <span className="mono">{weekLabel}</span> • Total planned:{" "}
                <span className="mono">{view.weekTotal.toFixed(1)}h</span>
                {plannerQ.refreshing ? <span className="muted"> {" "}• Updating…</span> : null}
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
              <button className="btn" onClick={() => plannerQ.refresh()} title="Refresh from Canvas">
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
              onChange={(e) => setCapacityFromInput(e.target.value)}
              style={{ width: 220 }}
              aria-label="Daily capacity hours"
            />

            <input
              type="number"
              min="0.5"
              max="12"
              step="0.5"
              value={capacity}
              onChange={(e) => setCapacityFromInput(e.target.value)}
              style={{ width: 90 }}
              aria-label="Daily capacity numeric"
              title="Type a capacity value"
            />

            <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={!!settings.showCompleted}
                onClick={(e) => e.stopPropagation()}
                onChange={() =>
                  setSettings((s) => {
                    const next = { ...s, showCompleted: !s.showCompleted };
                    savePlannerSettings(next);
                    return next;
                  })
                }
              />
              Show submitted
            </label>

            <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={!!settings.showCompletedSplits}
                onClick={(e) => e.stopPropagation()}
                onChange={() =>
                  setSettings((s) => {
                    const next = { ...s, showCompletedSplits: !s.showCompletedSplits };
                    savePlannerSettings(next);
                    return next;
                  })
                }
              />
              Show completed (planned splits)
            </label>

            <div className="muted" style={{ marginLeft: "auto" }}>
              Tip: red = missing • green = completed • blue = due date • yellow = split
            </div>
          </div>
        </div>
      </div>

      <div style={{ position: "relative" }}>
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

        <div ref={scrollerRef} style={{ overflowX: "auto", paddingBottom: 6 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gap: 12,
              minWidth: 980,
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
                        {list.map((entry) => {
                          if (entry.__kind === "split") {
                            const s = entry.split;
                            const a = (items || []).find((x) => x.course_id === s.courseId && x.id === s.assignmentId);

                            const name = a?.name || `Assignment ${s.assignmentId}`;
                            const courseLabel = a?.course_name ?? "Unknown Course";
                            const dueTime = fmtTime(a?.due_at);
                            const dueDate = fmtShortDate(a?.due_at);

                            const barVariant = getPlannerBarVariant({
                              isSplit: true,
                              splitCompleted: s.completed,
                              assignment: a,
                            });

                            return (
                              <div key={`split-${s.id}`} className="plannerCard">
                                <div className={`plannerBar plannerBar-${barVariant}`} />
                                <div className="plannerContent">
                                  <div className="plannerTitle" title={name}>
                                    {name}
                                  </div>

                                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
                                    <div className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                                      Due: <span className="mono">{dueDate || "—"}</span>{" "}
                                      <span className="mono">{dueTime || ""}</span>
                                    </div>
                                  </div>

                                  <div
                                    className="muted"
                                    style={{
                                      marginTop: 6,
                                      fontSize: 12,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                    title={courseLabel}
                                  >
                                    <span className="mono">{courseLabel}</span>
                                  </div>

                                  <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                                    <label className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                                      <input
                                        type="checkbox"
                                        checked={!!s.completed}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => toggleSplitCompleted(s.id, e.target.checked)}
                                      />
                                      Completed
                                    </label>

                                    <div className="muted" style={{ fontSize: 12 }}>
                                      Planned: <span className="mono">{s.hours.toFixed(1)}h</span> on{" "}
                                      <span className="mono">{s.dateISO}</span>
                                    </div>

                                    <button className="btn btnDanger" onClick={() => removeSplit(s.id)}>
                                      Remove
                                    </button>

                                    <button className="btn" onClick={() => navigateToAssignment(s.courseId, s.assignmentId)}>
                                      View assignment
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          // base cards
                          const a = entry.assignment;
                          const courseLabel = a.course_name ?? "Unknown Course";
                          const dueTime = fmtTime(a.due_at);
                          const dueDate = fmtShortDate(a.due_at);

                          const totalEffort = getEstimateHours(a.course_id, a.id);
                          const splitAway = entry.splitAway || 0;
                          const remaining = Math.max(0, totalEffort - splitAway);

                          const todayISO = isoDay(new Date());
                          const dueISO = a?.due_at ? isoDay(new Date(a.due_at)) : null;
                          const defaultDateISO = dueISO && todayISO <= dueISO ? todayISO : dueISO || "";

                          const draft = getDraft(a.course_id, a.id);
                          const effectiveDateISO = draft.dateISO || defaultDateISO;
                          const errMsg = splitErrors[keyFor(a.course_id, a.id)];

                          const barVariant = getPlannerBarVariant({ isSplit: false, splitCompleted: false, assignment: a });

                          return (
                            <div key={`${a.course_id}-${a.id}`} className="plannerCard">
                              <div className={`plannerBar plannerBar-${barVariant}`} />
                              <div className="plannerContent">
                                <div className="plannerTitle" title={a.name}>
                                  {a.name}
                                </div>

                                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
                                  <div className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                                    Due: <span className="mono">{dueDate || "—"}</span>{" "}
                                    <span className="mono">{dueTime || ""}</span>
                                  </div>
                                </div>

                                <div
                                  className="muted"
                                  style={{
                                    marginTop: 6,
                                    fontSize: 12,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={courseLabel}
                                >
                                  <span className="mono">{courseLabel}</span>
                                </div>

                                <div style={{ marginTop: 8 }}>
                                  <WorkloadEstimateControl courseId={a.course_id} assignmentId={a.id} />
                                </div>

                                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                                  Remaining on due date: <span className="mono">{remaining.toFixed(1)}h</span>
                                </div>

                                <div style={{ marginTop: 10 }}>
                                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                                    Split work to an earlier day:
                                  </div>

                                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                                    <label className="muted" style={{ fontSize: 12 }}>
                                      Date{" "}
                                      <input
                                        type="date"
                                        value={effectiveDateISO}
                                        min={todayISO}
                                        max={dueISO || undefined}
                                        onChange={(e) => {
                                          setDraft(a.course_id, a.id, { dateISO: e.target.value });
                                          clearErrMsg(a.course_id, a.id);
                                        }}
                                        style={{ marginLeft: 6 }}
                                      />
                                    </label>

                                    <label className="muted" style={{ fontSize: 12 }}>
                                      Hours{" "}
                                      <input
                                        type="number"
                                        min="0"
                                        step="0.25"
                                        value={draft.hours}
                                        onChange={(e) => {
                                          setDraft(a.course_id, a.id, { hours: e.target.value });
                                          clearErrMsg(a.course_id, a.id);
                                        }}
                                        style={{ width: 90, marginLeft: 6 }}
                                      />
                                    </label>

                                    <button className="btn" onClick={() => addSplit(a)} disabled={remaining <= 0}>
                                      Split
                                    </button>

                                    <div className="muted" style={{ fontSize: 12 }}>
                                      Max: <span className="mono">{remaining.toFixed(1)}h</span>
                                    </div>

                                    <button className="btn" onClick={() => navigateToAssignment(a.course_id, a.id)}>
                                      View assignment
                                    </button>
                                  </div>

                                  {errMsg ? (
                                    <div className="dangerText" style={{ marginTop: 6, fontSize: 12 }}>
                                      {errMsg}
                                    </div>
                                  ) : null}
                                </div>
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
                const hasDesc = !!stripHtml(a.description);

                return (
                  <li key={`und-${a.course_id}-${a.id}`} className="listItem">
                    <div className="listMain">
                      <div className="listTitle">{a.name}</div>
                      <div className="muted">
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
        </div>
      </div>

      <div className="card">
        <div className="cardBody">
          <div className="h3" style={{ marginTop: 0 }}>
            Reset planner cache
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            This will delete <span className="mono">all split cards</span>, clear planner settings, and remove
            <span className="mono"> all effort/workload estimates</span> stored in this browser.
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              className="btn btnDanger"
              onClick={() => {
                const ok = window.confirm(
                  "Reset planner cache?\n\nThis will:\n- Delete all split cards\n- Clear planner settings\n- Clear ALL effort/workload estimates stored in this browser\n\nThis cannot be undone."
                );
                if (!ok) return;

                try {
                  const toRemove = [];
                  for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (!k) continue;
                    const lk = k.toLowerCase();
                    if (lk.includes("effort") || lk.includes("workload")) toRemove.push(k);
                  }
                  for (const k of toRemove) localStorage.removeItem(k);
                } catch {
                  // ignore
                }

                localStorage.removeItem("weeklyPlanner:splits");
                localStorage.removeItem("weeklyPlanner:settings");
                localStorage.removeItem("weeklyPlanner:effortKeyMap");
                localStorage.removeItem("nav:upcoming:target");

                setSplits([]);
                setSplitDrafts({});
                setSplitErrors({});
                setSettings({ dailyCapacityHours: 3.0, showCompleted: false, showCompletedSplits: true });
                setEffortKeyMap({});
                setStorageTick((t) => t + 1);
              }}
            >
              Reset cache (deletes splits + effort)
            </button>
          </div>
        </div>
      </div>

      <div className="muted">
        Tip: if you see left/right arrows, you can scroll sideways to view the full week on smaller screens.
      </div>
    </div>
  );
}
