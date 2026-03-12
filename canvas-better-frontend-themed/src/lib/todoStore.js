// src/lib/todoStore.js
// Persistent storage for personal to-do items.
// Items are kept in localStorage under STORAGE_KEY and never synced to the backend.

const STORAGE_KEY = "canvassist:todos";

export function makeTodoId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return `todo_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

/**
 * Load all todo items from localStorage.
 * Returns a validated array of todo objects.
 */
export function loadTodos() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((t) => t && t.id && typeof t.title === "string")
      .map((t) => ({
        id: String(t.id),
        title: String(t.title || ""),
        notes: String(t.notes || ""),
        // due_at is a local datetime string like "2026-03-15T23:59:00" (no Z),
        // so new Date(due_at) treats it as local time — consistent with how
        // user-entered datetime-local values work.
        due_at: t.due_at ? String(t.due_at) : null,
        completed: !!t.completed,
        createdAt: t.createdAt ? String(t.createdAt) : new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

/**
 * Persist todos and notify same-tab listeners.
 */
export function saveTodos(todos) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  } catch {
    // ignore write errors (e.g. private mode quota)
  }
  // Notify same-tab listeners (storage event doesn't fire in the same tab)
  try {
    window.dispatchEvent(new CustomEvent("canvassist:todos:changed"));
  } catch {
    // ignore
  }
}
