// src/hooks/useCachedAsync.js
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const _cache = new Map();

function shouldSuppressAsyncError(error) {
  return !!(error && (error.status === 401 || error.status === 403 || error.needsToken));
}

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

  // Stable identity so callers can safely list the setter in effect deps.
  const setAndPersist = useCallback(
    (next) => {
      setValue((prev) => {
        const v = typeof next === "function" ? next(prev) : next;
        try {
          localStorage.setItem(keyStr, JSON.stringify({ v, ts: Date.now() }));
        } catch {
          // ignore
        }
        return v;
      });
    },
    [keyStr],
  );

  return [value, setAndPersist];
}

// ---------- Cached async fetch hook ----------
export function useCachedAsync(key, fetcher, opts = {}) {
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  const keyStr = useMemo(() => String(key), [key]);

  // Latest fetcher, read inside `run` so callers can pass inline functions
  // without changing `run`'s identity (and without re-triggering fetches).
  const fetcherRef = useRef(fetcher);
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });

  const cached = _cache.get(keyStr);
  const cachedOk =
    !!(cached && typeof cached.ts === "number" && Date.now() - cached.ts < ttlMs);

  const [data, setData] = useState(() => (cachedOk ? cached.data : null));
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(() => !cachedOk);
  const [refreshing, setRefreshing] = useState(() => cachedOk);

  // Mirrors `data` so `run` can choose loading vs. refreshing without depending on it.
  const dataRef = useRef(data);
  useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);

  const abortRef = useRef(null);

  // Stable per key: safe to list in effect deps and to expose as `refresh`.
  const run = useCallback(async () => {
    abortRef.current?.abort?.();
    const ac = new AbortController();
    abortRef.current = ac;

    const hasDataNow = dataRef.current != null;
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
        // Auth and token errors should not render as page-level ErrorBoxes.
        // AuthProvider and surrounding app state handle redirect/login/token flows.
        if (shouldSuppressAsyncError(e)) {
          setData(null);
          setError(null);
          // Don't cache null data - let it re-fetch when token is available
        } else {
          setError(e);
        }
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [keyStr]);

  // Fetch on mount and whenever the key changes.
  useEffect(() => {
    run();
    const controller = abortRef.current;
    return () => controller?.abort?.();
  }, [run]);

  // Re-fetch when auth state changes (login/logout)
  useEffect(() => {
    window.addEventListener("auth:changed", run);
    return () => window.removeEventListener("auth:changed", run);
  }, [run]);

  return { data, error, loading, refreshing, refresh: run };
}
