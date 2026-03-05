// src/App.jsx
import { useMemo, useState, useEffect } from "react";
import { Tabs } from "./components/Tabs";
import { MyInformation } from "./pages/MyInformation";
import { MyCourses } from "./pages/MyCourses";
import { UpcomingAssignments } from "./pages/UpcomingAssignments";
import { WeeklyPlanner } from "./pages/WeeklyPlanner";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { TokenEntry } from "./pages/TokenEntry";
import { TopLoadingBar } from "./components/TopLoadingBar";
import { SettingsButton } from "./components/SettingsButton";
import { SettingsModal } from "./components/SettingsModal";
import { ThemeProvider } from "./theme/ThemeProvider";
import { AuthProvider, useAuth } from "./hooks/useAuth.jsx";
import "./styles.css";

function DashboardApp() {
  const { user, loading, hasToken } = useAuth();
  const [authPage, setAuthPage] = useState("login"); // "login" or "register"
  const [demoMode, setDemoMode] = useState(() => localStorage.getItem("demoMode") === "true");
  
  // Handle hash-based routing for auth pages
  useEffect(() => {
    function handleHashChange() {
      const hash = window.location.hash.slice(1); // Remove the '#'
      if (hash === "register") {
        setAuthPage("register");
      } else {
        setAuthPage("login");
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
              <div className="brandTitle">Canvas Better (Local)</div>
              <div className="brandSub">A student-friendly dashboard</div>
            </div>
          </header>
          <main className="main muted">Loading...</main>
          <footer className="footer muted">Loading application...</footer>
        </div>
      </ThemeProvider>
    );
  }

  // Demo mode - show dashboard with mock data without authentication
  if (demoMode && !user) {
    return <DashboardContent demoMode={true} onExitDemo={() => {
      setDemoMode(false);
      localStorage.removeItem("demoMode");
      window.location.hash = "#";
    }} />;
  }

  if (!user) {
    // Not logged in - show login or register page based on hash
    return (
      <ThemeProvider>
        <div className="app">
          <TopLoadingBar />
          {authPage === "register" ? <Register /> : <Login onViewDemo={() => {
            setDemoMode(true);
            localStorage.setItem("demoMode", "true");
          }} />}
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

function DashboardContent({ demoMode = false, onExitDemo = null }) {
  const tabs = useMemo(
    () => [
      { key: "info", label: "My information" },
      { key: "courses", label: "My courses" },
      { key: "upcoming", label: "Upcoming assignments" },
      { key: "planner", label: "Weekly planner" },
    ],
    []
  );

  const [active, setActive] = useState("info");
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    function onNav(e) {
      const tab = e?.detail?.tab;
      if (tab) setActive(tab);
    }
    window.addEventListener("canvasbetter:navigate", onNav);
    return () => window.removeEventListener("canvasbetter:navigate", onNav);
  }, []);

  return (
    <ThemeProvider>
      <div className="app">
        <TopLoadingBar />

        {/* Fixed top-right settings button (always visible) */}
        <SettingsButton className="settingsFloating" onClick={() => setSettingsOpen(true)} />

        <header className="header">
          <div className="brand">
            <div className="brandTitle">Canvas Better (Local)</div>
            <div className="brandSub">A student-friendly dashboard</div>
            {demoMode && (
              <div style={{ fontSize: "var(--fontSm)", color: "var(--warning)", marginTop: "4px", fontWeight: 600 }}>
                🎭 Viewing demo data
              </div>
            )}
          </div>

          <Tabs tabs={tabs} activeKey={active} onChange={setActive} />
        </header>

        {/* widen only for planner */}
        <main className={`main ${active === "planner" ? "mainWide" : ""}`}>
          {active === "info" ? <MyInformation /> : null}
          {active === "courses" ? <MyCourses /> : null}
          {active === "upcoming" ? <UpcomingAssignments /> : null}
          {active === "planner" ? <WeeklyPlanner /> : null}
        </main>

        <footer className="footer muted">
          {demoMode ? (
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span>Viewing demo data</span>
              <button
                type="button"
                onClick={onExitDemo}
                className="btn"
                style={{ fontSize: "var(--fontSm)", padding: "6px 12px" }}
              >
                Sign in with real data
              </button>
            </div>
          ) : (
            <>
              Backend expected at <span className="mono">VITE_API_BASE_URL</span> (default: http://localhost:8000)
            </>
          )}
        </footer>

        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          demoMode={demoMode}
          onExitDemo={onExitDemo}
        />
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

