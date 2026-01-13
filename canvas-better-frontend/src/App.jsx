// src/App.jsx
import { useMemo, useState, useEffect } from "react";
import { Tabs } from "./components/Tabs";
import { MyInformation } from "./pages/MyInformation";
import { MyCourses } from "./pages/MyCourses";
import { UpcomingAssignments } from "./pages/UpcomingAssignments";
import { WeeklyPlanner } from "./pages/WeeklyPlanner";
import "./styles.css";

export default function App() {
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

  useEffect(() => {
    function onNav(e) {
      const tab = e?.detail?.tab;
      if (tab) setActive(tab);
    }
    window.addEventListener("canvasbetter:navigate", onNav);
    return () => window.removeEventListener("canvasbetter:navigate", onNav);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brandTitle">Canvas Better (Local)</div>
          <div className="brandSub">A student-friendly dashboard</div>
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
        Backend expected at <span className="mono">VITE_API_BASE_URL</span> (default: http://localhost:8000)
      </footer>
    </div>
  );
}
