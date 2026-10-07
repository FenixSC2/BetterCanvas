// src/hooks/useDesktopNotifications.js
import { useEffect, useMemo, useRef, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { getNotificationPermission, notifyOnce, notificationsSupported } from "../lib/notifications";
import { dueWithinHours, isMissing } from "../lib/urgency";
import { loadTodos, syncTodos } from "../lib/todoStore";
import { formatCourseTitle } from "../utils/courseUtils";

const GRADE_THRESHOLDS_KEY = "bc.notifications.gradeThresholds";
const LAST_KNOWN_GRADES_KEY = "bc.notifications.lastKnownGrades";

/** Forget the grade snapshot used for change notifications (called on sign-out). */
export function clearLastKnownGrades() {
  try {
    localStorage.removeItem(LAST_KNOWN_GRADES_KEY);
  } catch {
    // Storage unavailable; nothing to clear.
  }
}

export function loadGradeThresholds() {
  try {
    const raw = localStorage.getItem(GRADE_THRESHOLDS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

export function saveGradeThresholds(map) {
  try {
    localStorage.setItem(GRADE_THRESHOLDS_KEY, JSON.stringify(map || {}));
  } catch {
    // ignore
  }
}

function loadLastKnownGrades() {
  try {
    const raw = localStorage.getItem(LAST_KNOWN_GRADES_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function saveLastKnownGrades(map) {
  try {
    localStorage.setItem(LAST_KNOWN_GRADES_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export function useDesktopNotifications(hasToken = false) {
  const supported = notificationsSupported();
  const [permission, setPermission] = useState(getNotificationPermission());
  const [enabled, setEnabled] = useState(() => {
    // "enabled" means we should run checks; permission still gates actual notifications.
    return localStorage.getItem("bc.notifications.enabled") === "1";
  });

  const timerRef = useRef(null);

  // Keep permission fresh (user might change browser settings)
  useEffect(() => {
    if (!supported) return;
    const id = setInterval(() => setPermission(getNotificationPermission()), 2000);
    return () => clearInterval(id);
  }, [supported]);

  useEffect(() => {
    localStorage.setItem("bc.notifications.enabled", enabled ? "1" : "0");
  }, [enabled]);

  const canNotify = useMemo(() => supported && permission === "granted", [supported, permission]);

  useEffect(() => {
    // Don't run if not enabled, OR if user doesn't have a Canvas token yet
    if (!enabled || !hasToken) return;

    async function check() {
      try {
        // Pull a reasonable window of assignments
        const items = await canvasApi.getUpcoming(80);
        const todos = await syncTodos().catch(() => loadTodos());

        // 1) Overdue (missing) — very important, short cooldown
        for (const a of items) {
          if (a.submitted) continue;
          if (!isMissing(a)) continue;

          notifyOnce({
            dedupeKey: `missing:${a.course_id}:${a.id}`,
            title: "Overdue assignment",
            body: `${formatCourseTitle(a.course_name) || "Course"} • ${a.name}`,
            url: a.html_url,
            cooldownMs: 2 * 60 * 60 * 1000, // 2h
          });
        }

        // 2) Due today (next 12h) — medium cooldown
        for (const a of items) {
          if (a.submitted) continue;
          if (!dueWithinHours(a, 12)) continue;

          notifyOnce({
            dedupeKey: `due12h:${a.course_id}:${a.id}`,
            title: "Due soon",
            body: `${formatCourseTitle(a.course_name) || "Course"} • ${a.name} • Due ${new Date(a.due_at).toLocaleTimeString()}`,
            url: a.html_url,
            cooldownMs: 6 * 60 * 60 * 1000, // 6h
          });
        }

        // 3) High-value due within 24h (optional heuristic)
        for (const a of items) {
          if (a.submitted) continue;
          if (!dueWithinHours(a, 24)) continue;

          const pts = typeof a.points_possible === "number" ? a.points_possible : 0;
          if (pts < 25) continue; // threshold; tweak later

          notifyOnce({
            dedupeKey: `hi24h:${a.course_id}:${a.id}`,
            title: "High-points assignment due soon",
            body: `${formatCourseTitle(a.course_name) || "Course"} • ${a.name} • ${pts} points`,
            url: a.html_url,
            cooldownMs: 12 * 60 * 60 * 1000, // 12h
          });
        }

        // 4) Personal TODO overdue notifications
        for (const todo of todos || []) {
          if (todo?.completed) continue;
          if (!isMissing(todo)) continue;

          const occurrenceKey = `${todo.series_id || todo.id}:${todo.occurrence_index || 0}`;
          notifyOnce({
            dedupeKey: `todo:overdue:${occurrenceKey}`,
            title: "Overdue personal to-do",
            body: todo.title || "Untitled to-do",
            cooldownMs: 2 * 60 * 60 * 1000,
          });
        }

        // 5) Personal TODO due soon notifications
        for (const todo of todos || []) {
          if (todo?.completed) continue;
          if (!dueWithinHours(todo, 12)) continue;

          const occurrenceKey = `${todo.series_id || todo.id}:${todo.occurrence_index || 0}`;
          notifyOnce({
            dedupeKey: `todo:due12h:${occurrenceKey}`,
            title: "Personal to-do due soon",
            body: `${todo.title || "Untitled to-do"} • Due ${new Date(todo.due_at).toLocaleTimeString()}`,
            cooldownMs: 6 * 60 * 60 * 1000,
          });
        }

        // 6) Grade-drop below user-set threshold per course
        const thresholds = loadGradeThresholds();
        if (Object.keys(thresholds).length > 0) {
          try {
            const overviewData = await canvasApi.getOverview();
            const grades = Array.isArray(overviewData?.grades) ? overviewData.grades : [];
            const lastKnown = loadLastKnownGrades();
            const nextKnown = { ...lastKnown };
            for (const g of grades) {
              const courseId = g?.course_id ?? g?.id;
              if (courseId == null) continue;
              const courseKey = String(courseId);
              const score = Number(g?.current_score);
              if (!Number.isFinite(score)) continue;
              const threshold = Number(thresholds[courseKey]);
              if (!Number.isFinite(threshold)) {
                nextKnown[courseKey] = score;
                continue;
              }
              const prev = Number(lastKnown[courseKey]);
              const prevAbove = !Number.isFinite(prev) || prev >= threshold;
              if (prevAbove && score < threshold) {
                notifyOnce({
                  dedupeKey: `grade-drop:${courseKey}:${threshold}:${score.toFixed(2)}`,
                  title: "Grade dropped below threshold",
                  body: `${formatCourseTitle(g?.course_name) || `Course ${courseKey}`} • ${score.toFixed(1)}% (threshold ${threshold}%)`,
                  cooldownMs: 12 * 60 * 60 * 1000,
                });
              }
              nextKnown[courseKey] = score;
            }
            saveLastKnownGrades(nextKnown);
          } catch {
            // silent fail
          }
        }
      } catch {
        // silent fail — notifications should never crash the UI
      }
    }

    // Run immediately, then on interval
    check();

    timerRef.current = setInterval(check, 2 * 60 * 1000); // every 2 minutes
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, hasToken]);

  return {
    supported,
    permission,
    enabled,
    setEnabled,
    canNotify,
    refreshPermission: () => setPermission(getNotificationPermission()),
  };
}
