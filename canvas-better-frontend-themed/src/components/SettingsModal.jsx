// SettingsModal.jsx
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useTheme } from "../theme/useTheme";
import {
  getEffortSnapMinutes,
  setEffortSnapMinutes,
} from "../lib/workloadEstimates";
import { useAuth } from "../hooks/useAuth";
import { canvasApi } from "../api/canvasApi";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

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
  const { theme, density, setTheme, setDensity } = useTheme();
  const { user, logout, setTokenStatus } = useAuth();
  const [activeSection, setActiveSection] = useState("general");
  const [tokenLoading, setTokenLoading] = useState(false);

  // Effort settings draft
  const [snapDraft, setSnapDraft] = useState(() => getEffortSnapMinutes());

  // Weekly planner settings
  const [plannerSettings, setPlannerSettings] = useState(() => {
    try {
      const raw = localStorage.getItem("weeklyPlanner:settings");
      if (!raw) return { dayViewMode: "next7" };
      const obj = JSON.parse(raw);
      return { dayViewMode: obj?.dayViewMode || "next7" };
    } catch {
      return { dayViewMode: "next7" };
    }
  });

  // Hidden assignments state
  const [hiddenAssignments, setHiddenAssignments] = useState([]);
  const [candidatesForHiding, setCandidatesForHiding] = useState([]);
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [hideLoading, setHideLoading] = useState(null); // track which assignment is being hidden

  // Refresh effort drafts when opening modal
  useEffect(() => {
    if (!open) return;
    setSnapDraft(getEffortSnapMinutes());
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

  function applySnap() {
    // sanitize: integer minutes, min 1
    const raw = typeof snapDraft === "number" ? snapDraft : Number(snapDraft);
    const safe = Number.isFinite(raw) ? Math.max(1, Math.round(raw)) : 10;
    setEffortSnapMinutes(safe);
    setSnapDraft(getEffortSnapMinutes());
  }

  async function handleHideAssignment(courseId, assignmentId) {
    setHideLoading(`${courseId}:${assignmentId}`);
    try {
      await canvasApi.addHiddenAssignment(courseId, assignmentId);
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
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-3xl max-h-[90vh] p-0 overflow-hidden flex flex-col"
      >
        <DialogHeader className="flex-row items-start justify-between space-y-0 px-6 pt-6 pb-4 shrink-0">
          <div>
            <DialogTitle className="text-lg font-semibold">Settings</DialogTitle>
            <DialogDescription>
              Customize how CanvAssist looks and feels.
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close settings"
            className="-mt-1 -mr-2"
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden px-6 pb-6 gap-6 min-h-0">
          {/* Sidebar nav */}
          <aside className="flex flex-col gap-1 w-48 shrink-0">
            {sections.map((s) => (
              <Button
                key={s.key}
                type="button"
                variant="ghost"
                className={`w-full justify-start font-normal ${activeSection === s.key ? "bg-accent font-medium" : ""}`}
                onClick={() => setActiveSection(s.key)}
                disabled={!!s.disabled}
              >
                {s.label}
                {s.disabled ? (
                  <Badge variant="secondary" className="ml-auto text-xs">Soon</Badge>
                ) : null}
              </Button>
            ))}
          </aside>

          {/* Content area */}
          <section className="flex-1 min-w-0 overflow-y-auto">
            {activeSection === "general" ? (
              <div className="flex flex-col gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="mb-4">
                      <p className="text-sm font-semibold">Color palette</p>
                      <p className="text-sm text-muted-foreground">Applies across every tab.</p>
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
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-6">
                    <div className="mb-4">
                      <p className="text-sm font-semibold">Visual density</p>
                      <p className="text-sm text-muted-foreground">
                        Adjusts text size and spacing globally.
                      </p>
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
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-6">
                    <div className="mb-4">
                      <p className="text-sm font-semibold">Weekly Planner</p>
                      <p className="text-sm text-muted-foreground">
                        Choose how the calendar displays days in the weekly planner.
                      </p>
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
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-6">
                    <div className="mb-4">
                      <p className="text-sm font-semibold">Effort</p>
                      <p className="text-sm text-muted-foreground">
                        Controls how the progress bar snaps when you drag it.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="min-w-[220px] text-sm font-bold">
                        Drag snapping increment
                      </span>
                      <Input
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
                        className="w-24"
                      />
                      <span className="text-sm text-muted-foreground">minutes</span>
                      <Button type="button" variant="outline" size="sm" onClick={applySnap}>
                        Apply
                      </Button>
                    </div>
                    <p className="text-sm text-muted-foreground mt-2">
                      Default: 10 minutes. Minimum: 1 minute.
                    </p>
                  </CardContent>
                </Card>
              </div>
            ) : activeSection === "hidden" ? (
              <div className="flex flex-col gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="mb-4">
                      <p className="text-sm font-semibold">Hidden assignments</p>
                      <p className="text-sm text-muted-foreground">
                        Assignments you've hidden won't appear in missing counts or be flagged as missing across all tabs.
                      </p>
                    </div>

                    {!user || demoMode ? (
                      <p className="text-sm text-muted-foreground">Sign in to manage hidden assignments.</p>
                    ) : hiddenLoading ? (
                      <p className="text-sm text-muted-foreground">Loading...</p>
                    ) : (
                      <>
                        {/* Add/hide new assignments */}
                        <div className="mb-5">
                          <p className="text-sm font-semibold text-muted-foreground mb-2">
                            Search and hide assignments
                          </p>
                          <Input
                            type="text"
                            placeholder="Search by assignment name..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="mb-2"
                          />
                          <div className="max-h-[250px] overflow-y-auto rounded-md border">
                            {candidatesForHiding.length === 0 ? (
                              <p className="text-sm text-muted-foreground p-3">
                                All assignments are already submitted or no candidates found.
                              </p>
                            ) : (
                              <ul className="divide-y">
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
                                    const badgeVariant =
                                      badge.variant === "danger"
                                        ? "destructive"
                                        : "secondary";
                                    const badgeClassName =
                                      badge.variant === "warning"
                                        ? "border-amber-500 text-amber-600 dark:text-amber-400"
                                        : undefined;

                                    return (
                                      <li
                                        key={`${a.course_id}:${a.id}`}
                                        className="flex items-start justify-between gap-3 p-3"
                                      >
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center gap-2 mb-1">
                                            <span className="text-sm font-medium truncate">{a.name}</span>
                                            <Badge
                                              variant={badge.variant === "warning" ? "outline" : badgeVariant}
                                              className={badgeClassName}
                                            >
                                              {badge.label}
                                            </Badge>
                                          </div>
                                          <p className="text-xs text-muted-foreground">{a.course_name}</p>
                                        </div>
                                        {!isHidden && (
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => handleHideAssignment(a.course_id, a.id)}
                                            disabled={isLoading}
                                            className="shrink-0 mt-1"
                                          >
                                            {isLoading ? "Hiding..." : "Hide"}
                                          </Button>
                                        )}
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
                            <p className="text-sm font-semibold text-muted-foreground mb-2">
                              Hidden assignments ({hiddenAssignments.length})
                            </p>
                            <div className="max-h-[250px] overflow-y-auto rounded-md border">
                              <ul className="divide-y">
                                {hiddenAssignments.map((h) => {
                                  const assignmentId = getAssignmentId(h);
                                  const isLoading = hideLoading === `${h.course_id}:${assignmentId}`;
                                  const badge = getAssignmentBadge(h);
                                  const badgeVariant =
                                    badge.variant === "danger"
                                      ? "destructive"
                                      : "secondary";
                                  const badgeClassName =
                                    badge.variant === "warning"
                                      ? "border-amber-500 text-amber-600 dark:text-amber-400"
                                      : undefined;

                                  return (
                                    <li
                                      key={`${h.course_id}:${assignmentId}`}
                                      className="flex items-start justify-between gap-3 p-3"
                                    >
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                          <span className="text-sm font-medium truncate">{h.name}</span>
                                          <Badge
                                            variant={badge.variant === "warning" ? "outline" : badgeVariant}
                                            className={badgeClassName}
                                          >
                                            {badge.label}
                                          </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground">{h.course_name}</p>
                                      </div>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => handleUnhideAssignment(h.course_id, assignmentId)}
                                        disabled={isLoading}
                                        className="shrink-0 mt-1 border-green-500 text-green-600 hover:bg-green-50 dark:hover:bg-green-950"
                                      >
                                        {isLoading ? "Unhiding..." : "Unhide"}
                                      </Button>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : activeSection === "account" ? (
              <Card>
                <CardContent className="pt-6 flex flex-col gap-4">
                  <div>
                    <p className="text-sm font-semibold">Account</p>
                    <p className="text-sm text-muted-foreground">
                      {user ? `Signed in as ${user.email}` : "Not signed in"}
                    </p>
                  </div>

                  <div>
                    <p className="text-sm font-semibold mb-1">Canvas Token</p>
                    <p className="text-sm text-muted-foreground mb-3">
                      Manage your Canvas API token for this application.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleEditToken}
                        disabled={tokenLoading || (demoMode && !user)}
                      >
                        Edit Token
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={handleRevokeToken}
                        disabled={tokenLoading || (demoMode && !user)}
                      >
                        {tokenLoading ? "Revoking..." : "Revoke"}
                      </Button>
                    </div>
                  </div>

                  <Separator />

                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="self-start"
                    onClick={handleAuthAction}
                  >
                    {demoMode && !user ? "Sign in" : "Sign out"}
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm font-semibold">Coming soon</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    This section is a placeholder so we have room to add
                    settings like notification rules, GPA visibility, and other
                    toggles later.
                  </p>
                </CardContent>
              </Card>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
