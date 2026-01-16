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
    } catch (e) {
      if (e?.name !== "AbortError") setError(e);
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

  return { data, error, loading, refreshing, refresh: run };
}
