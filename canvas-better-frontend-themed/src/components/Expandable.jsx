// src/components/Expandable.jsx
import { useEffect, useId, useState } from "react";

export function Expandable({
  title,
  subtitle,
  right,
  children,
  defaultOpen = false,
  onToggle,
  onOpen,
  onClose,
  className = "",
  style,
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
    <details
      className={`card expandable ${className}`.trim()}
      open={open}
      onToggle={handleToggle}
      style={style}
    >
      <summary className="cardBody expandableSummary" aria-controls={id}>
        <div
          className="row"
          style={{
            alignItems: "center",
            gap: 10,
            width: "100%",
          }}
        >
          {/* our indicator */}
          <svg
            className={`expandableChevron${open ? " open" : ""}`}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="expandableTitle">{title}</div>
            {subtitle ? (
              <div className="expandableSubtitle" style={{ marginTop: 2 }}>
                {subtitle}
              </div>
            ) : null}
          </div>

          {/* right-side slot (e.g., View in Canvas button) */}
          {right ? (
            <div
              className="expandableRight"
              onClick={(e) => e.stopPropagation()} // prevent toggling when clicking button
              style={{ marginLeft: 10, display: "flex", alignItems: "center" }}
            >
              {right}
            </div>
          ) : null}
        </div>
      </summary>

      <div className="cardBody expandableBody" id={id}>
        {children}
      </div>
    </details>
  );
}
