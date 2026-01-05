// src/components/WorkloadEstimateControl.jsx
import { useEffect, useState } from "react";
import { getEstimateHours, setEstimateHours, clearEstimateHours, formatHours } from "../lib/workloadEstimates";

export function WorkloadEstimateControl({ courseId, assignmentId }) {
  const [hours, setHours] = useState(null);

  useEffect(() => {
    setHours(getEstimateHours({ courseId, assignmentId }));
  }, [courseId, assignmentId]);

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span className="muted">
        Effort: <span className="mono">{formatHours(hours)}</span>
      </span>

      <input
        type="number"
        min="0"
        step="0.25"
        value={hours ?? ""}
        placeholder="# hours"
        onChange={(e) => {
          const v = e.target.value === "" ? null : Number(e.target.value);
          setHours(e.target.value === "" ? null : v);
          if (e.target.value === "") clearEstimateHours({ courseId, assignmentId });
          else setEstimateHours({ courseId, assignmentId }, v);
        }}
        style={{ width: 90 }}
      />

      {hours != null ? (
        <button
          className="btn"
          onClick={() => {
            setHours(null);
            clearEstimateHours({ courseId, assignmentId });
          }}
          title="Clear estimate"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
