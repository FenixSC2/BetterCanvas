// src/lib/workloadEstimates.js

import {
  isDemoMode,
  readLocalJson,
  readSessionJson,
  writeLocalJson,
  writeSessionJson,
} from "./storagePolicy";
import { API_BASE } from "../api/canvasApi";

const NS = "canvassist:workload:v1";
const HOURS_MODE = "hours";
const CHECKLIST_MODE = "checklist";

// In-memory fallback for environments where storage is unavailable.
const _mockStore = new Map();

// Pending debounce timers for backend sync (one per assignment)
const _pendingSync = new Map();

// -----------------------------
// Keys / helpers
// -----------------------------
function makeKey({ courseId, assignmentId }) {
  return `${NS}:${courseId}:${assignmentId}`;
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
// Starter estimates for the demo courses (keyed by assignment offset within a course,
// matching the backend's demo generator) so the planner shows real workload on first load.
const DEMO_COURSE_IDS = new Set([101, 202, 303]);
const DEMO_SEED_HOURS = { 1: 4, 2: 3, 4: 1, 999: 0.5 };

function _demoSeedState(courseId, assignmentId) {
  const cid = Number(courseId);
  if (!DEMO_COURSE_IDS.has(cid)) return null;
  const hours = DEMO_SEED_HOURS[Number(assignmentId) - cid * 1000];
  return hours ? { estimateHours: hours, completedHours: 0, completed: false } : null;
}

function _readState({ courseId, assignmentId }) {
  const key = makeKey({ courseId, assignmentId });
  if (isDemoMode()) {
    const sessionState = readSessionJson(key, null);
    if (sessionState) return sessionState;
    return _mockStore.get(key) ?? _demoSeedState(courseId, assignmentId);
  }
  return readLocalJson(key, null);
}

function _writeState({ courseId, assignmentId }, state) {
  const key = makeKey({ courseId, assignmentId });
  if (isDemoMode()) {
    // Demo mode: browser-session scoped only, never persisted to DB.
    writeSessionJson(key, state);
    _mockStore.set(key, state);
    return;
  }
  writeLocalJson(key, state);
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
      const state = readLocalJson(lsKey, null);
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
      const existing = readLocalJson(key, null);
      const normalizedExisting = normalizeState(existing, getDefaultEffortMode());
      writeLocalJson(key, {
        estimateHours: est.estimate_hours,
        completedHours: est.completed_hours,
        completed: !!est.completed,
        updatedAt: est.updated_at,
        mode: normalizedExisting.mode,
        favorite: normalizedExisting.favorite,
        checklistItems: normalizedExisting.checklistItems,
      });
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
// Reset
// -----------------------------
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
export function computeRemainingHours(state) {
  const estimate = Number(state?.estimateHours) || 0;
  const done = Number(state?.completedHours) || 0;

  if (estimate <= 0) return null;
  return Math.max(0, estimate - done);
}

// ================================
// Global effort UI settings
// (snap minutes stays localStorage-only — it's a device UI preference)
// ================================

const SETTINGS_KEY = `${NS}:settings`;

function readSettings() {
  const parsed = readLocalJson(SETTINGS_KEY, null);
  if (!parsed) {
    return { snapMinutes: 10, defaultMode: HOURS_MODE };
  }

  const snapMinutes = Number(parsed?.snapMinutes);

  return {
    snapMinutes: Number.isFinite(snapMinutes)
      ? Math.max(1, Math.round(snapMinutes))
      : 10,
    defaultMode: sanitizeMode(parsed?.defaultMode),
  };
}

function writeSettings(partial) {
  const current = readSettings();
  writeLocalJson(SETTINGS_KEY, {
    ...current,
    ...partial,
    defaultMode: sanitizeMode(partial?.defaultMode ?? current.defaultMode),
    updatedAt: Date.now(),
  });

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

function normalizeChecklistTextForMatch(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function toChecklistItemText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function createImportedChecklistItem(text) {
  return {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    completed: false,
  };
}

// Import task rows from Todo create/edit into workload checklist state.
// - Always dedupes by normalized text.
// - If a duplicate matches an existing completed item, it is reopened.
export function importChecklistFromTodo(
  { courseId, assignmentId },
  taskItems,
  opts = {},
) {
  const strategy = opts?.strategy === "replace" ? "replace" : "append";
  const incoming = Array.isArray(taskItems) ? taskItems : [];
  const incomingTexts = incoming
    .map((item) => toChecklistItemText(item))
    .filter(Boolean);

  if (incomingTexts.length === 0) return;

  const prev = getEffortState({ courseId, assignmentId });
  const baseItems = strategy === "replace" ? [] : [...(prev.checklistItems || [])];
  const nextItems = baseItems.map((item) => ({ ...item }));
  const firstIndexByText = new Map();

  for (let i = 0; i < nextItems.length; i += 1) {
    const key = normalizeChecklistTextForMatch(nextItems[i]?.text);
    if (!key || firstIndexByText.has(key)) continue;
    firstIndexByText.set(key, i);
  }

  for (const text of incomingTexts) {
    const key = normalizeChecklistTextForMatch(text);
    if (!key) continue;

    const existingIndex = firstIndexByText.get(key);
    if (existingIndex != null) {
      if (nextItems[existingIndex]?.completed) {
        nextItems[existingIndex] = {
          ...nextItems[existingIndex],
          completed: false,
        };
      }
      continue;
    }

    nextItems.push(createImportedChecklistItem(text));
    firstIndexByText.set(key, nextItems.length - 1);
  }

  setChecklistItems({ courseId, assignmentId }, nextItems);
  setEffortMode({ courseId, assignmentId }, CHECKLIST_MODE);
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

// -----------------------------
// Recurring todo helpers
// -----------------------------

function _normalizeRecurringPreviewDueAt(dueAt) {
  return String(dueAt || "").trim().slice(0, 19);
}

export function makeRecurringPreviewAssignmentId(seriesId, dueAt) {
  const safeSeriesId = String(seriesId || "").trim();
  const safeDueAt = _normalizeRecurringPreviewDueAt(dueAt);
  if (!safeSeriesId || !safeDueAt) return "";
  return `preview:${safeSeriesId}:${safeDueAt}`;
}

function _normalizeTodoRecurrence(value) {
  const r = String(value || "none").trim().toLowerCase();
  return ["daily", "weekly", "monthly", "yearly"].includes(r) ? r : "none";
}

function _addDaysLocal(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

function _addMonthsLocal(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function _nextRecurringDate(date, recurrence) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  if (recurrence === "daily") return _addDaysLocal(date, 1);
  if (recurrence === "weekly") return _addDaysLocal(date, 7);
  if (recurrence === "monthly") return _addMonthsLocal(date, 1);
  if (recurrence === "yearly") return _addMonthsLocal(date, 12);
  return null;
}

function _formatOccurrenceDueAt(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/**
 * Returns the most recent occurrence of a recurring todo that falls on today's
 * calendar date or earlier, as a local ISO datetime string. Uses start-of-tomorrow
 * as the cutoff so an occurrence due at e.g. 4:20 AM still counts as today's
 * occurrence even when checked before 4:20 AM.
 */
export function computeCurrentOccurrenceDueAt(todo) {
  const recurrence = _normalizeTodoRecurrence(todo?.recurrence);
  if (recurrence === "none") return null;
  const seed = new Date(todo?.due_at || todo?.anchor_due_at || "");
  if (!Number.isFinite(seed.getTime())) return null;
  const startOfTomorrow = new Date();
  startOfTomorrow.setHours(0, 0, 0, 0);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  let cursor = seed;
  let last = cursor;
  let guard = 0;
  while (cursor.getTime() < startOfTomorrow.getTime() && guard < 2000) {
    last = cursor;
    const next = _nextRecurringDate(cursor, recurrence);
    if (!next) break;
    cursor = next;
    guard++;
  }
  return _formatOccurrenceDueAt(last);
}

export function hasStoredEffortState({ courseId, assignmentId }) {
  return _readState({ courseId, assignmentId }) !== null;
}

export function moveEffortState({ courseId, fromAssignmentId, toAssignmentId }) {
  const fromId = String(fromAssignmentId || "").trim();
  const toId = String(toAssignmentId || "").trim();
  if (!fromId || !toId || fromId === toId) return false;
  const from = _readState({ courseId, assignmentId: fromId });
  if (!from) return false;
  const existing = _readState({ courseId, assignmentId: toId });
  const fromNorm = normalizeState(from);
  const existingNorm = normalizeState(existing);
  const fromHasData =
    fromNorm.estimateHours > 0 || fromNorm.checklistItems.length > 0;
  const existingHasData =
    existingNorm.estimateHours > 0 || existingNorm.checklistItems.length > 0;
  const chosen =
    existingHasData && !fromHasData ? existingNorm : fromNorm;
  _writeState(
    { courseId, assignmentId: toId },
    { ...chosen, updatedAt: Date.now() }
  );
  // "Clear" source by writing null — _readState returns null for stored null,
  // so hasStoredEffortState returns false for this key going forward.
  _writeState({ courseId, assignmentId: fromId }, null);
  emitChanged({ courseId, assignmentId: fromId });
  emitChanged({ courseId, assignmentId: toId });
  return true;
}

export function adoptRecurringPreviewStates(todos, { courseId = "todo" } = {}) {
  const items = Array.isArray(todos) ? todos : [];
  for (const todo of items) {
    if (!todo || todo.completed || !todo.due_at) continue;
    const previewAssignmentId = makeRecurringPreviewAssignmentId(
      todo.series_id || todo.id,
      todo.due_at || todo.anchor_due_at
    );
    if (!previewAssignmentId || previewAssignmentId === String(todo.id)) continue;
    if (!hasStoredEffortState({ courseId, assignmentId: previewAssignmentId })) continue;
    moveEffortState({
      courseId,
      fromAssignmentId: previewAssignmentId,
      toAssignmentId: todo.id,
    });
  }
}

export function handoffRecurringEffortState({
  courseId = "todo",
  completedTodoId,
  generatedTodoId,
}) {
  return moveEffortState({
    courseId,
    fromAssignmentId: completedTodoId,
    toAssignmentId: generatedTodoId,
  });
}

export function seedRecurringPreviewState({
  courseId = "todo",
  sourceAssignmentId,
  previewAssignmentId,
}) {
  const sourceId = String(sourceAssignmentId || "").trim();
  const previewId = String(previewAssignmentId || "").trim();
  if (!sourceId || !previewId || sourceId === previewId) return false;
  if (hasStoredEffortState({ courseId, assignmentId: previewId })) return false;
  const source = getEffortState({ courseId, assignmentId: sourceId });
  const sourceChecklist = normalizeChecklistItems(source?.checklistItems).map(
    (item) => ({ ...item, completed: false })
  );
  const hasEstimate = Number(source?.estimateHours) > 0;
  const hasChecklist = sourceChecklist.length > 0;
  if (!hasEstimate && !hasChecklist) return false;
  const next = {
    ...source,
    completedHours: 0,
    completed: false,
    checklistItems: sourceChecklist,
    updatedAt: Date.now(),
  };
  _writeState({ courseId, assignmentId: previewId }, next);
  emitChanged({ courseId, assignmentId: previewId });
  return true;
}
