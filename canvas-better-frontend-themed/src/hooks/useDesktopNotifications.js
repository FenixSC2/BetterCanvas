// src/hooks/useDesktopNotifications.js
import { useEffect, useMemo, useRef, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { getNotificationPermission, notifyOnce, notificationsSupported } from "../lib/notifications";
import { dueWithinHours, isMissing } from "../lib/urgency";

export function useDesktopNotifications() {
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
    if (!enabled) return;

    async function check() {
      try {
        // Pull a reasonable window of assignments
        const items = await canvasApi.getUpcoming(80);

        // 1) Overdue (missing) — very important, short cooldown
        for (const a of items) {
          if (a.submitted) continue;
          if (!isMissing(a)) continue;

          notifyOnce({
            dedupeKey: `missing:${a.course_id}:${a.id}`,
            title: "Overdue assignment",
            body: `${a.course_name || "Course"} • ${a.name}`,
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
            body: `${a.course_name || "Course"} • ${a.name} • Due ${new Date(a.due_at).toLocaleTimeString()}`,
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
            body: `${a.course_name || "Course"} • ${a.name} • ${pts} points`,
            url: a.html_url,
            cooldownMs: 12 * 60 * 60 * 1000, // 12h
          });
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
  }, [enabled]);

  return {
    supported,
    permission,
    enabled,
    setEnabled,
    canNotify,
    refreshPermission: () => setPermission(getNotificationPermission()),
  };
}
