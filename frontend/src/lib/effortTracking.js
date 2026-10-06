// src/lib/effortTracking.js
// Global on/off switch for effort tracking (device-level UI preference).

export const EFFORT_ENABLED_KEY = "bc.effort.enabled";
export const EFFORT_ENABLED_EVENT = "canvassist:effort-enabled:changed";

export function readEffortEnabled() {
  try {
    const raw = localStorage.getItem(EFFORT_ENABLED_KEY);
    if (raw == null) return true;
    return raw !== "false";
  } catch {
    return true;
  }
}

export function setEffortTrackingEnabled(next) {
  try {
    localStorage.setItem(EFFORT_ENABLED_KEY, next ? "true" : "false");
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new CustomEvent(EFFORT_ENABLED_EVENT));
  } catch {
    // ignore
  }
}

export function isEffortTrackingEnabled() {
  return readEffortEnabled();
}
