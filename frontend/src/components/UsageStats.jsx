// src/components/UsageStats.jsx
// Admin-only usage analytics shown in Settings → Usage.

import { useEffect, useState } from "react";
import { API_BASE } from "../api/canvasApi";

const REFRESH_MS = 30_000;

function formatDay(iso, opts = { month: "short", day: "numeric" }) {
  // Days are calendar dates (America/New_York); parse as local noon to avoid TZ drift.
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, opts);
}

function StatTile({ label, value, sub }) {
  return (
    <div className="usageTile">
      <div className="usageTileLabel">{label}</div>
      <div className="usageTileValue">{value}</div>
      {sub ? <div className="usageTileSub">{sub}</div> : null}
    </div>
  );
}

function DailyBars({ title, series, field }) {
  const [hover, setHover] = useState(null);
  const peak = Math.max(0, ...series.map((d) => d[field]));
  const max = Math.max(1, peak);
  const total = series.reduce((sum, d) => sum + d[field], 0);
  const shown = hover ?? series[series.length - 1];

  return (
    <figure className="usageChart">
      <figcaption className="usageChartHead">
        <span className="usageChartTitle">{title}</span>
        <span className="usageChartReadout" aria-live="polite">
          {shown ? `${formatDay(shown.day)}: ${shown[field]}` : ""}
        </span>
      </figcaption>
      <div
        className="usageBars"
        role="img"
        aria-label={`${title}, last ${series.length} days, ${total} total`}
        onMouseLeave={() => setHover(null)}
      >
        {series.map((d) => (
          <div
            key={d.day}
            className={`usageBarSlot ${hover?.day === d.day ? "active" : ""}`}
            onMouseEnter={() => setHover(d)}
            title={`${formatDay(d.day, { weekday: "short", month: "short", day: "numeric" })}: ${d[field]}`}
          >
            <div
              className="usageBar"
              style={{ height: d[field] ? `${Math.max(4, (d[field] / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="usageAxis">
        <span>{series.length ? formatDay(series[0].day) : ""}</span>
        <span>peak {peak}</span>
        <span>Today</span>
      </div>
    </figure>
  );
}

export function UsageStats() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/api/admin/stats`, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setStats(data);
        setError(null);
        setUpdatedAt(new Date());
      } catch (err) {
        if (!cancelled) setError(err.message || "Failed to load");
      }
    }
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!stats) {
    return (
      <div className="card">
        <div className="cardBody muted">{error ? `Couldn't load usage stats (${error}).` : "Loading usage stats…"}</div>
      </div>
    );
  }

  const { online, users, demo, accounts, series } = stats;

  return (
    <div className="stack">
      <div className="card">
        <div className="cardBody">
          <div className="h3">Usage</div>
          <div className="muted" style={{ marginBottom: 14 }}>
            Counts exclude admin accounts. Days roll over at midnight Eastern.
            {updatedAt ? ` Updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}
            {error ? ` Refresh failed (${error}).` : ""}
          </div>

          <div className="usageGroupLabel">Online now · active in the last {online.window_minutes} min</div>
          <div className="usageTiles">
            <StatTile label="Signed-in users" value={online.users} />
            <StatTile label="Demo sessions" value={online.demo} />
          </div>

          <div className="usageGroupLabel">Active signed-in users</div>
          <div className="usageTiles">
            <StatTile label="Today" value={users.day} />
            <StatTile label="Last 7 days" value={users.week} />
            <StatTile label="Last 30 days" value={users.month} />
          </div>

          <div className="usageGroupLabel">Demo sessions</div>
          <div className="usageTiles">
            <StatTile label="Today" value={demo.day} />
            <StatTile label="Last 7 days" value={demo.week} />
            <StatTile label="Last 30 days" value={demo.month} />
          </div>

          <div className="usageGroupLabel">Accounts</div>
          <div className="usageTiles">
            <StatTile label="Total" value={accounts.total} />
            <StatTile label="New this week" value={accounts.new_this_week} />
            <StatTile label="Canvas connected" value={accounts.canvas_connected} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cardBody stack">
          <DailyBars title="Signed-in users per day" series={series} field="users" />
          <DailyBars title="Demo sessions per day" series={series} field="demo" />
        </div>
      </div>
    </div>
  );
}
