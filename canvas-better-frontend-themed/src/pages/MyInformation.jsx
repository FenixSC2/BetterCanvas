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
import { useAuth } from "../hooks/useAuth";
import { formatCourseTitle } from "../utils/courseUtils";

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
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
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


export function MyInformation({ active = true }) {
  const { hasToken } = useAuth();
  const notif = useDesktopNotifications(hasToken);
  const [heroGreeting, setHeroGreeting] = useState("");
  const lastGreetingRef = useRef("");

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

  useEffect(() => {
    if (!active) return;
    const next = pickRandomWithoutRepeat(
      greetingOptionsFor(new Date()),
      lastGreetingRef.current,
    );
    lastGreetingRef.current = next;
    setHeroGreeting(next);
  }, [active]);

  const announcements = announcementsQ.data || [];
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

  // Add-announcement-to-todo state: maps announcement id → { date, status }
  const [todoFormById, setTodoFormById] = useState({});

  // Set of announcement IDs that already have a to-do item (source = "announcement:{id}")
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

  // Keep addedAnnouncementIds in sync when the todo store changes
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

  const SHOW_GPA_KEY = "myinfo:showGpaInCollapsed";
  const [showGpaCollapsed, setShowGpaCollapsed] = useState(() => {
    try {
      const raw = localStorage.getItem(SHOW_GPA_KEY);
      return raw == null ? false : raw === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SHOW_GPA_KEY, String(showGpaCollapsed));
    } catch {
      // ignore
    }
  }, [showGpaCollapsed]);

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

  const SEEN_KEY = "announcements:seenIds";

  // DB-backed high-water mark: the ID of the newest announcement the user has
  // opened the dropdown to see. Fetched once on mount; only updated when the
  // user opens the Announcements expandable.
  const [lastSeenIdFromDb, setLastSeenIdFromDb] = useState(0);
  const lastSeenIdRef = useRef(0);

  useEffect(() => {
    canvasApi.getAnnouncementLastSeen().then((res) => {
      const id = res?.last_seen_id ?? 0;
      setLastSeenIdFromDb(id);
      lastSeenIdRef.current = id;
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const missingCount = overview?.missing_count ?? 0;
  const canvasDue24Count = overview?.due_next_24h_count ?? 0;
  const due24Count = canvasDue24Count + todosDue24h.length;
  const gpa = overview?.gpa;

  // GPA info tooltip (portal-based to escape overflow:hidden containers)
  const gpaInfoBtnRef = useRef(null);
  const [gpaInfoOpen, setGpaInfoOpen] = useState(false);
  const [gpaInfoPos, setGpaInfoPos] = useState({ top: 0, left: 0 });
  function openGpaInfo() {
    const rect = gpaInfoBtnRef.current?.getBoundingClientRect();
    if (rect) setGpaInfoPos({ top: rect.top + rect.height / 2, left: rect.right + 10 });
    setGpaInfoOpen(true);
  }

  const notificationsOn = !!notif.enabled;
  const isSecureContext =
    typeof window !== "undefined"
      ? window.isSecureContext || window.location.hostname === "localhost"
      : false;

  // Track whether the announcements expandable is open so we can re-mark seen
  // when announcements finish loading while the dropdown is already open.
  const [annIsOpen, setAnnIsOpen] = useState(false);

  // NEW badge count — based on DB high-water mark so it persists across sessions
  const newAnnouncementCount = useMemo(() => {
    if (!announcements?.length) return 0;
    return announcements.filter((a) => a?.id && a.id > lastSeenIdFromDb).length;
  }, [announcements, lastSeenIdFromDb]);

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

    const newestId = announcements?.[0]?.id ?? 0;
    if (newestId && newestId > lastSeenIdRef.current) {
      lastSeenIdRef.current = newestId;
      setLastSeenIdFromDb(newestId);
      canvasApi.setAnnouncementLastSeen(newestId).catch(() => {});
    }
  }

  // If the dropdown is already open when announcements finish loading, mark them seen.
  // This handles the case where the user opens the section before the fetch completes.
  useEffect(() => {
    if (annIsOpen && announcements?.length) {
      markAllAnnouncementsSeen();
    }
  }, [announcements]); // eslint-disable-line react-hooks/exhaustive-deps

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

  function htmlToPrettyText(html) {
    if (!html) return "";

    let s = String(html);

    // Convert layout HTML into newlines
    s = s.replace(/&nbsp;/gi, " ");
    s = s.replace(/<\s*br\s*\/?>/gi, "\n");
    s = s.replace(/<\/\s*p\s*>/gi, "\n\n");
    s = s.replace(/<\/\s*div\s*>/gi, "\n");
    s = s.replace(/<\/\s*li\s*>/gi, "\n");
    s = s.replace(/<\/\s*tr\s*>/gi, "\n");
    s = s.replace(/<\/\s*h[1-6]\s*>/gi, "\n\n");

    // Strip remaining tags safely
    const tmp = document.createElement("div");
    tmp.innerHTML = s;
    let text = tmp.textContent || "";

    // Normalize line endings
    text = text.replace(/\r\n/g, "\n");

    // 🔑 Collapse excessive blank lines (max 2 in a row)
    text = text.replace(/\n{3,}/g, "\n\n");

    // Trim junk at edges
    return text.trim();
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

        <p className="welcomeSubline">{datelineFor()}</p>

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
      </section>

      {/* Announcements */}
      <Expandable
        title="Announcements"
        subtitle={
          annLoading ? (
            <span className="muted">Loading…</span>
          ) : announcements?.length ? (
            <span className="muted">
              {announcements.length} recent{" "}
              {newAnnouncementCount > 0 ? (
                <span
                  className="mono"
                  style={{
                    marginLeft: 10,
                    padding: "2px 8px",
                    borderRadius: 999,
                    fontWeight: 700,
                    background: "rgba(0, 200, 0, 0.15)",
                    color: "rgb(0, 120, 0)",
                  }}
                  title="Unseen announcements"
                >
                  NEW: {newAnnouncementCount}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="muted">None found</span>
          )
        }
        onOpen={() => { setAnnIsOpen(true); markAllAnnouncementsSeen(); }}
        onClose={() => setAnnIsOpen(false)}
      >
        {annErr ? <ErrorBox error={annErr} /> : null}

        {annLoading ? (
          <Loading label="Loading announcements…" />
        ) : !announcements?.length ? (
          <div className="muted">No recent announcements.</div>
        ) : (
          <ul className="list listSpaced">
            {announcements.map((a) => {
              const isNew = a?.id && !seenIds.has(a.id);
              const titleText = a?.title || "Untitled announcement";
              const todoForm = todoFormById[a.id] || {};

              const subtitle = (
                <span className="muted">
                  {a.course_name ? (
                    <span className="mono">{formatCourseTitle(a.course_name)}</span>
                  ) : null}
                  {a.course_name ? " • " : ""}
                  Posted: <span className="mono">{fmtPosted(a.posted_at)}</span>
                  {isNew ? (
                    <>
                      {" • "}
                      <span
                        className="mono"
                        style={{
                          padding: "1px 6px",
                          borderRadius: 999,
                          fontWeight: 700,
                          background: "rgba(0, 200, 0, 0.15)",
                          color: "rgb(0, 120, 0)",
                        }}
                      >
                        NEW
                      </span>
                    </>
                  ) : null}
                  {a.message ? (
                    <>
                      {" • "}
                      Preview:{" "}
                      <span className="mono">{firstLine(a.message)}</span>
                    </>
                  ) : null}
                </span>
              );

              const right = (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {a.html_url ? (
                      <a
                        className="btn"
                        href={a.html_url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => markAnnouncementSeen(a.id)}
                        title="Open in Canvas"
                      >
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
                          onChange={(e) =>
                            setTodoFormById((prev) => ({
                              ...prev,
                              [a.id]: { ...prev[a.id], date: e.target.value },
                            }))
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="btn"
                        disabled={!todoForm.date}
                        onClick={async (e) => {
                          e.stopPropagation();
                          const dueAt = todoForm.date
                            ? new Date(todoForm.date + "T00:00:00").toISOString()
                            : null;
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
                            setTodoFormById((prev) => ({
                              ...prev,
                              [a.id]: { status: "added" },
                            }));
                            setTimeout(() => {
                              setTodoFormById((prev) => {
                                const next = { ...prev };
                                delete next[a.id];
                                return next;
                              });
                            }, 2500);
                          } catch {
                            // ignore
                          }
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
                    subtitle={subtitle}
                    right={right}
                    onOpen={() => markAnnouncementSeen(a.id)}
                  >
                    {a.message ? (
                      <div className="desc preserveWhitespace">
                        {htmlToPrettyText(a.message)}
                      </div>
                    ) : (
                      <div className="muted">No message body provided.</div>
                    )}

                  </Expandable>
                </li>
              );
            })}
          </ul>
        )}

        <div className="muted" style={{ marginTop: 10 }}>
          Refreshes every ~3 minutes while this tab is open.
        </div>
      </Expandable>

      {/* Next 24 hours */}
      <Expandable
        title="Next 24 hours"
        subtitle={
          overviewLoading ? (
            <span className="muted">Loading…</span>
          ) : due24Count > 0 ? (
            <span className="dangerText">Due soon: {due24Count}</span>
          ) : (
            <span className="muted">Nothing due (or all complete)</span>
          )
        }
      >
        {overviewErr ? (
          <ErrorBox error={overviewErr} />
        ) : overviewLoading ? (
          <Loading label="Loading assignments due soon…" />
        ) : due24Count === 0 ? (
          <div className="muted">
            No assignments due in the next 24 hours that are incomplete.
          </div>
        ) : (
          <ul className="list listSpaced">
            {/* Canvas assignments */}
            {(overview?.due_next_24h || []).map((a) => {
              const titleText = a?.name || "Untitled assignment";

              const subtitle = (
                <span className="muted" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {a.course_name ? (
                    <span className="mono">{formatCourseTitle(a.course_name)}</span>
                  ) : null}
                  <span>
                    Due: <span className="mono">{fmtDue(a.due_at)}</span>
                    {typeof a.points_possible === "number"
                      ? ` • Points: ${a.points_possible}`
                      : ""}
                  </span>
                </span>
              );

              const right = (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    justifyContent: "flex-end",
                  }}
                >
                  {a.html_url ? (
                    <a
                      className="btn"
                      href={a.html_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Canvas
                    </a>
                  ) : null}
                  <WorkloadEstimateControl
                    courseId={a.course_id}
                    assignmentId={a.assignment_id}
                    compactLabels={true}
                  />
                </div>
              );

              return (
                <li
                  key={`${a.course_id}-${a.assignment_id}`}
                  className="listItem"
                >
                  <Expandable
                    title={titleText}
                    subtitle={subtitle}
                    right={right}
                  >
                    {a.description ? (
                      <div className="desc preserveWhitespace">
                        {htmlToPrettyText(a.description)}
                      </div>
                    ) : (
                      <div className="muted">No description available.</div>
                    )}
                  </Expandable>
                </li>
              );
            })}
            {/* Personal todos due within 24h */}
            {todosDue24h.map((t) => {
              const subtitle = (
                <span className="muted">
                  <span className="mono">TO-DO's</span>
                  {" • "}Due: <span className="mono">{fmtDue(t.due_at)}</span>
                </span>
              );
              const right = (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("canvasbetter:navigate", {
                          detail: { tab: "todo" },
                        })
                      )
                    }
                  >
                    View to-do
                  </button>
                  <WorkloadEstimateControl
                    courseId="todo"
                    assignmentId={t.id}
                    compactLabels={true}
                  />
                </div>
              );
              return (
                <li key={`todo-${t.id}`} className="listItem">
                  <Expandable
                    title={t.title || "Untitled to-do"}
                    subtitle={subtitle}
                    right={right}
                  >
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
      </Expandable>

      {/* Missing work */}
      <Expandable
        title="Missing work (all courses)"
        subtitle={
          overviewLoading ? (
            <span className="muted">Loading…</span>
          ) : missingCount > 0 ? (
            <span className="dangerText">Missing: {missingCount}</span>
          ) : (
            <span className="muted">None detected</span>
          )
        }
      >
        {overviewErr ? (
          <ErrorBox error={overviewErr} />
        ) : overviewLoading ? (
          <Loading label="Loading missing work…" />
        ) : missingCount === 0 ? (
          <div className="muted">
            No missing work detected across your active courses.
          </div>
        ) : (
          <ul className="list listSpaced">
            {overview.missing.map((m) => {
              const titleText = (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {m?.name || "Untitled assignment"}
                  <span className="badge badgeDanger">Missing</span>
                </span>
              );

              const subtitle = (
                <span className="muted dangerMuted" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span className="mono">
                    {formatCourseTitle(m.course_name) ?? `Course ${m.course_id}`}
                  </span>
                  <span>
                    Due: <span className="mono">{fmtDue(m.due_at)}</span>
                    {typeof m.points_possible === "number"
                      ? ` • Points: ${m.points_possible}`
                      : ""}
                  </span>
                </span>
              );

              const right = (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    justifyContent: "flex-end",
                  }}
                >
                  {m.html_url ? (
                    <a
                      className="btn"
                      href={m.html_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Canvas
                    </a>
                  ) : null}
                  <WorkloadEstimateControl
                    courseId={m.course_id}
                    assignmentId={m.assignment_id}
                    compactLabels={true}
                  />
                </div>
              );

              return (
                <li
                  key={`${m.course_id}-${m.assignment_id}`}
                  className="listItem dangerItem"
                >
                  <Expandable
                    title={titleText}
                    subtitle={subtitle}
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
      </Expandable>

      {/* Grade overview */}
      <Expandable
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            Grade overview
            <button
              ref={gpaInfoBtnRef}
              type="button"
              className="authInfoBubble authInfoBubbleInfo"
              aria-label="GPA scope: current semester only"
              onMouseEnter={openGpaInfo}
              onMouseLeave={() => setGpaInfoOpen(false)}
              onFocus={openGpaInfo}
              onBlur={() => setGpaInfoOpen(false)}
              style={{ width: 18, height: 18, fontSize: 11, fontWeight: 700, flexShrink: 0 }}
            >
              i
            </button>
            {gpaInfoOpen && createPortal(
              <div style={{
                position: "fixed",
                top: gpaInfoPos.top,
                left: gpaInfoPos.left,
                transform: "translateY(-50%)",
                zIndex: 9999,
                width: "min(280px, 72vw)",
                padding: "10px 12px",
                borderRadius: "var(--radiusSm)",
                border: "1px solid var(--border2)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: "var(--fontSm)",
                lineHeight: 1.45,
                boxShadow: "var(--shadow)",
                pointerEvents: "none",
              }}>
                This GPA is calculated from your current semester courses only.
              </div>,
              document.body
            )}
          </span>
        }
        right={
          <div className="toggleRow">
            <span className="muted">Toggle GPA visibility:</span>
            <Toggle
              checked={showGpaCollapsed}
              onChange={setShowGpaCollapsed}
              label={showGpaCollapsed ? "Hide GPA" : "Show GPA"}
            />
          </div>
        }
        subtitle={
          showGpaCollapsed ? (
            gpa != null ? (
              <span>
                Running GPA: <span className="mono">{gpa}</span>
              </span>
            ) : (
              <span className="muted">No GPA available yet</span>
            )
          ) : (
            <span className="muted">GPA hidden</span>
          )
        }
      >
        {!overview?.grades?.length ? (
          <div className="muted" style={{ marginTop: 10 }}>
            No active courses found.
          </div>
        ) : (
          <ul className="list listSpaced">
            {overview.grades.map((g) => {
              const shownGrade = g.display_grade ?? g.current_grade ?? "—";
              const isEstimated = !!g.grade_is_estimated;

              const titleText = formatCourseTitle(g.course_name) || "Untitled course";

              const subtitle = (
                <span className="muted">
                  Grade:{" "}
                  <span
                    className={`gradeBadge ${
                      isEstimated ? "estimated" : "actual"
                    }`}
                    title={
                      isEstimated
                        ? "Estimated from current score"
                        : "Provided by Canvas"
                    }
                  >
                    {shownGrade}
                    {isEstimated ? " (est.)" : ""}
                  </span>
                  {" • "}
                  Score: <span className="mono">{g.current_score ?? "—"}</span>
                  {g.course_code ? (
                    <>
                      {" • "}
                      <span className="mono">{g.course_code}</span>
                    </>
                  ) : null}
                </span>
              );

              return (
                <li key={g.course_id} className="listItem">
                  <Expandable
                    title={titleText}
                    subtitle={subtitle}
                    variant="embedded"
                  >
                    <div className="stack" style={{ gap: 8 }}>
                      <div className="muted">
                        Course ID: <span className="mono">{g.course_id}</span>
                      </div>

                      <div className="rowWrap" style={{ gap: 10 }}>
                        <div className="muted">
                          Display grade:{" "}
                          <span className="mono">{g.display_grade ?? "—"}</span>
                        </div>
                        <div className="muted">
                          Current grade:{" "}
                          <span className="mono">{g.current_grade ?? "—"}</span>
                        </div>
                        <div className="muted">
                          Current score:{" "}
                          <span className="mono">{g.current_score ?? "—"}</span>
                        </div>
                      </div>

                      <div className="muted">
                        Status:{" "}
                        <span className="mono">
                          {isEstimated ? "Estimated" : "Actual"}
                        </span>
                      </div>
                    </div>
                  </Expandable>
                </li>
              );
            })}
          </ul>
        )}
      </Expandable>

      {/* Notifications */}
      <div className="card">
        <div className="cardBody">
          <div className="h3">Desktop notifications</div>

          {!notif.supported ? (
            <div className="muted" style={{ marginTop: 8 }}>
              Your browser doesn’t support desktop notifications.
            </div>
          ) : (
            <div className="stack" style={{ marginTop: 8 }}>
              <div className="muted">
                Permission: <span className="mono">{notif.permission}</span>
                {" • "}
                Notifications:{" "}
                <span className="mono">{notificationsOn ? "ON" : "OFF"}</span>
              </div>

              <div className="rowWrap" style={{ gap: 10 }}>
                {notificationsOn ? (
                  <button className="btn" onClick={handleDisableNotifications}>
                    Disable notifications
                  </button>
                ) : (
                  <button
                    className="btn"
                    onClick={handleEnableNotifications}
                    disabled={notif.permission === "denied"}
                    title={
                      notif.permission === "denied"
                        ? "Notifications are blocked in browser settings"
                        : "Enable and run checks while this tab is open"
                    }
                  >
                    Enable notifications
                  </button>
                )}

                <button
                  className="btn"
                  onClick={() => clearNotificationHistory()}
                  title="Allows alerts to fire again for the same assignments"
                >
                  Reset alerts
                </button>

                <button
                  className="btn"
                  disabled={notif.permission !== "granted"}
                  onClick={() => {
                    notifyOnce({
                      dedupeKey: `notifications:test:${Date.now()}`,
                      title: "Test notification",
                      body: "If you can see this, notifications are working.",
                      url: window.location.href,
                      cooldownMs: 0,
                    });
                  }}
                  title={
                    notif.permission !== "granted"
                      ? "Grant permission first"
                      : "Send a test notification"
                  }
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
                subtitle={
                  <span className="muted">
                    If permission is granted but nothing appears
                  </span>
                }
              >
                <div className="stack">
                  <div className="muted">
                    Live status:
                    <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                      <div>
                        Supported:{" "}
                        <span className="mono">
                          {String(!!notif.supported)}
                        </span>
                      </div>
                      <div>
                        Permission:{" "}
                        <span className="mono">{String(notif.permission)}</span>
                      </div>
                      <div>
                        Secure context:{" "}
                        <span className="mono">
                          {String(!!isSecureContext)}
                        </span>{" "}
                        <span className="muted">
                          (should be true on{" "}
                          <span className="mono">localhost</span> or HTTPS)
                        </span>
                      </div>
                      <div>
                        Enabled in app:{" "}
                        <span className="mono">
                          {String(!!notificationsOn)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="muted">
                    Tip: click <span className="mono">Send test</span>. If you
                    still see nothing, it’s almost always OS/browser-level
                    notification settings (not the app).
                  </div>

                  {notif.permission === "denied" ? (
                    <div className="muted">
                      You’ve blocked notifications for this site in browser
                      settings. Re-enable them there to use this feature.
                    </div>
                  ) : null}
                </div>
              </Expandable>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
