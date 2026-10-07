// src/App.jsx
import { lazy, Suspense, useMemo, useState, useEffect } from "react";
import { Tabs } from "./components/Tabs";
import { Loading } from "./components/Loading";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { TokenEntry } from "./pages/TokenEntry";
import { PrivacyPolicy, TermsOfUse } from "./pages/Legal";
import { TopLoadingBar } from "./components/TopLoadingBar";
import { SettingsButton } from "./components/SettingsButton";
import { SettingsModal } from "./components/SettingsModal";
import { ThemeProvider } from "./theme/ThemeProvider";
import { AuthProvider } from "./hooks/AuthProvider";
import { useAuth } from "./hooks/useAuth";
import { clearDemoMode, isDemoMode, setDemoMode } from "./lib/storagePolicy";
import { API_BASE } from "./api/canvasApi";
import { clearCanvasConnectResult } from "./lib/canvasConnect";
import "./styles.css";

function DashboardApp() {
  const { user, loading, hasToken } = useAuth();
  const [authPage, setAuthPage] = useState("landing"); // "landing" | "login" | "register" | "forgot-password" | "reset-password" | "privacy" | "terms"
  const [demoMode, setDemoModeState] = useState(() => isDemoMode());
  const ANNOUNCEMENT_SEEN_KEYS = ["announcements:seenIds", "announcements:lastSeenId"];

  async function enterDemoMode() {
    try {
      const res = await fetch(`${API_BASE}/api/demo/enable`, { credentials: "include" });
      if (res.ok) {
        // Session is set via httponly cookie by the server
      }
    } catch (err) {
      console.error("Failed to create demo session:", err);
    }

    // Re-opened demos should always present announcements as fresh/new.
    for (const key of ANNOUNCEMENT_SEEN_KEYS) {
      localStorage.removeItem(key);
    }

    setDemoModeState(true);
    setDemoMode(true);
  }

  function exitDemoMode() {
    setDemoModeState(false);
    clearDemoMode();
    window.location.hash = "#login";
  }
  
  // Handle hash-based routing for auth pages
  useEffect(() => {
    function handleHashChange() {
      const hash = window.location.hash.slice(1); // Remove the '#'
      const route = hash.split("?")[0];
      if (route === "register") {
        setAuthPage("register");
      } else if (route === "forgot-password") {
        setAuthPage("forgot-password");
      } else if (route === "reset-password") {
        setAuthPage("reset-password");
      } else if (route === "login") {
        setAuthPage("login");
      } else if (route === "canvas-connected") {
        // Back from Canvas OAuth; the auth check on load already sees the new connection.
        clearCanvasConnectResult();
        setAuthPage("landing");
      } else if (route === "privacy" || route === "terms") {
        setAuthPage(route);
        window.scrollTo(0, 0);
      } else {
        setAuthPage("landing");
      }
    }
    
    // Set initial page based on current hash
    handleHashChange();
    
    // Listen for hash changes
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);
  
  // Determine which page to show based on auth state
  if (loading) {
    return (
      <ThemeProvider>
        <div className="app">
          <TopLoadingBar />
          <header className="header">
            <div className="brand">
              <div className="brandLogomark" aria-hidden="true">CA</div>
              <div className="brandText">
                <div className="brandTitle">CanvAssist</div>
                <div className="brandSub">A student-friendly dashboard</div>
              </div>
            </div>
          </header>
          <main className="main">
            <div className="loadingState"><span className="spinner" /> Loading…</div>
          </main>
          <footer className="footer muted">Loading application...</footer>
        </div>
      </ThemeProvider>
    );
  }

  // Legal pages are reachable whether or not you're signed in.
  if (authPage === "privacy" || authPage === "terms") {
    return (
      <ThemeProvider>
        <div className="app">
          {authPage === "privacy" ? <PrivacyPolicy /> : <TermsOfUse />}
        </div>
      </ThemeProvider>
    );
  }

  // Demo mode - show dashboard with mock data without authentication
  if (demoMode && !user) {
    return <DashboardContent demoMode={true} onExitDemo={exitDemoMode} />;
  }

  if (!user) {
    // Not logged in - show login or register page based on hash
    return (
      <ThemeProvider>
        <div className="app">
          <TopLoadingBar />
          {authPage === "register" ? <Register /> : null}
          {authPage === "forgot-password" ? <ForgotPassword /> : null}
          {authPage === "reset-password" ? <ResetPassword /> : null}
          {authPage === "login" ? <Login onViewDemo={enterDemoMode} /> : null}
          {authPage === "landing" ? <Landing onTryDemo={enterDemoMode} /> : null}
        </div>
      </ThemeProvider>
    );
  }

  // User is logged in but doesn't have a token yet
  if (!hasToken) {
    return (
      <ThemeProvider>
        <div className="app">
          <TopLoadingBar />
          <TokenEntry />
        </div>
      </ThemeProvider>
    );
  }

  // User is logged in AND has a token - show the dashboard
  return <DashboardContent demoMode={false} onExitDemo={null} />;
}

// Dashboard tabs are code-split so the landing and auth screens load without them.
const named = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));
const MyInformation = named(() => import("./pages/MyInformation"), "MyInformation");
const MyCourses = named(() => import("./pages/MyCourses"), "MyCourses");
const UpcomingAssignments = named(() => import("./pages/UpcomingAssignments"), "UpcomingAssignments");
const WeeklyPlanner = named(() => import("./pages/WeeklyPlanner"), "WeeklyPlanner");
const TodoPage = named(() => import("./pages/TodoPage"), "TodoPage");
const GradePerformance = named(() => import("./pages/GradePerformance"), "GradePerformance");
const Discussions = named(() => import("./pages/Discussions"), "Discussions");

const PAGES = [
  { key: "info",     El: MyInformation },
  { key: "courses",  El: MyCourses },
  { key: "upcoming", El: UpcomingAssignments },
  { key: "planner",  El: WeeklyPlanner },
  { key: "discussions", El: Discussions },
  { key: "todo",     El: TodoPage },
  { key: "grades",   El: GradePerformance },
];

function DashboardContent({ demoMode = false, onExitDemo = null }) {
  const tabs = useMemo(
    () => [
      { key: "info", label: "My Information" },
      { key: "courses", label: "My Courses" },
      { key: "upcoming", label: "Upcoming Assignments" },
      { key: "planner", label: "Weekly Planner" },
      { key: "discussions", label: "Discussions" },
      { key: "todo", label: "To-Do's" },
      { key: "grades", label: "Grades" },
    ],
    []
  );

  const [active, setActive] = useState("info");
  // Track which tabs have been visited so we can keep them mounted (lazy-mount + CSS hide)
  const [mounted, setMounted] = useState(() => new Set(["info"]));
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    function onNav(e) {
      const tab = e?.detail?.tab;
      if (tab) {
        setMounted(prev => { const s = new Set(prev); s.add(tab); return s; });
        setActive(tab);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
    window.addEventListener("canvasbetter:navigate", onNav);
    return () => window.removeEventListener("canvasbetter:navigate", onNav);
  }, []);


  function handleTabChange(tab) {
    setMounted(prev => { const s = new Set(prev); s.add(tab); return s; });
    setActive(tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <ThemeProvider>
      <div className="app">
        <TopLoadingBar />

        <header className="header stickyHeader">
          <div className="brand">
            <div className="brandLogomark" aria-hidden="true">CA</div>
            <div className="brandTitle">CanvAssist</div>
            {demoMode && (
              <div className="brandDemoTag">Demo</div>
            )}
          </div>

          <div className="headerCenter">
            <Tabs tabs={tabs} activeKey={active} onChange={handleTabChange} />
          </div>

          <SettingsButton onClick={() => setSettingsOpen(true)} />
        </header>

        {/* widen only for planner */}
        <main className={`main ${active === "planner" ? "mainWide" : ""} ${demoMode ? "mainWithDemoBar" : ""}`}>
          {PAGES.map((page) => {
            if (!mounted.has(page.key)) return null;
            const { key, El } = page;
            return (
              <div key={key} style={{ display: active === key ? undefined : "none" }}>
                <Suspense fallback={<Loading />}>
                  <El active={active === key} {...(key === "grades" ? { demoMode } : {})} />
                </Suspense>
              </div>
            );
          })}
        </main>

        <footer className={`footer muted ${demoMode ? "footerDemoBar" : ""}`}>
          {demoMode ? (
            <div className="demoBar">
              <span>You're viewing sample data.</span>
              <button type="button" onClick={onExitDemo} className="btn">
                Sign in to use your own courses
              </button>
            </div>
          ) : (
            <>
              Questions, comments, or feedback? Reach us at{" "}
              <a href="mailto:support@canvassist.com">support@canvassist.com</a>.{" "}
              <a href="#privacy">Privacy</a> · <a href="#terms">Terms</a>
            </>
          )}
        </footer>

        {settingsOpen && (
          <SettingsModal
            onClose={() => setSettingsOpen(false)}
            demoMode={demoMode}
            onExitDemo={onExitDemo}
          />
        )}
      </div>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <DashboardApp />
    </AuthProvider>
  );
}

