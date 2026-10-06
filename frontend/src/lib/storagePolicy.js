const DEMO_MODE_KEY = "demoMode";
const LEGACY_DEMO_MODE_KEY = "demoMode";
const MOCK_WORKLOAD_PREFIX = "canvassist:workload:v1:";
const MOCK_TODOS_KEY = "canvassist:todos:mock:session";

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}

function safeParse(raw, fallback = null) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function isDemoMode() {
  const sessionValue = safeGet(sessionStorage, DEMO_MODE_KEY);
  if (sessionValue === "true") return true;

  // One-way migration path for older localStorage-based demo mode flags.
  const legacyValue = safeGet(localStorage, LEGACY_DEMO_MODE_KEY);
  if (legacyValue === "true") {
    safeSet(sessionStorage, DEMO_MODE_KEY, "true");
    safeRemove(localStorage, LEGACY_DEMO_MODE_KEY);
    return true;
  }

  return false;
}

export function setDemoMode(enabled) {
  if (enabled) {
    safeSet(sessionStorage, DEMO_MODE_KEY, "true");
    safeRemove(localStorage, LEGACY_DEMO_MODE_KEY);
    return;
  }
  clearDemoMode();
}

export function clearDemoMode() {
  safeRemove(sessionStorage, DEMO_MODE_KEY);
  safeRemove(localStorage, LEGACY_DEMO_MODE_KEY);
}

export function readLocalJson(key, fallback = null) {
  return safeParse(safeGet(localStorage, key), fallback);
}

export function writeLocalJson(key, value) {
  return safeSet(localStorage, key, JSON.stringify(value));
}

export function readSessionJson(key, fallback = null) {
  return safeParse(safeGet(sessionStorage, key), fallback);
}

export function writeSessionJson(key, value) {
  return safeSet(sessionStorage, key, JSON.stringify(value));
}

export function removeLocalKey(key) {
  safeRemove(localStorage, key);
}

// Keys written by features that have since been removed (e.g. the old Calendar tab).
const LEGACY_LOCAL_KEYS = ["bc.calendar.events"];

export function purgeLegacyStorage() {
  for (const key of LEGACY_LOCAL_KEYS) removeLocalKey(key);
}

export function getMockTodosKey() {
  return MOCK_TODOS_KEY;
}

export function clearMockSessionData() {
  safeRemove(sessionStorage, MOCK_TODOS_KEY);

  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(MOCK_WORKLOAD_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      safeRemove(sessionStorage, key);
    }
  } catch {
    // ignore
  }
}
