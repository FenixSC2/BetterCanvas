// src/pages/UpcomingAssignments.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { WorkloadEstimateControl } from "../components/WorkloadEstimateControl";
import { useCachedAsync, clearCachedAsync } from "../hooks/useCachedAsync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardFooter } from "@/components/ui/card";
import {
  Popover as ShadcnPopover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

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

export function UpcomingAssignments() {
  // ✅ Cached fetch (prevents tab-switch flash)
  const upcomingQ = useCachedAsync(
    "upcoming:list",
    ({ signal }) => canvasApi.getUpcoming({ signal }),
    { ttlMs: 60 * 1000 } // upcoming can be refreshed fairly often
  );

  const undatedQ = useCachedAsync(
    "undated:list",
    ({ signal }) => canvasApi.getUndatedAssignments({ signal }),
    { ttlMs: 60 * 1000 } // undated can be refreshed fairly often
  );

  // Keep a stable ref to the latest refresh so intervals/mount effects
  // don't capture a stale closure (useCachedAsync recreates refresh each render)
  const refreshRef = useRef(null);
  refreshRef.current = upcomingQ.refresh;

  const undatedRefreshRef = useRef(null);
  undatedRefreshRef.current = undatedQ.refresh;

  // Clear upcoming cache once on mount, then kick off the first fetch
  useEffect(() => {
    clearCachedAsync("upcoming:");
    clearCachedAsync("undated:");
    refreshRef.current?.();
    undatedRefreshRef.current?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 2.5 minutes while the page is open
  useEffect(() => {
    const POLL_MS = 2.5 * 60 * 1000;
    const t = setInterval(() => {
      refreshRef.current?.();
      undatedRefreshRef.current?.();
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  // track which details panels are open (allow multiple)
  const [openDetailsKeys, setOpenDetailsKeys] = useState(() => new Set());

  const items = Array.isArray(upcomingQ.data) ? upcomingQ.data : [];

  // Apply same loading logic as announcements
  const upcomingLoading =
    (upcomingQ.loading || upcomingQ.data == null) && !upcomingQ.error;

  // Filter: all | missing | upcoming | undated
  const [filterMode, setFilterMode] = useState("all");

  // Sorting blend: 0 = date only, 1 = points only
  const [blend, setBlend] = useState(0.35);

  // Popover state
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  // Focus/highlight state (for WeeklyPlanner -> UpcomingAssignments navigation)
  const [focusKey, setFocusKey] = useState(null); // `${courseId}-${assignmentId}`
  const focusTimerRef = useRef(null);
  const pendingFocusRef = useRef(null); // stores target until DOM is ready

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

    // Filter out completed assignments that are past their due date
    const shouldShow = (a) => {
      // If completed and past due date, don't show
      if (a.submitted && a.due_at) {
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
    } else if (filterMode === "upcoming") {
      filtered = nonMissing.filter(isUpcoming);
      list = [...missing, ...filtered];
    } else if (filterMode === "undated") {
      filtered = nonMissing.filter(isUndated);
      list = filtered; // Don't include missing - undated means no due date at all
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

  // Separate list for undated assignments (for the undated section)
  const undatedSorted = useMemo(() => {
    const now = Date.now();

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

    const weightScore = (a) => normalizePoints(a?.points_possible);

    // Use undated data from API
    const undatedItems = Array.isArray(undatedQ.data) ? undatedQ.data : [];

    // Filter out completed assignments that are past their due date
    const shouldShow = (a) => {
      if (a.submitted && a.due_at) {
        const h = hoursUntil(a.due_at);
        if (h != null && h < 0) return false;
      }
      return true;
    };

    let list = [...undatedItems].filter(shouldShow);

    // Sort: completed last
    list.sort((a, b) => {
      const aCompleted = !!a.submitted;
      const bCompleted = !!b.submitted;
      if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;

      const aScore = (1 - blend) * timeScore(a) + blend * weightScore(a);
      const bScore = (1 - blend) * timeScore(b) + blend * weightScore(b);
      if (bScore !== aScore) return bScore - aScore;

      return 0;
    });

    return list;
  }, [undatedQ.data, blend]);

  // === Auto-focus target assignment ===
  useEffect(() => {
    // wait until we have *some* data (cached or freshly loaded)
    if (!items?.length) return;

    const raw = localStorage.getItem("nav:upcoming:target");
    const target = parseUpcomingTarget(raw);
    if (!target) return;

    const key = `${target.courseId}-${target.assignmentId}`;
    const exists = items.some(
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

    // Mark pending focus; we'll execute scroll when DOM is present
    pendingFocusRef.current = key;
  }, [items, filterMode]);

  // After list renders (filteredSorted changes), perform scroll if pending
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
      if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
    };
  }, [filteredSorted]);

  if (upcomingQ.error) return <ErrorBox error={upcomingQ.error} />


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
      <div
        className="rowWrap"
        style={{
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
        }}
      >
        <div className="muted">
          Powered by <span className="mono">GET /api/upcoming</span>.
          {upcomingQ.refreshing ? (
            <span className="muted"> • Updating…</span>
          ) : null}
        </div>

        {/* Controls */}
        <div
          className="rowWrap"
          style={{ gap: 10, alignItems: "center", flexWrap: "nowrap" }}
        >
          <ShadcnPopover open={filterOpen} onOpenChange={(o) => { setFilterOpen(o); if (o) setSortOpen(false); }}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" title="Filter assignments">
                Filter: <span className="mono">{filterLabel}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-3">
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold">Filter</p>
                <p className="text-sm text-muted-foreground">Show only assignments matching:</p>
                <div className="flex flex-col gap-1 mt-1">
                  {[
                    ["all", "All"],
                    ["missing", "Missing"],
                    ["upcoming", "Upcoming"],
                    ["undated", "Undated"],
                  ].map(([key, label]) => (
                    <Button
                      key={key}
                      variant="ghost"
                      size="sm"
                      className="justify-start"
                      onClick={() => {
                        setFilterMode(key);
                        setFilterOpen(false);
                      }}
                      title={`Show ${label.toLowerCase()} assignments`}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Missing items stay at the top regardless of sorting.
                </p>
              </div>
            </PopoverContent>
          </ShadcnPopover>

          <ShadcnPopover open={sortOpen} onOpenChange={(o) => { setSortOpen(o); if (o) setFilterOpen(false); }}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" title="Sort by time and/or points">
                Sorting
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-3">
              <div className="flex flex-col gap-3">
                <p className="text-sm font-semibold">Sorting blend</p>
                <p className="text-sm text-muted-foreground">
                  Left = prioritize due date • Right = prioritize points
                </p>
                <div className="flex items-center gap-2 flex-nowrap">
                  <span className="mono text-sm min-w-[44px]">Time</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={blend}
                    onChange={(e) => setBlend(Number(e.target.value))}
                    className="flex-1 min-w-[160px]"
                  />
                  <span className="mono text-sm min-w-[52px] text-right">Points</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <span className="text-sm text-muted-foreground">Blend</span>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={blend}
                    onChange={(e) => setBlend(Number(e.target.value))}
                    className="w-20 h-8 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                  />
                  <span className="text-sm text-muted-foreground">(0–1)</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Tip: keep this around <span className="mono">0.25–0.45</span> to stay time-heavy.
                </p>
              </div>
            </PopoverContent>
          </ShadcnPopover>

          <Button variant="outline" size="sm" onClick={() => upcomingQ.refresh()} title="Fetch fresh upcoming assignments">
            Refresh
          </Button>
        </div>
      </div>

      {/* === Upcoming assignments wrapper === */}
      {filterMode !== "undated" ? (
        <Card className="overflow-hidden">
          <CardHeader className="pb-3 border-b">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                Upcoming assignments
                <Badge variant="secondary" className="font-mono">
                  {filteredSorted.length}
                </Badge>
              </div>

              <div className="muted">
                Filter: <span className="mono">{filterLabel}</span>
                {upcomingQ.refreshing ? (
                  <span className="muted"> • Updating…</span>
                ) : null}
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {upcomingLoading ? (
              <Loading label="Loading upcoming assignments…" />
            ) : filteredSorted.length === 0 ? (
              <div className="muted" style={{ padding: 10 }}>
                No assignments found for the selected filter.
              </div>
            ) : (
              <ul className="list listSpaced">{filteredSorted.map((a) => {
                const badge = getUrgencyBadge(a);

                const isMissing =
                  !a.submitted &&
                  a.due_at &&
                  hoursUntil(a.due_at) != null &&
                  hoursUntil(a.due_at) < 0;

                const courseLabel = a.course_name ?? "Unknown Course";
                const dueLabel = fmtDue(a.due_at);

                const desc = stripHtml(a.description);
                const hasDesc = !!desc;

                const focusId = `${a.course_id}-${a.id}`;
                const isFocused = focusKey === focusId;

                const badgeClass =
                  badge.variant === "success"
                    ? "badgeSuccess"
                    : badge.variant === "danger"
                    ? "badgeDanger"
                    : badge.variant === "warning"
                    ? "badgeWarn"
                    : "badgeNeutral";

                const subtitle = (
                  <span className={`muted ${isMissing ? "dangerMuted" : ""}`}>
                    <span className="mono">{courseLabel}</span>
                    {" • "}
                    Due:{" "}
                    <span className={`mono ${isMissing ? "dangerText" : ""}`}>
                      {dueLabel}
                    </span>
                    {typeof a.points_possible === "number" ? (
                      <>
                        {" • "}
                        <span className="mono">{a.points_possible}</span> pts
                      </>
                    ) : null}
                    {" • "}
                    <Badge
                      variant={badge.variant === "danger" ? "destructive" : badge.variant === "success" ? "outline" : "secondary"}
                      className={badge.variant === "success" ? "border-green-500 text-green-600 dark:text-green-400" : badge.variant === "warning" ? "border-amber-500 text-amber-600 dark:text-amber-400" : undefined}
                    >
                      {badge.label}
                    </Badge>
                  </span>
                );

                const right = a.html_url ? (
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href={a.html_url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open assignment in Canvas"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open in Canvas
                    </a>
                  </Button>
                ) : null;

                return (
                  <li
                    id={`asg-${focusId}`}
                    key={`${a.course_id}-${a.id}`}
                    className={`listItem ${isMissing ? "dangerItem" : ""} ${
                      isFocused ? "isFocused" : ""
                    }`}
                  >
                    <div className="assignmentRow">
                      <div className="assignmentMain">
                        <div className="assignmentTop">
                          <div className="assignmentTitleRow">
                            <div className="assignmentTitleRowLeft">
                              <span className="assignmentName">{a.name}</span>

                              <Badge
                                variant={badge.variant === "danger" ? "destructive" : badge.variant === "success" ? "outline" : "secondary"}
                                className={badge.variant === "success" ? "border-green-500 text-green-600 dark:text-green-400" : badge.variant === "warning" ? "border-amber-500 text-amber-600 dark:text-amber-400" : undefined}
                              >
                                {badge.label}
                              </Badge>

                              {typeof a.points_possible === "number" ? (
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
                            courseId={a.course_id}
                            assignmentId={a.id}
                          />
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
                            </div>
                          </Expandable>
                        </div>
                      </div>

                      <div className="assignmentActions">
                        <div
                          className={`muted assignmentDueRight ${
                            isMissing ? "dangerText" : ""
                          }`}
                        >
                          Due: <span className="mono">{dueLabel}</span>
                        </div>

                        {a.html_url ? (
                          <Button variant="outline" size="sm" asChild>
                            <a
                              href={a.html_url}
                              target="_blank"
                              rel="noreferrer"
                              title="Open assignment in Canvas"
                            >
                              Open in Canvas
                            </a>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          </CardContent>

          <CardFooter className="text-xs text-muted-foreground border-t py-2">
            Tip: effort estimates are stored locally in your browser (per
            assignment).
          </CardFooter>
        </Card>
      ) : null}

      {/* === Undated assignments section (show when filtering by undated OR when mode is "all") === */}
      {filterMode === "undated" || filterMode === "all" ? (
        <Card className="overflow-hidden">
          <CardHeader className="pb-3 border-b">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                Undated assignments
                <Badge variant="secondary" className="font-mono">
                  {filterMode === "undated" ? filteredSorted.length : undatedSorted.length}
                </Badge>
              </div>

              <div className="muted">
                {filterMode === "undated" ? `Filter: ${filterLabel}` : "No due date set"}
                {undatedQ.refreshing ? (
                  <span className="muted"> • Updating…</span>
                ) : null}
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {(undatedQ.loading || undatedQ.data == null) && !undatedQ.error ? (
              <Loading label="Loading assignments…" />
            ) : (filterMode === "undated" ? filteredSorted : undatedSorted).length === 0 ? (
              <div className="muted" style={{ padding: 10 }}>
                No undated assignments.
              </div>
            ) : (
              <ul className="list listSpaced">
                {(filterMode === "undated" ? filteredSorted : undatedSorted).map((a) => {
                  const badge = getUrgencyBadge(a);

                  const courseLabel = a.course_name ?? "Unknown Course";
                  const dueLabel = fmtDue(a.due_at);

                  const desc = stripHtml(a.description);
                  const hasDesc = !!desc;

                  const focusId = `${a.course_id}-${a.id}`;
                  const isFocused = focusKey === focusId;

                  const badgeClass =
                    badge.variant === "success"
                      ? "badgeSuccess"
                      : badge.variant === "danger"
                      ? "badgeDanger"
                      : badge.variant === "warning"
                      ? "badgeWarn"
                      : "badgeNeutral";

                  return (
                    <li
                      id={`asg-${focusId}`}
                      key={`${a.course_id}-${a.id}`}
                      className={`listItem ${isFocused ? "isFocused" : ""}`}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="assignmentRow" style={{ minWidth: 0 }}>
                        <div className="assignmentMain" style={{ minWidth: 0 }}>
                          <div className="assignmentTop">
                            <div className="assignmentTitleRow">
                              <div className="assignmentTitleRowLeft">
                                <span className="assignmentName">{a.name}</span>

                                <Badge
                                  variant={badge.variant === "danger" ? "destructive" : badge.variant === "success" ? "outline" : "secondary"}
                                  className={badge.variant === "success" ? "border-green-500 text-green-600 dark:text-green-400" : badge.variant === "warning" ? "border-amber-500 text-amber-600 dark:text-amber-400" : undefined}
                                >
                                  {badge.label}
                                </Badge>

                                {typeof a.points_possible === "number" ? (
                                  <span className="muted assignmentPts">
                                    <span className="mono">
                                      {a.points_possible}
                                    </span>{" "}
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
                              courseId={a.course_id}
                              assignmentId={a.id}
                            />
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
                              </div>
                            </Expandable>
                          </div>
                        </div>

                        {a.html_url ? (
                          <div className="assignmentActions" style={{ minWidth: 0 }}>
                            <Button variant="outline" size="sm" asChild>
                              <a
                                href={a.html_url}
                                target="_blank"
                                rel="noreferrer"
                                title="Open assignment in Canvas"
                              >
                                Open in Canvas
                              </a>
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>

          <CardFooter className="text-xs text-muted-foreground border-t py-2">
            Tip: effort estimates are stored locally in your browser (per
            assignment).
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}
