// src/pages/Discussions.jsx
import { useEffect, useMemo, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { useCachedAsync } from "../hooks/useCachedAsync";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";
import { Expandable } from "../components/Expandable";
import { formatCourseTitle } from "../utils/courseUtils";

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

function DiscussionReplies({ courseId, topic }) {
  const replyCount =
    typeof topic.discussion_subentry_count === "number"
      ? topic.discussion_subentry_count
      : null;
  const unread =
    typeof topic.unread_count === "number" && topic.unread_count > 0
      ? topic.unread_count
      : 0;

  const [opened, setOpened] = useState(false);
  const [openReplyIds, setOpenReplyIds] = useState(() => new Set());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!opened || data || loading) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    canvasApi
      .getDiscussionReplies(courseId, topic.id)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // data/loading are read as guards; including them would re-fetch on every error or completion
  }, [opened, courseId, topic.id]); // oxlint-disable-line react-doctor/exhaustive-deps

  function toggleReply(id) {
    setOpenReplyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const replies = useMemo(
    () => (Array.isArray(data?.replies) ? data.replies : []),
    [data?.replies],
  );

  // Show only top-level replies in the outer list, with nested children inline so a
  // long thread isn't dozens of independent items on the page.
  const topLevel = useMemo(() => replies.filter((r) => !r.parent_id), [replies]);
  const childrenByParent = useMemo(() => {
    const m = new Map();
    for (const r of replies) {
      if (!r.parent_id) continue;
      const arr = m.get(r.parent_id) || [];
      arr.push(r);
      m.set(r.parent_id, arr);
    }
    return m;
  }, [replies]);

  // For any reply whose subtree we don't fully render, count total descendants so
  // we can surface a "N more replies — view on Canvas" link inline with that card.
  // We only render top-level + direct children; deeper than that gets collapsed.
  const descendantCountById = useMemo(() => {
    const counts = new Map();
    function count(id) {
      if (counts.has(id)) return counts.get(id);
      const direct = childrenByParent.get(id) || [];
      let total = direct.length;
      for (const c of direct) total += count(c.id);
      counts.set(id, total);
      return total;
    }
    for (const r of replies) count(r.id);
    return counts;
  }, [replies, childrenByParent]);

  // Every reply card we actually render gets an expandable affordance, so building
  // the "expand all" set is just top-level + their direct children.
  const expandableIds = useMemo(() => {
    const ids = [];
    for (const r of topLevel) {
      ids.push(r.id);
      for (const c of childrenByParent.get(r.id) || []) ids.push(c.id);
    }
    return ids;
  }, [topLevel, childrenByParent]);

  if (replyCount === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No replies yet.
      </div>
    );
  }

  const allExpanded =
    expandableIds.length > 0 && expandableIds.every((id) => openReplyIds.has(id));
  const noneExpanded = openReplyIds.size === 0;

  function expandAll() { setOpenReplyIds(new Set(expandableIds)); }
  function collapseAll() { setOpenReplyIds(new Set()); }

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          style={{ fontSize: "var(--fontSm)", display: "inline-flex", alignItems: "center", gap: 6 }}
          onClick={() => setOpened((v) => !v)}
          aria-expanded={opened}
        >
          <span className="mono" aria-hidden="true" style={{ opacity: 0.8 }}>
            {opened ? "▾" : "▸"}
          </span>
          {opened ? "Hide replies" : "Show replies"}
          {replyCount != null ? ` (${replyCount})` : ""}
          {unread > 0 ? (
            <span
              className="badge badgeSuccess"
              style={{ marginLeft: 4, fontSize: 12 }}
            >
              NEW: {unread}
            </span>
          ) : null}
        </button>
        {opened && expandableIds.length > 0 ? (
          <>
            <button
              type="button"
              className="btn"
              style={{ fontSize: "var(--fontSm)" }}
              onClick={expandAll}
              disabled={allExpanded}
              title="Expand every reply in this thread"
            >
              Expand all
            </button>
            <button
              type="button"
              className="btn"
              style={{ fontSize: "var(--fontSm)" }}
              onClick={collapseAll}
              disabled={noneExpanded}
              title="Collapse every reply in this thread"
            >
              Collapse all
            </button>
          </>
        ) : null}
      </div>

      {opened ? (
        loading ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Loading replies…
          </div>
        ) : err ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Could not load replies.
          </div>
        ) : topLevel.length === 0 ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            No replies yet.
          </div>
        ) : (
          <ul className="list" style={{ marginTop: 8, gap: 6 }}>
            {topLevel.map((r) => (
              <ReplyItem
                key={r.id}
                reply={r}
                isOpen={openReplyIds.has(r.id)}
                onToggle={() => toggleReply(r.id)}
                children={childrenByParent.get(r.id) || []}
                openReplyIds={openReplyIds}
                toggleReply={toggleReply}
                descendantCountById={descendantCountById}
                topicHtmlUrl={topic.html_url}
              />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function ReplyItem({
  reply,
  isOpen,
  onToggle,
  children: childReplies,
  openReplyIds,
  toggleReply,
  descendantCountById,
  topicHtmlUrl,
  depth = 0,
}) {
  const body = stripHtml(reply.message_html);
  const preview = body.length > 120 ? body.slice(0, 120) + "…" : body;
  // We render direct children of depth-0 cards but stop there, so truncation
  // always happens at depth ≥ 1. Counting only here avoids double-reporting the
  // same hidden replies on both the top-level card and its child.
  const totalDescendants = descendantCountById?.get(reply.id) || 0;
  const hiddenUnder = depth >= 1 ? totalDescendants : 0;
  return (
    <li
      className={`listItem replyBubble${isOpen ? " replyBubbleOpen" : ""}`}
      style={{ marginLeft: depth * 16, listStyle: "none" }}
    >
      <button
        type="button"
        className="replyBubbleSummary"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span className="mono replyBubbleChevron" aria-hidden="true">
          {isOpen ? "▾" : "▸"}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>{reply.author_name || "Unknown"}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {reply.created_at ? fmtWhen(reply.created_at) : ""}
            </span>
            {reply.read_state === "unread" ? (
              <span className="badge badgeSuccess" style={{ fontSize: 12 }}>NEW</span>
            ) : null}
            <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
              {isOpen ? "click to collapse" : "click to expand"}
            </span>
          </span>
          {!isOpen && preview ? (
            <span
              className="muted"
              style={{ fontSize: 12, marginTop: 2, display: "block" }}
            >
              {preview}
            </span>
          ) : null}
        </span>
      </button>
      {isOpen ? (
        <div
          style={{
            fontSize: 13,
            whiteSpace: "pre-wrap",
            maxHeight: 240,
            overflowY: "auto",
            padding: "0 10px 8px 34px",
          }}
        >
          {body || <span className="muted">(empty reply)</span>}
        </div>
      ) : null}
      {isOpen && childReplies && childReplies.length > 0 ? (
        <ul className="list" style={{ margin: "0 10px 8px 24px", gap: 6, padding: 0 }}>
          {childReplies.map((c) => (
            <ReplyItem
              key={c.id}
              reply={c}
              isOpen={openReplyIds.has(c.id)}
              onToggle={() => toggleReply(c.id)}
              openReplyIds={openReplyIds}
              toggleReply={toggleReply}
              descendantCountById={descendantCountById}
              topicHtmlUrl={topicHtmlUrl}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
      {isOpen && hiddenUnder > 0 ? (
        <div
          className="muted"
          style={{ fontSize: 12, padding: "0 10px 8px 34px" }}
        >
          {hiddenUnder} more {hiddenUnder === 1 ? "reply" : "replies"} in this thread —{" "}
          {topicHtmlUrl ? (
            <a href={topicHtmlUrl} target="_blank" rel="noreferrer">
              view on Canvas
            </a>
          ) : (
            "view on Canvas"
          )}
        </div>
      ) : null}
    </li>
  );
}

function CourseDiscussions({ course, lastSeen, markSeen }) {
  const courseId = course.id;
  const q = useCachedAsync(
    `discussions:course:${courseId}`,
    ({ signal }) => canvasApi.getCourseDiscussions(courseId, 30, { signal }),
    { ttlMs: 3 * 60 * 1000 },
  );

  const topics = useMemo(
    () => (Array.isArray(q.data?.discussions) ? q.data.discussions : []),
    [q.data?.discussions],
  );

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
      title={formatCourseTitle(course.name) || `Course ${courseId}`}
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
                style={{ marginLeft: 8, fontSize: 12 }}
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
        <ul className="list listSpaced" style={{ marginTop: -10 }}>
          {sorted.map((t) => {
            const preview = stripHtml(t.message_html);
            const isNew = topicSortKey(t) > lastSeenTs;
            const when = t.last_reply_at || t.posted_at;
            return (
              <li key={t.id} className="listItem">
                <div className="cardBody stack" style={{ gap: 6, paddingTop: 10 }}>
                  <div className="rowWrap" style={{ alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700 }}>{t.title}</span>
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
                  </div>
                  {t.html_url ? (
                    <div>
                      <a
                        className="btn"
                        href={t.html_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Canvas
                      </a>
                    </div>
                  ) : null}
                  {preview ? (
                    <div
                      className="muted"
                      style={{
                        fontSize: 13,
                        whiteSpace: "pre-wrap",
                        maxHeight: 240,
                        overflowY: "auto",
                        paddingRight: 4,
                      }}
                    >
                      {preview}
                    </div>
                  ) : null}
                  <DiscussionReplies
                    courseId={courseId}
                    topic={t}
                  />
                </div>
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
