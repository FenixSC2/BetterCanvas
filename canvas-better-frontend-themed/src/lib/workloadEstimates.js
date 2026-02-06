// src/lib/workloadEstimates.js

const NS = "bettercanvas:workload:v1";

// -----------------------------
// Keys / helpers
// -----------------------------
function makeKey({ courseId, assignmentId }) {
  return `${NS}:${courseId}:${assignmentId}`;
}

function safeParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clampHours(h) {
  const n = typeof h === "number" ? h : Number(h);
  if (!Number.isFinite(n)) return NaN;
  return Math.max(0, Math.min(500, n));
}

function emitChanged({ courseId, assignmentId }) {
  // Same-tab update (storage doesn't fire in same tab)
  try {
    window.dispatchEvent(
      new CustomEvent("bettercanvas:workload:changed", {
        detail: { courseId, assignmentId },
      })
    );
  } catch {
    // ignore
  }
}

// -----------------------------
// Read state (with migration)
// -----------------------------
export function getEffortState({ courseId, assignmentId }) {
  const key = makeKey({ courseId, assignmentId });
  const raw = (() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  })();

  if (!raw) {
    return { estimateHours: 0, completedHours: 0, completed: false };
  }

  const parsed = safeParse(raw);

  // Backward compat: old format was { hours: <estimate> }
  // New format uses { estimateHours, completedHours, completed }
  const legacyEstimate = parsed?.hours;
  const estimateHoursRaw =
    parsed?.estimateHours ?? parsed?.estimate_hours ?? legacyEstimate ?? 0;

  const completedHoursRaw = parsed?.completedHours ?? parsed?.completed_hours ?? 0;

  const estimateHours = Number.isFinite(Number(estimateHoursRaw))
    ? Math.max(0, Number(estimateHoursRaw))
    : 0;

  const completedHours = Number.isFinite(Number(completedHoursRaw))
    ? Math.max(0, Number(completedHoursRaw))
    : 0;

  const completed = !!parsed?.completed;

  return { estimateHours, completedHours, completed };
}

// -----------------------------
// Estimate (total) hours
// -----------------------------
export function getEstimateHours({ courseId, assignmentId }) {
  const s = getEffortState({ courseId, assignmentId });
  return s.estimateHours > 0 ? s.estimateHours : null;
}

export function setEstimateHours({ courseId, assignmentId }, hours) {
  const h = clampHours(hours);

  const key = makeKey({ courseId, assignmentId });

  // If invalid => treat as clear estimate (but keep completedHours)
  if (!Number.isFinite(h)) {
    clearEstimateHours({ courseId, assignmentId });
    return;
  }

  const prev = getEffortState({ courseId, assignmentId });

  const next = {
    estimateHours: h,
    completedHours: prev.completedHours,
    completed: prev.completed,
    updatedAt: Date.now(),
  };

  // If user has already "completed", keep it consistent
  if (next.completed && h > 0) {
    next.completedHours = Math.max(next.completedHours, h);
  }

  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // ignore
  }

  emitChanged({ courseId, assignmentId });
}

export function clearEstimateHours({ courseId, assignmentId }) {
  const key = makeKey({ courseId, assignmentId });
  const prev = getEffortState({ courseId, assignmentId });

  // Keep completedHours/completed, but remove estimate
  const next = {
    estimateHours: 0,
    completedHours: prev.completedHours,
    completed: prev.completed,
    updatedAt: Date.now(),
  };

  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // ignore
  }

  emitChanged({ courseId, assignmentId });
}

// -----------------------------
// Completed hours
// -----------------------------
export function setCompletedHours({ courseId, assignmentId }, hours) {
  const h = clampHours(hours);
  if (!Number.isFinite(h)) return;

  const key = makeKey({ courseId, assignmentId });
  const prev = getEffortState({ courseId, assignmentId });

  // If we have an estimate, keep completedHours within [0, estimate]
  const bounded =
    prev.estimateHours > 0 ? Math.max(0, Math.min(h, prev.estimateHours)) : h;

  const next = {
    estimateHours: prev.estimateHours,
    completedHours: bounded,
    // If user drags to full, we can consider it completed
    completed:
      prev.estimateHours > 0 ? bounded >= prev.estimateHours : prev.completed,
    updatedAt: Date.now(),
  };

  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // ignore
  }

  emitChanged({ courseId, assignmentId });
}

export function addCompletedHours({ courseId, assignmentId }, deltaHours) {
  const d = clampHours(deltaHours);
  if (!Number.isFinite(d) || d <= 0) return;

  const prev = getEffortState({ courseId, assignmentId });

  const nextH = prev.completedHours + d;
  setCompletedHours({ courseId, assignmentId }, nextH);
}

// -----------------------------
// Complete toggle + reset
// -----------------------------
export function setCompleted({ courseId, assignmentId }, completed) {
  const key = makeKey({ courseId, assignmentId });
  const prev = getEffortState({ courseId, assignmentId });

  const next = {
    estimateHours: prev.estimateHours,
    completedHours: prev.completedHours,
    completed: !!completed,
    updatedAt: Date.now(),
  };

  // If marking complete and estimate exists, snap completedHours to estimate
  if (next.completed && next.estimateHours > 0) {
    next.completedHours = Math.max(next.completedHours, next.estimateHours);
  }

  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // ignore
  }

  emitChanged({ courseId, assignmentId });
}

export function resetProgress({ courseId, assignmentId }) {
  const key = makeKey({ courseId, assignmentId });
  const prev = getEffortState({ courseId, assignmentId });

  const next = {
    estimateHours: prev.estimateHours,
    completedHours: 0,
    completed: false,
    updatedAt: Date.now(),
  };

  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // ignore
  }

  emitChanged({ courseId, assignmentId });
}

// -----------------------------
// Derived helpers (used by UI)
// -----------------------------
export function computeProgress(state) {
  const estimate = Number(state?.estimateHours) || 0;
  const done = Number(state?.completedHours) || 0;
  const completed = !!state?.completed;

  if (completed) return 1;

  if (estimate <= 0) return 0;
  return Math.max(0, Math.min(1, done / estimate));
}

export function computeRemainingHours(state) {
  const estimate = Number(state?.estimateHours) || 0;
  const done = Number(state?.completedHours) || 0;

  if (estimate <= 0) return null;
  return Math.max(0, estimate - done);
}

export function formatHours(h) {
  if (h == null) return "—";
  const n = typeof h === "number" ? h : Number(h);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0h";
  if (n < 1) return `${Math.round(n * 60)}m`;

  // show at most 1 decimal
  const v = Math.round(n * 10) / 10;
  return `${v}h`;
}

// ================================
// Global effort UI settings
// ================================

const SETTINGS_KEY = `${NS}:settings`;

export function getEffortSnapMinutes() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return 10;

    const parsed = JSON.parse(raw);
    const v = Number(parsed?.snapMinutes);

    if (!Number.isFinite(v)) return 10;
    return Math.max(1, Math.round(v));
  } catch {
    return 10;
  }
}

export function setEffortSnapMinutes(minutes) {
  const m = Number(minutes);
  const safe = Number.isFinite(m) ? Math.max(1, Math.round(m)) : 10;

  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        snapMinutes: safe,
        updatedAt: Date.now(),
      })
    );
  } catch {
    // ignore
  }

  // Same-tab notification (storage doesn't fire in the same tab)
  try {
    window.dispatchEvent(
      new CustomEvent("bettercanvas:workload:settingsChanged")
    );
  } catch {
    // ignore
  }
}
