// src/lib/workloadEstimates.js

const NS = "bettercanvas:workload:v1";

function makeKey({ courseId, assignmentId }) {
  return `${NS}:${courseId}:${assignmentId}`;
}

export function getEstimateHours({ courseId, assignmentId }) {
  try {
    const raw = localStorage.getItem(makeKey({ courseId, assignmentId }));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const h = parsed?.hours;
    return typeof h === "number" && isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

export function setEstimateHours({ courseId, assignmentId }, hours) {
  const h = typeof hours === "number" ? hours : Number(hours);
  if (!isFinite(h) || h < 0) {
    // treat invalid/negative as delete
    clearEstimateHours({ courseId, assignmentId });
    return;
  }
  localStorage.setItem(
    makeKey({ courseId, assignmentId }),
    JSON.stringify({ hours: h, updatedAt: Date.now() })
  );
}

export function clearEstimateHours({ courseId, assignmentId }) {
  localStorage.removeItem(makeKey({ courseId, assignmentId }));
}

export function formatHours(h) {
  if (h == null) return "—";
  if (h === 0) return "0h";
  if (h < 1) return `${Math.round(h * 60)}m`;
  // show at most 1 decimal
  const v = Math.round(h * 10) / 10;
  return `${v}h`;
}
