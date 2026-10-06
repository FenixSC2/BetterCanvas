// src/lib/todoStore.js
// Server-backed storage for personal to-do items with a local cache for fast reads.

import { canvasApi } from "../api/canvasApi";
import {
  getMockTodosKey,
  isDemoMode,
  readLocalJson,
  readSessionJson,
  writeLocalJson,
  writeSessionJson,
} from "./storagePolicy";

const STORAGE_KEY = "canvassist:todos";
const CHANGE_EVENT = "canvassist:todos:changed";
const MOCK_STORAGE_KEY = getMockTodosKey();

export function makeTodoId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return `todo_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function normalizeTodo(raw) {
  const recurrence = String(raw?.recurrence || "none").trim().toLowerCase();
  const workloadResetMode = String(raw?.workload_reset_mode || "none")
    .trim()
    .toLowerCase();
  return {
    id: String(raw?.id || ""),
    title: String(raw?.title || ""),
    notes: String(raw?.notes || ""),
    due_at: raw?.due_at ? String(raw.due_at) : null,
    completed: !!raw?.completed,
    recurrence:
      recurrence === "daily" ||
      recurrence === "weekly" ||
      recurrence === "monthly" ||
      recurrence === "yearly"
        ? recurrence
        : "none",
    series_id: raw?.series_id ? String(raw.series_id) : null,
    occurrence_index: Number.isFinite(Number(raw?.occurrence_index))
      ? Math.max(0, Number(raw.occurrence_index))
      : 0,
    anchor_due_at: raw?.anchor_due_at ? String(raw.anchor_due_at) : null,
    workload_reset_mode:
      workloadResetMode === "progress" ||
      workloadResetMode === "checklist" ||
      workloadResetMode === "both"
        ? workloadResetMode
        : "none",
    source: raw?.source ? String(raw.source) : null,
    createdAt: raw?.createdAt ? String(raw.createdAt) : new Date().toISOString(),
    updatedAt: raw?.updatedAt ? String(raw.updatedAt) : null,
  };
}

function normalizeTodos(rawTodos) {
  if (!Array.isArray(rawTodos)) return [];
  return rawTodos
    .filter((todo) => todo && todo.id && typeof todo.title === "string")
    .map(normalizeTodo);
}

function notifyTodosChanged() {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    // ignore
  }
}

function writeCache(todos) {
  if (isDemoMode()) {
    writeSessionJson(MOCK_STORAGE_KEY, todos);
    return;
  }
  writeLocalJson(STORAGE_KEY, todos);
}

// A few starter to-dos so the demo shows personal items alongside Canvas work.
function buildDemoTodos() {
  const at = (days, hour) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const inHours = (hours) => {
    const d = new Date(Date.now() + hours * 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    return d.toISOString();
  };
  return [
    { id: "demo-todo-1", title: "Email TA about Problem Set 2 regrade", due_at: inHours(4) },
    { id: "demo-todo-2", title: "Review lecture notes for Quiz 2", due_at: at(2, 20), recurrence: "weekly" },
    { id: "demo-todo-3", title: "Book a Writing Center appointment", due_at: at(4, 12) },
    { id: "demo-todo-4", title: "Register for spring courses", due_at: null },
  ].map((todo) => ({ ...todo, notes: "", completed: false, createdAt: new Date().toISOString() }));
}

export function loadTodos() {
  if (isDemoMode()) {
    let raw = readSessionJson(MOCK_STORAGE_KEY, null);
    if (raw === null) {
      raw = buildDemoTodos();
      writeSessionJson(MOCK_STORAGE_KEY, raw);
    }
    return normalizeTodos(raw);
  }
  return normalizeTodos(readLocalJson(STORAGE_KEY, []));
}

async function fetchServerTodos(opts = {}) {
  const res = await canvasApi.getTodos(opts);
  return normalizeTodos(res?.todos);
}

async function migrateLocalTodos(localTodos, serverTodos, opts = {}) {
  const serverIds = new Set(serverTodos.map((todo) => String(todo.id)));
  const localOnly = localTodos.filter((todo) => !serverIds.has(String(todo.id)));
  if (localOnly.length === 0) return serverTodos;

  await Promise.allSettled(
    localOnly.map((todo) =>
      canvasApi.createTodo(
        {
          id: todo.id,
          title: todo.title,
          notes: todo.notes,
          due_at: todo.due_at,
          completed: todo.completed,
          recurrence: todo.recurrence,
          series_id: todo.series_id,
          occurrence_index: todo.occurrence_index,
          anchor_due_at: todo.anchor_due_at,
          workload_reset_mode: todo.workload_reset_mode,
        },
        opts,
      ),
    ),
  );

  return fetchServerTodos(opts);
}

export async function syncTodos(opts = {}) {
  const localTodos = loadTodos();
  if (isDemoMode()) {
    // Explicitly avoid backend sync in mock mode.
    writeCache(localTodos);
    notifyTodosChanged();
    return localTodos;
  }
  try {
    let serverTodos = await fetchServerTodos(opts);
    serverTodos = await migrateLocalTodos(localTodos, serverTodos, opts);
    writeCache(serverTodos);
    notifyTodosChanged();
    return serverTodos;
  } catch {
    return localTodos;
  }
}

export async function createTodoItem(todo, opts = {}) {
  const payload = normalizeTodo(todo);
  if (isDemoMode()) {
    const created = normalizeTodo(payload);
    const next = [...loadTodos().filter((item) => item.id !== created.id), created];
    writeCache(next);
    notifyTodosChanged();
    return created;
  }
  const res = await canvasApi.createTodo(
    {
      id: payload.id,
      title: payload.title,
      notes: payload.notes,
      due_at: payload.due_at,
      completed: payload.completed,
      recurrence: payload.recurrence,
      series_id: payload.series_id,
      occurrence_index: payload.occurrence_index,
      anchor_due_at: payload.anchor_due_at,
      workload_reset_mode: payload.workload_reset_mode,
      source: payload.source,
    },
    opts,
  );
  const created = normalizeTodo(res?.todo || payload);
  const next = [...loadTodos().filter((item) => item.id !== created.id), created];
  writeCache(next);
  notifyTodosChanged();
  return created;
}

export async function updateTodoItem(todoId, todo, opts = {}) {
  const payload = normalizeTodo({ ...todo, id: todoId });
  if (isDemoMode()) {
    const updated = normalizeTodo(payload);
    const next = loadTodos().map((item) =>
      item.id === updated.id ? updated : item,
    );
    writeCache(next);
    notifyTodosChanged();
    return { updatedTodo: updated, generatedTodo: null };
  }
  const res = await canvasApi.updateTodo(
    todoId,
    {
      id: payload.id,
      title: payload.title,
      notes: payload.notes,
      due_at: payload.due_at,
      completed: payload.completed,
      recurrence: payload.recurrence,
      series_id: payload.series_id,
      occurrence_index: payload.occurrence_index,
      anchor_due_at: payload.anchor_due_at,
      workload_reset_mode: payload.workload_reset_mode,
      edit_scope:
        todo?.edit_scope === "this-and-future"
          ? "this-and-future"
          : "this-occurrence",
    },
    opts,
  );
  const updated = normalizeTodo(res?.todo || payload);
  const maybeGenerated = res?.generated_todo ? normalizeTodo(res.generated_todo) : null;
  const next = loadTodos()
    .map((item) => (item.id === updated.id ? updated : item))
    .filter((item) => (maybeGenerated ? item.id !== maybeGenerated.id : true));
  if (maybeGenerated) next.push(maybeGenerated);
  writeCache(next);
  notifyTodosChanged();
  return { updatedTodo: updated, generatedTodo: maybeGenerated };
}

export async function deleteTodoItem(todoId, opts = {}) {
  const deleteScope =
    opts?.delete_scope === "this-and-future"
      ? "this-and-future"
      : "this-occurrence";
  if (isDemoMode()) {
    const current = loadTodos();
    const target = current.find((item) => item.id === todoId);
    const deletedIds =
      deleteScope === "this-and-future" && target?.series_id
        ? current
            .filter(
              (item) =>
                item.series_id === target.series_id &&
                item.occurrence_index >= target.occurrence_index,
            )
            .map((item) => item.id)
        : [todoId];
    const deletedIdSet = new Set(deletedIds.map((id) => String(id)));
    const next = current.filter((item) => !deletedIdSet.has(String(item.id)));
    writeCache(next);
    notifyTodosChanged();
    return deletedIds;
  }
  const res = await canvasApi.deleteTodo(todoId, deleteScope, opts);
  const deletedIds = Array.isArray(res?.deleted_ids)
    ? res.deleted_ids.map((id) => String(id))
    : [String(todoId)];
  const deletedIdSet = new Set(deletedIds);
  const next = loadTodos().filter((item) => !deletedIdSet.has(String(item.id)));
  writeCache(next);
  notifyTodosChanged();
  return deletedIds;
}
