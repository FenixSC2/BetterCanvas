// src/pages/UpcomingAssignments.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Expandable } from "../components/Expandable";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";

function fmtDue(dt) {
  if (!dt) return "No due date";
  const d = new Date(dt);
  return d.toLocaleString();
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

function clamp01(x) {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function hoursUntil(dueAtIso) {
  if (!dueAtIso) return Infinity;
  return (new Date(dueAtIso).getTime() - Date.now()) / (1000 * 60 * 60);
}

function isMissingAssignment(a) {
  if (!a?.due_at) return false;
  const h = hoursUntil(a.due_at);
  return Number.isFinite(h) && h < 0 && !a.submitted;
}

function isUpcomingAssignment(a) {
  if (!a?.due_at) return false;
  const h = hoursUntil(a.due_at);
  return Number.isFinite(h) && h >= 0;
}

export function UpcomingAssignments() {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  // Dropdown state
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const filterRef = useRef(null);
  const sortRef = useRef(null);

  // Filter mode: all | missing | upcoming | undated
  const [filterMode, setFilterMode] = useState(() => {
    const v = localStorage.getItem("upcomingFilterMode");
    return v || "all";
  });

  // 0 = due-date only, 1 = points-leaning (but still respects urgency a bit)
  const [alpha, setAlpha] = useState(() => {
    const v = localStorage.getItem("upcomingSortAlpha");
    const n = v != null ? Number(v) : 0.25;
    return Number.isFinite(n) ? clamp01(n) : 0.25;
  });

  // Persist settings
  useEffect(() => {
    localStorage.setItem("upcomingSortAlpha", String(alpha));
  }, [alpha]);

  useEffect(() => {
    localStorage.setItem("upcomingFilterMode", filterMode);
  }, [filterMode]);

  // Close dropdowns on outside click
  useEffect(() => {
    function onDocClick(e) {
      if (filterOpen && filterRef.current && !filterRef.current.contains(e.target)) {
        setFilterOpen(false);
      }
      if (sortOpen && sortRef.current && !sortRef.current.contains(e.target)) {
        setSortOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [filterOpen, sortOpen]);

  // Fetch
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setErr(null);

    canvasApi
      .getUpcoming(50, { signal: ac.signal })
      .then((data) => setItems(data || []))
      .catch((e) => {
        if (e.name !== "AbortError") setErr(e);
      })
      .finally(() => setLoading(false));

    return () => ac.abort();
  }, []);

  const visibleAndSorted = useMemo(() => {
    // 1) Apply filter mode FIRST
    const filtered = (items || []).filter((a) => {
      if (filterMode === "missing") return isMissingAssignment(a);
      if (filterMode === "upcoming") return isUpcomingAssignment(a);
      if (filterMode === "undated") return !a?.due_at;
      return true; // all
    });

    // 2) Categorize
    const missing = filtered.filter((a) => isMissingAssignment(a));
    const withDueNonMissing = filtered.filter((a) => a?.due_at && !isMissingAssignment(a));
    const undated = filtered.filter((a) => !a?.due_at);

    // 3) Missing always top: sort by due date (most overdue first = earlier due_at first)
    missing.sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());

    // If the current view is "undated only", skip fancy scoring
    if (filterMode === "undated") {
      return [...undated];
    }

    // 4) Weighted sort for the remaining due-dated items (non-missing)
    const nowMs = Date.now();

    const maxPointsRaw = Math.max(
      1,
      ...withDueNonMissing.map((a) => (typeof a.points_possible === "number" ? a.points_possible : 0))
    );
    const maxPointsLog = Math.log1p(maxPointsRaw);

    // Sharper urgency curve + normalize
    const rawU = withDueNonMissing.map((a) => {
      const h = (new Date(a.due_at).getTime() - nowMs) / (1000 * 60 * 60);
      const hh = Math.max(0, h);
      return 1 / (hh + 4); // stronger urgency than +12
    });

    const minU = Math.min(...rawU, 0);
    const maxU = Math.max(...rawU, 1);

    const urgencyNorm = (a) => {
      const h = (new Date(a.due_at).getTime() - nowMs) / (1000 * 60 * 60);
      const hh = Math.max(0, h);
      const u = 1 / (hh + 4);
      if (maxU === minU) return 1;
      return (u - minU) / (maxU - minU);
    };

    const weightNorm = (a) => {
      const pts = typeof a.points_possible === "number" ? a.points_possible : 0;
      const w = maxPointsLog > 0 ? Math.log1p(Math.max(0, pts)) / maxPointsLog : 0;
      return clamp01(w);
    };

    const scored = withDueNonMissing.map((a) => {
      const uN = urgencyNorm(a);

      // Dampen weight so it doesn't dominate too early
      const wN = weightNorm(a);
      const wAdj = Math.pow(wN, 1.8);

      // Even at alpha=1, keep some urgency signal
      const blendedWeightChannel = 0.35 * uN + 0.65 * wAdj;

      const score = (1 - alpha) * uN + alpha * blendedWeightChannel;

      return { ...a, _score: score };
    });

    scored.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    });

    // 5) Put undated last (unless filter says otherwise)
    return [...missing, ...scored, ...undated];
  }, [items, alpha, filterMode]);

  if (loading) return <Loading label="Loading upcoming assignments…" />;
  if (err) return <ErrorBox error={err} />;

  const alphaPct = Math.round(alpha * 100);

  const filterLabel =
    filterMode === "all"
      ? "All"
      : filterMode === "missing"
      ? "Missing"
      : filterMode === "upcoming"
      ? "Upcoming"
      : "Undated";

  return (
    <div className="stack">
      {/* Header row: left hint, right filter + sorting dropdowns */}
      <div className="rowWrap" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div className="muted">
          Powered by <span className="mono">GET /api/upcoming</span>.
        </div>

        <div className="rowWrap" style={{ gap: 10, alignItems: "center" }}>
          {/* Filter dropdown */}
          <div ref={filterRef} style={{ position: "relative" }}>
            <button className="btn" onClick={() => setFilterOpen((v) => !v)}>
              Filter: {filterLabel} ▾
            </button>

            {filterOpen ? (
              <div
                className="card"
                style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 8px)",
                  width: 220,
                  zIndex: 60,
                }}
              >
                <div className="cardBody">
                  <div className="h3" style={{ marginBottom: 8 }}>
                    Filter
                  </div>

                  <div className="stack" style={{ gap: 8 }}>
                    <button
                      className="btn"
                      onClick={() => {
                        setFilterMode("all");
                        setFilterOpen(false);
                      }}
                    >
                      All
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        setFilterMode("missing");
                        setFilterOpen(false);
                      }}
                    >
                      Missing only
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        setFilterMode("upcoming");
                        setFilterOpen(false);
                      }}
                    >
                      Upcoming only
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        setFilterMode("undated");
                        setFilterOpen(false);
                      }}
                    >
                      Undated only
                    </button>
                  </div>

                  <div className="muted" style={{ marginTop: 10 }}>
                    <b>Note: </b>Missing assignments are always pinned to the top in "All" view.
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Sorting dropdown */}
          <div ref={sortRef} style={{ position: "relative" }}>
            <button className="btn" onClick={() => setSortOpen((v) => !v)}>
              Sorting ▾
            </button>

            {sortOpen ? (
              <div
                className="card"
                style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 8px)",
                  width: 320,
                  zIndex: 50,
                }}
              >
                <div className="cardBody">
                  <div className="h3" style={{ marginBottom: 8 }}>
                    Weighted sort
                  </div>

                  <div className="muted" style={{ marginBottom: 8 }}>
                    Missing items stay at the top regardless of this setting.
                  </div>

                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={alpha}
                    onChange={(e) => setAlpha(Number(e.target.value))}
                    style={{ width: "100%" }}
                    aria-label="Weighted sort slider"
                    disabled={filterMode === "undated"}
                  />

                  <div className="rowWrap" style={{ justifyContent: "space-between", marginTop: 6 }}>
                    <div className="muted">Due date</div>
                    <div className="muted">Points</div>
                  </div>

                  <div className="rowWrap" style={{ marginTop: 10, alignItems: "center" }}>
                    <div className="muted" style={{ minWidth: 120 }}>
                      Points weight
                    </div>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      max="100"
                      value={alphaPct}
                      onChange={(e) => setAlpha(clamp01(Number(e.target.value) / 100))}
                      style={{ width: 90 }}
                      disabled={filterMode === "undated"}
                    />
                    <div className="muted">%</div>
                  </div>

                  <div className="rowWrap" style={{ marginTop: 12 }}>
                    <button className="btn" onClick={() => setAlpha(0)} disabled={filterMode === "undated"}>
                      Date
                    </button>
                    <button className="btn" onClick={() => setAlpha(0.25)} disabled={filterMode === "undated"}>
                      Balanced
                    </button>
                    <button className="btn" onClick={() => setAlpha(1)} disabled={filterMode === "undated"}>
                      Points
                    </button>
                  </div>

                  {filterMode === "undated" ? (
                    <div className="muted" style={{ marginTop: 10 }}>
                      Sorting is disabled for Undated-only view.
                    </div>
                  ) : (
                    <div className="muted" style={{ marginTop: 10 }}>
                      Current blend: <span className="mono">{100 - alphaPct}%</span> due •{" "}
                      <span className="mono">{alphaPct}%</span> points
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {visibleAndSorted.length === 0 ? (
        <div className="muted">No assignments match the current filter.</div>
      ) : null}

      <ul className="list">
        {visibleAndSorted.map((a) => {
          const dueHours = hoursUntil(a.due_at);
          const overdue = Number.isFinite(dueHours) && dueHours < 0;
          const missing = overdue && !a.submitted;

          const liClass = `listItem${missing ? " dangerItem" : ""}`;
          const dueClass = missing ? "dangerText" : "muted";

          const courseLabel = a.course_name || a.course_code || "Unknown course";

          return (
            <li key={`${a.course_id}-${a.id}`} className={liClass}>
              <div className="listMain">
                {/* Top line: Name (left) + Due (right) */}
                <div
                  className="rowWrap"
                  style={{ justifyContent: "space-between", gap: 12, alignItems: "baseline" }}
                >
                  <div className="listTitle">{a.name}</div>
                  <div className={dueClass} style={{ whiteSpace: "nowrap" }}>
                    Due: <span className="mono">{fmtDue(a.due_at)}</span>
                  </div>
                </div>

                {/* Second line */}
                <div className={missing ? "muted dangerMuted" : "muted"}>
                  <span className="mono">{courseLabel}</span>
                  {typeof a.points_possible === "number" ? ` • Points: ${a.points_possible}` : ""}
                  {a.submitted ? " • Submitted" : ""}
                  {a.score != null ? ` • Score: ${a.score}` : ""}
                  {missing ? " • Missing/Overdue" : ""}
                </div>

                {a.description ? (
                  <div style={{ marginTop: 8 }}>
                    <Expandable title="Description">
                      <div className="muted">{stripHtml(a.description)}</div>
                    </Expandable>
                  </div>
                ) : null}
              </div>

              {a.html_url ? (
                <a className="link" href={a.html_url} target="_blank" rel="noreferrer">
                  View
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
