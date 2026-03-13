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
import { loadTodos, syncTodos } from "../lib/todoStore";

/* ---------------- UI tuning knobs ---------------- */
const UI = {
  // Grid layout
  GRID_COLS: 4,
  GRID_ROW_HEIGHT_PX: 460,
  GRID_GAP_PX: 12,

  // Day card layout
  DAY_CARD_PADDING_PX: 10,
  DAY_HEADER_GAP_PX: 10,
  DAY_LIST_MARGIN_TOP_PX: 10,

  // Scrollable list (inside each day card)
  LIST_GAP_PX: 10,
  LIST_SCROLL_PAD_RIGHT_PX: 4,

  // Scroll controls / fades
  FADE_HEIGHT_PX: 22,
  BUTTON_SIZE_PX: 30,
  BUTTON_INSET_PX: 6,

  // Space reserved so content doesn’t sit underneath buttons
  // (keep this close to button size + inset so you don't get "empty top" feeling)
  BUTTON_RESERVED_PAD_PX: 22,
  // How many "next up" items to show by default
  NEXT_UP_LIMIT: 4,
};

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
function startOfWeekSunday(date) {
  const d = startOfDay(date);
  const day = d.getDay(); // 0=Sun ... 6=Sat
  return addDays(d, -day); // move to Sunday
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

function dayNumberUTC(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
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

/* ---------------- icons ---------------- */
function DoubleChevronIcon({ direction = "down" }) {
  const rotate = direction === "up" ? "rotate(180 12 12)" : undefined;

  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ width: 20, height: 20 }}
    >
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

// Toggle function component (used in settings)
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

/* ---------------- Scrollable day list ---------------- */
function ScrollableDayList({ children, style, className = "" }) {
  const scrollerRef = useRef(null);
  const shellRef = useRef(null);
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);

  function recompute() {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;

    // A tiny tolerance avoids flicker from fractional pixels
    setCanUp(scrollTop > 2);
    setCanDown(scrollTop + clientHeight < scrollHeight - 2);
  }

  useEffect(() => {
    const el = scrollerRef.current;
    const shell = shellRef.current;
    if (!el) return;

    recompute();

    const onScroll = () => recompute();
    el.addEventListener("scroll", onScroll, { passive: true });

    // Observe both the scroller and its shell so we recompute when layout changes
    const ro = new ResizeObserver(() => recompute());
    ro.observe(el);
    if (shell) ro.observe(shell);

    // Recompute after initial paint/layout settle
    const t1 = setTimeout(recompute, 0);
    const t2 = setTimeout(recompute, 50);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  // Also recompute when children change (new cards, effort widget expands, etc.)
  useEffect(() => {
    const t = setTimeout(recompute, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  function scrollToTop() {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToBottom() {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  const btnStyle = (pos) => ({
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 6,
    width: UI.BUTTON_SIZE_PX,
    height: UI.BUTTON_SIZE_PX,
    borderRadius: 999,
    display: "grid",
    placeItems: "center",
    ...(pos === "top"
      ? { top: UI.BUTTON_INSET_PX }
      : { bottom: UI.BUTTON_INSET_PX }),
  });

  return (
    <div
      ref={shellRef}
      className={`plannerDayListShell ${className}`}
      style={{
        ...style,
        position: "relative",
        overflow: "hidden",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* fades */}
      {canUp ? (
        <div
          aria-hidden="true"
          className="plannerFadeColorTop"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: UI.FADE_HEIGHT_PX,
            zIndex: 5,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {canDown ? (
        <div
          aria-hidden="true"
          className="plannerFadeColorBot"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: UI.FADE_HEIGHT_PX,
            zIndex: 5,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* buttons */}
      {canUp ? (
        <button
          type="button"
          className="plannerScrollBtn up"
          onClick={scrollToTop}
          aria-label="Scroll to top"
          title="Scroll to top"
          style={btnStyle("top")}
        >
          <DoubleChevronIcon direction="up" />
        </button>
      ) : null}

      {canDown ? (
        <button
          type="button"
          className="plannerScrollBtn down"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
          style={btnStyle("bottom")}
        >
          <DoubleChevronIcon direction="down" />
        </button>
      ) : null}

      {/* ONLY scrolling element */}
      <div
        ref={scrollerRef}
        className="plannerDayList"
        style={{
          flex: 1,
          height: 0,
          minHeight: 0,
          overflowY: "auto",
          paddingRight: UI.LIST_SCROLL_PAD_RIGHT_PX,
          paddingTop: 0,
          paddingBottom: 0,
          display: "flex",
          flexDirection: "column",
          gap: UI.LIST_GAP_PX,
        }}
      >
        {children}
      </div>
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
    if (!raw) return { dailyCapacityHours: 3.0, showCompleted: false, dayViewMode: "next7", showPersonalTodos: true };

    const obj = JSON.parse(raw);
    return {
      dailyCapacityHours: Number.isFinite(Number(obj?.dailyCapacityHours))
        ? Number(obj.dailyCapacityHours)
        : 3.0,
      showCompleted: !!obj?.showCompleted,
      dayViewMode: (obj?.dayViewMode === "next7" || obj?.dayViewMode === "week") ? obj.dayViewMode : "next7",
      showPersonalTodos: obj?.showPersonalTodos !== false,
    };
  } catch {
    return { dailyCapacityHours: 3.0, showCompleted: false, dayViewMode: "next7", showPersonalTodos: true };
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
          s.hours != null,
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
          Number.isFinite(s.hours),
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
    JSON.stringify({ courseId, assignmentId, ts: Date.now() }),
  );

  window.dispatchEvent(
    new CustomEvent("canvasbetter:navigate", { detail: { tab: "upcoming" } }),
  );
}

function navigateToTodoItem(todoId) {
  localStorage.setItem(
    "nav:todo:target",
    JSON.stringify({ todoId, ts: Date.now() }),
  );

  window.dispatchEvent(
    new CustomEvent("canvasbetter:navigate", { detail: { tab: "todo" } }),
  );
}

function FavoriteMarker() {
  return (
    <span className="favoriteMarker" title="Favorited" aria-label="Favorited">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path d="m12 3.5 2.78 5.63 6.22.9-4.5 4.38 1.06 6.19L12 17.68 6.44 20.6l1.06-6.19L3 10.03l6.22-.9L12 3.5Z" />
      </svg>
    </span>
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
  const [pos, setPos] = useState({ top: 0, left: 0, panelWidth: width });
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEntered(false);
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function recompute({ preservePosition = false } = {}) {
      const anchorAvailable =
        !!anchorEl &&
        anchorEl.isConnected &&
        typeof anchorEl.getBoundingClientRect === "function";

      const panel = panelRef.current;
      const rect = anchorAvailable ? anchorEl.getBoundingClientRect() : null;
      const margin = 10;
      const topSafeInset = 64;
      const maxViewportWidth = Math.max(260, window.innerWidth - margin * 2);
      const panelWidth = Math.min(width, maxViewportWidth);
      const panelHeight = panel?.getBoundingClientRect()?.height || 0;
      const minTop = Math.max(margin, topSafeInset);
      const maxTop =
        panelHeight > 0
          ? Math.max(minTop, window.innerHeight - panelHeight - margin)
          : window.innerHeight - margin;

      setPos((prev) => {
        let left = prev.left;
        let top = prev.top;

        if (!preservePosition && rect) {
          left =
            side === "right" ? rect.right + gap : rect.left - gap - panelWidth;

          top = rect.top;
        } else if (preservePosition && rect) {
          // Prefer keeping the popover visually anchored to its opener while available.
          left =
            side === "right" ? rect.right + gap : rect.left - gap - panelWidth;
          top = rect.top;
        }

        left = Math.max(
          margin,
          Math.min(left, window.innerWidth - panelWidth - margin),
        );

        // Minimal movement rule:
        // - push down only if top would be off-screen
        // - push up only if bottom would be off-screen
        if (top < minTop) {
          top = minTop;
        } else if (top > maxTop) {
          top = maxTop;
        }

        if (
          Math.abs(prev.top - top) < 0.5 &&
          Math.abs(prev.left - left) < 0.5 &&
          Math.abs(prev.panelWidth - panelWidth) < 0.5
        ) {
          return prev;
        }
        return { top, left, panelWidth };
      });
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

    recompute({ preservePosition: false });
    const rafPosition = requestAnimationFrame(() =>
      recompute({ preservePosition: false }),
    );

    const ro = new ResizeObserver(() => recompute({ preservePosition: true }));
    if (panelRef.current) ro.observe(panelRef.current);
    if (anchorEl) ro.observe(anchorEl);

    const onResize = () => recompute({ preservePosition: false });
    const onScroll = () => {
      recompute({ preservePosition: true });
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);

    return () => {
      cancelAnimationFrame(rafPosition);
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
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
        width: pos.panelWidth,
        height: "auto",
        maxHeight: "calc(100vh - 20px)",
        zIndex: 9999,
        boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
        opacity: entered ? 1 : 0,
        transform: entered ? "translateY(0px)" : "translateY(6px)",
        transition: "opacity 140ms ease, transform 180ms ease",
        willChange: "transform, opacity",
      }}
    >
      <div
        className="cardBody"
        style={{
          height: "auto",
          maxHeight: "calc(100vh - 20px)",
          overflowY: "auto",
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function WeeklyPlanner() {
  // ✅ Cached upcoming
  const plannerQ = useCachedAsync(
    "planner:upcoming",
    ({ signal }) => canvasApi.getUpcoming({ signal }),
    { ttlMs: 60 * 1000 },
  );

  const undatedQ = useCachedAsync(
    "planner:undated",
    ({ signal }) => canvasApi.getUndatedAssignments({ signal }),
    { ttlMs: 60 * 1000 },
  );

  const itemsRaw = Array.isArray(plannerQ.data) ? plannerQ.data : [];
  const undatedItemsRaw = Array.isArray(undatedQ.data) ? undatedQ.data : [];

  // Stable refs so event handlers always call the latest refresh
  const plannerRefreshRef = useRef(null);
  plannerRefreshRef.current = plannerQ.refresh;
  const undatedRefreshRef = useRef(null);
  undatedRefreshRef.current = undatedQ.refresh;

  // Refresh immediately when the user hides/unhides an assignment via Settings
  useEffect(() => {
    function onHiddenChanged() {
      plannerRefreshRef.current?.();
      undatedRefreshRef.current?.();
    }
    window.addEventListener("canvassist:hidden:changed", onHiddenChanged);
    return () => window.removeEventListener("canvassist:hidden:changed", onHiddenChanged);
  }, []);

  const [weekStart, setWeekStart] = useState(() =>
    startOfWeekSunday(new Date()),
  );
  const [next7Start, setNext7Start] = useState(() => startOfDay(new Date()));
  const [settings, setSettings] = useState(() => loadPlannerSettings());

  const [splits, setSplits] = useState(() => loadSplits());
  const [splitDrafts, setSplitDrafts] = useState({});
  const [splitErrors, setSplitErrors] = useState({});

  const [effortKeyMap, setEffortKeyMap] = useState(() => loadEffortKeyMap());
  const [storageTick, setStorageTick] = useState(0);

  const [todos, setTodos] = useState(() => loadTodos());

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
    if (settings.dayViewMode === "next7") {
      setNext7Start(startOfDay(new Date()));
      return;
    }

    // In week mode, anchor the grid to Sunday-start weeks.
    setWeekStart((d) => startOfWeekSunday(d));
  }, [settings.dayViewMode]);

  useEffect(() => {
    let active = true;

    syncTodos().then((serverTodos) => {
      if (active) setTodos(serverTodos);
    });

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
      if (e.key === "canvassist:todos") setTodos(loadTodos());
    }

    function onPlannerSettingsChanged() {
      setSettings(loadPlannerSettings());
    }

    function onWorkloadChanged() {
      setStorageTick((t) => t + 1);
    }

    function onWorkloadSettingsChanged() {
      setStorageTick((t) => t + 1);
    }

    function onTodosChanged() {
      setTodos(loadTodos());
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("canvassist:planner-settings-changed", onPlannerSettingsChanged);
    window.addEventListener("canvassist:workload:changed", onWorkloadChanged);
    window.addEventListener(
      "canvassist:workload:settingsChanged",
      onWorkloadSettingsChanged,
    );
    window.addEventListener("canvassist:todos:changed", onTodosChanged);
    return () => {
      active = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("canvassist:planner-settings-changed", onPlannerSettingsChanged);
      window.removeEventListener(
        "canvassist:workload:changed",
        onWorkloadChanged,
      );
      window.removeEventListener(
        "canvassist:workload:settingsChanged",
        onWorkloadSettingsChanged,
      );
      window.removeEventListener("canvassist:todos:changed", onTodosChanged);
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
  function workloadIsFavorite(courseId, assignmentId) {
    const st = getWorkloadState(courseId, assignmentId);
    return !!st?.favorite;
  }
  function hasWorkloadEstimate(courseId, assignmentId) {
    return workloadEstimateHours(courseId, assignmentId) > 0;
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

  const undatedItems = useMemo(() => {
    if (courseFilter === "all") return undatedItemsRaw;
    const cid = Number(courseFilter);
    if (!Number.isFinite(cid)) return undatedItemsRaw;
    return undatedItemsRaw.filter((a) => Number(a.course_id) === cid);
  }, [undatedItemsRaw, courseFilter]);

  const courseOptions = useMemo(() => {
    const map = new Map();
    for (const a of [...itemsRaw, ...undatedItemsRaw]) {
      const cid = a?.course_id;
      if (cid == null) continue;
      const name = a?.course_name || `Course ${cid}`;
      map.set(String(cid), name);
    }
    const arr = Array.from(map.entries()).map(([id, name]) => ({ id, name }));
    arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [itemsRaw, undatedItemsRaw]);

  const filteredSplits = useMemo(() => {
    if (courseFilter === "all") return splits;
    const cid = Number(courseFilter);
    if (!Number.isFinite(cid)) return splits;
    return splits.filter((s) => Number(s.courseId) === cid);
  }, [splits, courseFilter]);

  // Remaining you can split for an assignment:
  // - If estimate exists: cap = (remaining effort) - already planned splits
  // - If estimate does NOT exist: return null (splitting should be disabled)
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
    if (!hasWorkloadEstimate(courseId, assignmentId))
      return setErrMsg(
        courseId,
        assignmentId,
        "Set an estimated workload before splitting.",
      );

    // Only enforce cap if we have an estimate
    if (cap != null && hours > cap + 1e-9)
      return setErrMsg(
        courseId,
        assignmentId,
        `Can't split more than remaining (${cap.toFixed(1)}h).`,
      );

    if (targetISO < todayISO)
      return setErrMsg(courseId, assignmentId, "Can't split into a past date.");
    if (dueISO && targetISO > dueISO)
      return setErrMsg(
        courseId,
        assignmentId,
        `Can't split after due date (${dueISO}).`,
      );

    clearErrMsg(courseId, assignmentId);

    const existingIdx = splits.findIndex(
      (s) =>
        s.courseId === courseId &&
        s.assignmentId === assignmentId &&
        s.dateISO === targetISO,
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
      prev.map((s) => (s.id === splitId ? { ...s, completed: !!checked } : s)),
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
        prev.map((x) => (x.id === splitId ? { ...x, effortApplied: true } : x)),
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
      prev.map((x) => (x.id === splitId ? { ...x, effortApplied: false } : x)),
    );
    setStorageTick((t) => t + 1);
  };

  function openSplitPopover(e, assignment) {
    const btn = e?.currentTarget || null;

    const todayISO = isoDay(new Date());
    const dueISO = assignment?.due_at
      ? isoDay(new Date(assignment.due_at))
      : null;
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

    if (!hasWorkloadEstimate(courseId, assignmentId))
      return setSplitPopErr("Set an estimated workload before splitting.");
    if (!targetISO) return setSplitPopErr("Pick a split date.");
    if (!Number.isFinite(h) || h <= 0)
      return setSplitPopErr("Enter split hours > 0.");
    if (targetISO < todayISO)
      return setSplitPopErr("Can't split into a past date.");
    if (dueISO && targetISO > dueISO)
      return setSplitPopErr(`Can't split after due date (${dueISO}).`);

    // Only enforce cap if we have an estimate
    if (cap != null && h > cap + 1e-9)
      return setSplitPopErr(
        `Can't split more than remaining (${cap.toFixed(1)}h).`,
      );

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
    // Determine the start date based on the view mode
    let start;
    if (settings.dayViewMode === "next7") {
      // Next 7 days view: default to today on load, then allow paging by week.
      start = startOfDay(next7Start);
    } else {
      // Week view: use the selected week start
      start = startOfDay(weekStart);
    }
    const end = addDays(start, 7);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

    const buckets = new Map();
    for (let i = 0; i < 7; i++) buckets.set(i, []);
    const undated = [];
    const undatedSeen = new Set();
    const pushUndated = (assignment) => {
      const key = `${assignment?.course_id}:${assignment?.id}`;
      if (undatedSeen.has(key)) return;
      undatedSeen.add(key);
      undated.push(assignment);
    };

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
        0,
      );
    };

    const entryCourseLabel = (entry) => {
      if (entry.__kind === "base") return entry.assignment?.course_name || "";
      if (entry.__kind === "todo") return "TO-DO's";
      const assignment = (itemsRaw || []).find(
        (it) =>
          it.course_id === entry.split.courseId &&
          it.id === entry.split.assignmentId,
      );
      return assignment?.course_name || "";
    };

    const isEntryFavorite = (entry) => {
      if (entry.__kind === "base") {
        return workloadIsFavorite(
          entry.assignment?.course_id,
          entry.assignment?.id,
        );
      }
      if (entry.__kind === "todo") {
        return workloadIsFavorite("todo", entry.todo?.id);
      }
      return false;
    };

    const sortBucketEntries = (list) => {
      list.sort((x, y) => {
        const xSplit = x.__kind === "split";
        const ySplit = y.__kind === "split";
        if (xSplit !== ySplit) return xSplit ? 1 : -1;

        const xFavorite = isEntryFavorite(x);
        const yFavorite = isEntryFavorite(y);
        if (xFavorite !== yFavorite) return xFavorite ? -1 : 1;

        if (sortMode === "course") {
          const ac = entryCourseLabel(x).toLowerCase();
          const bc = entryCourseLabel(y).toLowerCase();
          if (ac !== bc) return ac.localeCompare(bc);
        }

        if (x.__kind === "todo" || y.__kind === "todo") {
          if (x.__kind !== y.__kind) return x.__kind === "base" ? -1 : 1;
          const xt = x.todo?.due_at ? new Date(x.todo.due_at).getTime() : Infinity;
          const yt = y.todo?.due_at ? new Date(y.todo.due_at).getTime() : Infinity;
          if (xt !== yt) return xt - yt;
          return String(x.todo?.title || "").localeCompare(
            String(y.todo?.title || ""),
          );
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
    };

    // split entries (always visible)
    for (const s of filteredSplits) {
      const splitDay = new Date(`${s.dateISO}T00:00:00`);
      if (!Number.isFinite(splitDay.getTime())) continue;

      if (splitDay >= start && splitDay < end) {
        const dayIdx = Math.floor(
          (splitDay.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
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
        pushUndated(a);
        continue;
      }

      const due = new Date(a.due_at);
      if (!Number.isFinite(due.getTime())) {
        pushUndated(a);
        continue;
      }

      if (due >= start && due < end) {
        const dayIdx = Math.floor(
          (startOfDay(due).getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
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

    for (const a of undatedItems || []) {
      if (!settings.showCompleted && a.submitted) continue;
      pushUndated(a);
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
    undated.sort(
      (a, b) =>
        (workloadIsFavorite(a.course_id, a.id) ? 0 : 1) -
          (workloadIsFavorite(b.course_id, b.id) ? 0 : 1) ||
        (a.name || "").localeCompare(b.name || ""),
    );

    // --- Personal to-do items ---
    const todoUndated = [];
    if (settings.showPersonalTodos) {
      for (const t of todos) {
        if (t.completed) continue;
        if (!t.due_at) {
          todoUndated.push(t);
          continue;
        }
        const due = new Date(t.due_at);
        if (!Number.isFinite(due.getTime())) {
          todoUndated.push(t);
          continue;
        }
        if (due >= start && due < end) {
          const dayIdx = Math.floor(
            (startOfDay(due).getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
          );
          const list = buckets.get(dayIdx) || [];
          list.push({ __kind: "todo", todo: t });
          buckets.set(dayIdx, list);
        }
      }
      todoUndated.sort(
        (a, b) =>
          (workloadIsFavorite("todo", a.id) ? 0 : 1) -
            (workloadIsFavorite("todo", b.id) ? 0 : 1) ||
          a.title.localeCompare(b.title),
      );
    }

    for (let i = 0; i < 7; i++) {
      const list = buckets.get(i) || [];
      sortBucketEntries(list);
      buckets.set(i, list);
    }

    return { start, end, days, buckets, undated, todoUndated, dayTotals, weekTotal };
  }, [
    items,
    itemsRaw,
    undatedItems,
    weekStart,
    next7Start,
    settings.showCompleted,
    settings.dayViewMode,
    settings.showPersonalTodos,
    storageTick,
    filteredSplits,
    effortKeyMap,
    sortMode,
    todos,
  ]);

  const nextUp = useMemo(() => {
    const after = view.end.getTime();
    const upcoming = (items || [])
      .filter((a) => a?.due_at)
      .map((a) => ({ a, t: new Date(a.due_at).getTime() }))
      .filter((x) => Number.isFinite(x.t) && x.t >= after)
      .filter((x) => (settings.showCompleted ? true : !x.a.submitted))
      .sort((x, y) => {
        const xf = workloadIsFavorite(x.a.course_id, x.a.id);
        const yf = workloadIsFavorite(y.a.course_id, y.a.id);
        if (xf !== yf) return xf ? -1 : 1;
        return x.t - y.t;
      })
      .slice(0, UI.NEXT_UP_LIMIT) // ✅ limit
      .map((x) => x.a);
    return upcoming;
  }, [items, view.end, settings.showCompleted, storageTick]);

  const viewOffsetLabel = useMemo(() => {
    const today = startOfDay(new Date());
    const baselineStart =
      settings.dayViewMode === "next7" ? today : startOfWeekSunday(today);
    const offsetDays =
      dayNumberUTC(startOfDay(view.start)) - dayNumberUTC(baselineStart);
    const offsetWeeks = Math.round(offsetDays / 7);

    if (offsetWeeks === 0) return "";
    if (offsetWeeks > 0)
      return offsetWeeks === 1
        ? "Viewing 1 week ahead"
        : `Viewing ${offsetWeeks} weeks ahead`;

    const absWeeks = Math.abs(offsetWeeks);
    return absWeeks === 1
      ? "Viewing 1 week earlier"
      : `Viewing ${absWeeks} weeks earlier`;
  }, [settings.dayViewMode, view.start]);

  if (plannerQ.error || undatedQ.error)
    return <ErrorBox error={plannerQ.error || undatedQ.error} />;
  if ((plannerQ.loading || undatedQ.loading) && itemsRaw.length === 0 && undatedItemsRaw.length === 0)
    return <Loading label="Loading planner…" />;

  const capacity = settings.dailyCapacityHours;

  const weekLabel =
    view.days.length >= 7
      ? (settings.dayViewMode === "next7"
          ? `${view.days[0].toLocaleDateString()} – ${view.days[6].toLocaleDateString()} (Next 7 days)`
          : `${view.days[0].toLocaleDateString()} – ${view.days[6].toLocaleDateString()}`)
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
  const splitPopCap = splitPopAssignment
    ? maxRemainingFor(splitPopAssignment)
    : null;
  const splitPopCanApply =
    !!splitPopAssignment &&
    hasWorkloadEstimate(
      splitPopAssignment.course_id,
      splitPopAssignment.id,
    ) &&
    splitPopCap != null &&
    splitPopCap > 1e-9;

  return (
    <div className="stack" style={{ width: "100%" }}>
      {/* Compact overrides so the effort widget takes less vertical space inside planner cards */}
      <style>{`
        .plannerEffortCompact { min-width: 0; }
        .plannerEffortCompact .effortWidget {
          min-width: 0;
          max-width: 100%;
          overflow: hidden;
          padding: 6px 8px !important;
        }
        .plannerEffortCompact .effortTopRow {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) auto;
          margin-bottom: 6px !important;
          gap: 6px !important;
          align-items: center !important;
          width: 100%;
        }
        .plannerEffortCompact .effortTopRow > * { min-width: 0; }
        .plannerEffortCompact .effortNumbers {
          flex: 1 1 auto;
          max-width: none;
          gap: 6px !important;
          flex-wrap: nowrap !important;
          min-width: 0;
          overflow: hidden;
        }
        .plannerEffortCompact .effortPill,
        .plannerEffortCompact .effortDone {
          padding: 3px 7px !important;
          font-size: 12px !important;
          line-height: 1.15;
        }
        .plannerEffortCompact .effortPill {
          width: auto;
          flex: 1 1 0%;
          min-width: 0;
          max-width: 100%;
          gap: 4px;
          justify-content: space-between;
          white-space: nowrap;
        }
        .plannerEffortCompact .effortPill .muted {
          flex: 0 0 auto;
          font-size: 0.92em;
          overflow: visible;
          text-overflow: clip;
          white-space: nowrap;
        }
        .plannerEffortCompact .effortPill .mono {
          flex: 0 0 auto;
          margin-left: 6px;
        }
        .plannerEffortCompact .effortPill .mono,
        .plannerEffortCompact .effortBarMeta,
        .plannerEffortCompact .capacityNumber {
          font-variant-numeric: tabular-nums;
          font-feature-settings: "tnum" 1;
        }
        .plannerEffortCompact .effortGearBtn {
          width: 32px !important;
          height: 32px !important;
          font-size: 16px !important;
          border-radius: 9px !important;
          flex: 0 0 auto;
          justify-self: end;
        }
        .plannerEffortCompact .effortBarWrap {
          width: 100%;
          grid-template-columns: minmax(0, 1fr) auto !important;
          margin-top: 6px !important;
          gap: 8px !important;
          overflow: hidden;
        }
        .plannerEffortCompact .effortBarTrack {
          height: 10px !important;
          width: 100%;
          min-width: 0;
        }
        .plannerEffortCompact .effortBarMeta {
          min-width: 0 !important;
          width: 3.5ch;
          justify-self: end;
          white-space: nowrap;
          text-align: right;
          font-size: 12px !important;
        }
        .plannerEffortCompact .effortCta {
          padding: 7px 9px !important;
          font-size: 12px !important;
        }

        /* Extra-dense planner card effort UI on narrower laptop widths */
        @media (max-width: 1520px) {
          .plannerDayCard .plannerEffortCompact .effortWidget {
            padding: 5px 7px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortTopRow {
            gap: 5px !important;
            margin-bottom: 5px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortNumbers {
            gap: 5px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortPill,
          .plannerDayCard .plannerEffortCompact .effortDone {
            padding: 2px 6px !important;
            font-size: 11px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortGearBtn {
            width: 30px !important;
            height: 30px !important;
            font-size: 15px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortBarTrack {
            height: 9px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortBarMeta {
            width: 3.8ch;
            font-size: 11px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortCta {
            padding: 6px 8px !important;
            font-size: 11px !important;
          }
        }

        @media (max-width: 1360px) {
          .plannerDayCard .plannerEffortCompact .effortWidget {
            padding: 4px 6px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortTopRow {
            gap: 4px !important;
            margin-bottom: 4px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortPill,
          .plannerDayCard .plannerEffortCompact .effortDone {
            padding: 2px 5px !important;
            font-size: 10px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortGearBtn {
            width: 28px !important;
            height: 28px !important;
            font-size: 14px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortBarWrap {
            gap: 6px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortBarTrack {
            height: 8px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortBarMeta {
            width: 3.6ch;
            font-size: 10px !important;
          }
          .plannerDayCard .plannerEffortCompact .effortCta {
            padding: 6px 7px !important;
            font-size: 10px !important;
          }
        }
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
                {viewOffsetLabel ? (
                  <span className="pill" style={{ marginLeft: 8 }}>
                    {viewOffsetLabel}
                  </span>
                ) : null}
                {plannerQ.refreshing || undatedQ.refreshing ? (
                  <span className="muted"> • Updating…</span>
                ) : null}
              </div>
            </div>

            <div className="rowWrap" style={{ gap: 10, alignItems: "center" }}>
              <button
                className="btn"
                onClick={() => {
                  if (settings.dayViewMode === "next7") {
                    setNext7Start((d) => addDays(d, -7));
                    return;
                  }
                  setWeekStart((d) => addDays(d, -7));
                }}
              >
                ← Prev
              </button>
              <button
                className="btn"
                onClick={() => {
                  if (settings.dayViewMode === "next7") {
                    setNext7Start(startOfDay(new Date()));
                    return;
                  }
                  setWeekStart(startOfWeekSunday(new Date()));
                }}
              >
                Today
              </button>
              <button
                className="btn"
                onClick={() => {
                  if (settings.dayViewMode === "next7") {
                    setNext7Start((d) => addDays(d, 7));
                    return;
                  }
                  setWeekStart((d) => addDays(d, 7));
                }}
              >
                Next →
              </button>
              <button
                className="btn"
                onClick={() => {
                  plannerQ.refresh();
                  undatedQ.refresh();
                }}
                title="Refresh from Canvas"
              >
                Refresh
              </button>
            </div>
          </div>

          <div
            className="rowWrap"
            style={{
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 12,
              flexWrap: "nowrap",
              overflowX: "auto",
              paddingBottom: 2,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                flexShrink: 0,
                minWidth: 260,
              }}
            >
              <div className="muted">
                Daily capacity:{" "}
                <span
                  className="capacityValue"
                  title="Used to warn about overloaded days"
                >
                  <span className="mono capacityNumber">{capacity.toFixed(1)}</span>
                  <span className="capacityUnit">h/day</span>
                </span>
              </div>
              <div className="rowWrap" style={{ gap: 10, alignItems: "center" }}>
                <input
                  type="range"
                  min="0.5"
                  max="12"
                  step="0.5"
                  value={capacity}
                  onChange={(e) => setCapacityFromInput(e.target.value)}
                  style={{ width: 240, flexShrink: 0 }}
                  aria-label="Daily capacity hours"
                />
                <input
                  type="number"
                  min="0.5"
                  max="12"
                  step="0.5"
                  value={capacity}
                  onChange={(e) => setCapacityFromInput(e.target.value)}
                  style={{ width: 76, flexShrink: 0 }}
                  aria-label="Daily capacity numeric"
                  title="Type a capacity value"
                />
              </div>
            </div>

            <div className="toggleRow">
              <span className="muted">Show submitted:</span>
              <Toggle
                checked={!!settings.showCompleted}
                onChange={() =>
                  setSettings((s) => {
                    const next = { ...s, showCompleted: !s.showCompleted };
                    savePlannerSettings(next);
                    return next;
                  })
                }
                label={
                  settings.showCompleted ? "Hide submitted" : "Show submitted"
                }
              />
            </div>

            <div className="toggleRow">
              <span className="muted">Show To-Do's:</span>
              <Toggle
                checked={!!settings.showPersonalTodos}
                onChange={() =>
                  setSettings((s) => {
                    const next = { ...s, showPersonalTodos: !s.showPersonalTodos };
                    savePlannerSettings(next);
                    return next;
                  })
                }
                label={
                  settings.showPersonalTodos
                    ? "Hide personal to-do items"
                    : "Show personal to-do items"
                }
              />
            </div>

            <div className="rowWrap" style={{ gap: 10, alignItems: "center" }}>
              <span className="muted">Course:</span>
              <select
                value={courseFilter}
                onChange={(e) => setCourseFilter(e.target.value)}
                className="select"
                aria-label="Filter by course"
                title={
                  courseFilter === "all"
                    ? "All"
                    : courseOptions.find((c) => c.id === courseFilter)?.name ||
                      "All"
                }
                style={{
                  width: 160,
                  minWidth: 160,
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
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
          </div>

          <div className="muted" style={{ marginTop: 8 }}>
            Tip: Missing/Submitted = Canvas state • Complete = workload
            progress • Yellow bar = split
          </div>
        </div>
      </div>

      {/* 4x2 layout (7 days + Next up card) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${UI.GRID_COLS}, minmax(0, 1fr))`,
          gridAutoRows: `${UI.GRID_ROW_HEIGHT_PX}px`,
          gap: UI.GRID_GAP_PX,
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
              style={{ height: "100%" }}
            >
              <div
                className="cardBody"
                style={{
                  padding: UI.DAY_CARD_PADDING_PX,
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                }}
              >
                <div
                  className={`plannerDayHeader${isToday ? " plannerDayHeaderToday" : ""}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: UI.DAY_HEADER_GAP_PX,
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
                  <div
                    className="plannerDayEmpty muted"
                    style={{ marginTop: 8 }}
                  >
                    No due items.
                  </div>
                ) : (
                  <ScrollableDayList
                    style={{
                      marginTop: UI.DAY_LIST_MARGIN_TOP_PX,
                      flex: 1,
                      minHeight: 0,
                    }}
                  >
                    {list.map((entry) => {
                      // --- Personal to-do items ---
                      if (entry.__kind === "todo") {
                        const t = entry.todo;
                        const dueTime = fmtTime(t.due_at);
                        const dueDate = fmtShortDate(t.due_at);
                        const isFavorited = workloadIsFavorite("todo", t.id);
                        return (
                          <div key={`todo-${t.id}`} className="card">
                            <div className="cardBody" style={{ padding: 0 }}>
                              <div className="plannerCard">
                                <div className="plannerBar plannerBar-todo" />
                                <div className="plannerContent" style={{ padding: 10 }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                                    <div className="plannerTitle" title={t.title} style={{ fontWeight: 900 }}>
                                      <span className="plannerTitleWrap">
                                        {isFavorited ? <FavoriteMarker /> : null}
                                        <span>{t.title}</span>
                                      </span>
                                    </div>
                                    <span className="badge badgeNeutral" style={{ flexShrink: 0 }}>
                                      Personal
                                    </span>
                                  </div>
                                  <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                                    <span style={{ fontWeight: 900 }}>Due on:</span>{" "}
                                    <span className="mono">{dueDate || "—"} {dueTime || ""}</span>
                                  </div>
                                  {t.notes ? (
                                    <div
                                      className="muted"
                                      style={{
                                        marginTop: 6,
                                        fontSize: 11,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                      title={t.notes}
                                    >
                                      {t.notes}
                                    </div>
                                  ) : null}
                                  <div className="plannerEffortCompact" style={{ marginTop: 10 }}>
                                    <WorkloadEstimateControl
                                      courseId="todo"
                                      assignmentId={t.id}
                                      compactLabels={true}
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      // --- Canvas assignment split cards ---
                      if (entry.__kind === "split") {
                        const s = entry.split;
                        const a = (itemsRaw || []).find(
                          (x) =>
                            x.course_id === s.courseId &&
                            x.id === s.assignmentId,
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
                        const isFavorited = workloadIsFavorite(s.courseId, s.assignmentId);

                        const missing = a ? isMissing(a) : false;
                        const submitted = !!a?.submitted;

                        return (
                          <div key={`split-${s.id}`} className="card">
                            <div className="cardBody" style={{ padding: 0 }}>
                              <div className="plannerCard">
                                <div
                                  className={`plannerBar plannerBar-${barVariant}`}
                                />
                                <div
                                  className="plannerContent"
                                  style={{ padding: 10 }}
                                >
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
                                      <span className="plannerTitleWrap">
                                        {isFavorited ? <FavoriteMarker /> : null}
                                        <span>{name}</span>
                                      </span>
                                    </div>
                                    <div
                                      style={{
                                        display: "flex",
                                        gap: 8,
                                        alignItems: "center",
                                        flexWrap: "wrap",
                                      }}
                                    >
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

                                  <div
                                    className="muted"
                                    style={{ marginTop: 6, fontSize: 12 }}
                                  >
                                    <span style={{ fontWeight: 900 }}>
                                      Due on:
                                    </span>{" "}
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
                                            e.target.checked,
                                          )
                                        }
                                      />
                                      Completed
                                    </label>

                                    <div
                                      className="muted"
                                      style={{ fontSize: 12 }}
                                    >
                                      Planned:{" "}
                                      <span className="mono">
                                        {(s.completed ? 0 : s.hours).toFixed(1)}
                                        h
                                      </span>{" "}
                                      on{" "}
                                      <span className="mono">{s.dateISO}</span>
                                    </div>

                                    <button
                                      className="btn btnDanger"
                                      onClick={() => removeSplit(s.id)}
                                    >
                                      Remove
                                    </button>

                                    <button
                                      className="btn"
                                      onClick={() =>
                                        navigateToAssignment(
                                          s.courseId,
                                          s.assignmentId,
                                        )
                                      }
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
                      const complete =
                        !submitted && isWorkloadComplete(a.course_id, a.id);

                      const todayISO = isoDay(new Date());
                      const dueISO = a?.due_at
                        ? isoDay(new Date(a.due_at))
                        : null;

                      const hasEstimate = hasWorkloadEstimate(a.course_id, a.id);
                      const cap = maxRemainingFor(a);
                      const canSplit =
                        !!a?.due_at &&
                        !submitted &&
                        (!dueISO || dueISO >= todayISO) &&
                        hasEstimate &&
                        cap != null &&
                        cap > 1e-9;
                      const isFavorited = workloadIsFavorite(a.course_id, a.id);

                      return (
                        <div key={`${a.course_id}-${a.id}`} className="card">
                          <div className="cardBody" style={{ padding: 0 }}>
                            <div className="plannerCard">
                              <div
                                className={`plannerBar plannerBar-${barVariant}`}
                              />
                              <div
                                className="plannerContent"
                                style={{ padding: 10 }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 10,
                                  }}
                                >
                                  <div
                                    className="plannerTitle"
                                    title={a.name}
                                    style={{ fontWeight: 900 }}
                                  >
                                    <span className="plannerTitleWrap">
                                      {isFavorited ? <FavoriteMarker /> : null}
                                      <span>{a.name}</span>
                                    </span>
                                  </div>
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: 8,
                                      alignItems: "center",
                                      flexWrap: "wrap",
                                    }}
                                  >
                                    {renderSingleStatusBadge({
                                      missing,
                                      submitted,
                                      complete,
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

                                <div
                                  className="muted"
                                  style={{ marginTop: 6, fontSize: 12 }}
                                >
                                  <span style={{ fontWeight: 900 }}>
                                    Due on:
                                  </span>{" "}
                                  <span className="mono">
                                    {dueDate || "—"} {dueTime || ""}
                                  </span>
                                </div>

                                <div
                                  className="plannerEffortCompact"
                                  style={{ marginTop: 10 }}
                                >
                                  <WorkloadEstimateControl
                                    courseId={a.course_id}
                                    assignmentId={a.id}
                                    compactLabels={true}
                                  />
                                </div>

                                <div
                                  className="muted"
                                  style={{ marginTop: 8, fontSize: 12 }}
                                >
                                  Planned today:{" "}
                                  <span className="mono">
                                    {plannedForThisDueDay.toFixed(1)}h
                                  </span>
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
                                          : "Splits unavailable (submitted, past due, no estimate, or no remaining estimate)"
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
                                      onClick={() =>
                                        navigateToAssignment(a.course_id, a.id)
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
                                      View
                                    </button>
                                  </div>

                                  {!hasEstimate ? (
                                    <div
                                      className="muted"
                                      style={{ marginTop: 6, fontSize: 12 }}
                                    >
                                      Set an estimated workload to enable splitting.
                                    </div>
                                  ) : splitErrors[keyFor(a.course_id, a.id)] ? (
                                    <div
                                      className="dangerText"
                                      style={{ marginTop: 6, fontSize: 12 }}
                                    >
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
        <div className="card" style={{ height: "100%" }}>
          <div
            className="cardBody"
            style={{
              padding: 10,
              height: "100%",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
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
              <ScrollableDayList
                style={{ marginTop: UI.DAY_LIST_MARGIN_TOP_PX, flex: 1, minHeight: 0 }}
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
                  const complete =
                    !submitted && isWorkloadComplete(a.course_id, a.id);
                  const isFavorited = workloadIsFavorite(a.course_id, a.id);

                  return (
                    <div key={`next-${a.course_id}-${a.id}`} className="card">
                      <div className="cardBody" style={{ padding: 0 }}>
                        <div className="plannerCard">
                          <div className={`plannerBar plannerBar-${variant}`} />
                          <div
                            className="plannerContent"
                            style={{ padding: 10 }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 10,
                              }}
                            >
                              <div
                                className="plannerTitle"
                                title={a.name}
                                style={{ fontWeight: 900 }}
                              >
                                <span className="plannerTitleWrap">
                                  {isFavorited ? <FavoriteMarker /> : null}
                                  <span>{a.name}</span>
                                </span>
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  gap: 8,
                                  alignItems: "center",
                                  flexWrap: "wrap",
                                }}
                              >
                                {renderSingleStatusBadge({
                                  missing,
                                  submitted,
                                  complete,
                                })}
                              </div>
                            </div>

                            <div
                              className="muted"
                              style={{ marginTop: 6, fontSize: 12 }}
                            >
                              <span className="mono">{courseLabel}</span>
                            </div>

                            <div
                              className="muted"
                              style={{ marginTop: 6, fontSize: 12 }}
                            >
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
                                flexWrap: "wrap",
                              }}
                            >
                              <button
                                className="btn"
                                onClick={() =>
                                  navigateToAssignment(a.course_id, a.id)
                                }
                              >
                                View assignment
                              </button>
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

              {splitPopCap == null ? (
                <div style={{ marginTop: 4 }}>
                  Max you can plan: <span className="mono">—</span>{" "}
                  <span className="muted">(set an estimate to enable splits)</span>
                </div>
              ) : (
                <div style={{ marginTop: 4 }}>
                  Max you can plan:{" "}
                  <span className="mono">
                    {splitPopCap.toFixed(1)}h
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

                <button
                  type="button"
                  className="btn"
                  onClick={applySplitFromPopover}
                  disabled={!splitPopCanApply}
                >
                  Apply
                </button>
              </div>
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                Completing a split will add those hours to “completed effort”.
              </div>
            </div>

            {splitPopErr ? (
              <div
                className="dangerText"
                style={{ marginTop: 10, fontSize: 12 }}
              >
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

          {view.undated.length === 0 && (!view.todoUndated || view.todoUndated.length === 0) ? (
            <div className="muted">None</div>
          ) : null}

          {/* Personal to-do items without a due date */}
          {view.todoUndated && view.todoUndated.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <div
                  className="h3"
                  style={{ marginTop: 0, marginBottom: 0, fontSize: "var(--fontSm)", textTransform: "uppercase", letterSpacing: "0.04em" }}
                >
                  Personal — undated
                </div>
                <span className="pill">{view.todoUndated.length}</span>
              </div>
              <ul className="list">
                {view.todoUndated.map((t) => (
                  <li key={`todo-und-${t.id}`} className="card plannerUndatedItem">
                    <div className="cardBody" style={{ padding: 0, height: "auto" }}>
                      <div className="plannerCard">
                        <div className="plannerBar plannerBar-todo" />
                        <div className="plannerContent plannerUndatedContent">
                          <div className="plannerUndatedTopRow">
                            <div className="plannerUndatedMain">
                              <div
                                className="plannerTitle plannerUndatedTitle"
                                title={t.title}
                              >
                                <span className="plannerTitleWrap">
                                  {workloadIsFavorite("todo", t.id) ? <FavoriteMarker /> : null}
                                  <span>{t.title}</span>
                                </span>
                                <span className="badge badgeNeutral plannerUndatedBadge">Personal</span>
                              </div>
                              <div className="muted plannerUndatedMeta">
                                <span className="mono">TO-DO's</span> • No due date
                              </div>
                              {t.notes ? (
                                <div className="muted plannerUndatedNotes" title={t.notes}>
                                  {t.notes}
                                </div>
                              ) : null}
                            </div>

                            <button
                              className="btn plannerUndatedAction"
                              onClick={() => navigateToTodoItem(t.id)}
                            >
                              View
                            </button>
                          </div>

                          <div className="plannerEffortCompact plannerUndatedEffort">
                            <WorkloadEstimateControl
                              courseId="todo"
                              assignmentId={t.id}
                              compactLabels={true}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {view.undated.length ? (
            <div style={{ marginTop: view.todoUndated && view.todoUndated.length > 0 ? 16 : 10 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <div
                  className="h3"
                  style={{ marginTop: 0, marginBottom: 0, fontSize: "var(--fontSm)", textTransform: "uppercase", letterSpacing: "0.04em" }}
                >
                  Canvas — undated
                </div>
                <span className="pill">{view.undated.length}</span>
              </div>
              <div className="muted">
                Count: <span className="mono">{view.undated.length}</span> •
                (These don’t appear in the calendar columns.)
              </div>
              <ul className="list" style={{ marginTop: 10 }}>
                {view.undated.slice(0, 10).map((a) => {
                  const courseLabel = a.course_name ?? "Unknown Course";
                  const hasDesc = !!stripHtml(a.description);
                  const submitted = !!a.submitted;
                  const status = renderSingleStatusBadge({
                    missing: false,
                    submitted,
                    complete: false,
                  });
                  const barVariant = submitted ? "submitted" : "original";
                  const isFavorited = workloadIsFavorite(a.course_id, a.id);

                  return (
                    <li key={`und-${a.course_id}-${a.id}`} className="card plannerUndatedItem">
                      <div className="cardBody" style={{ padding: 0, height: "auto" }}>
                        <div className="plannerCard">
                          <div className={`plannerBar plannerBar-${barVariant}`} />
                          <div className="plannerContent plannerUndatedContent">
                            <div className="plannerUndatedTopRow">
                              <div className="plannerUndatedMain">
                                <div
                                  className="plannerTitle plannerUndatedTitle"
                                  title={a.name}
                                >
                                  <span className="plannerTitleWrap">
                                    {isFavorited ? <FavoriteMarker /> : null}
                                    <span>{a.name}</span>
                                  </span>
                                  {status}
                                </div>
                                <div className="muted plannerUndatedMeta" title={courseLabel}>
                                  <span className="mono">{courseLabel}</span>
                                  {hasDesc ? " • Description available" : ""}
                                </div>
                              </div>

                              <button
                                className="btn plannerUndatedAction"
                                onClick={() => navigateToAssignment(a.course_id, a.id)}
                              >
                                View
                              </button>
                            </div>

                            <div className="plannerEffortCompact plannerUndatedEffort">
                              <WorkloadEstimateControl
                                courseId={a.course_id}
                                assignmentId={a.id}
                                compactLabels={true}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
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
                  "Reset planner cache?\n\nThis will:\n- Delete all split cards\n- Clear planner settings\n- Clear ALL effort/workload estimates stored in this browser\n\nThis cannot be undone.",
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
