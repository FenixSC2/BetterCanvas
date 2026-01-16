// src/pages/MyInformation.jsx
import { useEffect, useMemo, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";

import { useCachedAsync } from "../hooks/useCachedAsync";

// desktop notifications
import { useDesktopNotifications } from "../hooks/useDesktopNotifications";
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

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function MyInformation() {
  const notif = useDesktopNotifications();

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

  // Announcements state
  const [announcements, setAnnouncements] = useState([]);
  const [annLoading, setAnnLoading] = useState(true);
  const [annErr, setAnnErr] = useState(null);

  // Seen tracking
  const [seenIds, setSeenIds] = useState(() => new Set());

  const SEEN_KEY = "announcements:seenIds";
  const LAST_SEEN_KEY = "announcements:lastSeenId";

  const missingCount = overview?.missing_count ?? 0;
  const due24Count = overview?.due_next_24h_count ?? 0;
  const gpa = overview?.gpa;

  const notificationsOn = !!notif.enabled;
  const isSecureContext =
    typeof window !== "undefined"
      ? window.isSecureContext || window.location.hostname === "localhost"
      : false;

  // NEW badge count
  const newAnnouncementCount = useMemo(() => {
    if (!announcements?.length) return 0;
    let c = 0;
    for (const a of announcements) {
      if (a?.id && !seenIds.has(a.id)) c += 1;
    }
    return c;
  }, [announcements, seenIds]);

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

    try {
      const lastSeen = Number(localStorage.getItem(LAST_SEEN_KEY) || "0");
      if (id > lastSeen) localStorage.setItem(LAST_SEEN_KEY, String(id));
    } catch {
      // ignore
    }
  }

  function markAllAnnouncementsSeen() {
    const next = new Set(seenIds);
    for (const a of announcements || []) {
      if (a?.id) next.add(a.id);
    }
    persistSeen(next);

    const newestId = announcements?.[0]?.id ?? 0;
    if (newestId) {
      try {
        localStorage.setItem(LAST_SEEN_KEY, String(newestId));
      } catch {
        // ignore
      }
    }
  }

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

  // Announcements polling (side-effects + notifications)
  useEffect(() => {
    const ac = new AbortController();
    const POLL_MS = 3 * 60 * 1000;

    async function fetchAnnouncements({ notify }) {
      try {
        setAnnErr(null);
        if (announcements.length === 0) setAnnLoading(true);

        // Poll using cache=fresh so backend TTL doesn't hide new posts
        const anns = await canvasApi.getAnnouncements(14, 20, "fresh", {
          signal: ac.signal,
        });

        const safe = Array.isArray(anns) ? anns : [];
        setAnnouncements(safe);
        setAnnLoading(false);

        if (!notify || !notif.enabled || notif.permission !== "granted") return;

        let lastSeen = 0;
        try {
          lastSeen = Number(localStorage.getItem(LAST_SEEN_KEY) || "0");
        } catch {
          lastSeen = 0;
        }

        const newestId = safe?.[0]?.id ?? 0;
        if (newestId > lastSeen) {
          const newOnes = safe.filter((a) => a.id > lastSeen).slice(0, 3);

          for (const a of newOnes) {
            notifyOnce({
              dedupeKey: `announcement:${a.id}`,
              title: `New announcement${a.course_name ? ` • ${a.course_name}` : ""}`,
              body: a.title,
              url: a.html_url || window.location.href,
              cooldownMs: 0,
            });
          }

          try {
            localStorage.setItem(LAST_SEEN_KEY, String(newestId));
          } catch {
            // ignore
          }
        }
      } catch (e) {
        if (e.name === "AbortError") return;
        setAnnErr(e);
        setAnnLoading(false);
      }
    }

    fetchAnnouncements({ notify: false });
    const t = setInterval(() => fetchAnnouncements({ notify: true }), POLL_MS);

    return () => {
      clearInterval(t);
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notif.enabled, notif.permission]);

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

  // Error handling for main data
  const mainErr = profileQ.error || overviewQ.error;
  if (mainErr) return <ErrorBox error={mainErr} />;

  // Only show the big loading screen if we have *no* cached data yet
  if ((profileQ.loading && !profile) || (overviewQ.loading && !overview)) {
    return <Loading label="Loading profile…" />;
  }

  // If profile never arrives, show message (but this shouldn’t flash anymore)
  if (!profile) return <div className="muted">No profile found.</div>;

  return (
    <div className="stack">
      {/* Student card */}
      <div className="card">
        <div className="cardBody">
          <div className="row">
            {profile.avatar_url ? (
              <img className="avatar" src={profile.avatar_url} alt="avatar" />
            ) : (
              <div className="avatar placeholder" />
            )}

            <div>
              <div className="h2">{profile.name || "Unknown name"}</div>
              <div className="muted">
                User ID: <span className="mono">{profile.id}</span>
              </div>
              {profile.primary_email ? (
                <div className="muted">
                  Email: <span className="mono">{profile.primary_email}</span>
                </div>
              ) : null}
              {profile.sortable_name ? (
                <div className="muted">
                  Sortable: <span className="mono">{profile.sortable_name}</span>
                </div>
              ) : null}
              {profile.short_name ? (
                <div className="muted">
                  Short: <span className="mono">{profile.short_name}</span>
                </div>
              ) : null}

              {/* subtle background refresh indicator */}
              {profileQ.refreshing || overviewQ.refreshing ? (
                <div className="muted" style={{ marginTop: 6 }}>
                  Updating…
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

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
        onOpen={markAllAnnouncementsSeen}
      >
        {annErr ? <ErrorBox error={annErr} /> : null}

        {annLoading ? (
          <Loading label="Loading announcements…" />
        ) : !announcements?.length ? (
          <div className="muted">No recent announcements.</div>
        ) : (
          <ul className="list">
            {announcements.map((a) => {
              const isNew = a?.id && !seenIds.has(a.id);
              const titleText = a?.title || "Untitled announcement";

              const subtitle = (
                <span className="muted">
                  {a.course_name ? <span className="mono">{a.course_name}</span> : null}
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
                      Preview: <span className="mono">{firstLine(a.message)}</span>
                    </>
                  ) : null}
                </span>
              );

              const right =
                a.html_url ? (
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
                ) : null;

              return (
                <li key={a.id} className="listItem">
                  <Expandable
                    title={titleText}
                    subtitle={subtitle}
                    right={right}
                    onOpen={() => markAnnouncementSeen(a.id)}
                  >
                    {a.message ? (
                      <div className="desc">{stripHtml(a.message)}</div>
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
          due24Count > 0 ? (
            <span className="dangerText">Due soon: {due24Count}</span>
          ) : (
            <span className="muted">Nothing due (or all complete)</span>
          )
        }
      >
        {!overview ? (
          <div className="muted">No overview data yet.</div>
        ) : due24Count === 0 ? (
          <div className="muted">
            No assignments due in the next 24 hours that are incomplete.
          </div>
        ) : (
          <ul className="list">
            {overview.due_next_24h.map((a) => (
              <li key={`${a.course_id}-${a.assignment_id}`} className="listItem">
                <div className="listMain">
                  <div className="listTitle">{a.name}</div>
                  <div className="muted">
                    <span className="mono">{a.course_name}</span>
                    {" • "}
                    Due: <span className="mono">{fmtDue(a.due_at)}</span>
                    {typeof a.points_possible === "number"
                      ? ` • Points: ${a.points_possible}`
                      : ""}
                  </div>
                </div>
                {a.html_url ? (
                  <a className="link" href={a.html_url} target="_blank" rel="noreferrer">
                    View
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Expandable>

      {/* Missing work */}
      <Expandable
        title="Missing work (all courses)"
        subtitle={
          missingCount > 0 ? (
            <span className="dangerText">Missing: {missingCount}</span>
          ) : (
            <span className="muted">None detected</span>
          )
        }
      >
        {!overview ? (
          <div className="muted">No overview data yet.</div>
        ) : missingCount === 0 ? (
          <div className="muted">
            No missing work detected across your active courses.
          </div>
        ) : (
          <ul className="list">
            {overview.missing.map((m) => (
              <li
                key={`${m.course_id}-${m.assignment_id}`}
                className="listItem dangerItem"
              >
                <div className="listMain">
                  <div className="listTitle">{m.name}</div>
                  <div className="muted dangerMuted">
                    <span className="mono">
                      {m.course_name ?? `Course ${m.course_id}`}
                    </span>
                    {" • "}
                    Due: <span className="mono">{fmtDue(m.due_at)}</span>
                    {typeof m.points_possible === "number"
                      ? ` • Points: ${m.points_possible}`
                      : ""}
                  </div>
                </div>
                {m.html_url ? (
                  <a className="link" href={m.html_url} target="_blank" rel="noreferrer">
                    View
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Expandable>

      {/* Grade overview */}
      <Expandable
        title="Grade overview"
        subtitle={
          gpa != null ? (
            <span>
              Running GPA: <span className="mono">{gpa}</span>
            </span>
          ) : (
            <span className="muted">No GPA available yet</span>
          )
        }
      >
        {!overview?.grades?.length ? (
          <div className="muted">No active courses found.</div>
        ) : (
          <ul className="list">
            {overview.grades.map((g) => {
              const shownGrade = g.display_grade ?? g.current_grade ?? "—";
              const isEstimated = !!g.grade_is_estimated;

              return (
                <li key={g.course_id} className="listItem">
                  <div className="listMain">
                    <div className="listTitle">
                      {g.course_name}
                      {g.course_code ? (
                        <span className="muted"> ({g.course_code})</span>
                      ) : null}
                    </div>

                    <div className="muted" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <span>
                        Grade:{" "}
                        <span
                          className={`gradeBadge ${isEstimated ? "estimated" : "actual"}`}
                          title={isEstimated ? "Estimated from current score" : "Provided by Canvas"}
                        >
                          {shownGrade}
                          {isEstimated ? " (est.)" : ""}
                        </span>
                      </span>

                      <span>
                        Score: <span className="mono">{g.current_score ?? "—"}</span>
                      </span>
                    </div>
                  </div>
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
                <span className="mono">high-point due within 24 hours</span>, and{" "}
                <span className="mono">new announcements</span>.
              </div>

              <Expandable
                title="Troubleshooting notifications"
                subtitle={<span className="muted">If permission is granted but nothing appears</span>}
              >
                <div className="stack">
                  <div className="muted">
                    Live status:
                    <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                      <div>
                        Supported: <span className="mono">{String(!!notif.supported)}</span>
                      </div>
                      <div>
                        Permission: <span className="mono">{String(notif.permission)}</span>
                      </div>
                      <div>
                        Secure context: <span className="mono">{String(!!isSecureContext)}</span>{" "}
                        <span className="muted">
                          (should be true on <span className="mono">localhost</span> or HTTPS)
                        </span>
                      </div>
                      <div>
                        Enabled in app: <span className="mono">{String(!!notificationsOn)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="muted">
                    Tip: click <span className="mono">Send test</span>. If you still see nothing, it’s
                    almost always OS/browser-level notification settings (not the app).
                  </div>

                  {notif.permission === "denied" ? (
                    <div className="muted">
                      You’ve blocked notifications for this site in your browser settings. Re-enable them
                      there to use this feature.
                    </div>
                  ) : null}
                </div>
              </Expandable>
            </div>
          )}
        </div>
      </div>

      <div className="muted">
        Tip: this tab uses <span className="mono">GET /api/profile</span>,{" "}
        <span className="mono">GET /api/overview</span>, and polling announcements.
      </div>
    </div>
  );
}
