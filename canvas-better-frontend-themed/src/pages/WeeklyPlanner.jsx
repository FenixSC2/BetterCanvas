// src/pages/WeeklyPlanner.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { canvasApi } from "../api/canvasApi";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { WorkloadEstimateControl } from "../components/WorkloadEstimateControl";
import { useCachedAsync } from "../hooks/useCachedAsync";
import {
  addCompletedHours,
  getEffortState,
  setCompletedHours,
} from "../lib/workloadEstimates";

/* ---------------- date/time helpers ---------------- */
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
function isoDay(d) {
  const x = startOfDay(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

/* ---------------- effort parsing helpers (legacy discovery) ---------------- */
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

    const h =
      typeof obj?.hours === "number" && Number.isFinite(obj.hours)
        ? obj.hours
        : 0;
    const m =
      typeof obj?.minutes === "number" && Number.isFinite(obj.minutes)
        ? obj.minutes
        : 0;
    const total = h + m / 60;
    if (Number.isFinite(total)) return clampHours(total);
  } catch {
    // ignore
  }

  return null;
}

// 
function DoubleChevronIcon({ direction = "down" }) {
  // Your uploaded icon: double chevron. We'll draw it as SVG.
  // direction: "up" | "down"
  const rotate = direction === "up" ? "rotate(180 12 12)" : undefined;

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g transform={rotate}>
        <path
          d="M6 7l6 6 6-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M6 12l6 6 6-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

function ScrollableDayList({ children, style, className = "" }) {
  const ref = useRef(null);
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);

  function recompute() {
    const el = ref.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;

    setCanUp(scrollTop > 2);
    setCanDown(scrollTop + clientHeight < scrollHeight - 2);
  }

  useEffect(() => {
    recompute();
    const el = ref.current;
    if (!el) return;

    const onScroll = () => recompute();
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(() => recompute());
    ro.observe(el);

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  function scrollToTop() {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToBottom() {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className={`plannerDayList ${className}`} ref={ref} style={style}>
      <button
        type="button"
        className={`plannerScrollBtn up ${canUp ? "" : "hidden"}`}
        onClick={scrollToTop}
        aria-label="Scroll to top"
        title="Scroll to top"
      >
        <DoubleChevronIcon direction="up" />
      </button>

      <button
        type="button"
        className={`plannerScrollBtn down ${canDown ? "" : "hidden"}`}
        onClick={scrollToBottom}
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
      >
        <DoubleChevronIcon direction="down" />
      </button>

      {children}
    </div>
  );
}

/* ---------------- persistence ---------------- */
function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return `split_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function loadPlannerSettings() {
  try {
    const raw = localStorage.getItem("weeklyPlanner:settings");
    if (!raw) return { dailyCapacityHours: 3.0, showCompleted: false };

    const obj = JSON.parse(raw);
    return {
      dailyCapacityHours: Number.isFinite(Number(obj?.dailyCapacityHours))
        ? Number(obj.dailyCapacityHours)
        : 3.0,
      showCompleted: !!obj?.showCompleted,
    };
  } catch {
    return { dailyCapacityHours: 3.0, showCompleted: false };
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
        effortApplied: !!s.effortApplied,
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

/* ---------------- navigation ---------------- */
function navigateToAssignment(courseId, assignmentId) {
  localStorage.setItem(
    "nav:upcoming:target",
    JSON.stringify({ courseId, assignmentId, ts: Date.now() })
  );

  window.dispatchEvent(
    new CustomEvent("canvasbetter:navigate", { detail: { tab: "upcoming" } })
  );
}

/**
 * IMPORTANT:
 * - "Submitted" should ONLY mean Canvas submission (assignment.submitted === true).
 * - "Complete" is ONLY from the workload estimate system / completion.
 */
function getPlannerBarVariant({ isSplit, assignment }) {
  if (assignment?.submitted) return "submitted";
  if (isMissing(assignment)) return "missing";
  if (isSplit) return "split";
  return "original";
}

/* ---------------- Anchored popover (like WorkloadEstimateControl) ---------------- */
function AnchoredPopover({
  open,
  onClose,
  anchorEl,
  children,
  side = "left",
  gap = 10,
  width = 420,
}) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;

    function recompute() {
      if (!anchorEl) return;

      const rect = anchorEl.getBoundingClientRect();
      const margin = 10;

      let left = side === "right" ? rect.right + gap : rect.left - gap - width;
      left = Math.max(
        margin,
        Math.min(left, window.innerWidth - width - margin)
      );

      let top = rect.top;
      const maxTop = window.innerHeight - margin;
      top = Math.max(margin, Math.min(top, maxTop));

      setPos({ top, left });
    }

    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }

    function onClick(e) {
      const panel = panelRef.current;
      if (!panel) return;

      const t = e.target;
      if (panel.contains(t)) return;
      if (anchorEl && anchorEl.contains(t)) return;

      onClose?.();
    }

    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);

    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open, onClose, anchorEl, side, gap, width]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="card"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width,
        zIndex: 9999,
        boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
      }}
    >
      <div className="cardBody">{children}</div>
    </div>,
    document.body
  );
}

export function WeeklyPlanner() {
  // ✅ Cached upcoming
  const plannerQ = useCachedAsync(
    "planner:upcoming",
    ({ signal }) => canvasApi.getUpcoming({ signal }),
    { ttlMs: 60 * 1000 }
  );

  const itemsRaw = Array.isArray(plannerQ.data) ? plannerQ.data : [];

  const [weekStart, setWeekStart] = useState(() =>
    startOfWeekMonday(new Date())
  );
  const [settings, setSettings] = useState(() => loadPlannerSettings());

  const [splits, setSplits] = useState(() => loadSplits());
  const [splitDrafts, setSplitDrafts] = useState({});
  const [splitErrors, setSplitErrors] = useState({});

  const [effortKeyMap, setEffortKeyMap] = useState(() => loadEffortKeyMap());
  const [storageTick, setStorageTick] = useState(0);

  const [courseFilter, setCourseFilter] = useState("all");
  const [sortMode, setSortMode] = useState("time");

  // anchored split popover state
  const [splitPopOpen, setSplitPopOpen] = useState(false);
  const [splitPopAnchor, setSplitPopAnchor] = useState(null);
  const [splitPopAssignment, setSplitPopAssignment] = useState(null);
  const [splitPopDateISO, setSplitPopDateISO] = useState("");
  const [splitPopHours, setSplitPopHours] = useState("");
  const [splitPopErr, setSplitPopErr] = useState("");

  useEffect(() => saveSplits(splits), [splits]);
  useEffect(() => saveEffortKeyMap(effortKeyMap), [effortKeyMap]);

  useEffect(() => {
    function onStorage(e) {
      if (!e?.key) return;

      if (
        e.key.toLowerCase().includes("effort") ||
        e.key.toLowerCase().includes("workload")
      ) {
        setStorageTick((t) => t + 1);
      }

      if (e.key === "weeklyPlanner:settings")
        setSettings(loadPlannerSettings());
      if (e.key === "weeklyPlanner:splits") setSplits(loadSplits());
      if (e.key === "weeklyPlanner:effortKeyMap")
        setEffortKeyMap(loadEffortKeyMap());
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
          if (key === "weeklyPlanner:settings")
            setSettings(loadPlannerSettings());
        }
      } catch {
        // ignore
      }
    };

    return () => {
      localStorage.setItem = original;
    };
  }, []);

  // ---- Workload estimate helpers (use same state the widget uses) ----
  function getWorkloadState(courseId, assignmentId) {
    try {
      void storageTick;
      const st = getEffortState({ courseId, assignmentId });
      return st && typeof st === "object" ? st : null;
    } catch {
      return null;
    }
  }
  function workloadEstimateHours(courseId, assignmentId) {
    const st = getWorkloadState(courseId, assignmentId);
    const est = Number(st?.estimateHours);
    return Number.isFinite(est) ? est : 0;
  }
  function workloadCompletedHours(courseId, assignmentId) {
    const st = getWorkloadState(courseId, assignmentId);
    const c = Number(st?.completedHours);
    return Number.isFinite(c) ? c : 0;
  }
  function workloadRemainingHours(courseId, assignmentId) {
    const est = workloadEstimateHours(courseId, assignmentId);
    const done = workloadCompletedHours(courseId, assignmentId);
    return Math.max(0, est - done);
  }
  function isWorkloadComplete(courseId, assignmentId) {
    const st = getWorkloadState(courseId, assignmentId);
    if (st?.completed === true) return true;
    const est = workloadEstimateHours(courseId, assignmentId);
    if (est <= 0) return false;
    return workloadRemainingHours(courseId, assignmentId) <= 1e-9;
  }

  const effortMapKey = (courseId, assignmentId) =>
    `${String(courseId)}:${String(assignmentId)}`;

  // Legacy discovery (kept) — used only for mapping historical keys
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

  const items = useMemo(() => {
    if (courseFilter === "all") return itemsRaw;
    const cid = Number(courseFilter);
    if (!Number.isFinite(cid)) return itemsRaw;
    return itemsRaw.filter((a) => Number(a.course_id) === cid);
  }, [itemsRaw, courseFilter]);

  const courseOptions = useMemo(() => {
    const map = new Map();
    for (const a of itemsRaw) {
      const cid = a?.course_id;
      if (cid == null) continue;
      const name = a?.course_name || `Course ${cid}`;
      map.set(String(cid), name);
    }
    const arr = Array.from(map.entries()).map(([id, name]) => ({ id, name }));
    arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [itemsRaw]);

  const filteredSplits = useMemo(() => {
    if (courseFilter === "all") return splits;
    const cid = Number(courseFilter);
    if (!Number.isFinite(cid)) return splits;
    return splits.filter((s) => Number(s.courseId) === cid);
  }, [splits, courseFilter]);

  // Remaining you can split for an assignment:
  // - If estimate exists: cap = (remaining effort) - already planned splits
  // - If estimate does NOT exist: return null (no cap, still allow splitting)
  const maxRemainingFor = (assignment) => {
    const courseId = assignment.course_id;
    const assignmentId = assignment.id;

    const est = workloadEstimateHours(courseId, assignmentId);
    const rem = workloadRemainingHours(courseId, assignmentId);

    const alreadySplit = filteredSplits
      .filter((s) => s.courseId === courseId && s.assignmentId === assignmentId)
      .reduce((acc, s) => acc + (Number.isFinite(s.hours) ? s.hours : 0), 0);

    if (est <= 0) return null; // allow, but no cap

    return Math.max(0, rem - alreadySplit);
  };

  const addSplit = (assignment, payload /* {dateISO, hours} */) => {
    const courseId = assignment.course_id;
    const assignmentId = assignment.id;

    const hours = Number(payload?.hours);
    const targetISO = String(payload?.dateISO || "");

    const todayISO = isoDay(new Date());
    const dueISO = assignment?.due_at
      ? isoDay(new Date(assignment.due_at))
      : null;

    const cap = maxRemainingFor(assignment);

    if (!targetISO)
      return setErrMsg(courseId, assignmentId, "Pick a split date.");
    if (!Number.isFinite(hours) || hours <= 0)
      return setErrMsg(courseId, assignmentId, "Enter split hours > 0.");

    // Only enforce cap if we have an estimate
    if (cap != null && hours > cap + 1e-9)
      return setErrMsg(
        courseId,
        assignmentId,
        `Can't split more than remaining (${cap.toFixed(1)}h).`
      );

    if (targetISO < todayISO)
      return setErrMsg(courseId, assignmentId, "Can't split into a past date.");
    if (dueISO && targetISO > dueISO)
      return setErrMsg(
        courseId,
        assignmentId,
        `Can't split after due date (${dueISO}).`
      );

    clearErrMsg(courseId, assignmentId);

    const existingIdx = splits.findIndex(
      (s) =>
        s.courseId === courseId &&
        s.assignmentId === assignmentId &&
        s.dateISO === targetISO
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
          effortApplied: false,
        },
      ]);
    }

    setDraft(courseId, assignmentId, { hours: "" });
  };

  const removeSplit = (splitId) => {
    setSplits((prev) => prev.filter((s) => s.id !== splitId));
  };

  const toggleSplitCompleted = (splitId, checked) => {
    setSplits((prev) =>
      prev.map((s) => (s.id === splitId ? { ...s, completed: !!checked } : s))
    );

    const s = splits.find((x) => x.id === splitId);
    if (!s) return;

    const courseId = s.courseId;
    const assignmentId = s.assignmentId;
    const h = Number.isFinite(s.hours) ? s.hours : 0;

    if (checked) {
      if (h <= 0) return;
      if (s.effortApplied) return;

      addCompletedHours({ courseId, assignmentId }, h);

      setSplits((prev) =>
        prev.map((x) => (x.id === splitId ? { ...x, effortApplied: true } : x))
      );
      setStorageTick((t) => t + 1);
      return;
    }

    if (!s.effortApplied) return;

    const st = getEffortState({ courseId, assignmentId });
    const cur = Number.isFinite(st?.completedHours) ? st.completedHours : 0;
    const next = Math.max(0, cur - h);
    setCompletedHours({ courseId, assignmentId }, next);

    setSplits((prev) =>
      prev.map((x) => (x.id === splitId ? { ...x, effortApplied: false } : x))
    );
    setStorageTick((t) => t + 1);
  };

  function openSplitPopover(e, assignment) {
    const btn = e?.currentTarget || null;

    const todayISO = isoDay(new Date());
    const dueISO = assignment?.due_at ? isoDay(new Date(assignment.due_at)) : null;
    const defaultDateISO =
      dueISO && todayISO <= dueISO ? todayISO : dueISO || "";

    const draft = getDraft(assignment.course_id, assignment.id);
    const dateISO = draft.dateISO || defaultDateISO;

    setSplitPopErr("");
    setSplitPopAssignment(assignment);
    setSplitPopAnchor(btn);
    setSplitPopDateISO(dateISO || "");
    setSplitPopHours(draft.hours ?? "");
    setSplitPopOpen(true);
  }

  function closeSplitPopover() {
    setSplitPopOpen(false);
    setSplitPopAnchor(null);
    setSplitPopAssignment(null);
    setSplitPopErr("");
  }

  function applySplitFromPopover() {
    const a = splitPopAssignment;
    if (!a) return;

    const courseId = a.course_id;
    const assignmentId = a.id;

    const todayISO = isoDay(new Date());
    const dueISO = a?.due_at ? isoDay(new Date(a.due_at)) : null;

    const cap = maxRemainingFor(a);
    const h = Number(splitPopHours);
    const targetISO = String(splitPopDateISO || "");

    if (!targetISO) return setSplitPopErr("Pick a split date.");
    if (!Number.isFinite(h) || h <= 0) return setSplitPopErr("Enter split hours > 0.");
    if (targetISO < todayISO) return setSplitPopErr("Can't split into a past date.");
    if (dueISO && targetISO > dueISO) return setSplitPopErr(`Can't split after due date (${dueISO}).`);

    // Only enforce cap if we have an estimate
    if (cap != null && h > cap + 1e-9)
      return setSplitPopErr(`Can't split more than remaining (${cap.toFixed(1)}h).`);

    setSplitPopErr("");

    setDraft(courseId, assignmentId, { dateISO: targetISO, hours: "" });
    clearErrMsg(courseId, assignmentId);

    addSplit(a, { dateISO: targetISO, hours: h });
    closeSplitPopover();
  }

  // ---- One badge rule helper ----
  function renderSingleStatusBadge({ missing, submitted, complete }) {
    if (missing) return <span className="badge badgeDanger">Missing</span>;
    if (submitted) return <span className="badge badgeSuccess">Submitted</span>;
    if (complete) return <span className="badge badgeNeutral">Complete</span>;
    return null;
  }

  const view = useMemo(() => {
    const start = startOfDay(weekStart);
    const end = addDays(start, 7);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

    const buckets = new Map();
    for (let i = 0; i < 7; i++) buckets.set(i, []);
    const undated = [];

    const splitsByKey = new Map();
    for (const s of filteredSplits) {
      const key = `${s.courseId}:${s.assignmentId}`;
      const list = splitsByKey.get(key) || [];
      list.push(s);
      splitsByKey.set(key, list);
    }

    const splitSum = (courseId, assignmentId) => {
      const key = `${courseId}:${assignmentId}`;
      const list = splitsByKey.get(key) || [];
      return list.reduce(
        (acc, s) => acc + (Number.isFinite(s.hours) ? s.hours : 0),
        0
      );
    };

    // split entries (always visible)
    for (const s of filteredSplits) {
      const splitDay = new Date(`${s.dateISO}T00:00:00`);
      if (!Number.isFinite(splitDay.getTime())) continue;

      if (splitDay >= start && splitDay < end) {
        const dayIdx = Math.floor(
          (splitDay.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
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
        const dayIdx = Math.floor(
          (startOfDay(due).getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
        const list = buckets.get(dayIdx) || [];
        list.push({
          __kind: "base",
          assignment: a,
          splitAway: splitSum(a.course_id, a.id),
        });
        buckets.set(dayIdx, list);
      }
    }

    for (let i = 0; i < 7; i++) {
      const list = buckets.get(i) || [];
      list.sort((x, y) => {
        if (x.__kind !== y.__kind) return x.__kind === "base" ? -1 : 1;

        if (sortMode === "course") {
          const ax =
            x.__kind === "base"
              ? x.assignment
              : (itemsRaw || []).find(
                  (it) =>
                    it.course_id === x.split.courseId &&
                    it.id === x.split.assignmentId
                );
          const ay =
            y.__kind === "base"
              ? y.assignment
              : (itemsRaw || []).find(
                  (it) =>
                    it.course_id === y.split.courseId &&
                    it.id === y.split.assignmentId
                );
          const ac = (ax?.course_name || "").toLowerCase();
          const bc = (ay?.course_name || "").toLowerCase();
          if (ac !== bc) return ac.localeCompare(bc);
        }

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

        if (!!x.split.completed !== !!y.split.completed)
          return x.split.completed ? 1 : -1;
        if ((y.split.hours || 0) !== (x.split.hours || 0))
          return (y.split.hours || 0) - (x.split.hours || 0);
        return String(x.split.id).localeCompare(String(y.split.id));
      });
      buckets.set(i, list);
    }

    // Planned totals now tied to workload estimate state (same data as widget)
    const dayTotals = days.map((_, i) => {
      const list = buckets.get(i) || [];
      let total = 0;

      for (const entry of list) {
        if (entry.__kind === "split") {
          if (!entry.split.completed) {
            total += Number.isFinite(entry.split.hours) ? entry.split.hours : 0;
          }
          continue;
        }

        const a = entry.assignment;
        if (a?.submitted) continue;

        const rem = workloadRemainingHours(a.course_id, a.id);
        const planned = Math.max(0, rem - (entry.splitAway || 0));
        total += planned;
      }

      return total;
    });

    const weekTotal = dayTotals.reduce((s, x) => s + x, 0);
    undated.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    return { start, end, days, buckets, undated, dayTotals, weekTotal };
  }, [
    items,
    itemsRaw,
    weekStart,
    settings.showCompleted,
    storageTick,
    filteredSplits,
    effortKeyMap,
    sortMode,
  ]);

  const nextUp = useMemo(() => {
    const after = view.end.getTime();
    const upcoming = (items || [])
      .filter((a) => a?.due_at)
      .map((a) => ({ a, t: new Date(a.due_at).getTime() }))
      .filter((x) => Number.isFinite(x.t) && x.t >= after)
      .filter((x) => (settings.showCompleted ? true : !x.a.submitted))
      .sort((x, y) => x.t - y.t)
      .slice(0, 3) // ✅ limit
      .map((x) => x.a);
    return upcoming;
  }, [items, view.end, settings.showCompleted]);

  if (plannerQ.error) return <ErrorBox error={plannerQ.error} />;
  if (plannerQ.loading && itemsRaw.length === 0)
    return <Loading label="Loading planner…" />;

  const capacity = settings.dailyCapacityHours;

  const weekLabel =
    view.days.length >= 7
      ? `${view.days[0].toLocaleDateString()} – ${view.days[6].toLocaleDateString()}`
      : "";

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

  const isTodayISO = isoDay(new Date());

  return (
    <div className="stack" style={{ width: "100%" }}>
      {/* Compact overrides so the effort widget takes less vertical space inside planner cards */}
      <style>{`
        .plannerEffortCompact .effortWidget { padding: 8px !important; }
        .plannerEffortCompact .effortTopRow { margin-bottom: 6px !important; }
        .plannerEffortCompact .effortPill { padding: 4px 8px !important; }
        .plannerEffortCompact .effortDone { padding: 4px 8px !important; }
        .plannerEffortCompact .effortBarWrap { margin-top: 6px !important; }
        .plannerEffortCompact .effortCta { padding: 8px 10px !important; }
      `}</style>

      <div className="card">
        <div className="cardBody">
          <div
            className="rowWrap"
            style={{
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
            }}
          >
            <div>
              <div className="h2">Weekly Planner</div>
              <div className="muted">
                Week of <span className="mono">{weekLabel}</span> • Total
                planned:{" "}
                <span className="mono">{view.weekTotal.toFixed(1)}h</span>
                {plannerQ.refreshing ? (
                  <span className="muted"> • Updating…</span>
                ) : null}
              </div>
            </div>

            <div className="rowWrap" style={{ gap: 10, alignItems: "center" }}>
              <button
                className="btn"
                onClick={() => setWeekStart((d) => addDays(d, -7))}
              >
                ← Prev
              </button>
              <button
                className="btn"
                onClick={() => setWeekStart(startOfWeekMonday(new Date()))}
              >
                Today
              </button>
              <button
                className="btn"
                onClick={() => setWeekStart((d) => addDays(d, 7))}
              >
                Next →
              </button>
              <button
                className="btn"
                onClick={() => plannerQ.refresh()}
                title="Refresh from Canvas"
              >
                Refresh
              </button>
            </div>
          </div>

          <div
            className="rowWrap"
            style={{ gap: 14, alignItems: "center", marginTop: 12 }}
          >
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

            <label
              className="muted"
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
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

            <div className="rowWrap" style={{ gap: 10, alignItems: "center" }}>
              <span className="muted">Course:</span>
              <select
                value={courseFilter}
                onChange={(e) => setCourseFilter(e.target.value)}
                className="select"
                aria-label="Filter by course"
              >
                <option value="all">All</option>
                {courseOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="rowWrap" style={{ gap: 10, alignItems: "center" }}>
              <span className="muted">Sort:</span>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value)}
                className="select"
                aria-label="Sort mode"
              >
                <option value="time">Due time</option>
                <option value="course">Course</option>
              </select>
            </div>

            <div className="muted" style={{ marginLeft: "auto" }}>
              Tip: Missing/Submitted = Canvas state • Complete = workload progress • Yellow bar = split
            </div>
          </div>
        </div>
      </div>

      {/* 4x2 layout (7 days + Next up card) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 12,
          width: "100%",
          
        }}
      >
        {view.days.map((day, idx) => {
          const list = view.buckets.get(idx) || [];
          const total = view.dayTotals[idx];
          const overloaded = total > capacity + 1e-9;

          const isToday = isoDay(day) === isTodayISO;

          return (
            <div
              key={day.toISOString()}
              className={`card plannerDayCard${isToday ? " plannerDayCardToday" : ""}`}
            >
              <div className="cardBody" style={{ padding: 10 }}>
                <div
                  className={`plannerDayHeader${isToday ? " plannerDayHeaderToday" : ""}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "baseline",
                  }}
                >
                  <div
                    className="h3"
                    style={{
                      margin: 0,
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    {fmtDayHeader(day)}
                    {isToday ? <span className="pill">Today</span> : null}
                  </div>
                  <div
                    className={`muted ${overloaded ? "dangerText" : ""}`}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    <span className="mono">{total.toFixed(1)}h</span>
                    {overloaded ? <span> • Over</span> : null}
                  </div>
                </div>

                {list.length === 0 ? (
                  <div className="muted" style={{ marginTop: 8 }}>
                    No due items.
                  </div>
                ) : (
                  <ScrollableDayList
                    style={{
                      marginTop: 10,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      maxHeight: "520px",
                      overflowY: "auto",
                      paddingRight: 4,
                    }}
                  >
                    {list.map((entry) => {
                      if (entry.__kind === "split") {
                        const s = entry.split;
                        const a = (itemsRaw || []).find(
                          (x) =>
                            x.course_id === s.courseId &&
                            x.id === s.assignmentId
                        );

                        const name = a?.name || `Assignment ${s.assignmentId}`;
                        const courseLabel =
                          a?.course_name ?? `Course ${s.courseId}`;
                        const dueTime = fmtTime(a?.due_at);
                        const dueDate = fmtShortDate(a?.due_at);

                        const barVariant = getPlannerBarVariant({
                          isSplit: true,
                          assignment: a,
                        });

                        const missing = a ? isMissing(a) : false;
                        const submitted = !!a?.submitted;

                        return (
                          <div key={`split-${s.id}`} className="card">
                            <div className="cardBody" style={{ padding: 0 }}>
                              <div className="plannerCard">
                                <div className={`plannerBar plannerBar-${barVariant}`} />
                                <div className="plannerContent" style={{ padding: 10 }}>
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      gap: 10,
                                    }}
                                  >
                                    <div
                                      className="plannerTitle"
                                      title={name}
                                      style={{ fontWeight: 900 }}
                                    >
                                      {name}
                                    </div>
                                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                      {renderSingleStatusBadge({
                                        missing,
                                        submitted,
                                        complete: s.completed,
                                      })}
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

                                  <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                                    <span style={{ fontWeight: 900 }}>Due on:</span>{" "}
                                    <span className="mono">
                                      {dueDate || "—"} {dueTime || ""}
                                    </span>
                                  </div>

                                  <div
                                    style={{
                                      marginTop: 10,
                                      display: "flex",
                                      gap: 10,
                                      alignItems: "center",
                                      flexWrap: "wrap",
                                    }}
                                  >
                                    <label
                                      className="muted"
                                      style={{
                                        fontSize: 12,
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={!!s.completed}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) =>
                                          toggleSplitCompleted(
                                            s.id,
                                            e.target.checked
                                          )
                                        }
                                      />
                                      Completed
                                    </label>

                                    <div className="muted" style={{ fontSize: 12 }}>
                                      Planned:{" "}
                                      <span className="mono">
                                        {(s.completed ? 0 : s.hours).toFixed(1)}h
                                      </span>{" "}
                                      on <span className="mono">{s.dateISO}</span>
                                    </div>

                                    <button className="btn btnDanger" onClick={() => removeSplit(s.id)}>
                                      Remove
                                    </button>

                                    <button
                                      className="btn"
                                      onClick={() => navigateToAssignment(s.courseId, s.assignmentId)}
                                    >
                                      View assignment
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      // base assignment cards
                      const a = entry.assignment;
                      const courseLabel =
                        a.course_name ?? `Course ${a.course_id}`;
                      const dueTime = fmtTime(a.due_at);
                      const dueDate = fmtShortDate(a.due_at);

                      const splitAway = entry.splitAway || 0;
                      const rem = workloadRemainingHours(a.course_id, a.id);
                      const plannedForThisDueDay = Math.max(0, rem - splitAway);

                      const barVariant = getPlannerBarVariant({
                        isSplit: false,
                        assignment: a,
                      });

                      const missing = isMissing(a);
                      const submitted = !!a.submitted;
                      const complete = !submitted && isWorkloadComplete(a.course_id, a.id);

                      const todayISO = isoDay(new Date());
                      const dueISO = a?.due_at ? isoDay(new Date(a.due_at)) : null;

                      const cap = maxRemainingFor(a); // null means no cap (no estimate)
                      const canSplit =
                        !!a?.due_at &&
                        !submitted &&
                        (!dueISO || dueISO >= todayISO) &&
                        (cap == null ? true : cap > 1e-9);

                      return (
                        <div key={`${a.course_id}-${a.id}`} className="card">
                          <div className="cardBody" style={{ padding: 0 }}>
                            <div className="plannerCard">
                              <div className={`plannerBar plannerBar-${barVariant}`} />
                              <div className="plannerContent" style={{ padding: 10 }}>
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 10,
                                  }}
                                >
                                  <div className="plannerTitle" title={a.name} style={{ fontWeight: 900 }}>
                                    {a.name}
                                  </div>
                                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                    {renderSingleStatusBadge({ missing, submitted, complete })}
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

                                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                                  <span style={{ fontWeight: 900 }}>Due on:</span>{" "}
                                  <span className="mono">
                                    {dueDate || "—"} {dueTime || ""}
                                  </span>
                                </div>

                                <div className="plannerEffortCompact" style={{ marginTop: 10 }}>
                                  <WorkloadEstimateControl
                                    courseId={a.course_id}
                                    assignmentId={a.id}
                                    compactLabels={true}
                                  />
                                </div>

                                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                                  Planned today: <span className="mono">{plannedForThisDueDay.toFixed(1)}h</span>
                                </div>

                                <div style={{ marginTop: 10 }}>
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: 8,
                                      alignItems: "stretch",
                                      flexWrap: "nowrap",
                                    }}
                                  >
                                    <button
                                      className="btn"
                                      onClick={(e) => openSplitPopover(e, a)}
                                      disabled={!canSplit}
                                      title={
                                        canSplit
                                          ? "Plan part of this assignment earlier"
                                          : "Splits unavailable (submitted, past due, or no remaining estimate)"
                                      }
                                      style={{
                                        flex: 1,
                                        minWidth: 0,
                                        whiteSpace: "nowrap",
                                        display: "inline-flex",
                                        justifyContent: "center",
                                        fontSize: 13,
                                        padding: "8px 10px",
                                      }}
                                    >
                                      Split
                                    </button>

                                    <button
                                      className="btn"
                                      onClick={() => navigateToAssignment(a.course_id, a.id)}
                                      style={{
                                        flex: 1,
                                        minWidth: 0,
                                        whiteSpace: "nowrap",
                                        display: "inline-flex",
                                        justifyContent: "center",
                                        fontSize: 13,
                                        padding: "8px 10px",
                                      }}
                                    >
                                      View
                                    </button>
                                  </div>

                                  {splitErrors[keyFor(a.course_id, a.id)] ? (
                                    <div className="dangerText" style={{ marginTop: 6, fontSize: 12 }}>
                                      {splitErrors[keyFor(a.course_id, a.id)]}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </ScrollableDayList>
                )}
              </div>
            </div>
          );
        })}

        {/* Next up */}
        <div className="card">
          <div className="cardBody" style={{ padding: 10 }}>
            <div className="h3" style={{ margin: 0 }}>
              Next up
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              First assignments due after this week.
            </div>

            {nextUp.length === 0 ? (
              <div className="muted" style={{ marginTop: 10 }}>
                No upcoming items found after this week.
              </div>
            ) : (
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {nextUp.map((a) => {
                  const dueTime = fmtTime(a.due_at);
                  const dueDate = fmtShortDate(a.due_at);
                  const courseLabel = a.course_name ?? "Unknown Course";
                  const variant = getPlannerBarVariant({
                    isSplit: false,
                    assignment: a,
                  });

                  const missing = isMissing(a);
                  const submitted = !!a.submitted;
                  const complete = !submitted && isWorkloadComplete(a.course_id, a.id);

                  return (
                    <div key={`next-${a.course_id}-${a.id}`} className="card">
                      <div className="cardBody" style={{ padding: 0 }}>
                        <div className="plannerCard">
                          <div className={`plannerBar plannerBar-${variant}`} />
                          <div className="plannerContent" style={{ padding: 10 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                              <div className="plannerTitle" title={a.name} style={{ fontWeight: 900 }}>
                                {a.name}
                              </div>
                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                {renderSingleStatusBadge({ missing, submitted, complete })}
                              </div>
                            </div>

                            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                              <span className="mono">{courseLabel}</span>
                            </div>

                            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                              <span style={{ fontWeight: 900 }}>Due on:</span>{" "}
                              <span className="mono">
                                {dueDate || "—"} {dueTime || ""}
                              </span>
                            </div>

                            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                              <button className="btn" onClick={() => navigateToAssignment(a.course_id, a.id)}>
                                View assignment
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Split anchored popover */}
      <AnchoredPopover
        open={splitPopOpen}
        onClose={closeSplitPopover}
        anchorEl={splitPopAnchor}
        side="left"
        gap={10}
        width={420}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 900 }}>Split assignment</div>
          <button
            type="button"
            className="effortCloseBtn"
            onClick={closeSplitPopover}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {splitPopAssignment ? (
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              <div style={{ fontWeight: 900, color: "inherit" }}>
                {splitPopAssignment.name}
              </div>
              <div style={{ marginTop: 4 }}>
                Due on:{" "}
                <span className="mono">
                  {fmtShortDate(splitPopAssignment.due_at) || "—"}{" "}
                  {fmtTime(splitPopAssignment.due_at) || ""}
                </span>
              </div>

              {maxRemainingFor(splitPopAssignment) == null ? (
                <div style={{ marginTop: 4 }}>
                  Max you can plan: <span className="mono">—</span>{" "}
                  <span className="muted">(set an estimate to cap splits)</span>
                </div>
              ) : (
                <div style={{ marginTop: 4 }}>
                  Max you can plan:{" "}
                  <span className="mono">
                    {maxRemainingFor(splitPopAssignment).toFixed(1)}h
                  </span>
                </div>
              )}
            </div>

            <div className="effortDivider" style={{ margin: "12px 0" }} />

            <div className="effortField">
              <div className="effortFieldLabel">Split date</div>
              <div className="effortFieldRow">
                <input
                  type="date"
                  value={splitPopDateISO}
                  min={isoDay(new Date())}
                  max={
                    splitPopAssignment?.due_at
                      ? isoDay(new Date(splitPopAssignment.due_at))
                      : undefined
                  }
                  onChange={(e) => {
                    setSplitPopDateISO(e.target.value);
                    setSplitPopErr("");
                  }}
                />
              </div>
            </div>

            <div className="effortDivider" style={{ margin: "12px 0" }} />

            <div className="effortField">
              <div className="effortFieldLabel">Hours to plan</div>
              <div className="effortFieldRow">
                <input
                  className="effortInput"
                  type="number"
                  min="0"
                  step="0.25"
                  value={splitPopHours}
                  onChange={(e) => {
                    setSplitPopHours(e.target.value);
                    setSplitPopErr("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applySplitFromPopover();
                    }
                  }}
                  style={{ width: 120 }}
                />
                <span className="muted">hours</span>

                <button type="button" className="btn" onClick={applySplitFromPopover}>
                  Apply
                </button>
              </div>
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                Completing a split will add those hours to “completed effort”.
              </div>
            </div>

            {splitPopErr ? (
              <div className="dangerText" style={{ marginTop: 10, fontSize: 12 }}>
                {splitPopErr}
              </div>
            ) : null}
          </div>
        ) : null}
      </AnchoredPopover>

      <div className="card">
        <div className="cardBody">
          <div className="h3" style={{ marginTop: 0 }}>
            Undated assignments
          </div>

          {view.undated.length === 0 ? (
            <div className="muted">None</div>
          ) : (
            <div className="muted">
              Count: <span className="mono">{view.undated.length}</span> •
              (These don’t appear in the calendar columns.)
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

                    <button
                      className="btn"
                      onClick={() => navigateToAssignment(a.course_id, a.id)}
                    >
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
            This will delete <span className="mono">all split cards</span>,
            clear planner settings, and remove
            <span className="mono"> all effort/workload estimates</span> stored
            in this browser.
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
                    if (lk.includes("effort") || lk.includes("workload"))
                      toRemove.push(k);
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
                setSettings({ dailyCapacityHours: 3.0, showCompleted: false });
                setEffortKeyMap({});
                setStorageTick((t) => t + 1);

                closeSplitPopover();
                setCourseFilter("all");
                setSortMode("time");
              }}
            >
              Reset cache (deletes splits + effort)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
