import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../theme/useTheme";

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
  { key: "comfortable", label: "Comfortable", desc: "Larger text & more breathing room" },
  { key: "compact", label: "Compact", desc: "Smaller text & tighter spacing" },
];

export function SettingsModal({ open, onClose }) {
  const { theme, density, setTheme, setDensity } = useTheme();
  const [activeSection, setActiveSection] = useState("themes");

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

  const sections = useMemo(
    () => [
      { key: "themes", label: "Themes" },
      { key: "notifications", label: "Notifications", disabled: true },
      { key: "gpa", label: "GPA visibility", disabled: true },
      { key: "other", label: "Other", disabled: true },
    ],
    []
  );

  if (!open) return null;

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
            <div className="muted">Customize how Canvas Better looks and feels.</div>
          </div>

          <button type="button" className="iconBtn" onClick={onClose} aria-label="Close settings">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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
                          <div className={`themeSwatch themeSwatch-${opt.key}`} aria-hidden="true" />
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
                      Adjusts text size and spacing globally. (Expandable “how much to show” can be tuned later per-tab.)
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
            ) : (
              <div className="card">
                <div className="cardBody">
                  <div className="h3">Coming soon</div>
                  <div className="muted">
                    This section is a placeholder so we have room to add settings like notification rules, GPA visibility,
                    and other toggles later.
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
