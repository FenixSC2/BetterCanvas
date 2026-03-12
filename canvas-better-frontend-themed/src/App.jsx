// src/App.jsx
import { useMemo, useState, useEffect, useRef } from "react";
import { Tabs } from "./components/Tabs";
import { MyInformation } from "./pages/MyInformation";
import { MyCourses } from "./pages/MyCourses";
import { UpcomingAssignments } from "./pages/UpcomingAssignments";
import { WeeklyPlanner } from "./pages/WeeklyPlanner";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { TokenEntry } from "./pages/TokenEntry";
import { TopLoadingBar } from "./components/TopLoadingBar";
import { SettingsButton } from "./components/SettingsButton";
import { SettingsModal } from "./components/SettingsModal";
import { ThemeProvider } from "./theme/ThemeProvider";
import { AuthProvider, useAuth } from "./hooks/useAuth.jsx";
import "./styles.css";

function DashboardApp() {
  const { user, loading, hasToken } = useAuth();
  const [authPage, setAuthPage] = useState("login"); // "login" | "register" | "forgot-password" | "reset-password"
  const [demoMode, setDemoMode] = useState(() => localStorage.getItem("demoMode") === "true");
  const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
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

    setDemoMode(true);
    localStorage.setItem("demoMode", "true");
  }

  function exitDemoMode() {
    setDemoMode(false);
    localStorage.removeItem("demoMode");
    window.location.hash = "#";
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
              <div className="brandTitle">CanvAssist</div>
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
  const [headerCompact, setHeaderCompact] = useState(false);
  const headerCompactRef = useRef(false);
  const transitionTimeoutRef = useRef(null);

  useEffect(() => {
    function onNav(e) {
      const tab = e?.detail?.tab;
      if (tab) {
        setActive(tab);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
    window.addEventListener("canvasbetter:navigate", onNav);
    return () => window.removeEventListener("canvasbetter:navigate", onNav);
  }, []);

  useEffect(() => {
    function checkScroll() {
      const y = window.scrollY;
      const pageHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      const scrollableHeight = pageHeight - viewportHeight;
      
      // Don't change state if we're already transitioning
      if (transitionTimeoutRef.current) return;
      
      // Only enable compact mode on pages with substantial scrollable content (150px+)
      // This prevents jitter on borderline-scrollable pages
      if (scrollableHeight < 150) {
        // Force expanded state on short pages
        if (headerCompactRef.current) {
          headerCompactRef.current = false;
          setHeaderCompact(false);
        }
        return;
      }
      
      // Always expand when at the very top
      let nextCompact;
      if (y <= 2) {
        nextCompact = false;
      } else {
        // More responsive thresholds: compact at 40px, expand back at 10px
        nextCompact = headerCompactRef.current ? y > 10 : y > 40;
      }
      
      if (nextCompact !== headerCompactRef.current) {
        headerCompactRef.current = nextCompact;
        setHeaderCompact(nextCompact);
        
        // Lock state changes for the duration of the transition
        transitionTimeoutRef.current = setTimeout(() => {
          transitionTimeoutRef.current = null;
        }, 180); // Slightly longer than CSS transition (160ms)
      }
    }

    checkScroll();
    window.addEventListener("scroll", checkScroll, { passive: true });
    
    // Also check on resize in case window size changes
    window.addEventListener("resize", checkScroll, { passive: true });
    
    return () => {
      window.removeEventListener("scroll", checkScroll);
      window.removeEventListener("resize", checkScroll);
      if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current);
    };
  }, []);

  // Check scroll position when tab changes
  useEffect(() => {
    // Small delay to let content render
    const timer = setTimeout(() => {
      const pageHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      const scrollableHeight = pageHeight - viewportHeight;
      
      // Force expand on short pages (< 150px scrollable content)
      if (scrollableHeight < 150 && headerCompactRef.current) {
        headerCompactRef.current = false;
        setHeaderCompact(false);
      } else if (scrollableHeight >= 150) {
        // On longer pages, check if we're at the top
        const y = window.scrollY;
        if (y <= 2 && headerCompactRef.current) {
          headerCompactRef.current = false;
          setHeaderCompact(false);
        }
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [active]);

  function handleTabChange(tab) {
    setActive(tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <ThemeProvider>
      <div className="app">
        <TopLoadingBar />

        {/* Fixed top-right settings button (always visible) */}
        <SettingsButton className="settingsFloating" onClick={() => setSettingsOpen(true)} />

        <header className={`header stickyHeader ${headerCompact ? "headerCompact" : ""}`}>
          <div className="brand">
            <div className="brandTitle">CanvAssist</div>
            <div className="brandSub">A student-friendly dashboard</div>
            {demoMode && (
              <div style={{ fontSize: "var(--fontSm)", color: "var(--warning)", marginTop: "4px", fontWeight: 600 }}>
                🎭 Viewing demo data
              </div>
            )}
          </div>

          <Tabs tabs={tabs} activeKey={active} onChange={handleTabChange} />
        </header>

        {/* widen only for planner */}
        <main 
          className={`main ${active === "planner" ? "mainWide" : ""}`} 
          style={demoMode ? { paddingBottom: "60px" } : {}}
        >
          {active === "info" ? <MyInformation /> : null}
          {active === "courses" ? <MyCourses /> : null}
          {active === "upcoming" ? <UpcomingAssignments /> : null}
          {active === "planner" ? <WeeklyPlanner /> : null}
        </main>

        <footer className="footer muted" style={demoMode ? { position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100 } : {}}>
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

