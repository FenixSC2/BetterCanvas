import { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export function Register() {
  const { register, error, loading, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [localError, setLocalError] = useState("");

  async function handleRegister(e) {
    e.preventDefault();
    setLocalError("");

    if (!email || !password || !confirmPassword) {
      setLocalError("Please fill in all fields");
      return;
    }

    if (password !== confirmPassword) {
      setLocalError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setLocalError("Password must be at least 8 characters");
      return;
    }

    if (!/\d/.test(password)) {
      setLocalError("Password must contain at least one number");
      return;
    }

    if (!/[a-zA-Z]/.test(password)) {
      setLocalError("Password must contain at least one letter");
      return;
    }

    try {
      await register(email, password);
    } catch (err) {
      setLocalError(err.message || "Registration failed");
    }
  }

  return (
    <div className="authContainer">
      <div className="authPanel">
        <div className="authTitleRow">
          <h1 className="authTitle">CanvAssist</h1>
          <button
            type="button"
            className="authInfoBubble authInfoBubbleHoverable authInfoBubbleAlert"
            aria-label="Service availability notice"
          >
            !
            <span className="authInfoTooltip" role="tooltip">
              CanvAssist is currently available only for Northeastern students and is still in demo/beta.
            </span>
          </button>
        </div>
        <p className="authSubtitle">Create your account</p>
        <p className="authProjectBlurb">
          CanvAssist helps you stay ahead of Canvas coursework with better assignment visibility,
          timeline planning, and workload support tools. You are joining during beta, which means
          features will continue improving as student feedback comes in.
        </p>

        {(error || localError) && (
          <div className="authError" style={{ marginBottom: "16px" }}>
            {error || localError}
          </div>
        )}

        <form onSubmit={handleRegister} className="authForm">
          <div className="authField">
            <label htmlFor="register-email">Email address</label>
            <input
              id="register-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              placeholder="your@email.com"
              className="authInput"
            />
          </div>

          <div className="authField">
            <label htmlFor="register-password">Password</label>
            <div className="authInputRow">
              <input
                id="register-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                placeholder="••••••••"
                className="authInput authInputWithButton"
              />
              <button
                type="button"
                className="authInputButton"
                onClick={() => setShowPassword((prev) => !prev)}
                disabled={loading}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <div className="authHint">At least 8 characters, including a letter and a number</div>
          </div>

          <div className="authField">
            <label htmlFor="register-confirm-password">Confirm password</label>
            <div className="authInputRow">
              <input
                id="register-confirm-password"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading}
                placeholder="••••••••"
                className="authInput authInputWithButton"
              />
              <button
                type="button"
                className="authInputButton"
                onClick={() => setShowConfirmPassword((prev) => !prev)}
                disabled={loading}
                aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
                aria-pressed={showConfirmPassword}
              >
                {showConfirmPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <button type="submit" disabled={loading} className="authButton">
            {loading ? "Creating account..." : "Create account"}
          </button>
        </form>

        <div className="authFooter">
          <span>Already have an account? </span>
          <a href="#" onClick={(e) => {
            e.preventDefault();
            clearError();
            window.location.hash = '#login';
          }} className="authLink">
            Sign in
          </a>
        </div>
      </div>
    </div>
  );
}
