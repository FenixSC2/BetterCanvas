import { useMemo, useState } from "react";
import { Tabs } from "./components/Tabs";
import { MyInformation } from "./pages/MyInformation";
import { MyCourses } from "./pages/MyCourses";
import { UpcomingAssignments } from "./pages/UpcomingAssignments";
import "./styles.css";

export default function App() {
  const tabs = useMemo(
    () => [
      { key: "info", label: "My information" },
      { key: "courses", label: "My courses" },
      { key: "upcoming", label: "Upcoming assignments" },
    ],
    []
  );

  const [active, setActive] = useState("info");

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brandTitle">Canvas Better (Local)</div>
          <div className="brandSub">A student-friendly dashboard</div>
        </div>
        <Tabs tabs={tabs} activeKey={active} onChange={setActive} />
      </header>

      <main className="main">
        {active === "info" ? <MyInformation /> : null}
        {active === "courses" ? <MyCourses /> : null}
        {active === "upcoming" ? <UpcomingAssignments /> : null}
      </main>

      <footer className="footer muted">
        Backend expected at <span className="mono">VITE_API_BASE_URL</span> (default: http://localhost:8000)
      </footer>
    </div>
  );
}
