// src/lib/urgency.js

export function hoursUntil(dueAtIso) {
  if (!dueAtIso) return Infinity;
  return (new Date(dueAtIso).getTime() - Date.now()) / (1000 * 60 * 60);
}

export function isMissing(a) {
  if (!a?.due_at) return false;
  const h = hoursUntil(a.due_at);
  return Number.isFinite(h) && h < 0 && !a.submitted;
}

export function dueWithinHours(a, hours) {
  if (!a?.due_at) return false;
  const h = hoursUntil(a.due_at);
  return Number.isFinite(h) && h >= 0 && h <= hours;
}
