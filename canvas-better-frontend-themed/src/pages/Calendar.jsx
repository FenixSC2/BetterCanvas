// src/pages/Calendar.jsx
import { useEffect, useMemo, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { useCachedAsync } from "../hooks/useCachedAsync";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";

const EVENTS_KEY = "bc.calendar.events";

function loadCalendarEvents() {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => e && e.id && e.date && e.title);
  } catch {
    return [];
  }
}

function saveCalendarEvents(events) {
  try {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch {
    // ignore
  }
}

function makeEventId() {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseISO(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

function addMonths(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth() + n, 1);
  return d;
}

function monthGridStart(viewDate) {
  // Sunday-start month grid
  const firstOfMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const dow = firstOfMonth.getDay();
  return new Date(
    firstOfMonth.getFullYear(),
    firstOfMonth.getMonth(),
    1 - dow,
  );
}

function monthGridEnd(viewDate) {
  const start = monthGridStart(viewDate);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 42);
}

function fmtMonthYear(date) {
  return date.toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Calendar() {
  const [viewDate, setViewDate] = useState(() => new Date());
  const [events, setEvents] = useState(() => loadCalendarEvents());
  const [composerDate, setComposerDate] = useState("");
  const [composerTitle, setComposerTitle] = useState("");

  const gridStart = useMemo(() => monthGridStart(viewDate), [viewDate]);
  const gridEnd = useMemo(() => monthGridEnd(viewDate), [viewDate]);

  // Pull a wide window of assignments to populate the visible month.
  const upcomingQ = useCachedAsync(
    "calendar:upcoming",
    ({ signal }) => canvasApi.getUpcoming(200, { signal }),
    { ttlMs: 3 * 60 * 1000 },
  );

  const assignments = Array.isArray(upcomingQ.data) ? upcomingQ.data : [];

  // Bucket all data into ISO-day strings
  const itemsByDay = useMemo(() => {
    const map = new Map();
    function push(day, entry) {
      if (!day) return;
      if (!map.has(day)) map.set(day, []);
      map.get(day).push(entry);
    }
    for (const a of assignments) {
      const d = parseISO(a?.due_at);
      if (!d) continue;
      push(isoDay(d), {
        kind: "assignment",
        id: `${a.course_id}:${a.id}`,
        title: a.name || "Assignment",
        subtitle: a.course_name || "",
        url: a.html_url || null,
        at: d,
      });
    }
    for (const ev of events) {
      push(ev.date, {
        kind: "event",
        id: ev.id,
        title: ev.title,
        subtitle: ev.subtitle || "",
        url: null,
        at: parseISO(`${ev.date}T00:00:00`),
      });
    }
    // Sort each day's list: assignments first, then by time
    for (const list of map.values()) {
      list.sort((x, y) => {
        if (x.kind !== y.kind) return x.kind === "assignment" ? -1 : 1;
        const tx = x.at?.getTime() ?? 0;
        const ty = y.at?.getTime() ?? 0;
        return tx - ty;
      });
    }
    return map;
  }, [assignments, events]);

  // Build the 6-week grid
  const cells = useMemo(() => {
    const out = [];
    const cur = new Date(gridStart);
    while (cur < gridEnd) {
      out.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }, [gridStart, gridEnd]);

  const todayISO = isoDay(new Date());
  const currentMonth = viewDate.getMonth();

  const addEvent = () => {
    const date = (composerDate || "").trim();
    const title = (composerTitle || "").trim();
    if (!date || !title) return;
    const next = [
      ...events,
      { id: makeEventId(), date, title },
    ];
    setEvents(next);
    saveCalendarEvents(next);
    setComposerTitle("");
  };

  const removeEvent = (id) => {
    const next = events.filter((e) => e.id !== id);
    setEvents(next);
    saveCalendarEvents(next);
  };

  useEffect(() => {
    function onStorage(e) {
      if (e?.key === EVENTS_KEY) setEvents(loadCalendarEvents());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (upcomingQ.loading && !upcomingQ.data) return <Loading />;
  if (upcomingQ.error) return <ErrorBox error={upcomingQ.error} />;

  return (
    <div className="stack">
      <div className="card">
        <div className="cardBody">
          <div className="h3">Add an event</div>
          <div className="muted" style={{ marginBottom: 8 }}>
            Personal calendar events live locally in your browser and aren&apos;t
            synced to Canvas.
          </div>
          <div className="rowWrap" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="date"
              value={composerDate}
              onChange={(e) => setComposerDate(e.target.value)}
              style={{ minWidth: 150 }}
            />
            <input
              type="text"
              placeholder="Event title"
              value={composerTitle}
              onChange={(e) => setComposerTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addEvent();
                }
              }}
              style={{ flex: "1 1 220px", minWidth: 200 }}
            />
            <button
              type="button"
              className="btn"
              onClick={addEvent}
              disabled={!composerDate || !composerTitle.trim()}
            >
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cardBody">
          <div
            className="rowWrap"
            style={{ justifyContent: "space-between", alignItems: "center" }}
          >
            <div className="h2">{fmtMonthYear(viewDate)}</div>
            <div className="rowWrap" style={{ gap: 6 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setViewDate(addMonths(viewDate, -1))}
              >
                ‹ Prev
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setViewDate(new Date())}
              >
                Today
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setViewDate(addMonths(viewDate, 1))}
              >
                Next ›
              </button>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 4,
              marginTop: 12,
            }}
          >
            {WEEKDAYS.map((w) => (
              <div
                key={w}
                className="muted"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  textAlign: "center",
                  padding: "4px 0",
                }}
              >
                {w}
              </div>
            ))}

            {cells.map((cellDate) => {
              const iso = isoDay(cellDate);
              const inMonth = cellDate.getMonth() === currentMonth;
              const isToday = iso === todayISO;
              const items = itemsByDay.get(iso) || [];
              return (
                <div
                  key={iso}
                  className="card"
                  style={{
                    minHeight: 92,
                    padding: 6,
                    opacity: inMonth ? 1 : 0.45,
                    background: isToday
                      ? "color-mix(in srgb, var(--accent, #4f8ef7) 8%, var(--surface))"
                      : undefined,
                    borderColor: isToday ? "var(--accent, #4f8ef7)" : undefined,
                  }}
                >
                  <div
                    className="rowWrap"
                    style={{
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 4,
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 12,
                        fontWeight: isToday ? 800 : 600,
                      }}
                    >
                      {cellDate.getDate()}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "0 6px", fontSize: 11 }}
                      title="Add event on this date"
                      onClick={() => {
                        setComposerDate(iso);
                        setComposerTitle("");
                      }}
                    >
                      +
                    </button>
                  </div>
                  <ul
                    className="stack"
                    style={{ listStyle: "none", padding: 0, margin: 0, gap: 2 }}
                  >
                    {items.slice(0, 4).map((it) => (
                      <li key={`${it.kind}:${it.id}`}>
                        {it.kind === "assignment" ? (
                          it.url ? (
                            <a
                              href={it.url}
                              target="_blank"
                              rel="noreferrer"
                              className="badge badgeNeutral"
                              style={{ fontSize: 11, display: "block" }}
                              title={`${it.title} • ${it.subtitle}`}
                            >
                              {it.title}
                            </a>
                          ) : (
                            <span
                              className="badge badgeNeutral"
                              style={{ fontSize: 11, display: "block" }}
                              title={`${it.title} • ${it.subtitle}`}
                            >
                              {it.title}
                            </span>
                          )
                        ) : (
                          <span
                            className="badge badgeSuccess rowWrap"
                            style={{
                              fontSize: 11,
                              gap: 4,
                              alignItems: "center",
                              padding: "1px 6px",
                            }}
                            title={it.title}
                          >
                            <span>{it.title}</span>
                            <button
                              type="button"
                              className="btn"
                              style={{ padding: "0 4px", fontSize: 10 }}
                              onClick={() => removeEvent(it.id)}
                              aria-label="Remove event"
                            >
                              ×
                            </button>
                          </span>
                        )}
                      </li>
                    ))}
                    {items.length > 4 ? (
                      <li className="muted" style={{ fontSize: 10 }}>
                        +{items.length - 4} more
                      </li>
                    ) : null}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
