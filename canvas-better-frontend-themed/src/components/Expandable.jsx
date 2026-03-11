// src/components/Expandable.jsx
import { useEffect, useId, useState } from "react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

export function Expandable({
  title,
  subtitle,
  right,
  children,
  defaultOpen = false,
  onToggle,
  onOpen,
  onClose,
}) {
  const id = useId();
  const [open, setOpen] = useState(!!defaultOpen);

  useEffect(() => {
    setOpen(!!defaultOpen);
  }, [defaultOpen]);

  function handleOpenChange(isOpen) {
    setOpen(isOpen);
    onToggle?.(isOpen);
    if (isOpen) onOpen?.();
    else onClose?.();
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className="card expandable"
    >
      <CollapsibleTrigger
        type="button"
        className="cardBody expandableSummary w-full text-left"
        aria-controls={id}
      >
        <div
          className="row"
          style={{
            alignItems: "center",
            gap: 10,
            width: "100%",
          }}
        >
          {/* our indicator */}
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
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="cardBody expandableBody" id={id}>
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
