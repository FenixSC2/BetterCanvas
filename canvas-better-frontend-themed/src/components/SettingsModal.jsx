// SettingsModal.jsx
import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../theme/useTheme";
import {
  getDefaultEffortMode,
  getEffortSnapMinutes,
  setDefaultEffortMode,
  setEffortSnapMinutes,
} from "../lib/workloadEstimates";
import {
  isEffortTrackingEnabled,
  setEffortTrackingEnabled,
} from "./WorkloadEstimateControl";
import { useAuth } from "../hooks/useAuth";
import { canvasApi } from "../api/canvasApi";
import { clearDemoMode } from "../lib/storagePolicy";
import { formatCourseTitle } from "../utils/courseUtils";

const THEME_OPTIONS = [
  { key: "auto", label: "Auto", desc: "Follows your system light/dark" },
  { key: "classic", label: "Classic", desc: "Clean light theme" },
  { key: "midnight", label: "Midnight", desc: "Dark & high contrast" },
  { key: "ocean", label: "Ocean", desc: "Cool blues" },
  { key: "forest", label: "Forest", desc: "Soft greens" },
  { key: "rose", label: "Rose", desc: "Warm pinks" },
  { key: "contrast", label: "Classic Dark", desc: "Clean dark theme" },
  { key: "frog", label: "Frog", desc: "Frog." },
  { key: "cyber", label: "Cyber", desc: "Bright green on dark" },
];

const DENSITY_OPTIONS = [
  {
    key: "comfortable",
    label: "Comfortable",
    desc: "Larger text & more breathing room",
  },
  { key: "compact", label: "Compact", desc: "Smaller text & tighter spacing" },
];

const FONT_OPTIONS = [
  { key: "system", label: "System UI", css: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" },
  { key: "times",  label: "Times New Roman", css: '"Times New Roman", Times, serif' },
  { key: "georgia", label: "Georgia", css: "Georgia, serif" },
  { key: "inter",  label: "Inter", css: "Inter, ui-sans-serif, sans-serif" },
  { key: "mono",   label: "Monospace", css: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },
];

// Helper function to determine urgency badge
function getAssignmentBadge(assignment) {
  if (!assignment) return { label: "Unknown", variant: "neutral" };

  const now = Date.now();
  const dueTime = assignment.due_at ? new Date(assignment.due_at).getTime() : null;

  if (!dueTime) {
    return { label: "Undated", variant: "neutral" };
  }

  const hoursUntil = (dueTime - now) / (1000 * 60 * 60);

  if (hoursUntil < 0) {
    return { label: "Missing", variant: "danger" };
  }
  if (hoursUntil <= 12) {
    return { label: "Due soon", variant: "warning" };
  }
  if (hoursUntil <= 48) {
    return { label: "Upcoming", variant: "neutral" };
  }
  return { label: "Scheduled", variant: "neutral" };
}

function getAssignmentId(assignment) {
  return assignment?.id ?? assignment?.assignment_id;
}

export function SettingsModal({
  open,
  onClose,
  demoMode = false,
  onExitDemo = null,
}) {
  const { theme, density, font, setTheme, setDensity, setFont } = useTheme();
  const { user, logout, setTokenStatus } = useAuth();
  const [activeSection, setActiveSection] = useState("general");
  const [tokenLoading, setTokenLoading] = useState(false);

  // Effort settings draft
  const [snapDraft, setSnapDraft] = useState(() => getEffortSnapMinutes());
  const [defaultModeDraft, setDefaultModeDraft] = useState(() =>
    getDefaultEffortMode(),
  );
  const [effortEnabledDraft, setEffortEnabledDraft] = useState(() =>
    isEffortTrackingEnabled(),
  );

  // Weekly planner settings
  const [plannerSettings, setPlannerSettings] = useState(() => {
    try {
      const raw = localStorage.getItem("weeklyPlanner:settings");
      if (!raw) return { dayViewMode: "next7", showPersonalTodos: true };
      const obj = JSON.parse(raw);
      return {
        dayViewMode: obj?.dayViewMode || "next7",
        showPersonalTodos: obj?.showPersonalTodos !== false,
      };
    } catch {
      return { dayViewMode: "next7", showPersonalTodos: true };
    }
  });

  // Hidden assignments state
  const [hiddenAssignments, setHiddenAssignments] = useState([]);
  const [candidatesForHiding, setCandidatesForHiding] = useState([]);
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [hideLoading, setHideLoading] = useState(null); // track which assignment is being hidden

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Refresh effort drafts when opening modal
  useEffect(() => {
    if (!open) return;
    setSnapDraft(getEffortSnapMinutes());
    setDefaultModeDraft(getDefaultEffortMode());
    setEffortEnabledDraft(isEffortTrackingEnabled());
  }, [open]);

  // Load hidden assignments when opening the hidden assignments section
  useEffect(() => {
    if (!open || activeSection !== "hidden" || !user) return;

    setHiddenLoading(true);
    Promise.all([
      canvasApi.getHiddenAssignments(),
      canvasApi.getCandidatesForHiding(),
    ])
      .then(([hiddenRes, candidatesRes]) => {
        setHiddenAssignments(
          (hiddenRes.hidden_assignments || []).map((a) => ({
            ...a,
            id: getAssignmentId(a),
          })),
        );
        setCandidatesForHiding(candidatesRes.candidates || []);
      })
      .catch((err) => {
        console.error("Failed to load hidden assignments:", err);
      })
      .finally(() => {
        setHiddenLoading(false);
      });
  }, [open, activeSection, user]);

  const sections = useMemo(
    () => [
      { key: "general", label: "General" },
      { key: "hidden", label: "Hidden assignments" },
      { key: "account", label: "Account" },
      { key: "notifications", label: "Notifications", disabled: true },
      { key: "other", label: "Other", disabled: true },
    ],
    [],
  );

  if (!open) return null;

  function applySnap() {
    // sanitize: integer minutes, min 1
    const raw = typeof snapDraft === "number" ? snapDraft : Number(snapDraft);
    const safe = Number.isFinite(raw) ? Math.max(1, Math.round(raw)) : 10;
    setEffortSnapMinutes(safe);
    setSnapDraft(getEffortSnapMinutes());
  }

  function applyDefaultMode(mode = defaultModeDraft) {
    setDefaultEffortMode(mode);
    setDefaultModeDraft(getDefaultEffortMode());
  }

  async function handleHideAssignment(courseId, assignmentId) {
    setHideLoading(`${courseId}:${assignmentId}`);
    try {
      await canvasApi.addHiddenAssignment(courseId, assignmentId);
      window.dispatchEvent(new CustomEvent("canvassist:hidden:changed"));
      // Update hidden assignments list without introducing duplicates.
      setHiddenAssignments((prev) => {
        if (
          prev.some(
            (a) =>
              a.course_id === courseId && getAssignmentId(a) === assignmentId,
          )
        ) {
          return prev;
        }

        const source = candidatesForHiding.find(
          (a) => a.course_id === courseId && a.id === assignmentId,
        );

        return [
          ...prev,
          {
            id: assignmentId,
            course_id: courseId,
            course_name: source?.course_name,
            name: source?.name,
            due_at: source?.due_at,
            points_possible: source?.points_possible,
          },
        ];
      });
    } catch (err) {
      console.error("Failed to hide assignment:", err);
      alert("Failed to hide assignment. Please try again.");
    } finally {
      setHideLoading(null);
    }
  }

  async function handleUnhideAssignment(courseId, assignmentId) {
    setHideLoading(`${courseId}:${assignmentId}`);
    try {
      await canvasApi.removeHiddenAssignment(courseId, assignmentId);
      window.dispatchEvent(new CustomEvent("canvassist:hidden:changed"));
      // Update hidden assignments list
      setHiddenAssignments((prev) =>
        prev.filter(
          (a) => !(a.course_id === courseId && getAssignmentId(a) === assignmentId),
        ),
      );
    } catch (err) {
      console.error("Failed to unhide assignment:", err);
      alert("Failed to unhide assignment. Please try again.");
    } finally {
      setHideLoading(null);
    }
  }

  async function handleAuthAction() {
    const isDemoAndNotSignedIn = demoMode && !user;

    if (isDemoAndNotSignedIn) {
      // Exit demo mode and navigate to login page
      try {
        if (onExitDemo) {
          onExitDemo();
        } else {
          clearDemoMode();
          window.location.hash = "#";
        }
      } finally {
        onClose();
      }
      return;
    }

    // regular sign-out flow for authenticated users
    if (window.confirm("Are you sure you want to sign out?")) {
      await logout();
      // navigate to login page
      window.location.hash = "#";
      onClose();
    }
  }

  async function handleRevokeToken() {
    if (
      !window.confirm(
        "Are you sure you want to revoke your Canvas token? You'll need to add a new one to continue using the app.",
      )
    ) {
      return;
    }

    const API_BASE =
      import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:8000" : "https://api.canvassist.com");
    setTokenLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/token`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error("Failed to revoke token");
      }

      setTokenStatus(false);
      alert(
        "Canvas token has been revoked. You'll be redirected to add a new token.",
      );
      window.location.hash = "#";
    } catch (err) {
      alert(err.message || "Failed to revoke token");
    } finally {
      setTokenLoading(false);
    }
  }

  function handleEditToken() {
    // Temporarily mark token as unavailable to show TokenEntry page
    setTokenStatus(false);
    window.location.hash = "#token";
    onClose();
  }

  return (
    <div className="modalOverlay" onMouseDown={onClose} role="presentation">
      <div
        className="modalPanel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modalHeader">
          <div>
            <div className="h2">Settings</div>
            <div className="muted">
              Customize how CanvAssist looks and feels.
            </div>
          </div>

          <button
            type="button"
            className="iconBtn"
            onClick={onClose}
            aria-label="Close settings"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M18 6 6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M6 6l12 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="modalBody">
          <aside className="settingsNav">
            {sections.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`settingsNavItem ${activeSection === s.key ? "active" : ""}`}
                onClick={() => setActiveSection(s.key)}
                disabled={!!s.disabled}
              >
                {s.label}
                {s.disabled ? <span className="pill">Soon</span> : null}
              </button>
            ))}
          </aside>

          <section className="settingsContent">
            {activeSection === "general" ? (
              <div className="stack">
                <div className="card">
                  <div className="cardBody">
                    <div className="settingsSectionHeader">
                      <div className="h3">Color palette</div>
                      <div className="muted">Applies across every tab.</div>
                    </div>

                    <div className="settingsGrid">
                      {THEME_OPTIONS.map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          className={`themeChoice ${theme === opt.key ? "active" : ""}`}
                          onClick={() => setTheme(opt.key)}
                        >
                          <div
                            className={`themeSwatch themeSwatch-${opt.key}`}
                            aria-hidden="true"
                          />
                          <div className="themeChoiceText">
                            <div className="themeChoiceTitle">{opt.label}</div>
                            <div className="muted">{opt.desc}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="cardBody">
                    <div className="settingsSectionHeader">
                      <div className="h3">Visual density</div>
                      <div className="muted">
                        Adjusts text size and spacing globally. (Expandable "how
                        much to show" can be tuned later per-tab.)
                      </div>
                    </div>

                    <div className="segmented">
                      {DENSITY_OPTIONS.map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          className={`segmentedBtn ${density === opt.key ? "active" : ""}`}
                          onClick={() => setDensity(opt.key)}
                        >
                          <div className="segmentedTitle">{opt.label}</div>
                          <div className="segmentedDesc">{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="cardBody">
                    <div className="settingsSectionHeader">
                      <div className="h3">Font</div>
                      <div className="muted">Choose the typeface used throughout the app.</div>
                    </div>
                    <select
                      value={font}
                      onChange={(e) => setFont(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "8px 2.5rem 8px 10px",
                        borderRadius: "var(--radiusSm)",
                        border: "1px solid var(--border2)",
                        background: "var(--surface2)",
                        color: "var(--text)",
                        cursor: "pointer",
                        fontSize: "var(--fontBase)",
                      }}
                    >
                      {FONT_OPTIONS.map((opt) => (
                        <option key={opt.key} value={opt.key} style={{ fontFamily: opt.css }}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="card">
                  <div className="cardBody">
                    <div className="settingsSectionHeader">
                      <div className="h3">Weekly Planner</div>
                      <div className="muted">
                        Choose how the calendar displays days in the weekly planner.
                      </div>
                    </div>

                    <div className="segmented">
                      <button
                        type="button"
                        className={`segmentedBtn ${plannerSettings.dayViewMode === "next7" ? "active" : ""}`}
                        onClick={() => {
                          const newSettings = { ...plannerSettings, dayViewMode: "next7" };
                          setPlannerSettings(newSettings);
                          const fullSettings = JSON.parse(localStorage.getItem("weeklyPlanner:settings") || "{}");
                          const updated = { ...fullSettings, dayViewMode: "next7" };
                          localStorage.setItem("weeklyPlanner:settings", JSON.stringify(updated));
                          window.dispatchEvent(
                            new CustomEvent("canvassist:planner-settings-changed")
                          );
                        }}
                      >
                        <div className="segmentedTitle">Next 7 days</div>
                        <div className="segmentedDesc">Today + the next 6 days</div>
                      </button>

                      <button
                        type="button"
                        className={`segmentedBtn ${plannerSettings.dayViewMode === "week" ? "active" : ""}`}
                        onClick={() => {
                          const newSettings = { ...plannerSettings, dayViewMode: "week" };
                          setPlannerSettings(newSettings);
                          const fullSettings = JSON.parse(localStorage.getItem("weeklyPlanner:settings") || "{}");
                          const updated = { ...fullSettings, dayViewMode: "week" };
                          localStorage.setItem("weeklyPlanner:settings", JSON.stringify(updated));
                          window.dispatchEvent(
                            new CustomEvent("canvassist:planner-settings-changed")
                          );
                        }}
                      >
                        <div className="segmentedTitle">Week view</div>
                        <div className="segmentedDesc">Monday–Sunday of the selected week</div>
                      </button>
                    </div>

                    <div className="rowWrap" style={{ alignItems: "center", marginTop: 14, gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 180 }}>
                        <div style={{ fontWeight: 800 }}>Show personal to-do items</div>
                        <div className="muted" style={{ marginTop: 2 }}>
                          Display your personal to-do items in the day grid and undated section.
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={plannerSettings.showPersonalTodos}
                        className="toggle"
                        onClick={() => {
                          const newValue = !plannerSettings.showPersonalTodos;
                          const newSettings = { ...plannerSettings, showPersonalTodos: newValue };
                          setPlannerSettings(newSettings);
                          const fullSettings = JSON.parse(localStorage.getItem("weeklyPlanner:settings") || "{}");
                          const updated = { ...fullSettings, showPersonalTodos: newValue };
                          localStorage.setItem("weeklyPlanner:settings", JSON.stringify(updated));
                          window.dispatchEvent(
                            new CustomEvent("canvassist:planner-settings-changed")
                          );
                        }}
                      >
                        <span className={`toggleTrack ${plannerSettings.showPersonalTodos ? "on" : "off"}`}>
                          <span className={`toggleThumb ${plannerSettings.showPersonalTodos ? "on" : ""}`} />
                        </span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="cardBody">
                    <div className="settingsSectionHeader">
                      <div className="h3">Effort</div>
                      <div className="muted">
                        Controls how workload tracking behaves by default.
                      </div>
                    </div>

                    <div
                      className="rowWrap"
                      style={{ alignItems: "center", marginBottom: 18 }}
                    >
                      <label
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={effortEnabledDraft}
                          onChange={(e) => {
                            const next = e.target.checked;
                            setEffortEnabledDraft(next);
                            setEffortTrackingEnabled(next);
                          }}
                        />
                        <span style={{ fontWeight: 800 }}>
                          Show effort tracking widgets
                        </span>
                      </label>
                      <div className="muted">
                        Hide all workload/hour/progress widgets across every tab.
                      </div>
                    </div>

                    <div style={{ marginBottom: 18 }}>
                      <div style={{ minWidth: 220, fontWeight: 800, marginBottom: 10 }}>
                        Default workload style
                      </div>

                      <div className="segmented">
                        <button
                          type="button"
                          className={`segmentedBtn ${defaultModeDraft === "hours" ? "active" : ""}`}
                          onClick={() => {
                            setDefaultModeDraft("hours");
                            applyDefaultMode("hours");
                          }}
                        >
                          <div className="segmentedTitle">Hour estimate</div>
                          <div className="segmentedDesc">Use the existing hour and progress slider workflow.</div>
                        </button>

                        <button
                          type="button"
                          className={`segmentedBtn ${defaultModeDraft === "checklist" ? "active" : ""}`}
                          onClick={() => {
                            setDefaultModeDraft("checklist");
                            applyDefaultMode("checklist");
                          }}
                        >
                          <div className="segmentedTitle">Task list</div>
                          <div className="segmentedDesc">Start new workload widgets in checklist mode.</div>
                        </button>
                      </div>

                      <div className="muted" style={{ marginTop: 8 }}>
                        You can still switch any individual assignment inside its workload settings.
                      </div>
                    </div>

                    <div className="rowWrap" style={{ alignItems: "center" }}>
                      <div style={{ minWidth: 220, fontWeight: 800 }}>
                        Drag snapping increment
                      </div>

                      <input
                        className="effortInput"
                        type="text"
                        inputMode="numeric"
                        value={snapDraft}
                        onChange={(e) => setSnapDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            applySnap();
                          }
                        }}
                        style={{ width: 120 }}
                      />
                      <span className="muted">minutes</span>

                      <button type="button" className="btn" onClick={applySnap}>
                        Apply
                      </button>
                    </div>

                    <div className="muted" style={{ marginTop: 8 }}>
                      Default: 10 minutes. Minimum: 1 minute.
                    </div>
                  </div>
                </div>
              </div>
            ) : activeSection === "hidden" ? (
              <div className="stack">
                <div className="card">
                  <div className="cardBody">
                    <div className="settingsSectionHeader">
                      <div className="h3">Hidden assignments</div>
                      <div className="muted">
                        Assignments you've hidden won't appear in missing counts or be flagged as missing across all tabs.
                      </div>
                    </div>

                    {!user || demoMode ? (
                      <div className="muted">Sign in to manage hidden assignments.</div>
                    ) : hiddenLoading ? (
                      <div className="muted">Loading...</div>
                    ) : (
                      <>
                        {/* Add/hide new assignments */}
                        <div style={{ marginBottom: 20 }}>
                          <div className="muted" style={{ marginBottom: 8, fontWeight: 600 }}>
                            Search and hide assignments
                          </div>
                          <input
                            type="text"
                            placeholder="Search by assignment name..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            style={{
                              width: "100%",
                              padding: "8px 12px",
                              marginBottom: 8,
                              border: "1px solid var(--border)",
                              borderRadius: "4px",
                              fontSize: "var(--fontBase)",
                            }}
                          />
                          
                          <div style={{ maxHeight: 250, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "4px" }}>
                            {candidatesForHiding.length === 0 ? (
                              <div className="muted" style={{ padding: 12 }}>
                                All assignments are already submitted or no candidates found.
                              </div>
                            ) : (
                              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                                {candidatesForHiding
                                  .filter((a) =>
                                    a.name.toLowerCase().includes(searchQuery.toLowerCase())
                                  )
                                  .map((a) => {
                                    const isHidden = hiddenAssignments.some(
                                      (h) =>
                                        h.course_id === a.course_id &&
                                        getAssignmentId(h) === a.id,
                                    );
                                    const isLoading = hideLoading === `${a.course_id}:${a.id}`;
                                    const badge = getAssignmentBadge(a);
                                    const badgeClass =
                                      badge.variant === "danger"
                                        ? "badgeDanger"
                                        : badge.variant === "warning"
                                        ? "badgeWarn"
                                        : "badgeNeutral";
                                    
                                    return (
                                      <li
                                        key={`${a.course_id}:${a.id}`}
                                        style={{
                                          padding: "12px",
                                          borderBottom: "1px solid var(--border)",
                                          display: "flex",
                                          justifyContent: "space-between",
                                          alignItems: "flex-start",
                                          gap: "12px",
                                        }}
                                      >
                                        <div style={{ flexGrow: 1 }}>
                                          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                                            <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
                                              <span>{a.name}</span>
                                              {isHidden ? (
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ opacity: 0.85 }}>
                                                  <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                                  <path d="M15 9l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                                                </svg>
                                              ) : null}
                                            </div>
                                            <span className={`badge ${badgeClass}`}>{badge.label}</span>
                                          </div>
                                          <div className="muted" style={{ fontSize: "var(--fontSm)" }}>
                                            {formatCourseTitle(a.course_name)}
                                          </div>
                                        </div>
                                        <div
                                          style={{
                                            display: "flex",
                                            alignItems: "flex-end",
                                            gap: 8,
                                            flexWrap: "wrap",
                                            justifyContent: "flex-end",
                                          }}
                                        >
                                          {!isHidden ? (
                                            <button
                                              type="button"
                                              className="btn"
                                              onClick={() => handleHideAssignment(a.course_id, a.id)}
                                              disabled={isLoading}
                                              style={{ marginTop: "4px", whiteSpace: "nowrap", flexShrink: 0 }}
                                            >
                                              {isLoading ? "Hiding..." : "Hide"}
                                            </button>
                                          ) : (
                                            <button
                                              type="button"
                                              className="btn"
                                              onClick={() => handleUnhideAssignment(a.course_id, a.id)}
                                              disabled={isLoading}
                                              style={{
                                                marginTop: "4px",
                                                whiteSpace: "nowrap",
                                                flexShrink: 0,
                                                background: "var(--badge-success-bg)",
                                                color: "var(--badge-success-text)",
                                                border: "1px solid var(--badge-success-border)",
                                              }}
                                            >
                                              {isLoading ? "Unhiding..." : "Unhide"}
                                            </button>
                                          )}
                                        </div>
                                      </li>
                                    );
                                  })}
                              </ul>
                            )}
                          </div>
                        </div>

                        {/* Manage hidden assignments */}
                        {hiddenAssignments.length > 0 && (
                          <div>
                            <div className="muted" style={{ marginBottom: 8, fontWeight: 600 }}>
                              Hidden assignments ({hiddenAssignments.length})
                            </div>
                            <div style={{ maxHeight: 250, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "4px" }}>
                              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                                {hiddenAssignments.map((h) => {
                                  const assignmentId = getAssignmentId(h);
                                  const isLoading = hideLoading === `${h.course_id}:${assignmentId}`;
                                  const badge = getAssignmentBadge(h);
                                  const badgeClass =
                                    badge.variant === "danger"
                                      ? "badgeDanger"
                                      : badge.variant === "warning"
                                      ? "badgeWarn"
                                      : "badgeNeutral";
                                  
                                  return (
                                    <li
                                      key={`${h.course_id}:${assignmentId}`}
                                      style={{
                                        padding: "12px",
                                        borderBottom: "1px solid var(--border)",
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "flex-start",
                                        gap: "12px",
                                      }}
                                    >
                                      <div style={{ flexGrow: 1 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                                          <div style={{ fontWeight: 500 }}>
                                            {h.name}
                                          </div>
                                          <span className={`badge ${badgeClass}`}>{badge.label}</span>
                                        </div>
                                        <div className="muted" style={{ fontSize: "var(--fontSm)" }}>
                                          {formatCourseTitle(h.course_name)}
                                        </div>
                                      </div>
                                      <div
                                        style={{
                                          display: "flex",
                                          alignItems: "flex-end",
                                          gap: 8,
                                          flexWrap: "wrap",
                                          justifyContent: "flex-end",
                                        }}
                                      >
                                        <button
                                          type="button"
                                          className="btn"
                                          onClick={() =>
                                            handleUnhideAssignment(h.course_id, assignmentId)
                                          }
                                          disabled={isLoading}
                                          style={{
                                            marginTop: "4px",
                                            whiteSpace: "nowrap",
                                            flexShrink: 0,
                                            background: "var(--badge-success-bg)",
                                            color: "var(--badge-success-text)",
                                            border: "1px solid var(--badge-success-border)",
                                          }}
                                        >
                                          {isLoading ? "Unhiding..." : "Unhide"}
                                        </button>
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : activeSection === "account" ? (
              <div className="card">
                <div className="cardBody">
                  <div className="h3">Account</div>
                  <div className="muted" style={{ marginBottom: 16 }}>
                    {user ? `Signed in as ${user.email}` : "Not signed in"}
                  </div>

                  <div style={{ marginBottom: 20 }}>
                    <div
                      style={{
                        fontSize: "var(--fontSm)",
                        fontWeight: 600,
                        marginBottom: 8,
                        color: "var(--text)",
                      }}
                    >
                      Canvas Token
                    </div>
                    <p
                      style={{
                        fontSize: "var(--fontSm)",
                        color: "var(--muted)",
                        marginBottom: 12,
                      }}
                    >
                      Manage your Canvas API token for this application.
                    </p>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        type="button"
                        className="btn"
                        onClick={handleEditToken}
                        disabled={tokenLoading || (demoMode && !user)}
                      >
                        Edit Token
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={handleRevokeToken}
                        disabled={tokenLoading || (demoMode && !user)}
                        style={{
                          background: "var(--badge-danger-bg)",
                          color: "var(--badge-danger-text)",
                          border: "1px solid var(--badge-danger-border)",
                        }}
                      >
                        {tokenLoading ? "Revoking..." : "Revoke"}
                      </button>
                    </div>
                  </div>

                  <hr
                    style={{ margin: "16px 0", borderColor: "var(--border)" }}
                  />

                  <button
                    type="button"
                    className="btn"
                    onClick={handleAuthAction}
                    style={{
                      background: "var(--badge-danger-bg)",
                      color: "var(--badge-danger-text)",
                      border: "1px solid var(--badge-danger-border)",
                    }}
                  >
                    {demoMode && !user ? "Sign in" : "Sign out"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="cardBody">
                  <div className="h3">Coming soon</div>
                  <div className="muted">
                    This section is a placeholder so we have room to add
                    settings like notification rules, GPA visibility, and other
                    toggles later.
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
