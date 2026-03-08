import { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export function Register() {
  const { register, error, loading, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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
        <h1 className="authTitle">Canvas Better</h1>
        <p className="authSubtitle">Create your account</p>

        {(error || localError) && (
          <div className="authError" style={{ marginBottom: "16px" }}>
            {error || localError}
          </div>
        )}

        <form onSubmit={handleRegister} className="authForm">
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
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              placeholder="••••••••"
              className="authInput"
            />
            <div className="authHint">At least 8 characters, including a letter and a number</div>
          </div>

          <div className="authField">
            <label>Confirm password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={loading}
              placeholder="••••••••"
              className="authInput"
            />
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
