// src/components/TopLoadingBar.jsx
import { useEffect, useRef, useState } from "react";
import { loadingBus } from "../lib/loadingBus";

export function TopLoadingBar() {
  const [active, setActive] = useState(false);
  const [pct, setPct] = useState(0);
  const rafRef = useRef(null);
  const hideTimeoutRef = useRef(null);

  useEffect(() => {
    function stopAnim() {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    function scheduleHide() {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = setTimeout(() => {
        setActive(false);
        setPct(0);
      }, 250);
    }

    function tick() {
      setPct((p) => {
        // creep toward 90% while loading
        const target = 90;
        const delta = Math.max(0.2, (target - p) * 0.02);
        return Math.min(target, p + delta);
      });
      rafRef.current = requestAnimationFrame(tick);
    }

    const unsub = loadingBus.subscribe((count) => {
      if (count > 0) {
        // start bar
        setActive(true);
        setPct((p) => (p < 5 ? 5 : p)); // ensure visible progress
        if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
      } else {
        // finish bar
        stopAnim();
        setPct(100);
        scheduleHide();
      }
    });

    return () => {
      unsub();
      stopAnim();
      clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  if (!active) return null;

  return (
    <div className="topLoadingBar" aria-hidden="true">
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background:
            "linear-gradient(90deg, #2563eb 0%, #14b8a6 52%, #f59e0b 100%)",
          transition: pct >= 100 ? "width 120ms ease-out" : "width 60ms linear",
          boxShadow:
            "0 0 18px rgba(37,99,235,0.35), 0 0 28px rgba(20,184,166,0.22)",
          borderRadius: 999,
        }}
      />
    </div>
  );
}
