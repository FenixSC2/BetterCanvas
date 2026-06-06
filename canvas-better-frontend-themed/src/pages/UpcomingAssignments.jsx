// src/pages/UpcomingAssignments.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { WorkloadEstimateControl } from "../components/WorkloadEstimateControl";
import { useCachedAsync } from "../hooks/useCachedAsync";
import { loadTodos, syncTodos, updateTodoItem } from "../lib/todoStore";
import {
  loadAcceptedGradeKeys,
  acceptedGradeKey,
  hydrateAcceptedGradeKeysFromServer,
  markAssignmentCompletedLocal,
  markAssignmentCompletedRemote,
} from "../lib/acceptedGrades";
import { isAssignmentFavorited } from "../lib/workloadEstimates";
import { formatCourseTitle } from "../utils/courseUtils";

const UPCOMING_SORT_BLEND_KEY = "upcoming:sort:blend";

function loadSortBlend() {
  const raw = localStorage.getItem(UPCOMING_SORT_BLEND_KEY);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0.35;
  return Math.max(0, Math.min(1, parsed));
}

function fmtDue(dt) {
  if (!dt) return "No due date";
  const d = new Date(dt);
  return d.toLocaleString();
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

function decodeHtmlEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function collectAttachmentLinks(assignment) {
  const out = [];
  const seen = new Set();

  function push(name, url, contentType) {
    if (!url) return;
    const key = url.split("?")[0];
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: name || "Attachment",
      url,
      isPdf:
        (contentType && /pdf/i.test(contentType)) ||
        /\.pdf(\?|$)/i.test(key),
    });
  }

  const atts = Array.isArray(assignment?.attachments)
    ? assignment.attachments
    : [];
  for (const att of atts) {
    push(att?.display_name || att?.filename, att?.url, att?.content_type);
  }

  const html = typeof assignment?.description === "string"
    ? assignment.description
    : "";
  if (html && /</.test(html)) {
    const anchorRe = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
      const url = decodeHtmlEntities(m[1]);
      if (!/\.pdf(\?|$)/i.test(url) && !/\/files\/\d+/.test(url)) continue;
      const inner = stripHtml(m[2]).trim() || url.split("/").pop();
      push(decodeHtmlEntities(inner), url, null);
    }
  }

  return out;
}

function hoursUntil(dt) {
  if (!dt) return null;
  const t = new Date(dt).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / (1000 * 60 * 60);
}

function navigateToTodoItem(todoId) {
  localStorage.setItem(
    "nav:todo:target",
    JSON.stringify({ todoId, ts: Date.now() })
  );

  window.dispatchEvent(
    new CustomEvent("canvasbetter:navigate", { detail: { tab: "todo" } })
  );
}

function isTodoItem(item) {
  return item?.__kind === "todo";
}

function isCompletedItem(item) {
  return !!(item?.submitted || item?.completed);
}

// Basic urgency badge
function getUrgencyBadge(a) {
  if (isCompletedItem(a)) return { label: "Completed", variant: "success" };

  if (a.due_at) {
    const h = hoursUntil(a.due_at);
    if (h != null && h < 0) {
      return {
        label: isTodoItem(a) ? "Overdue" : "Missing",
        variant: "danger",
      };
    }
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
function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = "right",
  width = 320,
}) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width });

  useEffect(() => {
    if (!open) return;

    function recompute() {
      const anchor = anchorRef?.current;
      if (!anchor) return;

      const root = anchor.closest("[data-popover-root]");
      const rootRect = root?.getBoundingClientRect();
      if (!rootRect) return;

      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const maxWidth = Math.max(180, rootRect.width - margin * 2);
      const effectiveWidth = Math.min(width, maxWidth);

      let leftInRoot;
      if (align === "left") {
        leftInRoot = rect.left - rootRect.left;
      } else if (align === "center") {
        leftInRoot = rect.left - rootRect.left + rect.width / 2 - effectiveWidth / 2;
      } else {
        leftInRoot = rect.right - rootRect.left - effectiveWidth;
      }

      leftInRoot = Math.max(
        margin,
        Math.min(leftInRoot, rootRect.width - effectiveWidth - margin)
      );

      const topInRoot = rect.bottom - rootRect.top + margin;

      const next = {
        top: Math.round(topInRoot),
        left: Math.round(leftInRoot),
        width: Math.round(effectiveWidth),
      };
      setPos((prev) =>
        prev.top === next.top && prev.left === next.left && prev.width === next.width
          ? prev
          : next
      );
    }

    recompute();
    window.addEventListener("resize", recompute);

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
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open, onClose, anchorRef, align, width]);

  if (!open) return null;

  return (
    <div
      className="anchoredPopover"
      style={{
        top: pos.top,
        left: pos.left,
        width: pos.width,
      }}
    >
      <div
        ref={panelRef}
        className="card anchoredPopoverCard"
      >
        <div className="cardBody">{children}</div>
      </div>
    </div>
  );
}

function parseUpcomingTarget(raw) {
  if (!raw) return null;

  // Accept "courseId:assignmentId"
  if (
    typeof raw === "string" &&
    raw.includes(":") &&
    !raw.trim().startsWith("{")
  ) {
    const [c, a] = raw.split(":");
    const courseId = Number(c);
    const assignmentId = Number(a);
    if (Number.isFinite(courseId) && Number.isFinite(assignmentId))
      return { courseId, assignmentId };
  }

  // Accept JSON: {"courseId":...,"assignmentId":...} or variants
  try {
    const obj = JSON.parse(raw);
    const courseId = Number(
      obj.courseId ?? obj.course_id ?? obj.cid ?? obj.course
    );
    const assignmentId = Number(
      obj.assignmentId ??
        obj.assignment_id ??
        obj.id ??
        obj.aid ??
        obj.assignment
    );
    if (Number.isFinite(courseId) && Number.isFinite(assignmentId))
      return { courseId, assignmentId };
  } catch {
    // ignore
  }

  return null;
}

function firstLine(text, max = 120) {
  if (!text) return "";
  const t = String(text).replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function normalizeTodo(todo) {
  const title = String(todo?.title || "").trim();
  const notes = String(todo?.notes || "").trim();
  const fallbackTitle = firstLine(notes, 64) || "Untitled TO-DO";

  return {
    ...todo,
    name: title || fallbackTitle,
    title: title || fallbackTitle,
    notes,
    __kind: "todo",
    course_id: "todo",
    course_name: "TO-DO's",
    description: notes,
    html_url: null,
    points_possible: null,
    submitted: !!todo.completed,
  };
}

function mergeAssignmentsByIdentity(primary, crossCheck) {
  const out = [];
  const seen = new Set();

  for (const item of primary || []) {
    const key = `${item?.course_id}:${item?.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  for (const item of crossCheck || []) {
    const key = `${item?.course_id}:${item?.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function AttachmentsList({ assignment }) {
  const links = collectAttachmentLinks(assignment);
  if (!links.length) return null;
  return (
    <div className="attachmentsList stack">
      <div className="muted">Attachments</div>
      <ul className="stack">
        {links.map((l) => (
          <li key={l.url}>
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              title={l.isPdf ? "Open PDF in new tab" : "Open file in new tab"}
            >
              {l.name}
              {l.isPdf ? (
                <span className="badge badgeNeutral" style={{ marginLeft: 8 }}>
                  PDF
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </div>
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

export function UpcomingAssignments() {
  // ✅ Cached fetch (prevents tab-switch flash)
  const upcomingQ = useCachedAsync(
    "upcoming:list",
    ({ signal }) => canvasApi.getUpcoming({ signal }),
    { ttlMs: 3 * 60 * 1000 }
  );

  const upcomingCrossCheckQ = useCachedAsync(
    "upcoming:cross-check",
    ({ signal }) => canvasApi.getUpcomingCrossCheck({ signal }),
    { ttlMs: 3 * 60 * 1000 }
  );

  const undatedQ = useCachedAsync(
    "undated:list",
    ({ signal }) => canvasApi.getUndatedAssignments({ signal }),
    { ttlMs: 3 * 60 * 1000 }
  );

  const personalDatesQ = useCachedAsync(
    "personal-assignment-dates",
    ({ signal }) => canvasApi.getPersonalAssignmentDates({ signal }),
    { ttlMs: 5 * 60 * 1000 }
  );

  const [personalDatesById, setPersonalDatesById] = useState({});
  const [addingDateFor, setAddingDateFor] = useState(null); // "course_id:assignment_id"
  const [addingDateInput, setAddingDateInput] = useState("");

  useEffect(() => {
    if (!personalDatesQ.data?.dates) return;
    const byId = {};
    for (const d of personalDatesQ.data.dates) {
      byId[`${d.course_id}:${d.assignment_id}`] = d.due_at;
    }
    setPersonalDatesById(byId);
  }, [personalDatesQ.data]);

  // Keep a stable ref to the latest refresh so intervals/mount effects
  // don't capture a stale closure (useCachedAsync recreates refresh each render)
  const refreshRef = useRef(null);
  refreshRef.current = upcomingQ.refresh;

  const crossCheckRefreshRef = useRef(null);
  crossCheckRefreshRef.current = upcomingCrossCheckQ.refresh;

  const undatedRefreshRef = useRef(null);
  undatedRefreshRef.current = undatedQ.refresh;

  // Kick off the first fetch on mount
  useEffect(() => {
    refreshRef.current?.();
    crossCheckRefreshRef.current?.();
    undatedRefreshRef.current?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh immediately when the user hides/unhides an assignment via Settings
  useEffect(() => {
    function onHiddenChanged() {
      refreshRef.current?.();
      crossCheckRefreshRef.current?.();
      undatedRefreshRef.current?.();
    }
    window.addEventListener("canvassist:hidden:changed", onHiddenChanged);
    return () => window.removeEventListener("canvassist:hidden:changed", onHiddenChanged);
  }, []);

  // Auto-refresh every 2.5 minutes while the page is open
  useEffect(() => {
    const POLL_MS = 2.5 * 60 * 1000;
    const t = setInterval(() => {
      refreshRef.current?.();
      crossCheckRefreshRef.current?.();
      undatedRefreshRef.current?.();
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  // track which details panels are open (allow multiple)
  const [openDetailsKeys, setOpenDetailsKeys] = useState(() => new Set());
  const [todos, setTodos] = useState(() => loadTodos());
  const [workloadTick, setWorkloadTick] = useState(0);

  // Tracks which graded-but-unsubmitted assignments the user has accepted/dismissed.
  // The Accept-grade button lives in the Grades tab now (so users can see the actual
  // grade before accepting). Upcoming still reads the same Set to hide accepted rows.
  // Refresh on focus so an acceptance in another tab takes effect when the user returns.
  const [acceptedGradeKeys, setAcceptedGradeKeys] = useState(() => loadAcceptedGradeKeys());
  useEffect(() => {
    let active = true;

    hydrateAcceptedGradeKeysFromServer()
      .then((next) => {
        if (active) setAcceptedGradeKeys(next);
      })
      .catch(() => {
        // local fallback remains active
      });

    function refresh() { setAcceptedGradeKeys(loadAcceptedGradeKeys()); }
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("canvassist:accepted-grades:changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("canvassist:accepted-grades:changed", refresh);
    };
  }, []);

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
      // keep optimistic local state
    }
  }

  const primaryCanvasItems = useMemo(
    () => (Array.isArray(upcomingQ.data) ? upcomingQ.data : []),
    [upcomingQ.data],
  );
  const crossCheckCanvasItems = useMemo(
    () => (Array.isArray(upcomingCrossCheckQ.data) ? upcomingCrossCheckQ.data : []),
    [upcomingCrossCheckQ.data],
  );
  const canvasItems = useMemo(
    () => mergeAssignmentsByIdentity(primaryCanvasItems, crossCheckCanvasItems),
    [primaryCanvasItems, crossCheckCanvasItems]
  );
  const canvasUndatedItems = useMemo(
    () => (Array.isArray(undatedQ.data) ? undatedQ.data : []),
    [undatedQ.data],
  );

  useEffect(() => {
    let active = true;

    syncTodos().then((serverTodos) => {
      if (active) setTodos(serverTodos);
    });

    function syncTodosLocal() {
      setTodos(loadTodos());
    }

    function onStorage(e) {
      if (e.key === "canvassist:todos") syncTodosLocal();
    }

    window.addEventListener("canvassist:todos:changed", syncTodosLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      active = false;
      window.removeEventListener("canvassist:todos:changed", syncTodosLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    function onStorage(e) {
      if (!e?.key) return;
      const lk = String(e.key).toLowerCase();
      if (lk.includes("workload") || lk.includes("effort")) {
        setWorkloadTick((t) => t + 1);
      }
    }

    function onWorkloadChanged() {
      setWorkloadTick((t) => t + 1);
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("canvassist:workload:changed", onWorkloadChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(
        "canvassist:workload:changed",
        onWorkloadChanged,
      );
    };
  }, []);

  async function handleToggleTodoComplete(id) {
    const existing = todos.find((t) => t.id === id);
    if (!existing) return;
    await updateTodoItem(id, { ...existing, completed: !existing.completed });
    setTodos(loadTodos());
  }

  const todoItems = useMemo(() => todos.map(normalizeTodo), [todos]);
  const datedTodoItems = useMemo(
    () => todoItems.filter((todo) => !!todo.due_at),
    [todoItems]
  );
  const undatedTodoItems = useMemo(
    () => todoItems.filter((todo) => !todo.due_at),
    [todoItems]
  );

  const canvasPointStats = useMemo(() => {
    const datedWithPoints = canvasItems
      .map((item) => {
        const points = Number(item?.points_possible);
        const dueTs = item?.due_at ? new Date(item.due_at).getTime() : NaN;
        if (!Number.isFinite(points) || points <= 0 || !Number.isFinite(dueTs)) {
          return null;
        }
        return { points, dueTs };
      })
      .filter(Boolean);

    const allPoints = [...canvasItems, ...canvasUndatedItems]
      .map((item) => Number(item?.points_possible))
      .filter((points) => Number.isFinite(points) && points > 0);

    const avgPoints =
      allPoints.length > 0
        ? allPoints.reduce((sum, points) => sum + points, 0) / allPoints.length
        : 60;

    return {
      avgPoints,
      datedWithPoints,
    };
  }, [canvasItems, canvasUndatedItems]);

  // Undated Canvas assignments that have a user-set personal date — injected into dated section
  const personallyDatedItems = useMemo(
    () =>
      canvasUndatedItems
        .filter((a) => personalDatesById[`${a.course_id}:${a.id}`])
        .map((a) => ({
          ...a,
          due_at: personalDatesById[`${a.course_id}:${a.id}`],
          _personalDate: true,
        })),
    [canvasUndatedItems, personalDatesById]
  );

  const items = useMemo(
    () => [...canvasItems, ...personallyDatedItems, ...datedTodoItems],
    [canvasItems, personallyDatedItems, datedTodoItems]
  );

  // Apply same loading logic as announcements
  const upcomingLoading =
    (upcomingQ.loading || upcomingQ.data == null) && !upcomingQ.error;

  // Filter: all | missing | upcoming | completed | undated | todo
  const [filterMode, setFilterMode] = useState("all");

  // Sorting blend: 0 = date only, 1 = points only
  const [blend, setBlend] = useState(loadSortBlend);

  useEffect(() => {
    localStorage.setItem(UPCOMING_SORT_BLEND_KEY, String(blend));
  }, [blend]);

  // Popover state
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const filterBtnRef = useRef(null);
  const sortBtnRef = useRef(null);

  // Focus/highlight state (for WeeklyPlanner -> UpcomingAssignments navigation)
  const [focusKey, setFocusKey] = useState(null); // `${courseId}-${assignmentId}`
  const focusTimerRef = useRef(null);
  const pendingFocusRef = useRef(null); // stores target until DOM is ready

  const filteredSorted = useMemo(() => {
    const now = Date.now();
    const TODO_NEARBY_WINDOW_HOURS = 72;
    const todoWeightMemo = new Map();

    const normalizePoints = (p) => {
      const n = typeof p === "number" ? p : Number(p);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(300, n));
    };

    const getSyntheticTodoWeight = (todo) => {
      const key = String(todo?.id || "");
      if (todoWeightMemo.has(key)) return todoWeightMemo.get(key);

      const baseWeight = normalizePoints(canvasPointStats.avgPoints || 60);
      let syntheticWeight = baseWeight;

      if (todo?.due_at && canvasPointStats.datedWithPoints.length > 0) {
        const dueTs = new Date(todo.due_at).getTime();
        if (Number.isFinite(dueTs)) {
          const nearbyPoints = canvasPointStats.datedWithPoints
            .filter(
              ({ dueTs: otherDueTs }) =>
                Math.abs(otherDueTs - dueTs) <=
                TODO_NEARBY_WINDOW_HOURS * 60 * 60 * 1000
            )
            .map(({ points }) => points);

          if (nearbyPoints.length > 0) {
            const nearbyAvg =
              nearbyPoints.reduce((sum, points) => sum + points, 0) /
              nearbyPoints.length;
            syntheticWeight = normalizePoints(nearbyAvg);
          }
        }
      }

      if (todo?.due_at) {
        const h = hoursUntil(todo.due_at);
        if (h != null && h < 0) {
          syntheticWeight = Math.max(syntheticWeight, baseWeight * 1.25);
        } else if (h != null && h <= 48) {
          syntheticWeight = Math.max(syntheticWeight, baseWeight * 1.1);
        }
      }

      // Keep todo weight competitive but bounded.
      const bounded = Math.max(30, Math.min(220, syntheticWeight));
      todoWeightMemo.set(key, bounded);
      return bounded;
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

    const weightScore = (a) =>
      isTodoItem(a)
        ? getSyntheticTodoWeight(a)
        : normalizePoints(a?.points_possible);

    const isGradeAccepted = (a) =>
      !isTodoItem(a) && acceptedGradeKeys.has(acceptedGradeKey(a.course_id, a.id));

    const isMissing = (a) => {
      if (isCompletedItem(a)) return false;
      if (isGradeAccepted(a)) return false;
      const h = hoursUntil(a.due_at);
      return h != null && h < 0;
    };

    const isUpcoming = (a) => {
      if (!a?.due_at || isCompletedItem(a)) return false;
      const h = hoursUntil(a.due_at);
      return h != null && h >= 0;
    };

    const isCompleted = (a) => isCompletedItem(a) || isGradeAccepted(a);
    const isTodo = (a) => isTodoItem(a);
    const isFavorite = (a) =>
      isAssignmentFavorited({
        courseId: isTodoItem(a) ? "todo" : a.course_id,
        assignmentId: a.id,
      });

    // Filter out completed assignments that are past their due date
    const shouldShow = (a) => {
      // If completed and past due date, don't show
      if (isCompletedItem(a) && a.due_at) {
        const h = hoursUntil(a.due_at);
        if (h != null && h < 0) return false;
      }
      return true;
    };

    // 1) filter - missing assignments always appear at top, then apply selected filter
    let list = [...items].filter(shouldShow);
    const missing = list.filter(isMissing);
    const nonMissing = list.filter((a) => !isMissing(a));

    let filtered;
    if (filterMode === "missing") {
      filtered = missing;
      list = missing; // Only show missing items, don't duplicate
    } else if (filterMode === "favorites") {
      filtered = list.filter(isFavorite);
      const filteredMissing = filtered.filter(isMissing);
      const filteredNonMissing = filtered.filter((a) => !isMissing(a));
      list = [...filteredMissing, ...filteredNonMissing];
    } else if (filterMode === "todo") {
      filtered = list.filter(isTodo);
      const filteredMissing = filtered.filter(isMissing);
      const filteredNonMissing = filtered.filter((a) => !isMissing(a));
      list = [...filteredMissing, ...filteredNonMissing];
    } else if (filterMode === "upcoming") {
      filtered = nonMissing.filter(isUpcoming);
      list = [...missing, ...filtered];
    } else if (filterMode === "completed") {
      filtered = list.filter(isCompleted);
      list = filtered;
    } else {
      // "all"
      filtered = nonMissing;
      list = [...missing, ...filtered];
    }

    // 2) sorting with invariants: missing first, completed last
    list.sort((a, b) => {
      const aMissing = isMissing(a);
      const bMissing = isMissing(b);
      if (aMissing !== bMissing) return aMissing ? -1 : 1;

      const aFavorite = isFavorite(a);
      const bFavorite = isFavorite(b);
      if (aFavorite !== bFavorite) return aFavorite ? -1 : 1;

      const aCompleted = isCompleted(a);
      const bCompleted = isCompleted(b);
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
    // workloadTick is an intentional invalidation key for isAssignmentFavorited (reads localStorage)
  }, [items, filterMode, blend, canvasPointStats, workloadTick, acceptedGradeKeys]); // oxlint-disable-line react-doctor/exhaustive-deps

  // Separate list for undated assignments (for the undated section)
  const undatedSorted = useMemo(() => {
    const now = Date.now();
    const TODO_BASE_WEIGHT = Math.max(
      30,
      Math.min(220, Number(canvasPointStats.avgPoints) || 60)
    );

    const normalizePoints = (p) => {
      const n = typeof p === "number" ? p : Number(p);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(300, n));
    };

    const timeScore = (a) => {
      if (!a?.due_at) return 0;
      const t = new Date(a.due_at).getTime();
      if (!Number.isFinite(t)) return 0;
      const hours = (t - now) / (1000 * 60 * 60);
      if (hours < 0) return 10_000;
      return 1200 / Math.max(1, hours);
    };

    const weightScore = (a) =>
      isTodoItem(a) ? TODO_BASE_WEIGHT : normalizePoints(a?.points_possible);

    const isCompleted = (a) => isCompletedItem(a);
    const isTodo = (a) => isTodoItem(a);
    const isFavorite = (a) =>
      isAssignmentFavorited({
        courseId: isTodoItem(a) ? "todo" : a.course_id,
        assignmentId: a.id,
      });

    let undatedItems = [
      ...canvasUndatedItems.filter((a) => !personalDatesById[`${a.course_id}:${a.id}`]),
      ...undatedTodoItems,
    ];

    if (filterMode === "todo") {
      undatedItems = undatedItems.filter(isTodo);
    } else if (filterMode === "favorites") {
      undatedItems = undatedItems.filter(isFavorite);
    }

    // Filter out completed assignments that are past their due date
    const shouldShow = (a) => {
      if (isCompleted(a) && a.due_at) {
        const h = hoursUntil(a.due_at);
        if (h != null && h < 0) return false;
      }
      return true;
    };

    let list = [...undatedItems].filter(shouldShow);

    // Sort: completed last
    list.sort((a, b) => {
      const aCompleted = isCompleted(a);
      const bCompleted = isCompleted(b);
      if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;

      const aFavorite = isFavorite(a);
      const bFavorite = isFavorite(b);
      if (aFavorite !== bFavorite) return aFavorite ? -1 : 1;

      if (isTodo(a) !== isTodo(b)) return isTodo(a) ? -1 : 1;

      const aScore = (1 - blend) * timeScore(a) + blend * weightScore(a);
      const bScore = (1 - blend) * timeScore(b) + blend * weightScore(b);
      if (bScore !== aScore) return bScore - aScore;

      return 0;
    });

    return list;
    // workloadTick is an intentional invalidation key for isAssignmentFavorited (reads localStorage)
  }, [
    canvasUndatedItems,
    undatedTodoItems,
    personalDatesById,
    blend,
    filterMode,
    canvasPointStats,
    workloadTick, // oxlint-disable-line react-doctor/exhaustive-deps
  ]);

  // === Auto-focus target assignment ===
  /* oxlint-disable react-doctor/no-event-handler -- responds to localStorage nav target + async data arrival; no handler on this page sets these */
  useEffect(() => {
    // wait until we have *some* data (cached or freshly loaded)
    if (!canvasItems?.length) return;

    const raw = localStorage.getItem("nav:upcoming:target");
    const target = parseUpcomingTarget(raw);
    if (!target) return;

    const key = `${target.courseId}-${target.assignmentId}`;
    const exists = canvasItems.some(
      (a) =>
        Number(a.course_id) === target.courseId &&
        Number(a.id) === target.assignmentId
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
  }, [canvasItems, filterMode]);
  /* oxlint-enable react-doctor/no-event-handler */

  // After list renders (filteredSorted changes), perform scroll if pending.
  // The timer ID is set inside an async run() closure, so the cleanup reads the
  // latest ref value rather than a snapshot — clearing the most recent timer is
  // the intended behavior here.
  // oxlint-disable-next-line react-doctor/exhaustive-deps
  useEffect(() => {
    const key = pendingFocusRef.current;
    if (!key) return;

    const elId = `asg-${key}`;
    const run = () => {
      const el = document.getElementById(elId);
      if (!el) return false;

      setFocusKey(key);
      el.scrollIntoView({ behavior: "smooth", block: "center" });

      pendingFocusRef.current = null;

      if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = window.setTimeout(() => setFocusKey(null), 2500);

      return true;
    };

    requestAnimationFrame(() => {
      if (run()) return;
      requestAnimationFrame(() => run());
    });

    return () => {
      // focusTimerRef is assigned inside the async `run` closure above, so we
      // can only read the latest value here. The setTimeout sets a fresh ID each
      // time, so clearing the latest matches expectations.
      if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
    };
  }, [filteredSorted]); // oxlint-disable-line react-doctor/exhaustive-deps

  if (upcomingQ.error || undatedQ.error)
    return <ErrorBox error={upcomingQ.error || undatedQ.error} />


  const filterLabel =
    filterMode === "all"
      ? "All"
      : filterMode === "missing"
      ? "Missing"
      : filterMode === "upcoming"
      ? "Upcoming"
      : filterMode === "favorites"
      ? "Favorites"
      : filterMode === "completed"
      ? "Completed"
      : filterMode === "todo"
      ? "TO-DO's"
      : "Undated";

  return (
    <div className="stack" style={{ position: "relative" }} data-popover-root>
      <div className="upcomingControlsRow">
        <div className="muted">
          Powered by <span className="mono">GET /api/upcoming</span>.
          <span> • Includes personal TO-DO items stored in this browser.</span>
          {upcomingQ.refreshing ? (
            <span className="muted"> • Updating…</span>
          ) : null}
        </div>

        {/* Controls */}
        <div className="upcomingControlsToolbar">
          <button
            type="button"
            ref={filterBtnRef}
            className="btn upcomingControlsBtn"
            onClick={() => {
              setFilterOpen((v) => !v);
              setSortOpen(false);
            }}
            title="Filter assignments"
          >
            Filter: <span className="mono">{filterLabel}</span>
          </button>

          <button
            type="button"
            ref={sortBtnRef}
            className="btn upcomingControlsBtn"
            onClick={() => {
              setSortOpen((v) => !v);
              setFilterOpen(false);
            }}
            title="Sort by time and/or points"
          >
            Sorting
          </button>

          <button
            type="button"
            className="btn upcomingControlsBtn"
            onClick={() => {
              upcomingQ.refresh();
              undatedQ.refresh();
            }}
            title="Fetch fresh upcoming assignments"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filter popover — stack options vertically */}
      <Popover
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        anchorRef={filterBtnRef}
        align="right"
        width={260}
      >
        <div className="stack">
          <div className="h3" style={{ marginBottom: 2 }}>
            Filter
          </div>
          <div className="muted">Show only items matching:</div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginTop: 6,
            }}
          >
            {[
              ["all", "All"],
              ["missing", "Missing"],
              ["upcoming", "Upcoming"],
              ["favorites", "Favorites"],
              ["completed", "Completed"],
              ["todo", "TO-DO's"],
              ["undated", "Undated"],
            ].map(([key, label]) => (
              <button
                type="button"
                key={key}
                className="btn"
                onClick={() => {
                  setFilterMode(key);
                  setFilterOpen(false);
                }}
                title={`Show ${label.toLowerCase()} items`}
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

      {/* Sorting popover */}
      <Popover
        open={sortOpen}
        onClose={() => setSortOpen(false)}
        anchorRef={sortBtnRef}
        align="center"
        width={360}
      >
        <div className="stack">
          <div className="h3" style={{ marginBottom: 2 }}>
            Sorting blend
          </div>
          <div className="muted">
            Left = prioritize due date • Right = prioritize points
          </div>

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
              aria-label="Blend between due-date and effort sort"
              value={blend}
              onChange={(e) => setBlend(Number(e.target.value))}
              style={{ flex: 1, minWidth: 160 }}
            />

            <span className="mono" style={{ minWidth: 52, textAlign: "right" }}>
              Points
            </span>
          </div>

          <div
            className="rowWrap"
            style={{ gap: 10, alignItems: "center", marginTop: 4 }}
          >
            <span className="muted">Blend</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              aria-label="Sort blend value"
              value={blend}
              onChange={(e) => setBlend(Number(e.target.value))}
              style={{ width: 90 }}
            />
            <span className="muted">(0–1)</span>
          </div>

          <div className="muted">
            Tip: keep this around <span className="mono">0.25–0.45</span> to
            stay time-heavy.
          </div>
        </div>
      </Popover>

      {/* === Upcoming assignments wrapper === */}
      {filterMode !== "undated" ? (
        <div className="upcomingPanel">
          <div className="upcomingPanelHeader">
            <div className="upcomingPanelHeaderLeft">
              <div className="upcomingPanelTitle">
                Upcoming assignments
                <span className="upcomingPanelCount mono">
                  {filteredSorted.length}
                </span>
              </div>

              <div className="muted">
                Filter: <span className="mono">{filterLabel}</span>
                {upcomingQ.refreshing ? (
                  <span className="muted"> • Updating…</span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="upcomingPanelBody">
            {upcomingLoading ? (
              <Loading label="Loading upcoming assignments…" />
            ) : filteredSorted.length === 0 ? (
              <div className="muted" style={{ padding: 10 }}>
                No items found for the selected filter.
              </div>
            ) : (
              <ul className="list listSpaced">{filteredSorted.map((a) => {
                const badge = getUrgencyBadge(a);
                const todoItem = isTodoItem(a);

                const isMissing =
                  !isCompletedItem(a) &&
                  !acceptedGradeKeys.has(acceptedGradeKey(a.course_id, a.id)) &&
                  a.due_at &&
                  hoursUntil(a.due_at) != null &&
                  hoursUntil(a.due_at) < 0;

                const courseLabel = todoItem
                  ? "TO-DO's"
                  : formatCourseTitle(a.course_name) ?? "Unknown Course";
                const dueLabel = fmtDue(a.due_at);

                const desc = todoItem
                  ? String(a.description || "").trim()
                  : stripHtml(a.description);
                const hasDesc = !!desc;

                const focusId = todoItem ? `todo-${a.id}` : `${a.course_id}-${a.id}`;
                const isFocused = focusKey === focusId;
                const isFavorited = isAssignmentFavorited({
                  courseId: todoItem ? "todo" : a.course_id,
                  assignmentId: a.id,
                });

                return (
                  <li
                    id={`asg-${focusId}`}
                    key={focusId}
                    className={`listItem ${isMissing ? "dangerItem" : ""} ${
                      isFocused ? "isFocused" : ""
                    }`}
                    style={{ overflow: "hidden" }}
                  >
                    <div
                      className={`assignmentRow ${isMissing ? "assignmentRowMissing" : ""}`}
                      style={{ minWidth: 0, width: "100%", maxWidth: "100%" }}
                    >
                      <div
                        className="assignmentMain"
                        style={{ minWidth: 0, flex: "1 1 0", width: "100%", maxWidth: "100%" }}
                      >
                        <div className="assignmentTop">
                          <div className="assignmentTitleRow">
                            <div className="assignmentTitleRowLeft">
                              {todoItem ? (
                                <input
                                  type="checkbox"
                                  className="themeCheckbox"
                                  checked={!!a.completed}
                                  onChange={() => handleToggleTodoComplete(a.id)}
                                  style={{ marginTop: 2, flexShrink: 0 }}
                                  aria-label={a.completed ? "Mark incomplete" : "Mark complete"}
                                />
                              ) : null}
                              <span className="assignmentNameWrap">
                                {isFavorited ? <FavoriteMarker /> : null}
                                <span className="assignmentName" style={todoItem && a.completed ? { textDecoration: "line-through" } : undefined}>{a.name}</span>
                              </span>

                              <span
                                className={`badge badge${
                                  badge.variant === "success"
                                    ? "Success"
                                    : badge.variant === "danger"
                                    ? "Danger"
                                    : badge.variant === "warning"
                                    ? "Warn"
                                    : "Neutral"
                                }`}
                              >
                                {badge.label}
                              </span>

                              {todoItem ? (
                                <span className="badge badgeNeutral">
                                  {a.source?.startsWith("announcement") ? "Announcement" : "Personal"}
                                </span>
                              ) : a._personalDate ? (
                                <span className="badge badgeNeutral">Personal date</span>
                              ) : typeof a.points_possible === "number" ? (
                                <span className="muted assignmentPts">
                                  <span className="mono">
                                    {a.points_possible}
                                  </span>{" "}
                                  pts
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <div
                            className={`muted ${
                              isMissing ? "dangerMuted" : ""
                            }`}
                          >
                            <span className="mono">{courseLabel}</span>
                          </div>
                        </div>

                        <div className="assignmentControls">
                          <WorkloadEstimateControl
                            courseId={todoItem ? "todo" : a.course_id}
                            assignmentId={a.id}
                            compactLabels={!todoItem && isMissing}
                          />
                        </div>
                      </div>

                      <div
                        className="assignmentActions"
                        style={{ minWidth: 0, maxWidth: "100%" }}
                      >
                        <div
                          className={`muted assignmentDueRight ${
                            isMissing ? "dangerText" : ""
                          }`}
                          style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
                        >
                          Due: <span className="mono">{dueLabel}</span>
                        </div>

                        {a.html_url ? (
                          <a
                            className="btn"
                            href={a.html_url}
                            target="_blank"
                            rel="noreferrer"
                            title="Open assignment in Canvas"
                          >
                            Open in Canvas
                          </a>
                        ) : null}

                        {/* "Accept grade" lives on the Grades tab now — see GradePerformance.jsx —
                            so the user can see the actual score before accepting. */}

                        {!todoItem && isMissing ? (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              void markCompleted(a.course_id, a.id);
                            }}
                            title="Mark completed and stop showing this as missing"
                          >
                            Mark completed
                          </button>
                        ) : null}

                        {a._personalDate ? (
                          <button
                            type="button"
                            className="btn"
                            style={{ fontSize: "var(--fontSm)" }}
                            onClick={async () => {
                              await canvasApi.deletePersonalAssignmentDate(a.course_id, a.id);
                              setPersonalDatesById((prev) => {
                                const next = { ...prev };
                                delete next[`${a.course_id}:${a.id}`];
                                return next;
                              });
                            }}
                          >
                            Remove date
                          </button>
                        ) : null}
                      </div>

                      <div className="assignmentDetails">
                        <Expandable
                          title="Details"
                          defaultOpen={openDetailsKeys.has(focusId)}
                          subtitle={
                            hasDesc && !openDetailsKeys.has(focusId) ? (
                              <span className="muted">{firstLine(desc)}</span>
                            ) : hasDesc ? (
                              <span className="muted"> </span>
                            ) : (
                              <span className="muted">No description</span>
                            )
                          }
                          onToggle={(isOpen) => {
                            setOpenDetailsKeys((prev) => {
                              const next = new Set(prev);
                              if (isOpen) next.add(focusId);
                              else next.delete(focusId);
                              return next;
                            });
                          }}
                        >
                          <div className="stack">
                            {hasDesc ? (
                              <div className="preserveWhitespace">{desc}</div>
                            ) : (
                              <div className="muted">
                                No description provided.
                              </div>
                            )}
                            {!todoItem ? <AttachmentsList assignment={a} /> : null}
                          </div>
                        </Expandable>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="upcomingPanelFooter muted">
          Tip: effort estimates are stored locally in your browser (per
          assignment).
        </div>
      </div>
      ) : null}

      {/* === Undated assignments section (show when filtering by undated OR when mode is "all") === */}
      {filterMode === "undated" || filterMode === "all" || filterMode === "todo" || filterMode === "favorites" ? (
        <div className="upcomingPanel">
          <div className="upcomingPanelHeader">
            <div className="upcomingPanelHeaderLeft">
              <div className="upcomingPanelTitle">
                Undated assignments
                <span className="upcomingPanelCount mono">
                  {undatedSorted.length}
                </span>
              </div>

              <div className="muted">
                {filterMode === "todo"
                  ? "Undated personal TO-DO items"
                  : filterMode === "favorites"
                  ? "Favorited items without due dates"
                  : filterMode === "undated"
                  ? `Filter: ${filterLabel}`
                  : "No due date set"}
                {undatedQ.refreshing ? (
                  <span className="muted"> • Updating…</span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="upcomingPanelBody">
            {(undatedQ.loading || undatedQ.data == null) && !undatedQ.error ? (
              <Loading label="Loading assignments…" />
            ) : undatedSorted.length === 0 ? (
              <div className="muted" style={{ padding: 10 }}>
                {filterMode === "todo" ? "No undated TO-DO items." : "No undated assignments."}
              </div>
            ) : (
              <ul className="list listSpaced">
                {undatedSorted.map((a) => {
                  const badge = getUrgencyBadge(a);
                  const todoItem = isTodoItem(a);

                  const courseLabel = todoItem
                    ? "TO-DO's"
                    : formatCourseTitle(a.course_name) ?? "Unknown Course";

                  const desc = todoItem
                    ? String(a.description || "").trim()
                    : stripHtml(a.description);
                  const hasDesc = !!desc;

                  const focusId = todoItem ? `todo-${a.id}` : `${a.course_id}-${a.id}`;
                  const isFocused = focusKey === focusId;
                  const isFavorited = isAssignmentFavorited({
                    courseId: todoItem ? "todo" : a.course_id,
                    assignmentId: a.id,
                  });

                  return (
                    <li
                      id={`asg-${focusId}`}
                      key={focusId}
                      className={`listItem ${isFocused ? "isFocused" : ""}`}
                      style={{ overflow: "hidden" }}
                    >
                      <div className="assignmentRow" style={{ minWidth: 0 }}>
                        <div className="assignmentMain" style={{ minWidth: 0 }}>
                          <div className="assignmentTop">
                            <div className="assignmentTitleRow">
                              <div className="assignmentTitleRowLeft">
                                {todoItem ? (
                                  <input
                                    type="checkbox"
                                    className="themeCheckbox"
                                    checked={!!a.completed}
                                    onChange={() => handleToggleTodoComplete(a.id)}
                                    style={{ marginTop: 2, flexShrink: 0 }}
                                    aria-label={a.completed ? "Mark incomplete" : "Mark complete"}
                                  />
                                ) : null}
                                <span className="assignmentNameWrap">
                                  {isFavorited ? <FavoriteMarker /> : null}
                                  <span className="assignmentName" style={todoItem && a.completed ? { textDecoration: "line-through" } : undefined}>{a.name}</span>
                                </span>

                                <span
                                  className={`badge badge${
                                    badge.variant === "success"
                                      ? "Success"
                                      : badge.variant === "danger"
                                      ? "Danger"
                                      : badge.variant === "warning"
                                      ? "Warn"
                                      : "Neutral"
                                  }`}
                                >
                                  {badge.label}
                                </span>

                                {todoItem ? (
                                  <span className="badge badgeNeutral">
                                    {a.source?.startsWith("announcement") ? "Announcement" : "Personal"}
                                  </span>
                                ) : typeof a.points_possible === "number" ? (
                                  <span className="muted assignmentPts">
                                    <span className="mono">{a.points_possible}</span>{" "}
                                    pts
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div className="muted">
                              <span className="mono">{courseLabel}</span>
                            </div>
                          </div>

                          <div className="assignmentControls">
                            <WorkloadEstimateControl
                              courseId={todoItem ? "todo" : a.course_id}
                              assignmentId={a.id}
                            />
                          </div>
                        </div>

                        {todoItem ? (
                          <div className="assignmentActions" style={{ minWidth: 0 }}>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => navigateToTodoItem(a.id)}
                              title="Open this item in TO-DO's"
                            >
                              View TO-DO
                            </button>
                          </div>
                        ) : (
                          <div className="assignmentActions" style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                            {a.html_url ? (
                              <a
                                className="btn"
                                href={a.html_url}
                                target="_blank"
                                rel="noreferrer"
                                title="Open assignment in Canvas"
                              >
                                Open in Canvas
                              </a>
                            ) : null}
                            {addingDateFor === focusId ? (
                              <>
                                <input
                                  type="datetime-local"
                                  aria-label="Set a personal due date"
                                  value={addingDateInput}
                                  onChange={(e) => setAddingDateInput(e.target.value)}
                                  style={{ fontSize: "var(--fontSm)" }}
                                />
                                <button
                                  type="button"
                                  className="btn"
                                  style={{ fontSize: "var(--fontSm)" }}
                                  onClick={async () => {
                                    if (!addingDateInput) return;
                                    const due_at = addingDateInput.length === 16
                                      ? `${addingDateInput}:00`
                                      : addingDateInput;
                                    await canvasApi.upsertPersonalAssignmentDate(a.course_id, a.id, due_at);
                                    setPersonalDatesById((prev) => ({
                                      ...prev,
                                      [`${a.course_id}:${a.id}`]: due_at,
                                    }));
                                    setAddingDateFor(null);
                                    setAddingDateInput("");
                                  }}
                                >
                                  Save date
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  style={{ fontSize: "var(--fontSm)" }}
                                  onClick={() => { setAddingDateFor(null); setAddingDateInput(""); }}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn"
                                style={{ fontSize: "var(--fontSm)" }}
                                onClick={() => { setAddingDateFor(focusId); setAddingDateInput(""); }}
                              >
                                Add date
                              </button>
                            )}
                          </div>
                        )}

                        <div className="assignmentDetails">
                          <Expandable
                            title="Details"
                            defaultOpen={openDetailsKeys.has(focusId)}
                            subtitle={
                              hasDesc && !openDetailsKeys.has(focusId) ? (
                                <span className="muted">{firstLine(desc)}</span>
                              ) : hasDesc ? (
                                <span className="muted"> </span>
                              ) : (
                                <span className="muted">
                                  {todoItem ? "No notes" : "No description"}
                                </span>
                              )
                            }
                            onToggle={(isOpen) => {
                              setOpenDetailsKeys((prev) => {
                                const next = new Set(prev);
                                if (isOpen) next.add(focusId);
                                else next.delete(focusId);
                                return next;
                              });
                            }}
                          >
                            <div className="stack">
                              {hasDesc ? (
                                <div className="preserveWhitespace">{desc}</div>
                              ) : (
                                <div className="muted">
                                  {todoItem
                                    ? "No notes provided."
                                    : "No description provided."}
                                </div>
                              )}
                              {!todoItem ? <AttachmentsList assignment={a} /> : null}
                            </div>
                          </Expandable>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="upcomingPanelFooter muted">
            Tip: effort estimates are stored locally in your browser (per
            assignment).
          </div>
        </div>
      ) : null}
    </div>
  );
}
