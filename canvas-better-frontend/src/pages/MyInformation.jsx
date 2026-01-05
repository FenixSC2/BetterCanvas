// src/pages/MyInformation.jsx
import { useEffect, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";

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

export function MyInformation() {
  const [profile, setProfile] = useState(null);
  const [overview, setOverview] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const notif = useDesktopNotifications();

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setErr(null);

    Promise.all([
      canvasApi.getProfile({ signal: ac.signal }),
      canvasApi.getOverview({ signal: ac.signal }),
    ])
      .then(([p, o]) => {
        setProfile(p);
        setOverview(o);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setErr(e);
      })
      .finally(() => setLoading(false));

    return () => ac.abort();
  }, []);

  if (loading) return <Loading label="Loading profile…" />;
  if (err) return <ErrorBox error={err} />;
  if (!profile) return <div className="muted">No profile found.</div>;

  const missingCount = overview?.missing_count ?? 0;
  const due24Count = overview?.due_next_24h_count ?? 0;
  const gpa = overview?.gpa;

  const notificationsOn = !!notif.enabled;
  const isSecureContext =
    typeof window !== "undefined"
      ? window.isSecureContext || window.location.hostname === "localhost"
      : false;

  async function handleEnableNotifications() {
    const perm = await requestNotificationPermission();
    notif.refreshPermission();

    if (perm === "granted") {
      notif.setEnabled(true);

      // Test notification when turning on
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
            </div>
          </div>
        </div>
      </div>

      {/* Desktop notifications card */}
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
                <span className="mono">Due within 12 hours</span>, and{" "}
                <span className="mono">high-point due within 24 hours</span>.
                Click a notification to open the assignment in Canvas.
              </div>

              {/* NEW: Troubleshooting expandable */}
              <Expandable
                title="Troubleshooting notifications"
                subtitle={<span className="muted">If permission is granted but nothing appears</span>}
              >
                <div className="stack">
                  <div className="muted">
                    Live status:
                    <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                      <div>
                        Supported:{" "}
                        <span className="mono">{String(!!notif.supported)}</span>
                      </div>
                      <div>
                        Permission:{" "}
                        <span className="mono">{String(notif.permission)}</span>
                      </div>
                      <div>
                        Secure context:{" "}
                        <span className="mono">{String(!!isSecureContext)}</span>{" "}
                        <span className="muted">
                          (should be true on <span className="mono">localhost</span> or HTTPS)
                        </span>
                      </div>
                      <div>
                        Enabled in app:{" "}
                        <span className="mono">{String(!!notificationsOn)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="muted">
                    Common causes when <span className="mono">permission=granted</span> but you
                    still see nothing:
                    <ul className="list" style={{ marginTop: 8 }}>
                      <li className="listItem">
                        <div className="listMain">
                          <div className="listTitle">OS notifications are disabled</div>
                          <div className="muted">
                            On macOS: System Settings → Notifications → allow notifications for your browser,
                            and disable Focus / Do Not Disturb.
                          </div>
                        </div>
                      </li>
                      <li className="listItem">
                        <div className="listMain">
                          <div className="listTitle">Browser site permissions</div>
                          <div className="muted">
                            Check the “lock” icon in the address bar (Site settings) → Notifications → Allow.
                          </div>
                        </div>
                      </li>
                      <li className="listItem">
                        <div className="listMain">
                          <div className="listTitle">Not running on localhost / HTTPS</div>
                          <div className="muted">
                            Notifications require a secure context. Use{" "}
                            <span className="mono">http://localhost</span> (Vite) or HTTPS.
                          </div>
                        </div>
                      </li>
                    </ul>
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

      {/* 1) All missing work */}
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
        {missingCount === 0 ? (
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
                  <a
                    className="link"
                    href={m.html_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Expandable>

      {/* 2) Next 24 hours */}
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
        {due24Count === 0 ? (
          <div className="muted">
            No assignments due in the next 24 hours that are incomplete.
          </div>
        ) : (
          <ul className="list">
            {overview.due_next_24h.map((a) => (
              <li
                key={`${a.course_id}-${a.assignment_id}`}
                className="listItem"
              >
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
                  <a
                    className="link"
                    href={a.html_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Expandable>

      {/* 3) Grade overview */}
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
          <>
            {overview?.any_estimated_grades ? (
              <div className="muted" style={{ marginBottom: 8 }}>
                <span className="mono">Note:</span> Some course letter grades are
                estimated from the current score.
              </div>
            ) : null}

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
                          <span className="muted">{" "}({g.course_code})</span>
                        ) : null}
                      </div>

                      <div
                        className="muted"
                        style={{
                          display: "flex",
                          gap: 10,
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        <span>
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
                        </span>

                        <span>
                          Score:{" "}
                          <span className="mono">{g.current_score ?? "—"}</span>
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div className="muted" style={{ marginTop: 10 }}>
          {overview?.any_estimated_grades ? (
            <>
              Note: Some letter grades are{" "}
              <span className="mono">estimated</span> from the current score
              because Canvas hasn&apos;t provided a letter grade yet. Estimated
              grades are highlighted in <span className="mono">yellow</span>.
            </>
          ) : (
            <>Note: GPA is computed from letter grades provided by Canvas.</>
          )}
        </div>
      </Expandable>

      <div className="muted">
        Tip: this tab uses <span className="mono">GET /api/profile</span> and{" "}
        <span className="mono">GET /api/overview</span>.
      </div>
    </div>
  );
}
