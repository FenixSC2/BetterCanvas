// src/hooks/useCachedAsync.js
import { useEffect, useMemo, useRef, useState } from "react";

const _cache = new Map();

export function clearCachedAsync(keyPrefix) {
  if (!keyPrefix) {
    _cache.clear();
    return;
  }
  for (const k of _cache.keys()) {
    if (String(k).startsWith(keyPrefix)) _cache.delete(k);
  }
}

// ---------- NEW: localStorage hydration helper (does NOT affect useCachedAsync) ----------
function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Hydrates state from localStorage and keeps it persisted.
 * Use this when you want "instant UI" on tab switch + across reloads.
 *
 * Storage format:
 *   localStorage[cacheKey] = JSON.stringify({ v: <value>, ts: <epoch_ms> })
 */
export function useHydratedStateFromCache(cacheKey, initialValue) {
  const keyStr = useMemo(() => String(cacheKey), [cacheKey]);

  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(keyStr);
      if (!raw) return initialValue;
      const obj = safeJsonParse(raw, null);
      if (obj && Object.prototype.hasOwnProperty.call(obj, "v")) return obj.v;
      return initialValue;
    } catch {
      return initialValue;
    }
  });

  const setAndPersist = (next) => {
    setValue((prev) => {
      const v = typeof next === "function" ? next(prev) : next;
      try {
        localStorage.setItem(keyStr, JSON.stringify({ v, ts: Date.now() }));
      } catch {
        // ignore
      }
      return v;
    });
  };

  return [value, setAndPersist];
}

// ---------- Your ORIGINAL hook (unchanged behavior) ----------
export function useCachedAsync(key, fetcher, opts = {}) {
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  const keyStr = useMemo(() => String(key), [key]);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const cached = _cache.get(keyStr);
  const cachedOk =
    !!(cached && typeof cached.ts === "number" && Date.now() - cached.ts < ttlMs);

  const [data, setData] = useState(() => (cachedOk ? cached.data : null));
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(() => !cachedOk);
  const [refreshing, setRefreshing] = useState(() => cachedOk);

  const abortRef = useRef(null);

  async function run() {
    abortRef.current?.abort?.();
    const ac = new AbortController();
    abortRef.current = ac;

    const hasDataNow = data != null;
    if (!hasDataNow) setLoading(true);
    else setRefreshing(true);

    setError(null);

    try {
      const next = await fetcherRef.current({ signal: ac.signal });
      _cache.set(keyStr, { data: next, ts: Date.now() });
      setData(next);
      setError(null); // Clear any previous errors on success
    } catch (e) {
      if (e?.name !== "AbortError") {
        // If error is 403 (needs token), silently set empty data instead of showing error
        // This prevents error messages when user hasn't added their Canvas token yet
        if (e?.status === 403 || e?.needsToken) {
          setData(null);
          setError(null); // Don't show error for missing token
          // Don't cache null data - let it re-fetch when token is available
        } else {
          setError(e);
        }
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    run();
    return () => abortRef.current?.abort?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyStr]);

  // Re-fetch when auth state changes (login/logout)
  useEffect(() => {
    function handleAuthChange() {
      run();
    }
    window.addEventListener("auth:changed", handleAuthChange);
    return () => window.removeEventListener("auth:changed", handleAuthChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, error, loading, refreshing, refresh: run };
}
