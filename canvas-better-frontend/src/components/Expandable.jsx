import { useState } from "react";

export function Expandable({ title, subtitle, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="card">
      <button
        className="cardHeader"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <div className="cardHeaderLeft">
          <div className="cardTitle">{title}</div>
          {subtitle ? <div className="cardSubtitle">{subtitle}</div> : null}
        </div>
        <div className="chev">{open ? "▾" : "▸"}</div>
      </button>

      {open ? <div className="cardBody">{children}</div> : null}
    </div>
  );
}
