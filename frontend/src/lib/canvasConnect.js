// src/lib/canvasConnect.js
// How users connect Canvas: OAuth ("Connect Canvas") once the school issues a
// developer key, otherwise a pasted personal access token.

import { API_BASE } from "../api/canvasApi";

const FALLBACK = { oauth_enabled: false, personal_tokens_allowed: true };
let pending = null;

/** Fetch (once per page load) which connection methods the backend offers. */
export function loadCanvasConnectConfig() {
  if (!pending) {
    pending = fetch(`${API_BASE}/api/auth/canvas/config`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : FALLBACK))
      .catch(() => FALLBACK);
  }
  return pending;
}

/** Full-page navigation that starts the Canvas OAuth flow. */
export function startCanvasConnect() {
  window.location.assign(`${API_BASE}/api/auth/canvas/start`);
}

const ERROR_MESSAGES = {
  denied: "Canvas access wasn't approved. Connect again whenever you're ready.",
  expired: "That connection attempt expired. Please try again.",
  failed: "Couldn't finish connecting to Canvas. Please try again.",
  disabled: "Connecting with Canvas isn't available right now.",
};

const RESULT_HASH = /^#canvas-(connected|error=([a-z]+))/;

/** Message for a "#canvas-error=<reason>" left by the OAuth callback, or "". */
export function readCanvasConnectError() {
  const match = window.location.hash.match(RESULT_HASH);
  if (!match || !match[2]) return "";
  return ERROR_MESSAGES[match[2]] || ERROR_MESSAGES.failed;
}

/** Remove the OAuth callback result from the URL so a reload doesn't repeat it. */
export function clearCanvasConnectResult() {
  if (RESULT_HASH.test(window.location.hash)) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}
