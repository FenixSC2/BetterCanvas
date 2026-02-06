// src/components/WorkloadEstimateControl.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addCompletedHours,
  computeProgress,
  computeRemainingHours,
  formatHours,
  getEffortState,
  resetProgress,
  setCompleted,
  getEffortSnapMinutes,
  setCompletedHours,
  setEstimateHours,
} from "../lib/workloadEstimates";

/* --------------------- small numeric helpers --------------------- */
function num(x) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function clampUiHours(x) {
  const n = num(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(500, n));
}

function roundToStep(value, step = 0.5) {
  const n = clampUiHours(value);
  const s = step > 0 ? step : 0.5;
  return Math.round(n / s) * s;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function snapToMinutes(hours, snapMinutes) {
  const stepH = Math.max(1, snapMinutes) / 60;
  const h = Number.isFinite(hours) ? hours : 0;
  return Math.round(h / stepH) * stepH;
}

/**
 * Parse a decimal-ish string safely, returning NaN if unusable.
 * Supports empty string -> NaN
 */
function parseHoursDraft(s) {
  if (s == null) return NaN;
  const t = String(s).trim();
  if (!t) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/* --------------------- Stepper (+ / -) --------------------- */
function Stepper({ value, onChange, step = 0.5, min = 0 }) {
  const v = parseHoursDraft(value);
  const safe = Number.isFinite(v) ? v : 0;

  return (
    <div className="effortStepper" aria-label="Adjust value">
      <button
        type="button"
        className="effortStepBtn"
        onClick={() => onChange(String(Math.max(min, roundToStep(safe - step, step))))}
        aria-label="Decrease"
        title="Decrease"
      >
        −
      </button>
      <button
        type="button"
        className="effortStepBtn"
        onClick={() => onChange(String(roundToStep(safe + step, step)))}
        aria-label="Increase"
        title="Increase"
      >
        +
      </button>
    </div>
  );
}

/* --------------------- Popover --------------------- */
/**
 * Anchored popover:
 * - portal to body
 * - fixed positioning (viewport coords)
 * - recomputes on scroll/resize so it "moves" with content
 * - closes on outside click + Escape
 */
function Popover({
  open,
  onClose,
  anchorRef,
  children,
  side = "right",
  gap = 10,
}) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, minWidth: 360 });

  useEffect(() => {
    if (!open) return;

    function recompute() {
      const anchor = anchorRef?.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const width = 380;
      const margin = 10;

      let left =
        side === "right" ? rect.right + gap : rect.left - gap - width;

      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

      let top = rect.top;
      top = Math.max(margin, Math.min(top, window.innerHeight - margin));

      setPos({ top, left, minWidth: width });
    }

    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);

    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }

    function onClick(e) {
      const panel = panelRef.current;
      const anchor = anchorRef?.current;
      if (!panel || !anchor) return;

      const t = e.target;
      if (panel.contains(t)) return;
      if (anchor.contains(t)) return;

      onClose?.();
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);

    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open, onClose, anchorRef, side, gap]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="card"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: 380,
        zIndex: 9999,
        boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
      }}
    >
      <div className="cardBody">{children}</div>
    </div>,
    document.body
  );
}

/* --------------------- Main component --------------------- */
export function WorkloadEstimateControl({ courseId, assignmentId }) {
  const [tick, setTick] = useState(0);

  // Inline "Input estimated hours" state
  const [inlineEstimate, setInlineEstimate] = useState(false);
  const inlineRef = useRef(null);

  // Popover
  const [open, setOpen] = useState(false);
  const gearRef = useRef(null);

  // Global snap minutes (for dragging)
  const [snapMinutes, setSnapMinutes] = useState(() => getEffortSnapMinutes());

  // Drag state
  const draggingRef = useRef(false);
  const dragRafRef = useRef(0);
  const lastDragHoursRef = useRef(null);
  const [dragPreviewPct, setDragPreviewPct] = useState(null);

  // Focus inline estimate when it opens
  useEffect(() => {
    if (!inlineEstimate) return;
    requestAnimationFrame(() => inlineRef.current?.focus());
  }, [inlineEstimate]);

  // Sync workload state across:
  // - other tabs (storage)
  // - same tab (custom event fired by workloadEstimates.js)
  useEffect(() => {
    function onStorage(e) {
      // We only care if this key is about our assignment; you already had this filter.
      if (!e?.key) return;
      const k = String(e.key);
      if (!k.includes(String(courseId)) || !k.includes(String(assignmentId))) return;
      if (!k.toLowerCase().includes("workload") && !k.toLowerCase().includes("effort")) return;
      setTick((t) => t + 1);
    }

    function onLocalChanged(e) {
      const d = e?.detail;
      if (!d) return;
      if (String(d.courseId) === String(courseId) && String(d.assignmentId) === String(assignmentId)) {
        setTick((t) => t + 1);
      }
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("bettercanvas:workload:changed", onLocalChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("bettercanvas:workload:changed", onLocalChanged);
    };
  }, [courseId, assignmentId]);

  // Sync snapMinutes when user changes it in Settings tab
  useEffect(() => {
    function onSettingsChanged() {
      setSnapMinutes(getEffortSnapMinutes());
    }
    window.addEventListener("bettercanvas:workload:settingsChanged", onSettingsChanged);
    window.addEventListener("storage", onSettingsChanged); // cross-tab
    return () => {
      window.removeEventListener("bettercanvas:workload:settingsChanged", onSettingsChanged);
      window.removeEventListener("storage", onSettingsChanged);
    };
  }, []);

  const state = useMemo(() => {
    void tick;
    return getEffortState({ courseId, assignmentId });
  }, [courseId, assignmentId, tick]);

  const progress = computeProgress(state);
  const remaining = computeRemainingHours(state);

  const pct = Math.round(progress * 100);
  const hasEstimate = state.estimateHours > 0;

  // ---- Piecewise color gradient (tuned) ----
  // If you later pass "submitted", swap isFullyComplete = submitted instead.
  const isFullyComplete = !!state.completed;

  const p = clamp01(progress); // 0..1
  let hue;
  if (p <= 2 / 3) {
    const t = p / (2 / 3); // 0..1
    hue = 0 + t * 55; // red -> yellow
  } else if (p < 0.99) {
    const t = (p - 2 / 3) / (0.99 - 2 / 3); // 0..1
    hue = 55 + t * (85 - 55); // yellow -> yellow-green
  } else {
    hue = isFullyComplete ? 120 : 85; // true green only for completed
  }

  const saturation = 72;
  const lightness = 42;
  const fillColor = `hsl(${hue} ${saturation}% ${lightness}%)`;

  // Draft inputs (apply pattern)
  const [estimateDraft, setEstimateDraft] = useState(() =>
    state.estimateHours > 0 ? String(state.estimateHours) : ""
  );
  const [addDraft, setAddDraft] = useState("");

  // Reset drafts when popover closes
  useEffect(() => {
    if (!open) {
      setEstimateDraft(state.estimateHours > 0 ? String(state.estimateHours) : "");
      setAddDraft("");
    }
  }, [state.estimateHours, open]);

  function applyEstimate() {
    const h = clampUiHours(estimateDraft);
    setEstimateHours({ courseId, assignmentId }, h);
    setTick((t) => t + 1);
  }

  function applyAddCompleted() {
    const d = clampUiHours(addDraft);
    if (d <= 0) return;
    addCompletedHours({ courseId, assignmentId }, d);
    setAddDraft("");
    // keep current behavior: close popover after Add
    setOpen(false);
    setTick((t) => t + 1);
  }

  function doResetProgress() {
    resetProgress({ courseId, assignmentId });
    setTick((t) => t + 1);
  }

  function setCompletedToggle(next) {
    setCompleted({ courseId, assignmentId }, next);
    setTick((t) => t + 1);
  }

  /* --------------------- drag to set completed --------------------- */
  function commitCompletedHours(nextHours) {
    const snapped = snapToMinutes(nextHours, snapMinutes);
    setCompletedHours({ courseId, assignmentId }, snapped);

    if (hasEstimate) {
      if (snapped >= state.estimateHours) {
        setCompleted({ courseId, assignmentId }, true);
      } else if (state.completed) {
        setCompleted({ courseId, assignmentId }, false);
      }
    }

    setTick((t) => t + 1);
  }

  function calcHoursFromPointer(e) {
    if (!hasEstimate) return null;

    const track = e.currentTarget;
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = clamp01(x / rect.width);

    const targetHours = ratio * state.estimateHours;
    const snapped = snapToMinutes(targetHours, snapMinutes);

    return Math.max(0, Math.min(state.estimateHours, snapped));
  }

  function onBarPointerDown(e) {
    if (!hasEstimate) return;
    e.preventDefault();

    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);

    const nextH = calcHoursFromPointer(e);
    if (nextH == null) return;

    lastDragHoursRef.current = nextH;
    const pctPreview = state.estimateHours > 0 ? (nextH / state.estimateHours) * 100 : 0;
    setDragPreviewPct(pctPreview);

    commitCompletedHours(nextH);
  }

  function onBarPointerMove(e) {
    if (!draggingRef.current) return;
    if (!hasEstimate) return;

    const nextH = calcHoursFromPointer(e);
    if (nextH == null) return;

    lastDragHoursRef.current = nextH;
    const pctPreview = state.estimateHours > 0 ? (nextH / state.estimateHours) * 100 : 0;
    setDragPreviewPct(pctPreview);

    if (dragRafRef.current) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = 0;
      const h = lastDragHoursRef.current;
      if (h == null) return;
      commitCompletedHours(h);
    });
  }

  function endDrag() {
    draggingRef.current = false;
    setDragPreviewPct(null);
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
  }

  const pctDisplay = dragPreviewPct != null ? Math.round(dragPreviewPct) : pct;

  return (
    <div
      className={`effortWidget ${open ? "effortWidgetOpen" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="effortTopRow">
        <div className="effortNumbers">
          {!hasEstimate ? (
            inlineEstimate ? (
              <div className="effortInlineSet">
                <input
                  ref={inlineRef}
                  className="effortInput"
                  // Use text to avoid native number spinners; Stepper provides +/-.
                  type="text"
                  inputMode="decimal"
                  placeholder="Hours…"
                  value={estimateDraft}
                  onChange={(e) => setEstimateDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyEstimate();
                      setInlineEstimate(false);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setInlineEstimate(false);
                      setEstimateDraft("");
                    }
                  }}
                />

                <Stepper
                  value={estimateDraft}
                  onChange={(v) => setEstimateDraft(v)}
                  step={0.5}
                  min={0}
                />

                <button
                  type="button"
                  className="btn effortApplyBtn"
                  onClick={() => {
                    applyEstimate();
                    setInlineEstimate(false);
                  }}
                >
                  Apply
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="effortCta"
                onClick={() => {
                  setEstimateDraft("");
                  setInlineEstimate(true);
                }}
                title="Set an estimate for this assignment"
              >
                Input estimated hours
              </button>
            )
          ) : (
            <>
              <span className="effortPill">
                Total Estimated:{" "}
                <span className="mono">{formatHours(state.estimateHours)}</span>
              </span>
              <span className="effortPill">
                Remaining: <span className="mono">{formatHours(remaining)}</span>
              </span>
              {state.completed ? <span className="effortDone">✓ Completed</span> : null}
            </>
          )}
        </div>

        <button
          ref={gearRef}
          type="button"
          className="effortGearBtn"
          onClick={() => setOpen((v) => !v)}
          aria-label="Edit effort"
          title="Effort settings"
        >
          ⚙
        </button>
      </div>

      <div className="effortBarWrap" aria-label={`Progress ${pctDisplay}%`}>
        <div
          className="effortBarTrack"
          role={hasEstimate ? "slider" : undefined}
          tabIndex={hasEstimate ? 0 : -1}
          aria-valuemin={0}
          aria-valuemax={hasEstimate ? state.estimateHours : 0}
          aria-valuenow={hasEstimate ? state.completedHours : 0}
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ cursor: hasEstimate ? "ew-resize" : "default" }}
          title={
            hasEstimate
              ? `Drag to set completed effort (snaps to ${snapMinutes} min)`
              : "Set an estimate to enable dragging"
          }
        >
          <div
            className="effortBarFill"
            style={{
              width: `${pctDisplay}%`,
              background: fillColor,
            }}
          />
        </div>

        <div className="effortBarMeta">
          <span className="mono">{pctDisplay}%</span>
        </div>
      </div>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={gearRef}
        side="right"
      >
        <div className="effortPopoverHeader">
          <div style={{ fontWeight: 900 }}>Effort</div>
          <button
            type="button"
            className="effortCloseBtn"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="effortPopoverBody">
          <div className="effortField">
            <div className="effortFieldLabel">Estimated effort (hours)</div>
            <div className="effortFieldRow">
              <input
                className="effortInput"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 5"
                value={estimateDraft}
                onChange={(e) => setEstimateDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyEstimate();
                  }
                }}
              />

              <Stepper
                value={estimateDraft}
                onChange={(v) => setEstimateDraft(v)}
                step={0.5}
                min={0}
              />

              <button
                type="button"
                className="btn effortApplyBtn"
                onClick={applyEstimate}
              >
                Apply
              </button>
            </div>

            <div className="muted" style={{ marginTop: 6 }}>
              Sets the total work needed for this assignment.
            </div>
          </div>

          <div className="effortDivider" />

          <div className="effortField">
            <div className="effortFieldLabel">Add completed effort (hours)</div>
            <div className="effortFieldRow">
              <input
                className="effortInput"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 2"
                value={addDraft}
                onChange={(e) => setAddDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyAddCompleted();
                  }
                }}
              />

              <Stepper
                value={addDraft}
                onChange={(v) => setAddDraft(v)}
                step={0.5}
                min={0}
              />

              <button type="button" className="btn" onClick={applyAddCompleted}>
                Add
              </button>
            </div>

            <div className="muted" style={{ marginTop: 6 }}>
              Completed: <span className="mono">{formatHours(state.completedHours)}</span>
              {hasEstimate ? (
                <>
                  {" "}
                  / <span className="mono">{formatHours(state.estimateHours)}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="effortDivider" />

          <div className="effortActionsRow">
            <label className="effortCheckboxRow" title="Mark as completed in one click">
              <input
                type="checkbox"
                checked={!!state.completed}
                onChange={(e) => {
                  const next = e.target.checked;

                  if (next) {
                    setCompletedToggle(true);
                  } else {
                    // Unchecking = undo complete AND reset progress (your requirement)
                    setCompletedToggle(false);
                    doResetProgress();
                  }
                }}
              />
              <span>Mark complete</span>
            </label>

            <button
              type="button"
              className="btn"
              onClick={doResetProgress}
              title="Set completed effort to 0"
            >
              Reset progress
            </button>
          </div>

          <div className="muted">
            Marking an assignment as completed is not the same as submitting it.
            "Complete" assignments will still show up until they are submitted in Canvas.
          </div>
        </div>
      </Popover>
    </div>
  );
}
