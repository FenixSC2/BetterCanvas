// src/hooks/useNow.js
import { useEffect, useState } from "react";

/**
 * Current time in epoch ms, refreshed every `intervalMs`.
 * Lets components derive time-relative values (overdue, due-soon, sort scores)
 * without calling Date.now() during render.
 */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
