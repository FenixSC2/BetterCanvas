// src/pages/TodoPage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { WorkloadEstimateControl } from "../components/WorkloadEstimateControl";
import {
  createTodoItem,
  deleteTodoItem,
  loadTodos,
  makeTodoId,
  syncTodos,
  updateTodoItem,
} from "../lib/todoStore";
import {
  adoptRecurringPreviewStates,
  computeCurrentOccurrenceDueAt,
  handoffRecurringEffortState,
  hasStoredEffortState,
  importChecklistFromTodo,
  isAssignmentFavorited,
  makeRecurringPreviewAssignmentId,
  moveEffortState,
} from "../lib/workloadEstimates";

// WorkloadEstimateControl uses courseId/assignmentId to namespace localStorage keys.
// We use the special courseId "todo" to keep personal items isolated from Canvas data.
// Backend sync is skipped for non-numeric courseIds (see workloadEstimates.js).
const TODO_COURSE_ID = "todo";

/* ---------- helpers ---------- */

function fmtDue(due_at) {
  if (!due_at) return "No due date";
  const d = new Date(due_at);
  if (!Number.isFinite(d.getTime())) return "Invalid date";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function hoursUntil(due_at) {
  if (!due_at) return null;
  const t = new Date(due_at).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / (1000 * 60 * 60);
}

function getUrgencyVariant(todo) {
  if (todo.completed) return "success";
  if (!todo.due_at) return "neutral";
  const h = hoursUntil(todo.due_at);
  if (h == null) return "neutral";
  if (h < 0) return "danger";
  if (h <= 12) return "warning";
  return "neutral";
}

function getUrgencyLabel(todo) {
  if (todo.completed) return "Completed";
  if (!todo.due_at) return "Undated";
  const h = hoursUntil(todo.due_at);
  if (h == null) return "Undated";
  if (h < 0) return "Overdue";
  if (h <= 12) return "Due soon";
  return "Scheduled";
}

// Convert a datetime-local input value (YYYY-MM-DDTHH:MM) to storage format
// (YYYY-MM-DDTHH:MM:00 — no Z, so new Date() treats it as local time)
function inputToStorageDatetime(v) {
  if (!v) return null;
  // Add seconds if missing
  return v.length === 16 ? `${v}:00` : v;
}

// Convert storage format back to datetime-local input value
function storageDatetimeToInput(v) {
  if (!v) return "";
  // datetime-local input expects YYYY-MM-DDTHH:MM
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseTodoTarget(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    const todoId = String(obj?.todoId || "").trim();
    if (!todoId) return null;
    return {
      todoId,
      ts: Number.isFinite(Number(obj?.ts)) ? Number(obj.ts) : 0,
    };
  } catch {
    return null;
  }
}

function FavoriteMarker() {
  return (
    <span className="favoriteMarker" title="Favorited" aria-label="Favorited">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path d="m12 3.5 2.78 5.63 6.22.9-4.5 4.38 1.06 6.19L12 17.68 6.44 20.6l1.06-6.19L3 10.03l6.22-.9L12 3.5Z" />
      </svg>
    </span>
  );
}

function sanitizeTaskRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const text = String(row || "").trim();
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function normalizeRecurrence(value) {
  const raw = String(value || "none").trim().toLowerCase();
  return ["daily", "weekly", "monthly", "yearly"].includes(raw)
    ? raw
    : "none";
}

function recurrenceLabel(value) {
  const recurrence = normalizeRecurrence(value);
  if (recurrence === "daily") return "Repeats daily";
  if (recurrence === "weekly") return "Repeats weekly";
  if (recurrence === "monthly") return "Repeats monthly";
  if (recurrence === "yearly") return "Repeats yearly";
  return "No repeat";
}

function normalizeWorkloadResetMode(value) {
  const raw = String(value || "none").trim().toLowerCase();
  return ["progress", "checklist", "both"].includes(raw) ? raw : "none";
}

/* ---------- TodoItemForm ---------- */
// Renders a create or edit form inline in a card body.
// onSubmit({ title, notes, due_at })
// onCancel()

function TodoItemForm({
  initial = {},
  onSubmit,
  onCancel,
  submitLabel = "Save",
  showImportStrategy = false,
  showEditScope = false,
}) {
  const [title, setTitle] = useState(initial.title ?? "");
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [dueInput, setDueInput] = useState(() =>
    storageDatetimeToInput(initial.due_at ?? "")
  );
  const [recurrence, setRecurrence] = useState(() =>
    normalizeRecurrence(initial.recurrence),
  );
  const [taskRows, setTaskRows] = useState(() => {
    const incoming = sanitizeTaskRows(initial.task_items || []);
    return incoming.length ? incoming : [""];
  });
  const [appendToChecklist, setAppendToChecklist] = useState(
    initial.import_strategy !== "replace",
  );
  const [workloadResetMode, setWorkloadResetMode] = useState(() =>
    normalizeWorkloadResetMode(initial.workload_reset_mode),
  );
  const [editScope, setEditScope] = useState(
    initial.edit_scope === "this-and-future"
      ? "this-and-future"
      : "this-occurrence",
  );
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  const taskInputRefs = useRef([]);
  const pendingTaskFocusIndexRef = useRef(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    const nextFocusIndex = pendingTaskFocusIndexRef.current;
    if (!Number.isInteger(nextFocusIndex)) return;
    const nextInput = taskInputRefs.current[nextFocusIndex];
    if (!nextInput) return;
    nextInput.focus();
    nextInput.select();
    pendingTaskFocusIndexRef.current = null;
  }, [taskRows]);

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setErr("Title is required.");
      return;
    }
    if (recurrence !== "none" && !dueInput) {
      setErr("Recurring to-dos require a due date and time.");
      return;
    }
    setErr("");
    const dueAt = inputToStorageDatetime(dueInput);
    onSubmit({
      title: trimmed,
      notes: notes.trim(),
      due_at: dueAt,
      recurrence,
      series_id: String(initial.series_id || initial.id || "").trim() || null,
      occurrence_index: Number(initial.occurrence_index || 0) || 0,
      anchor_due_at: String(initial.anchor_due_at || "").trim() || dueAt,
      workload_reset_mode: workloadResetMode,
      edit_scope: editScope,
      task_items: sanitizeTaskRows(taskRows),
      import_strategy: appendToChecklist ? "append" : "replace",
    });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <label style={{ fontWeight: 700, fontSize: "var(--fontSm)" }}>
          Title <span style={{ color: "var(--badge-danger-text)" }}>*</span>
        </label>
        <input
          ref={titleRef}
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (err) setErr("");
          }}
          placeholder="E.g. Study for exam"
          style={{ width: "100%" }}
        />
        {err ? (
          <div className="dangerText" style={{ fontSize: "var(--fontSm)" }}>
            {err}
          </div>
        ) : null}
      </div>

      <div style={{ display: "grid", gap: 4 }}>
        <label style={{ fontWeight: 700, fontSize: "var(--fontSm)" }}>
          Due date &amp; time{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            (optional)
          </span>
        </label>
        <input
          type="datetime-local"
          value={dueInput}
          onChange={(e) => {
            setDueInput(e.target.value);
            if (err) setErr("");
          }}
          style={{ width: "auto", maxWidth: 260 }}
        />
      </div>

      <div style={{ display: "grid", gap: 4 }}>
        <label style={{ fontWeight: 700, fontSize: "var(--fontSm)" }}>
          Repeat
        </label>
        <select
          value={recurrence}
          onChange={(e) => {
            setRecurrence(normalizeRecurrence(e.target.value));
            if (err) setErr("");
          }}
          className="select"
          style={{ width: "auto", maxWidth: 260 }}
        >
          <option value="none">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
      </div>

      {showEditScope && recurrence !== "none" ? (
        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontWeight: 700, fontSize: "var(--fontSm)" }}>
            Apply edits to
          </label>
          <select
            value={editScope}
            onChange={(e) => setEditScope(e.target.value)}
            className="select"
            style={{ width: "auto", maxWidth: 260 }}
          >
            <option value="this-occurrence">This occurrence only</option>
            <option value="this-and-future">This and future occurrences</option>
          </select>
        </div>
      ) : null}

      {recurrence !== "none" ? (
        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontWeight: 700, fontSize: "var(--fontSm)" }}>
            On each repeat, reset workload
          </label>
          <select
            value={workloadResetMode}
            onChange={(e) => setWorkloadResetMode(normalizeWorkloadResetMode(e.target.value))}
            className="select"
            style={{ width: "auto", maxWidth: 320 }}
          >
            <option value="none">Do not reset workload</option>
            <option value="progress">Reset progress only</option>
            <option value="checklist">Uncheck checklist items only</option>
            <option value="both">Reset progress and uncheck checklist items</option>
          </select>
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 4 }}>
        <label style={{ fontWeight: 700, fontSize: "var(--fontSm)" }}>
          Notes{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            (optional)
          </span>
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add any notes or details…"
          rows={3}
          style={{ width: "100%", resize: "vertical" }}
        />
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <label style={{ fontWeight: 700, fontSize: "var(--fontSm)" }}>
          Task list items{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            (optional)
          </span>
        </label>

        <div className="muted" style={{ fontSize: "var(--fontSm)" }}>
          Any tasks entered here will be added to Workload checklist mode.
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          {taskRows.map((row, idx) => (
            <div
              key={`task-row-${idx}`}
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <input
                ref={(node) => {
                  taskInputRefs.current[idx] = node;
                }}
                type="text"
                value={row}
                onChange={(e) => {
                  const next = [...taskRows];
                  next[idx] = e.target.value;
                  setTaskRows(next);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  pendingTaskFocusIndexRef.current = idx + 1;
                  setTaskRows((prev) => {
                    const next = [...prev];
                    next.splice(idx + 1, 0, "");
                    return next;
                  });
                }}
                placeholder={`Task ${idx + 1}`}
                style={{ width: "100%" }}
              />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (taskRows.length === 1) {
                    setTaskRows([""]);
                    return;
                  }
                  setTaskRows(taskRows.filter((_, i) => i !== idx));
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <div>
          <button
            type="button"
            className="btn"
            onClick={() => setTaskRows((prev) => [...prev, ""])}
          >
            + Add task item
          </button>
        </div>

        {showImportStrategy ? (
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginTop: 4,
            }}
          >
            <input
              type="checkbox"
              className="themeCheckbox"
              checked={appendToChecklist}
              onChange={(e) => setAppendToChecklist(e.target.checked)}
            />
            <span className="muted" style={{ fontSize: "var(--fontSm)" }}>
              Keep existing tasks and add new ones
            </span>
          </label>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="submit" className="btn">
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ---------- TodoCard ---------- */

function TodoCard({ todo, onToggleComplete, onEdit, onDelete, onCreate, isFocused = false }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [repeating, setRepeating] = useState(false);
  const [repeatDueAt, setRepeatDueAt] = useState("");
  const isFavorited = isAssignmentFavorited({
    courseId: TODO_COURSE_ID,
    assignmentId: todo.id,
  });

  const effortAssignmentId = todo.id;

  // For recurring todos, display the current occurrence date rather than the
  // original DB anchor date (e.g. show Mar 24 not Mar 18 for a daily repeat).
  const isRecurring = normalizeRecurrence(todo.recurrence) !== "none";
  const effectiveDueAt = (isRecurring && computeCurrentOccurrenceDueAt(todo)) || todo.due_at;

  const urgencyVariant = getUrgencyVariant({ ...todo, due_at: effectiveDueAt });
  const urgencyLabel = getUrgencyLabel({ ...todo, due_at: effectiveDueAt });

  const badgeClass =
    urgencyVariant === "danger"
      ? "badgeDanger"
      : urgencyVariant === "warning"
      ? "badgeWarn"
      : urgencyVariant === "success"
      ? "badgeSuccess"
      : "badgeNeutral";

  const hasNotes = !!todo.notes.trim();
  const notesPreview = hasNotes
    ? todo.notes.replace(/\s+/g, " ").trim()
    : "";
  if (editing) {
    return (
      <div className="card">
        <div className="cardBody" style={{ height: "auto" }}>
          <div
            style={{
              fontWeight: 800,
              marginBottom: 12,
              fontSize: "var(--fontSm)",
              color: "var(--muted)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Edit item
          </div>
          <TodoItemForm
            initial={todo}
            onSubmit={(draft) => {
              onEdit(todo.id, draft);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
            submitLabel="Save changes"
            showImportStrategy={true}
            showEditScope={true}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      id={`todo-card-${todo.id}`}
      className="card"
      style={{
        opacity: todo.completed ? 0.65 : 1,
        transition: "opacity 150ms ease, box-shadow 200ms ease, border-color 200ms ease",
        borderColor: isFocused ? "color-mix(in srgb, var(--accent), var(--border) 45%)" : undefined,
        boxShadow: isFocused ? "0 0 0 2px color-mix(in srgb, var(--accent), transparent 70%)" : undefined,
      }}
    >
      <div className="cardBody" style={{ height: "auto" }}>
        {/* Title row */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
          }}
        >
          {/* Checkbox */}
          <input
            type="checkbox"
            className="themeCheckbox"
            checked={todo.completed}
            onChange={() => onToggleComplete(todo.id)}
            style={{ marginTop: 2, flexShrink: 0 }}
            aria-label={todo.completed ? "Mark incomplete" : "Mark complete"}
          />

          {/* Title + meta */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 800,
                wordBreak: "break-word",
                lineHeight: 1.3,
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              {isFavorited ? <FavoriteMarker /> : null}
              <span style={{ textDecoration: todo.completed ? "line-through" : "none" }}>
                {todo.title}
              </span>
              <span className={`badge ${badgeClass}`}>{urgencyLabel}</span>
              {todo?.recurrence && todo.recurrence !== "none" ? (
                <span className="badge badgeNeutral">
                  {recurrenceLabel(todo.recurrence)}
                </span>
              ) : null}
              <span className="muted" style={{ fontSize: "var(--fontSm)" }}>
                {fmtDue(effectiveDueAt)}
              </span>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {todo.completed ? (
              <button
                type="button"
                className="btn"
                onClick={() => { setRepeating((v) => !v); setRepeatDueAt(""); }}
                style={{ fontSize: "var(--fontSm)", padding: "4px 10px" }}
              >
                Repeat
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() => setEditing(true)}
              style={{ fontSize: "var(--fontSm)", padding: "4px 10px" }}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btnDanger"
              onClick={() => onDelete(todo)}
              style={{ fontSize: "var(--fontSm)", padding: "4px 10px" }}
            >
              Delete
            </button>
          </div>
        </div>

        {/* Repeat inline UI */}
        {repeating ? (
          <div
            style={{
              marginTop: 10,
              paddingLeft: 26,
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span className="muted" style={{ fontSize: "var(--fontSm)", fontWeight: 700 }}>
              New due date:
            </span>
            <input
              type="datetime-local"
              value={repeatDueAt}
              onChange={(e) => setRepeatDueAt(e.target.value)}
              style={{ fontSize: "var(--fontSm)" }}
            />
            <button
              type="button"
              className="btn"
              style={{ fontSize: "var(--fontSm)", padding: "4px 10px" }}
              onClick={async () => {
                const dueAt = repeatDueAt
                  ? (repeatDueAt.length === 16 ? `${repeatDueAt}:00` : repeatDueAt)
                  : null;
                await onCreate({
                  id: makeTodoId(),
                  title: todo.title,
                  notes: todo.notes || "",
                  due_at: dueAt,
                  completed: false,
                  recurrence: "none",
                  series_id: null,
                  occurrence_index: 0,
                  anchor_due_at: dueAt,
                  workload_reset_mode: todo.workload_reset_mode || "none",
                  task_items: [],
                  import_strategy: "replace",
                });
                setRepeating(false);
              }}
            >
              Confirm
            </button>
            <button
              type="button"
              className="btn"
              style={{ fontSize: "var(--fontSm)", padding: "4px 10px" }}
              onClick={() => setRepeating(false)}
            >
              Cancel
            </button>
          </div>
        ) : null}

        {/* Notes (collapsible) */}
        {hasNotes ? (
          <div style={{ marginTop: 10, paddingLeft: 26 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                maxWidth: "100%",
              }}
            >
              <button
                type="button"
                className="muted"
                onClick={() => setExpanded((v) => !v)}
                style={{
                  background: "var(--surface2)",
                  border: "1px solid var(--border2)",
                  borderRadius: "var(--radiusSm)",
                  cursor: "pointer",
                  padding: "2px 8px",
                  fontWeight: 700,
                  fontSize: "var(--fontSm)",
                  textDecoration: "underline",
                  textDecorationStyle: "dotted",
                  flexShrink: 0,
                }}
              >
                {expanded ? "Hide notes" : "Show notes"}
              </button>
              {!expanded ? (
                <>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 1,
                      height: 14,
                      background: "var(--border2)",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    className="muted"
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "var(--fontSm)",
                    }}
                  >
                    <strong style={{ color: "var(--text)" }}>Preview:</strong>{" "}
                    {notesPreview}
                  </span>
                </>
              ) : null}
            </div>
            {expanded ? (
              <div
                style={{
                  marginTop: 6,
                  fontSize: "var(--fontSm)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  lineHeight: 1.5,
                }}
              >
                {todo.notes}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Workload estimate */}
        <div style={{ marginTop: 14, paddingLeft: 26 }}>
          <WorkloadEstimateControl
            courseId={TODO_COURSE_ID}
            assignmentId={effortAssignmentId}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------- Section heading ---------- */

function SectionHeading({ label, count }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        paddingBottom: 4,
        borderBottom: "1px solid var(--border)",
        marginBottom: 4,
      }}
    >
      <div className="h3" style={{ margin: 0 }}>
        {label}
      </div>
      {count != null ? (
        <span className="pill">{count}</span>
      ) : null}
    </div>
  );
}

function DeleteRecurringTodoModal({ todo, onClose, onConfirm }) {
  if (!todo) return null;

  return (
    <div className="modalOverlay" onMouseDown={onClose} role="presentation">
      <div
        className="modalPanel"
        role="dialog"
        aria-modal="true"
        aria-label="Delete recurring to-do"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: "min(440px, 95vw)", height: "auto", minHeight: "unset" }}
      >
        <div className="modalHeader">
          <div>
            <div className="h2">Delete recurring to-do</div>
            <div className="muted">
              Choose how much of this recurring series to remove.
            </div>
          </div>

          <button
            type="button"
            className="iconBtn"
            onClick={onClose}
            aria-label="Close delete dialog"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M18 6 6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M6 6l12 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Todo summary */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "10px 12px",
              background: "var(--surface2)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }}
            >
              <path
                d="M17 2v4M7 2v4M3 10h18M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M7 14h.01M12 14h.01M17 14h.01M7 18h.01M12 18h.01"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <div>
              <div style={{ fontWeight: 700, lineHeight: 1.3 }}>{todo.title}</div>
              <div className="muted" style={{ marginTop: 3, fontSize: "var(--fontSm)" }}>
                {recurrenceLabel(todo.recurrence)}{todo.due_at ? ` • ${fmtDue(todo.due_at)}` : ""}
              </div>
            </div>
          </div>

          {/* Delete options */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              type="button"
              className="btn btnDanger"
              onClick={() => onConfirm("this-occurrence")}
              style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "10px 14px" }}
            >
              <span style={{ fontWeight: 700 }}>Delete this occurrence only</span>
              <span style={{ fontWeight: 400, fontSize: "var(--fontSm)", opacity: 0.8 }}>
                Only removes this date's entry; future ones remain.
              </span>
            </button>
            <button
              type="button"
              className="btn btnDanger"
              onClick={() => onConfirm("this-and-future")}
              style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "10px 14px" }}
            >
              <span style={{ fontWeight: 700 }}>Delete this and future occurrences</span>
              <span style={{ fontWeight: 400, fontSize: "var(--fontSm)", opacity: 0.8 }}>
                Removes this entry and all upcoming ones in the series.
              </span>
            </button>
          </div>

          {/* Cancel */}
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--muted)",
              fontSize: "var(--fontSm)",
              padding: "4px 0",
              textAlign: "center",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- TodoPage ---------- */

export function TodoPage() {
  const [todos, setTodos] = useState(() => loadTodos());
  const [showNewForm, setShowNewForm] = useState(false);
  const [focusedTodoId, setFocusedTodoId] = useState("");
  const [pendingDeleteTodo, setPendingDeleteTodo] = useState(null);
  const [workloadTick, setWorkloadTick] = useState(0);
  const [completedExpanded, setCompletedExpanded] = useState(false);

  // Keep in sync when another tab or the planner writes to the store
  useEffect(() => {
    let active = true;

    syncTodos().then((serverTodos) => {
      adoptRecurringPreviewStates(serverTodos, { courseId: TODO_COURSE_ID });
      if (active) setTodos(serverTodos);
    });

    function onTodosChanged() {
      const nextTodos = loadTodos();
      adoptRecurringPreviewStates(nextTodos, { courseId: TODO_COURSE_ID });
      setTodos(nextTodos);
    }
    function onStorage(e) {
      if (e.key === "canvassist:todos") onTodosChanged();
    }
    window.addEventListener("canvassist:todos:changed", onTodosChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      active = false;
      window.removeEventListener("canvassist:todos:changed", onTodosChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    function onStorage(e) {
      if (!e?.key) return;
      const lk = String(e.key).toLowerCase();
      if (lk.includes("workload") || lk.includes("effort")) {
        setWorkloadTick((t) => t + 1);
      }
    }

    function onWorkloadChanged() {
      setWorkloadTick((t) => t + 1);
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("canvassist:workload:changed", onWorkloadChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(
        "canvassist:workload:changed",
        onWorkloadChanged,
      );
    };
  }, []);

  useEffect(() => {
    const target = parseTodoTarget(localStorage.getItem("nav:todo:target"));
    if (!target?.todoId) return;
    const isFresh = Date.now() - (target.ts || 0) < 10 * 60 * 1000;
    if (!isFresh) {
      localStorage.removeItem("nav:todo:target");
      return;
    }
    setFocusedTodoId(target.todoId);
    localStorage.removeItem("nav:todo:target");
  }, []);

  useEffect(() => {
    if (!focusedTodoId) return;
    const exists = todos.some((t) => String(t.id) === String(focusedTodoId));
    if (!exists) return;
    const el = document.getElementById(`todo-card-${focusedTodoId}`);
    if (!el) return;

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setFocusedTodoId(""), 2600);
    return () => clearTimeout(timer);
  }, [focusedTodoId, todos]);

  /* ---------- helpers to mutate state + store ---------- */

  async function handleCreate(draft) {
    const taskItems = sanitizeTaskRows(draft?.task_items || []);
    const now = new Date().toISOString();
    const newItem = {
      id: makeTodoId(),
      title: draft.title,
      notes: draft.notes,
      due_at: draft.due_at,
      completed: false,
      recurrence: normalizeRecurrence(draft?.recurrence),
      series_id: draft?.series_id || null,
      occurrence_index: Number(draft?.occurrence_index || 0) || 0,
      anchor_due_at: draft?.anchor_due_at || draft?.due_at || null,
      workload_reset_mode: normalizeWorkloadResetMode(draft?.workload_reset_mode),
      createdAt: now,
    };
    await createTodoItem(newItem);

    if (taskItems.length > 0) {
      importChecklistFromTodo(
        { courseId: TODO_COURSE_ID, assignmentId: newItem.id },
        taskItems,
        { strategy: "replace" },
      );
    }

    setShowNewForm(false);
    // Scroll to top so the new item is visible (it may land in any section)
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleEdit(id, draft) {
    const existing = todos.find((t) => t.id === id);
    if (!existing) return;

    const nextTodo = {
      ...existing,
      title: draft.title,
      notes: draft.notes,
      due_at: draft.due_at,
      recurrence: normalizeRecurrence(draft?.recurrence),
      series_id: draft?.series_id || existing.series_id || existing.id,
      occurrence_index: Number(draft?.occurrence_index ?? existing.occurrence_index ?? 0) || 0,
      anchor_due_at: draft?.anchor_due_at || existing.anchor_due_at || draft?.due_at || null,
      workload_reset_mode:
        normalizeWorkloadResetMode(draft?.workload_reset_mode) ||
        existing.workload_reset_mode ||
        "none",
      edit_scope:
        draft?.edit_scope === "this-and-future"
          ? "this-and-future"
          : "this-occurrence",
    };
    await updateTodoItem(id, nextTodo);

    const taskItems = sanitizeTaskRows(draft?.task_items || []);
    if (taskItems.length > 0) {
      importChecklistFromTodo(
        { courseId: TODO_COURSE_ID, assignmentId: id },
        taskItems,
        { strategy: draft?.import_strategy === "replace" ? "replace" : "append" },
      );
    }
  }

  async function handleToggleComplete(id) {
    const existing = todos.find((t) => t.id === id);
    if (!existing) return;
    const result = await updateTodoItem(id, { ...existing, completed: !existing.completed });

    const nextCompleted = !existing.completed;
    if (nextCompleted && result?.generatedTodo?.id) {
      const generatedTodo = result.generatedTodo;
      const previewAssignmentId = makeRecurringPreviewAssignmentId(
        generatedTodo.series_id || generatedTodo.id,
        generatedTodo.due_at || generatedTodo.anchor_due_at,
      );

      if (
        previewAssignmentId &&
        hasStoredEffortState({
          courseId: TODO_COURSE_ID,
          assignmentId: previewAssignmentId,
        })
      ) {
        moveEffortState({
          courseId: TODO_COURSE_ID,
          fromAssignmentId: previewAssignmentId,
          toAssignmentId: generatedTodo.id,
        });
      } else {
        handoffRecurringEffortState(
          {
            courseId: TODO_COURSE_ID,
            fromAssignmentId: id,
            toAssignmentId: generatedTodo.id,
          },
          existing.workload_reset_mode || "none",
        );
      }
    }
  }

  async function handleDelete(id, deleteScope = "this-occurrence") {
    await deleteTodoItem(id, { delete_scope: deleteScope });
  }

  function handleRequestDelete(todo) {
    if (todo?.recurrence && todo.recurrence !== "none") {
      setPendingDeleteTodo(todo);
      return;
    }
    if (window.confirm(`Delete "${todo.title}"?`)) {
      handleDelete(todo.id);
    }
  }

  async function handleConfirmDelete(deleteScope) {
    const target = pendingDeleteTodo;
    setPendingDeleteTodo(null);
    if (!target?.id) return;
    await handleDelete(target.id, deleteScope);
  }

  /* ---------- derive sections ---------- */

  const { overdue, upcoming, undated, completed } = useMemo(() => {
    const now = Date.now();
    const o = [], u = [], un = [], c = [];
    const favoriteRank = (todo) =>
      isAssignmentFavorited({
        courseId: TODO_COURSE_ID,
        assignmentId: todo.id,
      })
        ? 0
        : 1;

    for (const t of todos) {
      if (t.completed) {
        c.push(t);
        continue;
      }
      if (!t.due_at) {
        un.push(t);
        continue;
      }
      const dt = new Date(t.due_at).getTime();
      if (!Number.isFinite(dt)) {
        un.push(t);
        continue;
      }
      if (dt < now) {
        o.push(t);
      } else {
        u.push(t);
      }
    }

    // Sort each group
    const byDue = (a, b) => new Date(a.due_at) - new Date(b.due_at);
    o.sort((a, b) => favoriteRank(a) - favoriteRank(b) || byDue(a, b));
    u.sort((a, b) => favoriteRank(a) - favoriteRank(b) || byDue(a, b));
    un.sort(
      (a, b) =>
        favoriteRank(a) - favoriteRank(b) || a.title.localeCompare(b.title),
    );
    // Completed: most recently created first
    c.sort(
      (a, b) =>
        favoriteRank(a) - favoriteRank(b) ||
        new Date(b.createdAt) - new Date(a.createdAt),
    );

    return { overdue: o, upcoming: u, undated: un, completed: c };
  }, [todos, workloadTick]);

  const totalActive = overdue.length + upcoming.length + undated.length;

  return (
    <div className="stack">
      {/* Page header */}
      <div className="card">
        <div className="cardBody" style={{ height: "auto" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div className="h2">My To-Do</div>
              <div className="muted" style={{ marginTop: 4 }}>
                Personal tasks, notes, and deadlines. Items with due dates appear
                in the Weekly Planner.
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setShowNewForm((v) => !v)}
              style={{ flexShrink: 0 }}
            >
              {showNewForm ? "Cancel" : "+ New item"}
            </button>
          </div>

          {showNewForm ? (
            <div
              style={{
                marginTop: 16,
                paddingTop: 16,
                borderTop: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  fontWeight: 800,
                  marginBottom: 12,
                  fontSize: "var(--fontSm)",
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                New to-do
              </div>
              <TodoItemForm
                onSubmit={handleCreate}
                onCancel={() => setShowNewForm(false)}
                submitLabel="Create to-do"
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* Empty state */}
      {todos.length === 0 ? (
        <div className="card">
          <div className="cardBody muted" style={{ height: "auto", textAlign: "center", padding: "32px 16px" }}>
            No to-do items yet. Click <strong>+ New item</strong> to get started.
          </div>
        </div>
      ) : null}

      {/* Overdue */}
      {overdue.length > 0 ? (
        <div className="stack">
          <SectionHeading label="Overdue" count={overdue.length} />
          {overdue.map((t) => (
            <TodoCard
              key={t.id}
              todo={t}
              onToggleComplete={handleToggleComplete}
              onEdit={handleEdit}
              onDelete={handleRequestDelete}
              onCreate={handleCreate}
              isFocused={String(focusedTodoId) === String(t.id)}
            />
          ))}
        </div>
      ) : null}

      {/* Upcoming */}
      {upcoming.length > 0 ? (
        <div className="stack">
          <SectionHeading label="Upcoming" count={upcoming.length} />
          {upcoming.map((t) => (
            <TodoCard
              key={t.id}
              todo={t}
              onToggleComplete={handleToggleComplete}
              onEdit={handleEdit}
              onDelete={handleRequestDelete}
              onCreate={handleCreate}
              isFocused={String(focusedTodoId) === String(t.id)}
            />
          ))}
        </div>
      ) : null}

      {/* Undated */}
      {undated.length > 0 ? (
        <div className="stack">
          <SectionHeading label="Undated" count={undated.length} />
          {undated.map((t) => (
            <TodoCard
              key={t.id}
              todo={t}
              onToggleComplete={handleToggleComplete}
              onEdit={handleEdit}
              onDelete={handleRequestDelete}
              onCreate={handleCreate}
              isFocused={String(focusedTodoId) === String(t.id)}
            />
          ))}
        </div>
      ) : null}

      {/* Completed */}
      {completed.length > 0 ? (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            className="muted"
            onClick={() => setCompletedExpanded((v) => !v)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: "var(--fontSm)",
              paddingBottom: 8,
              paddingLeft: 0,
              userSelect: "none",
              color: "inherit",
            }}
          >
            Completed ({completed.length}) — click to {completedExpanded ? "hide" : "expand"}
          </button>
          {completedExpanded && (
            <div className="stack" style={{ marginTop: 8 }}>
              {completed.map((t) => (
                <TodoCard
                  key={t.id}
                  todo={t}
                  onToggleComplete={handleToggleComplete}
                  onEdit={handleEdit}
                  onDelete={handleRequestDelete}
                  onCreate={handleCreate}
                  isFocused={String(focusedTodoId) === String(t.id)}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Footer note if everything is done */}
      {todos.length > 0 && totalActive === 0 ? (
        <div className="card">
          <div
            className="cardBody muted"
            style={{ height: "auto", textAlign: "center", padding: "20px 16px" }}
          >
            All caught up! 🎉 Everything is marked complete.
          </div>
        </div>
      ) : null}

      <DeleteRecurringTodoModal
        todo={pendingDeleteTodo}
        onClose={() => setPendingDeleteTodo(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
