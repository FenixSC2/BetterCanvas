import { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export function ForgotPassword() {
  const { forgotPassword, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [localError, setLocalError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLocalError("");
    setSuccessMessage("");

    if (!email) {
      setLocalError("Please enter your email address");
      return;
    }

    try {
      setSubmitting(true);
      const data = await forgotPassword(email);
      setSuccessMessage(
        data?.message || "If an account with that email exists, a reset link has been sent."
      );
    } catch (err) {
      setLocalError(err.message || "Failed to request password reset");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="authContainer">
      <div className="authPanel">
        <h1 className="authTitle">Reset your password</h1>
        <p className="authSubtitle">Enter the email linked to your account.</p>

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
            <label>Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              placeholder="your@email.com"
              className="authInput"
            />
          </div>

          <button type="submit" disabled={submitting} className="authButton">
            {submitting ? "Sending..." : "Send reset link"}
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
