import { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export function Login({ onViewDemo }) {
  const { login, error, loading, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState("");

  const handleMockMode = () => {
    if (onViewDemo) {
      onViewDemo();
    }
  };

  async function handleLogin(e) {
    e.preventDefault();
    setLocalError("");

    if (!email || !password) {
      setLocalError("Please enter both email and password");
      return;
    }

    try {
      await login(email, password);
    } catch (err) {
      setLocalError(err.message || "Login failed");
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
              CanvAssist is currently available only for Northeastern students and is still in demo/beta. CanvAssist is not affiliated with Canvas. Do not use your Canvas password here.
            </span>
          </button>
        </div>
        <p className="authSubtitle">Sign in to your account</p>
        <p className="authProjectBlurb">
          CanvAssist helps you organize Canvas coursework with clearer assignment views, planning tools,
          and workload support built for busy student schedules. This release is an early beta, so your
          feedback directly shapes what gets improved next.
        </p>

        {(error || localError) && (
          <div className="authError" style={{ marginBottom: "16px" }}>
            {error || localError}
          </div>
        )}

        <form onSubmit={handleLogin} className="authForm">
          <div className="authField">
            <label>Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              placeholder="your@email.com"
              className="authInput"
            />
          </div>

          <div className="authField">
            <label>Password</label>
            <div className="authInputRow">
              <input
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
            <div className="authHint">
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  clearError();
                  window.location.hash = "#forgot-password";
                }}
                className="authLink"
              >
                Forgot password?
              </a>
            </div>
          </div>

          <button type="submit" disabled={loading} className="authButton">
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <div style={{ margin: "16px 0", textAlign: "center" }}>
          <div style={{ fontSize: "var(--fontSm)", color: "var(--muted)", marginBottom: "12px" }}>
            Or try the demo first:
          </div>
          <button
            type="button"
            onClick={handleMockMode}
            className="authButton authButtonSecondary"
          >
            View Mock Data
          </button>
        </div>

        <div className="authFooter">
          <span>Don't have an account? </span>
          <a href="#" onClick={(e) => {
            e.preventDefault();
            clearError();
            window.location.hash = '#register';
          }} className="authLink">
            Sign up
          </a>
        </div>
      </div>
    </div>
  );
}
