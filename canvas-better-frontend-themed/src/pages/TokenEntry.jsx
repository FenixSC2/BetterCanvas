import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";

export function TokenEntry() {
  const { user, logout, error: authError, setTokenStatus, hasToken: contextHasToken } = useAuth();
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

  // Check if token is already stored
  useEffect(() => {
    async function checkToken() {
      try {
        const headers = {};
        
        // Add session ID from localStorage as a header (fallback for cross-origin requests)
        const sessionId = localStorage.getItem("session_id");
        if (sessionId) {
          headers["X-Session-ID"] = sessionId;
        }
        
        const res = await fetch(`${API_BASE}/api/auth/token/status`, {
          credentials: "include",
          headers,
        });
        if (res.ok) {
          const data = await res.json();
          setHasToken(data.has_token);
        }
      } catch (err) {
        console.error("Failed to check token status:", err);
      }
    }

    if (user) {
      checkToken();
    }
  }, [user, API_BASE]);

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
      const headers = { "Content-Type": "application/json" };
      
      // Add session ID from localStorage as a header (fallback for cross-origin requests)
      const sessionId = localStorage.getItem("session_id");
      if (sessionId) {
        headers["X-Session-ID"] = sessionId;
      }
      
      const res = await fetch(`${API_BASE}/api/auth/token`, {
        method: "POST",
        headers,
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
        <h1 className="authTitle">Canvas Token</h1>
        <p className="authSubtitle">Logged in as {user.email}</p>

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
            To use Canvas Better, you need to provide your Canvas personal access token.
          </p>
          <p style={{ fontWeight: 600, marginBottom: "8px" }}>How to get your token:</p>
          <ol>
            <li>Go to Canvas (your institution's Canvas URL)</li>
            <li>Click your profile icon → <strong>Settings</strong></li>
            <li>Scroll to <strong>Approved Integrations</strong></li>
            <li>Click <strong>New Access Token</strong></li>
            <li>Give it a name like "Canvas Better"</li>
            <li>Click <strong>Generate Token</strong> and copy it</li>
            <li>Paste it below</li>
          </ol>
        </div>

        {!hasToken ? (
          <form onSubmit={handleSubmitToken} className="authForm">
            <div className="authField">
              <label>Canvas Access Token</label>
              <textarea
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
                  // Manually navigate by reloading or wait for context update
                  window.location.reload();
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
                <label>New Canvas Token (optional)</label>
                <textarea
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

