// src/components/WorkloadEstimateControl.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addCompletedHours,
  getEffortState,
  setCompletedHours,
  setEstimateHours,
  getEffortSnapMinutes,
} from "../lib/workloadEstimates";

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
  const [err, setErr] = useState("");

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
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Patch localStorage.setItem so same-tab updates re-render
  useEffect(() => {
    const original = localStorage.setItem;

    localStorage.setItem = function patchedSetItem(key, value) {
      original.call(this, key, value);
      try {
        if (typeof key === "string") {
          const lk = key.toLowerCase();
          if (lk.includes("effort") || lk.includes("workload")) {
            setTick((t) => t + 1);
          }
        }
      } catch {
        // ignore
      }
    };

    return () => {
      localStorage.setItem = original;
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
  const remaining = computeRemainingHours(st);
  const isComplete = !!st?.completed;
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

  const fillCls = useMemo(() => barColorClass(pct), [pct]);

  function closePopover() {
    setOpen(false);
    setAnchorEl(null);
    setErr("");
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
    setAnchorEl(btn);
    setOpen(true);
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
          <span className="effortPill">
            <span className="muted">{L.total}</span>{" "}
            <span className="mono">{fmt1(estimate)}h</span>
          </span>

          <span className="effortPill">
            <span className="muted">{L.rem}</span>{" "}
            <span className="mono">{fmtRemaining(remaining)}</span>
          </span>

          {!compactComplete && isComplete ? (
            <span className="effortDone">Complete</span>
          ) : null}
        </div>

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

      {/* ✅ Draggable progress bar (snaps by global step) */}
      {estimate <= 0 ? (
        <div className="effortBarWrap">
          {showInlineEstimate ? (
            <div
              style={{
                gridColumn: "1 / -1",
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
          ) : (
            <button
              type="button"
              className="effortCta"
              onClick={() => {
                setOpen(false); // just to be safe; don't open popover here
                setAnchorEl(null);
                setErr("");
                setInlineEstimateDraft("");
                setShowInlineEstimate(true);
              }}
              style={{ gridColumn: "1 / -1", width: "fit-content" }}
            >
              {compactLabels ? "Set estimated hours" : "Set estimated hours"}
            </button>
          )}
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
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="effortBarMeta mono">{Math.round(pct)}%</div>
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
            {/* ---- Estimate editor ---- */}
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

            {/* ---- Add time / progress controls ---- */}
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
          </div>
        </div>
      </AnchoredPopover>
    </div>
  );
}
