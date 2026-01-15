// src/components/Expandable.jsx
import { useEffect, useId, useState } from "react";

/**
 * Expandable section (details/summary) with:
 * - explicit chevron indicator
 * - no native summary marker (we hide it via inline styles)
 * - onToggle/onOpen/onClose callbacks
 */
export function Expandable({
  title,
  subtitle,
  children,
  defaultOpen = false,
  onToggle,
  onOpen,
  onClose,
  right, // optional right-side element inside summary row (e.g. button)
}) {
  const id = useId();
  const [open, setOpen] = useState(!!defaultOpen);

  useEffect(() => {
    setOpen(!!defaultOpen);
  }, [defaultOpen]);

  function handleToggle(e) {
    const isOpen = !!e.currentTarget.open;
    setOpen(isOpen);

    onToggle?.(isOpen);
    if (isOpen) onOpen?.();
    else onClose?.();
  }

  return (
    <details className="card expandable" open={open} onToggle={handleToggle}>
      <summary
        className="cardBody expandableSummary"
        aria-controls={id}
        style={{
          listStyle: "none", // helps some browsers
        }}
      >
        <div
          className="row"
          style={{
            alignItems: "center",
            gap: 10,
            justifyContent: "space-between",
          }}
        >
          <div className="row" style={{ alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
            {/* Explicit indicator (only one) */}
            <span
              className="mono"
              aria-hidden="true"
              style={{
                width: 18,
                display: "inline-block",
                userSelect: "none",
                opacity: 0.8,
              }}
            >
              {open ? "▾" : "▸"}
            </span>

            <div className="expandableHeader" style={{ flex: 1, minWidth: 0 }}>
              <div className="expandableTitle">{title}</div>
              {subtitle ? <div className="expandableSubtitle">{subtitle}</div> : null}
            </div>
          </div>

          {/* optional right-side content */}
          {right ? <div style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>{right}</div> : null}
        </div>

        {/* Hide the native marker reliably */}
        <style>{`
          summary::-webkit-details-marker { display: none; }
          summary::marker { content: ""; }
        `}</style>
      </summary>

      <div className="cardBody expandableBody" id={id}>
        {children}
      </div>
    </details>
  );
}
