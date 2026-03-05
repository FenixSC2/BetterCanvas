// SettingsModal.jsx
import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../theme/useTheme";
import {
  getEffortSnapMinutes,
  setEffortSnapMinutes,
} from "../lib/workloadEstimates";
import { useAuth } from "../hooks/useAuth";

const THEME_OPTIONS = [
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

export function SettingsModal({
  open,
  onClose,
  demoMode = false,
  onExitDemo = null,
}) {
  const { theme, density, setTheme, setDensity } = useTheme();
  const { user, logout, setTokenStatus } = useAuth();
  const [activeSection, setActiveSection] = useState("themes");
  const [tokenLoading, setTokenLoading] = useState(false);

  // Effort settings draft
  const [snapDraft, setSnapDraft] = useState(() => getEffortSnapMinutes());

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
  }, [open]);

  const sections = useMemo(
    () => [
      { key: "themes", label: "Themes" },
      { key: "effort", label: "Effort" },
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

  async function handleAuthAction() {
    const isDemoAndNotSignedIn = demoMode && !user;

    if (isDemoAndNotSignedIn) {
      // Exit demo mode and navigate to login page
      try {
        if (onExitDemo) {
          onExitDemo();
        } else {
          localStorage.removeItem("demoMode");
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
      import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
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
              Customize how Canvas Better looks and feels.
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
            {activeSection === "themes" ? (
              <div className="stack">
                <div className="card">
                  <div className="cardBody">
                    <div className="h3">Color palette</div>
                    <div className="muted" style={{ marginBottom: 10 }}>
                      Applies across every tab.
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
                    <div className="h3">Visual density</div>
                    <div className="muted" style={{ marginBottom: 10 }}>
                      Adjusts text size and spacing globally. (Expandable “how
                      much to show” can be tuned later per-tab.)
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
              </div>
            ) : activeSection === "effort" ? (
              <div className="stack">
                <div className="card">
                  <div className="cardBody">
                    <div className="h3">Effort</div>
                    <div className="muted" style={{ marginBottom: 10 }}>
                      Controls how the progress bar snaps when you drag it.
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
