import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

function readTokenFromHash() {
  const hash = window.location.hash || "";
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) return "";
  const query = hash.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  return params.get("token") || "";
}

export function ResetPassword() {
  const { resetPassword, clearError } = useAuth();
  const [token, setToken] = useState(() => readTokenFromHash());
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function syncToken() {
      setToken(readTokenFromHash());
    }
    window.addEventListener("hashchange", syncToken);
    return () => window.removeEventListener("hashchange", syncToken);
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setLocalError("");
    setSuccessMessage("");

    if (!token) {
      setLocalError("This reset link is missing a token.");
      return;
    }

    if (!newPassword || !confirmPassword) {
      setLocalError("Please complete all password fields");
      return;
    }

    if (newPassword !== confirmPassword) {
      setLocalError("Passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      setLocalError("Password must be at least 8 characters");
      return;
    }

    if (!/\d/.test(newPassword)) {
      setLocalError("Password must contain at least one number");
      return;
    }

    if (!/[a-zA-Z]/.test(newPassword)) {
      setLocalError("Password must contain at least one letter");
      return;
    }

    try {
      setSubmitting(true);
      const data = await resetPassword(token, newPassword);
      setSuccessMessage(data?.message || "Password reset successful. Please sign in.");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setLocalError(err.message || "Failed to reset password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="authContainer">
      <div className="authPanel">
        <h1 className="authTitle">Set a new password</h1>
        <p className="authSubtitle">Choose a new password for your account.</p>

        {localError && (
          <div className="authError" style={{ marginBottom: "16px" }}>
            {localError}
          </div>
        )}

        {successMessage && (
          <div className="authSuccess" style={{ marginBottom: "16px" }}>
            {successMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="authForm">
          <div className="authField">
            <label htmlFor="reset-new-password">New password</label>
            <input
              id="reset-new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
              placeholder="••••••••"
              className="authInput"
            />
            <div className="authHint">At least 8 characters, including a letter and a number</div>
          </div>

          <div className="authField">
            <label htmlFor="reset-confirm-password">Confirm new password</label>
            <input
              id="reset-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
              placeholder="••••••••"
              className="authInput"
            />
          </div>

          <button type="submit" disabled={submitting} className="authButton">
            {submitting ? "Resetting..." : "Reset password"}
          </button>
        </form>

        <div className="authFooter">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              clearError();
              window.location.hash = "#login";
            }}
            className="authLink"
          >
            Back to sign in
          </a>
        </div>
      </div>
    </div>
  );
}
