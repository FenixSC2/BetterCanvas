// src/lib/notifications.js

const LS_PERMISSION_KEY = "bc.notifications.permissionAsked";
const LS_SENT_KEY = "bc.notifications.sent"; // JSON map: key -> lastSentMs

function loadSentMap() {
  try {
    return JSON.parse(localStorage.getItem(LS_SENT_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSentMap(map) {
  localStorage.setItem(LS_SENT_KEY, JSON.stringify(map));
}

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission() {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return "unsupported";

  // Track that we asked at least once (for UX logic later)
  localStorage.setItem(LS_PERMISSION_KEY, "1");

  const perm = await Notification.requestPermission();
  return perm; // "granted" | "denied" | "default"
}

/**
 * Send a notification if allowed and if it hasn't been sent recently.
 * @param {object} opts
 * @param {string} opts.dedupeKey - unique key for this alert
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} [opts.url] - open on click
 * @param {number} [opts.cooldownMs] - default 6 hours
 */
export function notifyOnce({ dedupeKey, title, body, url, cooldownMs = 6 * 60 * 60 * 1000 }) {
  if (!notificationsSupported()) return false;
  if (Notification.permission !== "granted") return false;

  const sent = loadSentMap();
  const now = Date.now();
  const last = sent[dedupeKey];

  if (typeof last === "number" && now - last < cooldownMs) {
    return false; // still cooling down
  }

  const n = new Notification(title, { body });

  if (url) {
    n.onclick = () => {
      try {
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        // ignore
      }
    };
  }

  sent[dedupeKey] = now;
  saveSentMap(sent);
  return true;
}

export function clearNotificationHistory() {
  localStorage.removeItem(LS_SENT_KEY);
}
