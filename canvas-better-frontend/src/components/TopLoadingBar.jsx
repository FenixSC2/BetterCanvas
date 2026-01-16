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
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        height: 3,
        width: "100%",
        zIndex: 9999,
        background: "transparent",
      }}
      aria-hidden="true"
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          // bright blue-ish bar (you can swap to your theme variable later)
          background: "linear-gradient(90deg, #4f46e5, #22c55e)",
          transition: pct >= 100 ? "width 120ms ease-out" : "width 60ms linear",
          boxShadow: "0 0 10px rgba(79,70,229,0.35)",
        }}
      />
    </div>
  );
}
