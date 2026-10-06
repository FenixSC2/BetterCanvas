// Shared store for "user accepted this graded-but-unsubmitted assignment's grade".
// Originally lived in UpcomingAssignments under "upcoming:acceptedGrades"; kept
// the same localStorage key so existing user state migrates seamlessly when the
// Accept-grade action moved over to the Grades tab.

import { canvasApi } from "../api/canvasApi";

const KEY = "upcoming:acceptedGrades";
const SOURCE_KEY = "upcoming:acceptedGradeSources";

const DEFAULT_SOURCE = "manual_completed";
const VALID_SOURCES = new Set([
  "accepted_grade",
  "manual_completed",
  "manual_ungraded",
]);

function normalizeSource(raw) {
  const source = String(raw || DEFAULT_SOURCE).trim().toLowerCase();
  return VALID_SOURCES.has(source) ? source : DEFAULT_SOURCE;
}

function emitAcceptedChanged(nextSet) {
  window.dispatchEvent(
    new CustomEvent("canvassist:accepted-grades:changed", {
      detail: { keys: [...nextSet] },
    }),
  );
}

export function acceptedGradeKey(courseId, assignmentId) {
  return `${courseId}:${assignmentId}`;
}

export function loadAcceptedGradeKeys() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export function loadAcceptedGradeSources() {
  try {
    const raw = JSON.parse(localStorage.getItem(SOURCE_KEY) || "{}");
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [key, source] of Object.entries(raw)) {
      out[String(key)] = normalizeSource(source);
    }
    return out;
  } catch {
    return {};
  }
}

export function persistAcceptedGradeKeys(set) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    // localStorage may be unavailable in some browser modes; silent fallback.
  }
  emitAcceptedChanged(set);
}

function persistAcceptedGradeSources(sourceByKey) {
  try {
    localStorage.setItem(SOURCE_KEY, JSON.stringify(sourceByKey || {}));
  } catch {
    // localStorage may be unavailable in some browser modes; silent fallback.
  }
}

export function acceptedGradeSourceFor(sourceByKey, courseId, assignmentId) {
  const key = acceptedGradeKey(courseId, assignmentId);
  return normalizeSource(sourceByKey?.[key]);
}

export function markGradeAccepted(set, courseId, assignmentId) {
  const next = new Set(set);
  next.add(acceptedGradeKey(courseId, assignmentId));
  persistAcceptedGradeKeys(next);
  return next;
}

export function markAssignmentCompletedLocal(set, courseId, assignmentId) {
  return markGradeAccepted(set, courseId, assignmentId);
}

export function unmarkAssignmentCompletedLocal(set, courseId, assignmentId) {
  const next = new Set(set);
  next.delete(acceptedGradeKey(courseId, assignmentId));
  persistAcceptedGradeKeys(next);
  return next;
}

function setFromServerRows(rows) {
  const next = new Set();
  const sourceByKey = {};
  for (const row of rows || []) {
    const courseId = Number(row?.course_id);
    const assignmentId = Number(row?.assignment_id);
    if (!Number.isFinite(courseId) || !Number.isFinite(assignmentId)) continue;
    const key = acceptedGradeKey(courseId, assignmentId);
    next.add(key);
    sourceByKey[key] = normalizeSource(row?.status_source);
  }
  persistAcceptedGradeKeys(next);
  persistAcceptedGradeSources(sourceByKey);
  return next;
}

export async function hydrateAcceptedGradeKeysFromServer() {
  const local = loadAcceptedGradeKeys();
  const localSources = loadAcceptedGradeSources();
  const res = await canvasApi.getCompletedAssignments();
  const server = setFromServerRows(res?.flags || []);
  const serverSources = loadAcceptedGradeSources();

  // Merge historical local-only keys into server-backed state.
  const missingOnServer = [...local].filter((key) => !server.has(key));
  if (missingOnServer.length === 0) return server;

  const merged = new Set(server);
  const mergedSources = { ...serverSources };
  for (const key of missingOnServer) {
    merged.add(key);
    mergedSources[key] = normalizeSource(localSources?.[key]);
    const [courseIdRaw, assignmentIdRaw] = String(key).split(":");
    const courseId = Number(courseIdRaw);
    const assignmentId = Number(assignmentIdRaw);
    if (!Number.isFinite(courseId) || !Number.isFinite(assignmentId)) continue;
    try {
      await canvasApi.upsertCompletedAssignment(
        courseId,
        assignmentId,
        mergedSources[key],
      );
    } catch {
      // Keep merged local state even if server sync fails for one key.
    }
  }

  persistAcceptedGradeKeys(merged);
  persistAcceptedGradeSources(mergedSources);
  return merged;
}

export async function markAssignmentCompletedRemote(
  set,
  courseId,
  assignmentId,
  statusSource = "manual_completed",
) {
  const next = markAssignmentCompletedLocal(set, courseId, assignmentId);
  const key = acceptedGradeKey(courseId, assignmentId);
  const sourceByKey = loadAcceptedGradeSources();
  sourceByKey[key] = normalizeSource(statusSource);
  persistAcceptedGradeSources(sourceByKey);
  await canvasApi.upsertCompletedAssignment(
    courseId,
    assignmentId,
    sourceByKey[key],
  );
  return next;
}
