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
  return {
    id: String(raw?.id || ""),
    title: String(raw?.title || ""),
    notes: String(raw?.notes || ""),
    due_at: raw?.due_at ? String(raw.due_at) : null,
    completed: !!raw?.completed,
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

export function loadTodos() {
  const raw = isDemoMode()
    ? readSessionJson(MOCK_STORAGE_KEY, [])
    : readLocalJson(STORAGE_KEY, []);
  return normalizeTodos(raw);
}

export function saveTodos(todos) {
  const normalized = normalizeTodos(todos);
  writeCache(normalized);
  notifyTodosChanged();
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
    return updated;
  }
  const res = await canvasApi.updateTodo(
    todoId,
    {
      id: payload.id,
      title: payload.title,
      notes: payload.notes,
      due_at: payload.due_at,
      completed: payload.completed,
    },
    opts,
  );
  const updated = normalizeTodo(res?.todo || payload);
  const next = loadTodos().map((item) =>
    item.id === updated.id ? updated : item,
  );
  writeCache(next);
  notifyTodosChanged();
  return updated;
}

export async function deleteTodoItem(todoId, opts = {}) {
  if (isDemoMode()) {
    const next = loadTodos().filter((item) => item.id !== todoId);
    writeCache(next);
    notifyTodosChanged();
    return;
  }
  await canvasApi.deleteTodo(todoId, opts);
  const next = loadTodos().filter((item) => item.id !== todoId);
  writeCache(next);
  notifyTodosChanged();
}
