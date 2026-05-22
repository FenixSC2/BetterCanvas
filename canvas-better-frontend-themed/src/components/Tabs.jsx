import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Animated segmented tab bar. A single sliding indicator pill tracks the
 * active tab. We measure the active button's offsetLeft/offsetWidth and
 * publish them as CSS variables on the container so the indicator can
 * transition with the spring easing defined in styles.css.
 */
export function Tabs({ tabs, activeKey, onChange }) {
  const containerRef = useRef(null);
  const buttonRefs = useRef(new Map());
  const [indicator, setIndicator] = useState({ x: 0, w: 0, ready: false });

  const measure = useCallback(() => {
    const container = containerRef.current;
    const btn = buttonRefs.current.get(activeKey);
    if (!container || !btn) return;
    setIndicator({ x: btn.offsetLeft, w: btn.offsetWidth, ready: true });
  }, [activeKey]);

  useLayoutEffect(() => {
    measure();
  }, [measure, tabs]);

  // Re-measure on container resize (window resize, font load, density change)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(container);
    return () => ro.disconnect();
  }, [measure]);

  // Re-measure once after web fonts settle (Inter loads async)
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts || !document.fonts.ready) return;
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
    };
  }, [measure]);

  const style = indicator.ready
    ? {
        "--tab-indicator-x": `${indicator.x - 4}px`,
        "--tab-indicator-width": `${indicator.w}px`,
      }
    : { "--tab-indicator-width": "0px" };

  return (
    <div
      className="tabs"
      ref={containerRef}
      style={style}
      role="tablist"
    >
      <span className="tabIndicator" aria-hidden="true" />
      {tabs.map((t) => (
        <button
          key={t.key}
          ref={(el) => {
            if (el) buttonRefs.current.set(t.key, el);
            else buttonRefs.current.delete(t.key);
          }}
          className={`tab ${activeKey === t.key ? "active" : ""}`}
          onClick={() => onChange(t.key)}
          type="button"
          role="tab"
          aria-selected={activeKey === t.key}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
