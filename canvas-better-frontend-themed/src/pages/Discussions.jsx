// src/pages/Discussions.jsx
import { useEffect, useMemo, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { useCachedAsync } from "../hooks/useCachedAsync";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { Expandable } from "../components/Expandable";

const LAST_SEEN_KEY = "bc.discussions.lastSeenByCourse";

function loadLastSeen() {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function saveLastSeen(map) {
  try {
    localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fmtWhen(raw) {
  if (!raw) return "—";
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  return new Date(t).toLocaleString();
}

function topicSortKey(t) {
  return Math.max(
    t.posted_at ? Date.parse(t.posted_at) || 0 : 0,
    t.last_reply_at ? Date.parse(t.last_reply_at) || 0 : 0,
  );
}

function CourseDiscussions({ course, lastSeen, markSeen }) {
  const courseId = course.id;
  const q = useCachedAsync(
    `discussions:course:${courseId}`,
    ({ signal }) => canvasApi.getCourseDiscussions(courseId, 30, { signal }),
    { ttlMs: 3 * 60 * 1000 },
  );

  const topics = Array.isArray(q.data?.discussions) ? q.data.discussions : [];

  const sorted = useMemo(() => {
    const list = topics.slice();
    list.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return topicSortKey(b) - topicSortKey(a);
    });
    return list;
  }, [topics]);

  const lastSeenTs = lastSeen[String(courseId)] || 0;
  const newCount = sorted.filter((t) => topicSortKey(t) > lastSeenTs).length;

  const handleToggle = (isOpen) => {
    if (isOpen && sorted.length > 0) {
      const maxTs = sorted.reduce(
        (acc, t) => Math.max(acc, topicSortKey(t)),
        0,
      );
      if (maxTs > lastSeenTs) markSeen(courseId, maxTs);
    }
  };

  return (
    <Expandable
      title={course.name || `Course ${courseId}`}
      subtitle={
        q.loading ? (
          <span className="muted">Loading discussions...</span>
        ) : q.error ? (
          <span className="muted">Could not load discussions</span>
        ) : sorted.length === 0 ? (
          <span className="muted">No discussions</span>
        ) : (
          <span className="muted">
            {sorted.length} topic{sorted.length === 1 ? "" : "s"}
            {newCount > 0 ? (
              <span
                className="badge badgeSuccess"
                style={{ marginLeft: 8, fontSize: 11 }}
              >
                NEW: {newCount}
              </span>
            ) : null}
          </span>
        )
      }
      onToggle={handleToggle}
    >
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : sorted.length === 0 ? (
        <div className="muted">No discussion topics found for this course.</div>
      ) : (
        <ul className="list listSpaced">
          {sorted.map((t) => {
            const preview = stripHtml(t.message_html);
            const isNew = topicSortKey(t) > lastSeenTs;
            const when = t.last_reply_at || t.posted_at;
            return (
              <li key={t.id} className="stack" style={{ gap: 4 }}>
                <div className="rowWrap" style={{ alignItems: "center", gap: 8 }}>
                  {t.html_url ? (
                    <a
                      href={t.html_url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontWeight: 700 }}
                    >
                      {t.title}
                    </a>
                  ) : (
                    <span style={{ fontWeight: 700 }}>{t.title}</span>
                  )}
                  {t.pinned ? (
                    <span className="badge badgeNeutral">Pinned</span>
                  ) : null}
                  {t.locked ? (
                    <span className="badge badgeWarn">Locked</span>
                  ) : null}
                  {isNew ? (
                    <span className="badge badgeSuccess">NEW</span>
                  ) : null}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t.author_name ? <>By {t.author_name} • </> : null}
                  {when ? fmtWhen(when) : "Unknown time"}
                  {typeof t.discussion_subentry_count === "number"
                    ? ` • ${t.discussion_subentry_count} repl${t.discussion_subentry_count === 1 ? "y" : "ies"}`
                    : ""}
                </div>
                {preview ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {preview.length > 240
                      ? preview.slice(0, 240) + "…"
                      : preview}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Expandable>
  );
}

export function Discussions() {
  const [lastSeen, setLastSeen] = useState(() => loadLastSeen());

  const coursesQ = useCachedAsync(
    "discussions:courses",
    ({ signal }) => canvasApi.getCourses({ signal }),
    { ttlMs: 5 * 60 * 1000 },
  );

  const courses = Array.isArray(coursesQ.data) ? coursesQ.data : [];

  const markSeen = (courseId, ts) => {
    const next = { ...lastSeen, [String(courseId)]: ts };
    setLastSeen(next);
    saveLastSeen(next);
  };

  useEffect(() => {
    function onStorage(e) {
      if (e?.key === LAST_SEEN_KEY) setLastSeen(loadLastSeen());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (coursesQ.loading && !coursesQ.data) return <Loading />;
  if (coursesQ.error) return <ErrorBox error={coursesQ.error} />;

  if (courses.length === 0) {
    return (
      <div className="card">
        <div className="cardBody">
          <div className="muted">No courses available.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="cardBody">
          <div className="h2">Discussions</div>
          <div className="muted">
            Active discussion topics by course. Pinned posts surface to the
            top; expand a course to mark its newest topic as seen.
          </div>
        </div>
      </div>

      {courses.map((c) => (
        <CourseDiscussions
          key={c.id}
          course={c}
          lastSeen={lastSeen}
          markSeen={markSeen}
        />
      ))}
    </div>
  );
}
