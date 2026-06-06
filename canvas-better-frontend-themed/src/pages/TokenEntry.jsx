import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { clearCachedAsync } from "../hooks/useCachedAsync";

export function TokenEntry() {
  const { user, logout, error: authError, setTokenStatus, tokenExpired, clearTokenExpired } = useAuth();
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  const API_BASE =
    import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:8000" : "https://api.canvassist.com");

  // Check if token is already stored. When the token has been flagged expired by the API,
  // skip this check — we know the stored token is no longer valid even if the DB row exists.
  useEffect(() => {
    async function checkToken() {
      try {
        const res = await fetch(`${API_BASE}/api/auth/token/status`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          setHasToken(data.has_token);
        }
      } catch (err) {
        console.error("Failed to check token status:", err);
      }
    }

    if (user && !tokenExpired) {
      checkToken();
    } else if (tokenExpired) {
      setHasToken(false);
    }
  }, [user, API_BASE, tokenExpired]);

  async function handleSubmitToken(e) {
    e.preventDefault();
    setLocalError("");
    setSuccess(false);

    if (!token.trim()) {
      setLocalError("Please enter your Canvas token");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token: token.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Failed to save token");
      }

      setToken("");
      setSuccess(true);
      setHasToken(true);
      setTokenStatus(true);
      if (clearTokenExpired) clearTokenExpired();
      
      // Small delay to ensure token is saved before triggering refetch
      setTimeout(() => {
        // Emit auth change event so all data fetches happen now that we have a token
        window.dispatchEvent(new CustomEvent("auth:changed"));
      }, 100);
      
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setLocalError(err.message || "Failed to save token");
    } finally {
      setLoading(false);
    }
  }

  async function handleRevokeToken(e) {
    e.preventDefault();
    if (!confirm("Are you sure you want to revoke your Canvas token? You'll need to enter a new one to use the app.")) {
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/token`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error("Failed to revoke token");
      }

      setToken("");
      setHasToken(false);
      setSuccess(false);
      setTokenStatus(false);
      
      // Clear cached Canvas data since token is revoked
      clearCachedAsync();
    } catch (err) {
      setLocalError(err.message || "Failed to revoke token");
    } finally {
      setLoading(false);
    }
  }

  if (!user) {
    return null;
  }

  return (
    <div className="authContainer">
      <div className="authPanel" style={{ maxWidth: "600px" }}>
        <div className="authTitleRow">
          <h1 className="authTitle">{tokenExpired ? "Canvas Token Expired" : "Canvas Token"}</h1>
          <button
            type="button"
            className="authInfoBubble authInfoBubbleHoverable authInfoBubbleNeutral"
            aria-label="How we use your token"
          >
            ?
            <span className="authInfoTooltip" role="tooltip">
              We use your Canvas token only to read your course data and power features in your account.
              Tokens are encrypted at rest, sent over secure requests, and are never sold or shared.
            </span>
          </button>
        </div>
        <p className="authSubtitle">Logged in as {user.email}</p>

        {tokenExpired && (
          <div className="authError" style={{ marginBottom: "16px" }}>
            Your Canvas token has expired or been revoked. Generate a new one in Canvas and paste it
            below to keep using CanvAssist.
          </div>
        )}

        {(authError || localError) && (
          <div className="authError" style={{ marginBottom: "16px" }}>
            {authError || localError}
          </div>
        )}

        {success && (
          <div className="authSuccess" style={{ marginBottom: "16px" }}>
            Token saved successfully
          </div>
        )}

        <div className="authInstructions" style={{ marginBottom: "24px" }}>
          <p style={{ marginTop: 0 }}>
            To use CanvAssist, you need to provide your Canvas personal access token.
          </p>
          <p style={{ fontWeight: 600, marginBottom: "8px" }}>How to get your token:</p>
          <ol>
            <li>Sign in to your university Canvas portal in a browser tab.</li>
            <li>Open your account menu (profile icon) and select <strong>Settings</strong>.</li>
            <li>Scroll to the <strong>Approved Integrations</strong> section near the bottom of the page.</li>
            <li>Select <strong>New Access Token</strong>.</li>
            <li>
              For <strong>Purpose</strong>, enter something recognizable like <code>CanvAssist Beta</code>.
            </li>
            <li>
              If your school supports expiration dates, choose one that fits your preference (you can always
              generate a fresh token later).
            </li>
            <li>
              Click <strong>Generate Token</strong>, then copy it immediately. Canvas may only fully show it once.
            </li>
            <li>Paste the token below and save it to connect your account.</li>
          </ol>
          <p className="authWarning">
            Keep this token private. Do not share it in messages, screenshots, code snippets, or with other
            people. Anyone with your token can access your Canvas data as you.
          </p>
        </div>

        {!hasToken ? (
          <form onSubmit={handleSubmitToken} className="authForm">
            <div className="authField">
              <div className="authLabelRow">
                <label htmlFor="canvas-access-token">Canvas Access Token</label>
                <button
                  type="button"
                  className="authInfoBubble authInfoBubbleHoverable authInfoBubbleNeutral"
                  aria-label="Why token is requested"
                >
                  ?
                  <span className="authInfoTooltip" role="tooltip">
                    This token lets CanvAssist fetch your courses and assignments from Canvas. It is
                    encrypted before storage and never displayed back to other users.
                  </span>
                </button>
              </div>
              <textarea
                id="canvas-access-token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={loading}
                placeholder="Paste your Canvas token here..."
                className="authTextarea"
              />
              <div className="authHint">
                Your token is encrypted and stored securely. It will never be exposed in URLs or logs.
              </div>
            </div>

            <button type="submit" disabled={loading} className="authButton">
              {loading ? "Saving..." : "Save Token"}
            </button>
          </form>
        ) : (
          <div>
            <div className="authSuccess" style={{ marginBottom: "16px" }}>
              ✓ Canvas token is saved and ready to use
            </div>

            <div style={{ marginBottom: "24px" }}>
              <button
                type="button"
                onClick={() => {
                  setTokenStatus(true);
                }}
                className="authButton"
                style={{
                  width: "100%",
                  marginBottom: "12px",
                }}
              >
                Continue to Dashboard
              </button>
            </div>

            <p style={{ marginBottom: "16px", fontSize: "var(--fontSm)", color: "var(--muted)" }}>
              Want to update your token? Enter a new one below, or revoke the current one.
            </p>

            <form onSubmit={handleSubmitToken} className="authForm">
              <div className="authField">
                <div className="authLabelRow">
                  <label htmlFor="canvas-new-token">New Canvas Token (optional)</label>
                  <button
                    type="button"
                    className="authInfoBubble authInfoBubbleHoverable authInfoBubbleNeutral"
                    aria-label="How replacement tokens are handled"
                  >
                    ?
                    <span className="authInfoTooltip" role="tooltip">
                      Updating replaces the token currently on file. We continue to encrypt stored tokens
                      and never share or sell them.
                    </span>
                  </button>
                </div>
                <textarea
                  id="canvas-new-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={loading}
                  placeholder="Leave empty to keep current token..."
                  className="authTextarea"
                />
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                <button type="submit" disabled={loading || !token.trim()} className="authButton" style={{ flex: 1 }}>
                  {loading ? "Updating..." : "Update Token"}
                </button>
                <button
                  type="button"
                  onClick={handleRevokeToken}
                  disabled={loading}
                  className="authButton authButtonDanger"
                  style={{ flex: 1 }}
                >
                  {loading ? "Revoking..." : "Revoke"}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="authFooter">
          <button
            type="button" 
            onClick={logout} 
            className="authLink"
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: "inherit" }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

