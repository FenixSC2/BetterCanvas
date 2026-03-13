// src/components/WorkloadEstimateControl.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addCompletedHours,
  addChecklistItem,
  getEffortState,
  removeChecklistItem,
  setAssignmentFavorite,
  setCompletedHours,
  setEffortMode,
  setEstimateHours,
  getEffortSnapMinutes,
  toggleChecklistItem,
  updateChecklistItemText,
} from "../lib/workloadEstimates";

const CHECKLIST_MODE = "checklist";

// remaining hours helper (formats to minutes when less than 1 hour, otherwise hours with 1 decimal)
function fmtRemaining(hrs) {
  const h = Number(hrs);
  if (!Number.isFinite(h)) return "0h";

  // Less than 1 hour → show minutes
  if (h > 0 && h < 1) {
    const mins = Math.max(1, Math.round(h * 60));
    return `${mins}m`;
  }

  // Otherwise show hours
  return `${fmt1(h)}h`;
}

/* ---------------- Anchored popover (portal) ---------------- */
function AnchoredPopover({
  open,
  onClose,
  anchorEl,
  children,
  side = "right",
  gap = 10,
  width = 420,
}) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;

    function recompute() {
      if (!anchorEl) return;

      const rect = anchorEl.getBoundingClientRect();
      const margin = 10;

      let left = side === "right" ? rect.right + gap : rect.left - gap - width;
      left = Math.max(
        margin,
        Math.min(left, window.innerWidth - width - margin),
      );

      // Align top with anchor, clamp
      let top = rect.top;
      const maxTop = window.innerHeight - margin;
      top = Math.max(margin, Math.min(top, maxTop));

      setPos({ top, left });
    }

    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }

    function onClick(e) {
      const panel = panelRef.current;
      if (!panel) return;

      const t = e.target;
      if (panel.contains(t)) return;
      if (anchorEl && anchorEl.contains(t)) return;

      onClose?.();
    }

    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);

    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open, onClose, anchorEl, side, gap, width]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width,
        zIndex: 9999,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function clampHours(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(200, x));
}

function fmt1(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "0.0";
  return n.toFixed(1);
}

function computeRemainingHours(st) {
  const est = Number(st?.estimateHours);
  const comp = Number(st?.completedHours);
  const E = Number.isFinite(est) ? est : 0;
  const C = Number.isFinite(comp) ? comp : 0;
  return Math.max(0, E - C);
}

function clampPct(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, x));
}

function barColorClass(pct) {
  // Uses the existing CSS classes in styles.css:
  // .effortBarFill.isRed/.isYellow/.isYellowGreen/.isGreen
  if (pct <= 25) return "isRed";
  if (pct <= 50) return "isYellow";
  if (pct <= 75) return "isYellowGreen";
  return "isGreen";
}

function roundToStep(value, step) {
  const v = Number(value);
  const s = Number(step);
  if (!Number.isFinite(v)) return 0;
  if (!Number.isFinite(s) || s <= 0) return v;
  return Math.round(v / s) * s;
}

function getChecklistProgress(items) {
  const safeItems = Array.isArray(items) ? items : [];
  const total = safeItems.length;
  const done = safeItems.filter((item) => item.completed).length;
  const pct = total > 0 ? clampPct((done / total) * 100) : 0;
  const nextItem = safeItems.find((item) => !item.completed) || null;
  return { total, done, pct, nextItem };
}

function ChecklistEditorRow({ item, onToggle, onSaveText, onRemove }) {
  const [draft, setDraft] = useState(item.text);
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    setDraft(item.text);
  }, [item.id, item.text]);

  useEffect(() => {
    if (!isEditing) return;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
  }, [isEditing]);

  function commit() {
    const trimmed = String(draft || "").trim();
    if (!trimmed || trimmed === item.text) {
      setDraft(item.text);
      return;
    }
    onSaveText(trimmed);
  }

  function startEdit() {
    setDraft(item.text);
    setIsEditing(true);
  }

  function finishEdit(save = true) {
    if (save) {
      commit();
    } else {
      setDraft(item.text);
    }
    setIsEditing(false);
  }

  return (
    <div className="effortChecklistEditorRow">
      <label className="effortChecklistItem effortChecklistEditorLabel">
        <input
          type="checkbox"
          checked={!!item.completed}
          onChange={(e) => onToggle(e.target.checked)}
        />

        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            className={`effortInput effortChecklistTextInput ${
              item.completed ? "isDone" : ""
            }`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => finishEdit(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                finishEdit(true);
              } else if (e.key === "Escape") {
                e.preventDefault();
                finishEdit(false);
              }
            }}
            aria-label="Checklist item text"
          />
        ) : (
          <span
            className={`effortChecklistItemText effortChecklistPreview ${
              item.completed ? "isDone" : ""
            }`}
            title={item.text}
          >
            {item.text}
          </span>
        )}
      </label>

      <div className="effortChecklistActions">
        <button
          type="button"
          className="btn effortChecklistActionBtn"
          onClick={() => {
            if (isEditing) finishEdit(true);
            else startEdit();
          }}
          title={isEditing ? "Save task text" : "Edit task text"}
        >
          {isEditing ? "Done" : "Edit"}
        </button>

        <button
          type="button"
          className="btn effortChecklistActionBtn"
          onClick={onRemove}
          title="Remove task"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export function WorkloadEstimateControl({
  courseId,
  assignmentId,
  compactLabels = false,
}) {
  const [tick, setTick] = useState(0);

  // popover state
  const [open, setOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState(null);

  // input state
  const [draftHours, setDraftHours] = useState("");
  const [addHoursDraft, setAddHoursDraft] = useState(""); // for "Add time" custom
  const [newChecklistItemDraft, setNewChecklistItemDraft] = useState("");
  const [err, setErr] = useState("");
  const [checklistExpanded, setChecklistExpanded] = useState(false);

  // inline estimate UI (used when estimate <= 0)
  const [showInlineEstimate, setShowInlineEstimate] = useState(false);
  const [inlineEstimateDraft, setInlineEstimateDraft] = useState("");

  // drag state for progress bar
  const barRef = useRef(null);
  const draggingRef = useRef(false);

  // inline estimate input focus
  const inlineEstimateRef = useRef(null);

  useEffect(() => {
    if (!showInlineEstimate) return;
    // Focus after render
    requestAnimationFrame(() => inlineEstimateRef.current?.focus?.());
  }, [showInlineEstimate]);

  // Keep UI synced with localStorage changes (same-tab + cross-tab)
  useEffect(() => {
    function onStorage(e) {
      if (!e?.key) return;
      const lk = String(e.key).toLowerCase();
      if (lk.includes("effort") || lk.includes("workload"))
        setTick((t) => t + 1);
    }

    function onWorkloadChanged() {
      setTick((t) => t + 1);
    }

    function onWorkloadSettingsChanged() {
      setTick((t) => t + 1);
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("canvassist:workload:changed", onWorkloadChanged);
    window.addEventListener(
      "canvassist:workload:settingsChanged",
      onWorkloadSettingsChanged,
    );
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(
        "canvassist:workload:changed",
        onWorkloadChanged,
      );
      window.removeEventListener(
        "canvassist:workload:settingsChanged",
        onWorkloadSettingsChanged,
      );
    };
  }, []);

  const L = useMemo(() => {
    return {
      total: compactLabels ? "Total:" : "Total Estimated:",
      rem: compactLabels ? "Rem:" : "Remaining:",
      inputBtn: compactLabels
        ? "Edit / track"
        : "Edit estimated hours / track progress",
    };
  }, [compactLabels]);

  const st = useMemo(() => {
    try {
      void tick;
      return getEffortState({ courseId, assignmentId });
    } catch {
      return null;
    }
  }, [courseId, assignmentId, tick]);

  const estimate = Number.isFinite(Number(st?.estimateHours))
    ? Number(st.estimateHours)
    : 0;
  const completed = Number.isFinite(Number(st?.completedHours))
    ? Number(st.completedHours)
    : 0;
  const mode = st?.mode === CHECKLIST_MODE ? CHECKLIST_MODE : "hours";
  const isChecklistMode = mode === CHECKLIST_MODE;
  const isFavorite = !!st?.favorite;
  const checklistItems = Array.isArray(st?.checklistItems) ? st.checklistItems : [];
  const checklistProgress = useMemo(
    () => getChecklistProgress(checklistItems),
    [checklistItems],
  );
  const remaining = computeRemainingHours(st);
  const isComplete = isChecklistMode
    ? checklistProgress.total > 0 && checklistProgress.done >= checklistProgress.total
    : !!st?.completed;
  const compactComplete = compactLabels && isComplete;

  // Helper fn: gives a checkbox next to completed badge on assignments in weekly planner (or other uses of the shortened "compact" mode) to quickly mark complete/incomplete by toggling between 0% and 100% completed.
  function setCompletedChecked(checked) {
    if (estimate <= 0) return;
    if (checked) {
      // Mark complete: set completed to full estimate
      setCompletedHours({ courseId, assignmentId }, estimate);
    } else {
      // Unmark complete: reset to 0% (your request)
      setCompletedHours({ courseId, assignmentId }, 0);
    }
  }

  // --- snapping: try to read whatever your "global snapping" exposes ---
  function getSnapStepHours() {
    // SettingsModal controls snapping in MINUTES
    const mins = Number(getEffortSnapMinutes?.());
    const safeMins = Number.isFinite(mins) ? Math.max(1, Math.round(mins)) : 10; // default 10
    return safeMins / 60; // convert to hours
  }

  // include tick so same-tab snap changes re-render (your setItem patch already bumps tick)
  const snapStep = useMemo(() => getSnapStepHours(), [tick]);

  const pct = useMemo(() => {
    if (estimate <= 0) return 0;
    return clampPct((completed / estimate) * 100);
  }, [estimate, completed]);

  const displayPct = isChecklistMode ? checklistProgress.pct : pct;
  const fillCls = useMemo(() => barColorClass(displayPct), [displayPct]);

  function closePopover() {
    setOpen(false);
    setAnchorEl(null);
    setErr("");
    setNewChecklistItemDraft("");
  }

  function applyEstimate() {
    const raw = Number(draftHours);
    const h = clampHours(raw);
    if (!Number.isFinite(raw) || h <= 0) {
      setErr("Enter hours > 0.");
      return;
    }
    setErr("");
    setEstimateHours({ courseId, assignmentId }, h);
    closePopover();
  }

  function applyInlineEstimate() {
    const raw = Number(inlineEstimateDraft);
    const h = clampHours(raw);
    if (!Number.isFinite(raw) || h <= 0) {
      setErr("Enter hours > 0.");
      return;
    }
    setErr("");
    setEstimateHours({ courseId, assignmentId }, h);
    setShowInlineEstimate(false);
  }

  function openPopover(e) {
    const btn = e?.currentTarget || null;
    setShowInlineEstimate(false);
    setErr("");
    setDraftHours(estimate > 0 ? String(estimate) : "");
    setAddHoursDraft("");
    setNewChecklistItemDraft("");
    setAnchorEl(btn);
    setOpen(true);
  }

  function applyMode(nextMode) {
    setEffortMode({ courseId, assignmentId }, nextMode);
    if (nextMode === CHECKLIST_MODE) {
      setChecklistExpanded(true);
    }
  }

  function applyNewChecklistItem() {
    const text = String(newChecklistItemDraft || "").trim();
    if (!text) return;
    addChecklistItem({ courseId, assignmentId }, text);
    setNewChecklistItemDraft("");
    setChecklistExpanded(true);
  }

  function doAddCompleted(delta) {
    const d = Number(delta);
    const h = clampHours(d);
    if (!Number.isFinite(d) || h === 0) return;
    addCompletedHours({ courseId, assignmentId }, h);
  }

  function resetProgress() {
    setCompletedHours({ courseId, assignmentId }, 0);
  }

  // ---------- draggable progress ----------
  function setProgressFromClientX(clientX) {
    if (estimate <= 0) return;
    const el = barRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const x = Math.max(rect.left, Math.min(clientX, rect.right));
    const t = rect.width > 0 ? (x - rect.left) / rect.width : 0;

    const targetCompletedRaw = t * estimate;
    const snapped = roundToStep(targetCompletedRaw, snapStep);
    const clamped = Math.max(0, Math.min(estimate, snapped));

    setCompletedHours({ courseId, assignmentId }, clamped);
  }

  function onBarPointerDown(e) {
    if (estimate <= 0) return;
    draggingRef.current = true;

    // capture pointer to keep receiving events even if pointer leaves
    try {
      e.currentTarget?.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    setProgressFromClientX(e.clientX);
  }

  function onBarPointerMove(e) {
    if (!draggingRef.current) return;
    setProgressFromClientX(e.clientX);
  }

  function onBarPointerUp(e) {
    if (!draggingRef.current) return;
    draggingRef.current = false;

    try {
      e.currentTarget?.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  }

  // ensure drag state clears if something weird happens
  useEffect(() => {
    function up() {
      draggingRef.current = false;
    }
    window.addEventListener("pointerup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("blur", up);
    };
  }, []);

  return (
    <div className="effortWidget">
      <div className="effortTopRow">
        <div className="effortNumbers">
          {isChecklistMode ? (
            <>
              <span className="effortPill">
                <span className="muted">Checklist:</span>{" "}
                <span className="mono">{Math.round(displayPct)}%</span>
              </span>

              <span className="effortPill">
                <span className="muted">Done:</span>{" "}
                <span className="mono">
                  {checklistProgress.done}/{checklistProgress.total}
                </span>
              </span>
            </>
          ) : estimate > 0 ? (
            <>
              <span className="effortPill">
                <span className="muted">{L.total}</span>{" "}
                <span className="mono">{fmt1(estimate)}h</span>
              </span>

              <span className="effortPill">
                <span className="muted">{L.rem}</span>{" "}
                <span className="mono">{fmtRemaining(remaining)}</span>
              </span>
            </>
          ) : showInlineEstimate ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <input
                ref={inlineEstimateRef}
                className="effortInput"
                type="number"
                min="0"
                step="0.25"
                placeholder={compactLabels ? "Hours…" : "Estimated hours…"}
                value={inlineEstimateDraft}
                onChange={(e) => {
                  setInlineEstimateDraft(e.target.value);
                  setErr("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyInlineEstimate();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setShowInlineEstimate(false);
                    setErr("");
                  }
                }}
                style={{ width: 160 }}
              />

              <button
                type="button"
                className="btn"
                onClick={applyInlineEstimate}
              >
                Apply
              </button>

              <button
                type="button"
                className="btn"
                onClick={() => {
                  setShowInlineEstimate(false);
                  setErr("");
                }}
              >
                Cancel
              </button>

              {err ? (
                <div
                  className="dangerText"
                  style={{ fontSize: 12, width: "100%" }}
                >
                  {err}
                </div>
              ) : null}
            </div>
          ) : estimate <= 0 && !showInlineEstimate ? (
            <button
              type="button"
              className="effortCta"
              onClick={() => {
                setOpen(false);
                setAnchorEl(null);
                setErr("");
                setInlineEstimateDraft("");
                setShowInlineEstimate(true);
              }}
              style={{ margin: "0 auto" }}
            >
              {compactLabels ? "Set estimated hours" : "Set estimated hours"}
            </button>
          ) : null}

          {!compactComplete && isComplete ? (
            <span className="effortDone">Complete</span>
          ) : null}
        </div>

        <div className="effortActions">
          <button
            type="button"
            className={`effortFavoriteBtn ${isFavorite ? "active" : ""}`}
            onClick={() =>
              setAssignmentFavorite(
                { courseId, assignmentId },
                !isFavorite,
              )
            }
            title={isFavorite ? "Unfavorite item" : "Favorite item"}
            aria-label={isFavorite ? "Unfavorite item" : "Favorite item"}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill={isFavorite ? "currentColor" : "none"}
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="m12 3.5 2.78 5.63 6.22.9-4.5 4.38 1.06 6.19L12 17.68 6.44 20.6l1.06-6.19L3 10.03l6.22-.9L12 3.5Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <button
            type="button"
            className="effortGearBtn"
            onClick={openPopover}
            title={L.inputBtn}
            aria-label={L.inputBtn}
          >
            ✎
          </button>
        </div>
      </div>

      {isChecklistMode ? (
        <div className="effortChecklistSummary">
          {checklistProgress.total > 0 ? (
            <>
              {checklistProgress.nextItem ? (
                <label className="effortChecklistPrimary">
                  <input
                    type="checkbox"
                    checked={!!checklistProgress.nextItem.completed}
                    onChange={(e) =>
                      toggleChecklistItem(
                        { courseId, assignmentId },
                        checklistProgress.nextItem.id,
                        e.target.checked,
                      )
                    }
                  />
                  <span className="effortChecklistPrimaryText">
                    {checklistProgress.nextItem.text}
                  </span>
                </label>
              ) : (
                <div className="effortChecklistPrimary isDone">
                  <input type="checkbox" checked={true} readOnly />
                  <span className="effortChecklistPrimaryText isDone">
                    All checklist items complete.
                  </span>
                </div>
              )}

              <button
                type="button"
                className="effortChecklistExpandBtn"
                onClick={() => setChecklistExpanded((v) => !v)}
                aria-label={checklistExpanded ? "Collapse checklist" : "Expand checklist"}
                title={checklistExpanded ? "Collapse checklist" : "Expand checklist"}
              >
                {checklistExpanded ? "▾" : "▸"}
              </button>
            </>
          ) : (
            <div className="muted" style={{ marginTop: 8 }}>
              No checklist items yet. Open settings to add steps.
            </div>
          )}
        </div>
      ) : null}

      {isChecklistMode && checklistExpanded && checklistProgress.total > 0 ? (
        <div className="effortChecklistList">
          {checklistItems.map((item) => (
            <label key={item.id} className="effortChecklistItem">
              <input
                type="checkbox"
                checked={!!item.completed}
                onChange={(e) =>
                  toggleChecklistItem(
                    { courseId, assignmentId },
                    item.id,
                    e.target.checked,
                  )
                }
              />
              <span
                className={`effortChecklistItemText ${
                  item.completed ? "isDone" : ""
                }`}
              >
                {item.text}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      {/* ✅ Draggable progress bar (snaps by global step) */}
      {isChecklistMode ? (
        <div className="effortBarWrap">
          <div
            className="effortBarTrack"
            title="Checklist completion"
          >
            <div
              className={`effortBarFill ${fillCls}`}
              style={{ width: `${displayPct}%` }}
            />
          </div>

          <div className="effortBarMeta mono">{Math.round(displayPct)}%</div>
        </div>
      ) : estimate <= 0 ? (
        <div className="effortBarWrap">
        </div>
      ) : compactLabels && isComplete ? (
        <div className="effortBarWrap">
          <label
            style={{
              gridColumn: "1 / -1",
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={true}
              onChange={(e) => setCompletedChecked(e.target.checked)}
            />
            <span className="effortDone">Completed</span>
          </label>
        </div>
      ) : (
        <div className="effortBarWrap">
          {/* your existing draggable bar exactly as-is */}
          <div
            ref={barRef}
            className="effortBarTrack"
            role="slider"
            aria-label="Completed hours"
            aria-valuemin={0}
            aria-valuemax={estimate}
            aria-valuenow={Math.max(0, Math.min(estimate, completed))}
            tabIndex={estimate > 0 ? 0 : -1}
            onPointerDown={onBarPointerDown}
            onPointerMove={onBarPointerMove}
            onPointerUp={onBarPointerUp}
            onKeyDown={(e) => {
              if (estimate <= 0) return;
              const step = snapStep || 0.25;
              if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = Math.min(
                  estimate,
                  roundToStep(completed + step, step),
                );
                setCompletedHours({ courseId, assignmentId }, next);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                e.preventDefault();
                const next = Math.max(0, roundToStep(completed - step, step));
                setCompletedHours({ courseId, assignmentId }, next);
              } else if (e.key === "Home") {
                e.preventDefault();
                setCompletedHours({ courseId, assignmentId }, 0);
              } else if (e.key === "End") {
                e.preventDefault();
                setCompletedHours({ courseId, assignmentId }, estimate);
              }
            }}
            style={{
              cursor: estimate > 0 ? "ew-resize" : "default",
              touchAction: "none",
            }}
            title={
              estimate > 0
                ? `Drag to set completed (snap ${snapStep}h)`
                : "Set an estimate to enable tracking"
            }
          >
            <div
              className={`effortBarFill ${fillCls}`}
              style={{ width: `${displayPct}%` }}
            />
          </div>

          <div className="effortBarMeta mono">{Math.round(displayPct)}%</div>
        </div>
      )}

      <AnchoredPopover
        open={open}
        onClose={closePopover}
        anchorEl={anchorEl}
        side="right" // ✅ default pop direction on the right
        gap={10}
        width={420}
      >
        <div className="effortPopover">
          <div className="effortPopoverHeader">
            <div style={{ fontWeight: 900 }}>
              {compactLabels ? "Effort" : "Estimated hours & tracking"}
            </div>
            <button
              type="button"
              className="effortCloseBtn"
              onClick={closePopover}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="effortPopoverBody">
            <div className="effortField">
              <div className="effortFieldLabel">Tracking mode</div>
              <div className="effortModeRow">
                <button
                  type="button"
                  className={`effortModeBtn ${!isChecklistMode ? "active" : ""}`}
                  onClick={() => applyMode("hours")}
                >
                  Hour estimate
                </button>
                <button
                  type="button"
                  className={`effortModeBtn ${isChecklistMode ? "active" : ""}`}
                  onClick={() => applyMode(CHECKLIST_MODE)}
                >
                  Task list
                </button>
              </div>
            </div>

            <div className="effortDivider" />

            {isChecklistMode ? (
              <div className="effortField">
                <div className="effortFieldLabel">Task list</div>

                {checklistItems.length === 0 ? (
                  <div className="muted">No tasks yet. Add the first step below.</div>
                ) : (
                  <div className="effortChecklistEditor">
                    {checklistItems.map((item) => (
                      <ChecklistEditorRow
                        key={item.id}
                        item={item}
                        onToggle={(checked) =>
                          toggleChecklistItem(
                            { courseId, assignmentId },
                            item.id,
                            checked,
                          )
                        }
                        onSaveText={(text) =>
                          updateChecklistItemText(
                            { courseId, assignmentId },
                            item.id,
                            text,
                          )
                        }
                        onRemove={() =>
                          removeChecklistItem({ courseId, assignmentId }, item.id)
                        }
                      />
                    ))}
                  </div>
                )}

                <div className="effortFieldRow" style={{ marginTop: 10 }}>
                  <input
                    className="effortInput"
                    type="text"
                    placeholder="Add task…"
                    value={newChecklistItemDraft}
                    onChange={(e) => setNewChecklistItemDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        applyNewChecklistItem();
                      }
                    }}
                    style={{ flex: 1, minWidth: 0 }}
                  />

                  <button
                    type="button"
                    className="btn"
                    onClick={applyNewChecklistItem}
                  >
                    Add step
                  </button>
                </div>

                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Progress is based on completed checklist items.
                </div>
              </div>
            ) : (
              <>
                <div className="effortField">
                  <div className="effortFieldLabel">Estimated hours</div>
                  <div className="effortFieldRow">
                    <input
                      className="effortInput"
                      type="number"
                      min="0"
                      step="0.25"
                      value={draftHours}
                      onChange={(e) => {
                        setDraftHours(e.target.value);
                        setErr("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          applyEstimate();
                        }
                      }}
                      style={{ width: 140 }}
                    />
                    <span className="muted">hours</span>

                    <button
                      type="button"
                      className="btn effortApplyBtn"
                      onClick={applyEstimate}
                    >
                      Apply
                    </button>
                  </div>

                  {err ? (
                    <div className="dangerText" style={{ fontSize: 12 }}>
                      {err}
                    </div>
                  ) : null}
                </div>

                <div className="effortDivider" />

                <div className="effortField">
                  <div className="effortFieldLabel">Track progress</div>

                  <div
                    className="effortFieldRow"
                    style={{ flexWrap: "wrap", gap: 8 }}
                  >
                    <button
                      type="button"
                      className="btn"
                      onClick={() => doAddCompleted(snapStep)}
                      title={`+${snapStep}h`}
                      disabled={estimate <= 0}
                    >
                      +{fmtRemaining(snapStep)}
                    </button>

                    <button
                      type="button"
                      className="btn"
                      onClick={() => doAddCompleted(0.5)}
                      title="+0.5h"
                      disabled={estimate <= 0}
                    >
                      +30m
                    </button>

                    <button
                      type="button"
                      className="btn"
                      onClick={() => doAddCompleted(1)}
                      title="+1h"
                      disabled={estimate <= 0}
                    >
                      +1h
                    </button>

                    <button
                      type="button"
                      className="btn"
                      onClick={() => doAddCompleted(2)}
                      title="+2h"
                      disabled={estimate <= 0}
                    >
                      +2h
                    </button>
                  </div>

                  <div className="effortFieldRow" style={{ marginTop: 10 }}>
                    <input
                      className="effortInput"
                      type="number"
                      min="0"
                      step="0.25"
                      placeholder="Add hours…"
                      value={addHoursDraft}
                      onChange={(e) => setAddHoursDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const v = Number(addHoursDraft);
                          if (Number.isFinite(v) && v !== 0) {
                            doAddCompleted(v);
                            setAddHoursDraft("");
                          }
                        }
                      }}
                      style={{ width: 140 }}
                      disabled={estimate <= 0}
                    />
                    <span className="muted">hours</span>

                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        const v = Number(addHoursDraft);
                        if (!Number.isFinite(v) || v === 0) return;
                        doAddCompleted(v);
                        setAddHoursDraft("");
                      }}
                      disabled={estimate <= 0}
                      title="Add to completed hours"
                    >
                      Add
                    </button>

                    <button
                      type="button"
                      className="btn"
                      onClick={resetProgress}
                      disabled={completed <= 0}
                      title="Reset completed hours to 0"
                    >
                      Reset progress
                    </button>
                  </div>

                  <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    Drag the bar to set completed hours (snaps to {fmtRemaining(snapStep)}).
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </AnchoredPopover>
    </div>
  );
}
