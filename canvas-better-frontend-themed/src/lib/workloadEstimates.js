// src/lib/workloadEstimates.js

const NS = "canvassist:workload:v1";
const API_BASE =
  import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:8000" : "https://api.canvassist.com");
const HOURS_MODE = "hours";
const CHECKLIST_MODE = "checklist";

// In-memory store used exclusively in demo/mock mode — nothing is persisted
const _mockStore = new Map();

// Pending debounce timers for backend sync (one per assignment)
const _pendingSync = new Map();

// -----------------------------
// Mode detection
// -----------------------------
function isDemoMode() {
  try {
    return localStorage.getItem("demoMode") === "true";
  } catch {
    return false;
  }
}

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

function sanitizeMode(mode) {
  return mode === CHECKLIST_MODE ? CHECKLIST_MODE : HOURS_MODE;
}

function normalizeChecklistItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => {
      const text = String(item?.text ?? item?.label ?? "").trim();
      if (!text) return null;
      const rawId = item?.id;
      const id =
        typeof rawId === "string" || typeof rawId === "number"
          ? String(rawId)
          : `item-${index}`;
      return {
        id,
        text,
        completed: !!item?.completed,
      };
    })
    .filter(Boolean);
}

function createChecklistItem(text) {
  return {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: String(text || "").trim(),
    completed: false,
  };
}

function normalizeState(parsed, fallbackMode = HOURS_MODE) {
  if (!parsed || typeof parsed !== "object") {
    return {
      estimateHours: 0,
      completedHours: 0,
      completed: false,
      mode: sanitizeMode(fallbackMode),
      favorite: false,
      checklistItems: [],
    };
  }

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

  const checklistItems = normalizeChecklistItems(
    parsed?.checklistItems ?? parsed?.checklist ?? []
  );
  const mode = sanitizeMode(
    parsed?.mode ?? parsed?.trackingMode ?? parsed?.tracking_mode ?? fallbackMode
  );

  let completed = !!parsed?.completed;
  if (mode === CHECKLIST_MODE) {
    completed =
      checklistItems.length > 0 && checklistItems.every((item) => item.completed);
  }

  return {
    estimateHours,
    completedHours,
    completed,
    mode,
    favorite: !!(parsed?.favorite ?? parsed?.pinned ?? parsed?.important),
    checklistItems,
    updatedAt: parsed?.updatedAt ?? parsed?.updated_at,
  };
}

function withLocalOnlyFields(prev, next) {
  return {
    ...next,
    mode: sanitizeMode(next?.mode ?? prev?.mode ?? HOURS_MODE),
    favorite: !!(next?.favorite ?? prev?.favorite),
    checklistItems: normalizeChecklistItems(
      next?.checklistItems ?? prev?.checklistItems ?? []
    ),
  };
}

function emitChanged({ courseId, assignmentId }) {
  // Same-tab update (storage event doesn't fire in the same tab)
  try {
    window.dispatchEvent(
      new CustomEvent("canvassist:workload:changed", {
        detail: { courseId, assignmentId },
      })
    );
  } catch {
    // ignore
  }
}

// -----------------------------
// Unified read/write (handles demo vs real mode)
// -----------------------------
function _readState({ courseId, assignmentId }) {
  const key = makeKey({ courseId, assignmentId });
  if (isDemoMode()) {
    return _mockStore.get(key) ?? null;
  }
  const raw = (() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  })();
  return safeParse(raw);
}

function _writeState({ courseId, assignmentId }, state) {
  const key = makeKey({ courseId, assignmentId });
  if (isDemoMode()) {
    // Demo mode: keep only in memory, never persist or sync
    _mockStore.set(key, state);
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // ignore
  }
  // Skip backend sync for personal to-do items (non-positive-integer courseId).
  // Canvas course IDs are always positive integers; "todo" triggers no network request.
  const cidNum = Number(courseId);
  if (!Number.isFinite(cidNum) || cidNum <= 0) return;

  // Schedule a debounced background sync to the backend
  _scheduleSyncToBackend(courseId, assignmentId);
}

// -----------------------------
// Backend sync — async, non-blocking, debounced
// -----------------------------
function _scheduleSyncToBackend(courseId, assignmentId) {
  const syncKey = `${courseId}:${assignmentId}`;
  clearTimeout(_pendingSync.get(syncKey));
  _pendingSync.set(
    syncKey,
    setTimeout(() => {
      _pendingSync.delete(syncKey);
      // Re-read from localStorage at fire time to get the most current value
      const lsKey = makeKey({ courseId, assignmentId });
      const raw = (() => {
        try {
          return localStorage.getItem(lsKey);
        } catch {
          return null;
        }
      })();
      const state = safeParse(raw);
      if (state) _doSyncToBackend(courseId, assignmentId, state);
    }, 800)
  );
}

async function _doSyncToBackend(courseId, assignmentId, state) {
  try {
    await fetch(
      `${API_BASE}/api/workload-estimates/${encodeURIComponent(courseId)}/${encodeURIComponent(assignmentId)}`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          estimate_hours: state.estimateHours ?? 0,
          completed_hours: state.completedHours ?? 0,
          completed: !!state.completed,
        }),
      }
    );
  } catch {
    // Non-blocking — local state is valid regardless of network availability
  }
}

// -----------------------------
// Backend hydration — overwrites localStorage with authoritative server data
// -----------------------------
export async function hydrateWorkloadFromBackend() {
  if (isDemoMode()) return;
  try {
    const res = await fetch(`${API_BASE}/api/workload-estimates`, {
      credentials: "include",
    });
    if (!res.ok) return; // Not authenticated or other transient error
    const data = await res.json();
    const estimates = Array.isArray(data?.estimates) ? data.estimates : [];
    for (const est of estimates) {
      const key = makeKey({
        courseId: est.course_id,
        assignmentId: est.assignment_id,
      });
      const existing = safeParse(
        (() => {
          try {
            return localStorage.getItem(key);
          } catch {
            return null;
          }
        })()
      );
      const normalizedExisting = normalizeState(existing, getDefaultEffortMode());
      try {
        localStorage.setItem(
          key,
          JSON.stringify({
            estimateHours: est.estimate_hours,
            completedHours: est.completed_hours,
            completed: !!est.completed,
            updatedAt: est.updated_at,
            mode: normalizedExisting.mode,
            favorite: normalizedExisting.favorite,
            checklistItems: normalizedExisting.checklistItems,
          })
        );
      } catch {
        // ignore
      }
    }
    // Notify all WorkloadEstimateControl components to re-render
    window.dispatchEvent(new CustomEvent("canvassist:workload:changed"));
  } catch {
    // Non-blocking
  }
}

// Hydrate from backend whenever the user authenticates (login or page refresh)
if (typeof window !== "undefined") {
  window.addEventListener("auth:changed", () => {
    hydrateWorkloadFromBackend();
  });
}

// -----------------------------
// Read state (with legacy migration)
// -----------------------------
export function getEffortState({ courseId, assignmentId }) {
  const parsed = _readState({ courseId, assignmentId });
  return normalizeState(parsed, getDefaultEffortMode());
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
    mode: prev.mode,
    favorite: prev.favorite,
    checklistItems: prev.checklistItems,
    updatedAt: Date.now(),
  };

  // If user has already "completed", keep it consistent
  if (next.completed && h > 0) {
    next.completedHours = Math.max(next.completedHours, h);
  }

  _writeState({ courseId, assignmentId }, next);
  emitChanged({ courseId, assignmentId });
}

export function clearEstimateHours({ courseId, assignmentId }) {
  const prev = getEffortState({ courseId, assignmentId });

  // Keep completedHours/completed, but remove estimate
  const next = {
    estimateHours: 0,
    completedHours: prev.completedHours,
    completed: prev.completed,
    mode: prev.mode,
    favorite: prev.favorite,
    checklistItems: prev.checklistItems,
    updatedAt: Date.now(),
  };

  _writeState({ courseId, assignmentId }, next);
  emitChanged({ courseId, assignmentId });
}

// -----------------------------
// Completed hours
// -----------------------------
export function setCompletedHours({ courseId, assignmentId }, hours) {
  const h = clampHours(hours);
  if (!Number.isFinite(h)) return;

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
    mode: prev.mode,
    favorite: prev.favorite,
    checklistItems: prev.checklistItems,
    updatedAt: Date.now(),
  };

  _writeState({ courseId, assignmentId }, next);
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
  const prev = getEffortState({ courseId, assignmentId });

  const next = {
    estimateHours: prev.estimateHours,
    completedHours: prev.completedHours,
    completed: !!completed,
    mode: prev.mode,
    favorite: prev.favorite,
    checklistItems: prev.checklistItems,
    updatedAt: Date.now(),
  };

  // If marking complete and estimate exists, snap completedHours to estimate
  if (next.completed && next.estimateHours > 0) {
    next.completedHours = Math.max(next.completedHours, next.estimateHours);
  }

  _writeState({ courseId, assignmentId }, next);
  emitChanged({ courseId, assignmentId });
}

export function resetProgress({ courseId, assignmentId }) {
  const prev = getEffortState({ courseId, assignmentId });

  const next = {
    estimateHours: prev.estimateHours,
    completedHours: 0,
    completed: false,
    mode: prev.mode,
    favorite: prev.favorite,
    checklistItems: prev.checklistItems,
    updatedAt: Date.now(),
  };

  _writeState({ courseId, assignmentId }, next);
  emitChanged({ courseId, assignmentId });
}

// -----------------------------
// Derived helpers (used by UI)
// -----------------------------
export function computeProgress(state) {
  if (state?.mode === CHECKLIST_MODE) {
    const items = normalizeChecklistItems(state?.checklistItems);
    if (items.length === 0) return 0;
    const done = items.filter((item) => item.completed).length;
    return Math.max(0, Math.min(1, done / items.length));
  }

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
// (snap minutes stays localStorage-only — it's a device UI preference)
// ================================

const SETTINGS_KEY = `${NS}:settings`;

function readSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return { snapMinutes: 10, defaultMode: HOURS_MODE };
    }

    const parsed = JSON.parse(raw);
    const snapMinutes = Number(parsed?.snapMinutes);

    return {
      snapMinutes: Number.isFinite(snapMinutes)
        ? Math.max(1, Math.round(snapMinutes))
        : 10,
      defaultMode: sanitizeMode(parsed?.defaultMode),
    };
  } catch {
    return { snapMinutes: 10, defaultMode: HOURS_MODE };
  }
}

function writeSettings(partial) {
  const current = readSettings();
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        ...current,
        ...partial,
        defaultMode: sanitizeMode(partial?.defaultMode ?? current.defaultMode),
        updatedAt: Date.now(),
      })
    );
  } catch {
    // ignore
  }

  try {
    window.dispatchEvent(
      new CustomEvent("canvassist:workload:settingsChanged")
    );
  } catch {
    // ignore
  }
}

export function getEffortSnapMinutes() {
  return readSettings().snapMinutes;
}

export function setEffortSnapMinutes(minutes) {
  const m = Number(minutes);
  const safe = Number.isFinite(m) ? Math.max(1, Math.round(m)) : 10;

  writeSettings({ snapMinutes: safe });
}

export function getDefaultEffortMode() {
  return readSettings().defaultMode;
}

export function setDefaultEffortMode(mode) {
  writeSettings({ defaultMode: sanitizeMode(mode) });
}

export function isAssignmentFavorited({ courseId, assignmentId }) {
  return !!getEffortState({ courseId, assignmentId }).favorite;
}

export function setAssignmentFavorite({ courseId, assignmentId }, favorite) {
  const prev = getEffortState({ courseId, assignmentId });
  const next = withLocalOnlyFields(prev, {
    ...prev,
    favorite: !!favorite,
    updatedAt: Date.now(),
  });
  _writeState({ courseId, assignmentId }, next);
  emitChanged({ courseId, assignmentId });
}

export function setEffortMode({ courseId, assignmentId }, mode) {
  const prev = getEffortState({ courseId, assignmentId });
  const next = withLocalOnlyFields(prev, {
    ...prev,
    mode: sanitizeMode(mode),
    updatedAt: Date.now(),
  });
  _writeState({ courseId, assignmentId }, next);
  emitChanged({ courseId, assignmentId });
}

export function setChecklistItems({ courseId, assignmentId }, checklistItems) {
  const prev = getEffortState({ courseId, assignmentId });
  const nextItems = normalizeChecklistItems(checklistItems);
  const next = withLocalOnlyFields(prev, {
    ...prev,
    checklistItems: nextItems,
    completed:
      nextItems.length > 0 && nextItems.every((item) => item.completed),
    updatedAt: Date.now(),
  });
  _writeState({ courseId, assignmentId }, next);
  emitChanged({ courseId, assignmentId });
}

export function addChecklistItem({ courseId, assignmentId }, text) {
  const item = createChecklistItem(text);
  if (!item.text) return;
  const prev = getEffortState({ courseId, assignmentId });
  setChecklistItems(
    { courseId, assignmentId },
    [...prev.checklistItems, item]
  );
}

export function updateChecklistItemText(
  { courseId, assignmentId },
  itemId,
  text
) {
  const prev = getEffortState({ courseId, assignmentId });
  const nextItems = prev.checklistItems.map((item) =>
    item.id === itemId ? { ...item, text: String(text || "").trim() } : item
  );
  setChecklistItems({ courseId, assignmentId }, nextItems);
}

export function toggleChecklistItem(
  { courseId, assignmentId },
  itemId,
  completed
) {
  const prev = getEffortState({ courseId, assignmentId });
  const nextItems = prev.checklistItems.map((item) =>
    item.id === itemId ? { ...item, completed: !!completed } : item
  );
  setChecklistItems({ courseId, assignmentId }, nextItems);
}

export function removeChecklistItem({ courseId, assignmentId }, itemId) {
  const prev = getEffortState({ courseId, assignmentId });
  const nextItems = prev.checklistItems.filter((item) => item.id !== itemId);
  setChecklistItems({ courseId, assignmentId }, nextItems);
}
