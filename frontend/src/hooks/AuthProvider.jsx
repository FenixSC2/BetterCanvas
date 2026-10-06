import { createContext, useState, useEffect, useCallback, useRef } from "react";
import { clearCachedAsync } from "./useCachedAsync";
import { clearDemoMode, clearMockSessionData } from "../lib/storagePolicy";
import { API_BASE } from "../api/canvasApi";

const AuthContext = createContext(null);

function parseErrorDetail(data, fallback) {
  const d = data?.detail;
  if (!d) return fallback;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e) => e.msg).join(", ");
  return fallback;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasToken, setHasToken] = useState(false);
  const [tokenExpired, setTokenExpired] = useState(false);
  const loggingInRef = useRef(false);

  // Listen for 401 unauthorized events from API
  useEffect(() => {
    function handleUnauthorized() {
      // Don't interfere with an in-progress login attempt
      if (loggingInRef.current) return;
      setUser((prev) => {
        // Only show "session expired" if the user was actually logged in;
        // background requests on page load should not show this error.
        if (prev !== null) {
          setError("Your session has expired. Please log in again.");
        }
        return null;
      });
      setHasToken(false);
    }

    window.addEventListener("auth:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", handleUnauthorized);
  }, []);

  // Listen for Canvas token expiry events from API (403 with "invalid or expired" detail)
  useEffect(() => {
    function handleTokenInvalid() {
      setTokenExpired(true);
      setHasToken(false);
      // Force any cached Canvas data to be dropped so a new token re-fetches cleanly
      clearCachedAsync();
    }
    window.addEventListener("canvas:tokenInvalid", handleTokenInvalid);
    return () => window.removeEventListener("canvas:tokenInvalid", handleTokenInvalid);
  }, []);

  const checkAuth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        credentials: "include",
      });

      if (res.ok) {
        const userData = await res.json();
        setUser(userData);
        setError(null);

        // Check if they have a token
        const tokenRes = await fetch(`${API_BASE}/api/auth/token/status`, {
          credentials: "include",
        });
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          setHasToken(tokenData.has_token);
        }
      } else {
        setUser(null);
        setHasToken(false);
        setError(null);
      }
    } catch (err) {
      console.error("Auth check failed:", err);
      setUser(null);
      setHasToken(false);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Check if user is logged in on mount. checkAuth is a useCallback([]) so it is stable.
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = useCallback(async (email, password) => {
    loggingInRef.current = true;
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(parseErrorDetail(data, "Login failed"));
      }

      const data = await res.json();

      // Clear demo-mode and mock-session state before moving into a real account session.
      clearDemoMode();
      clearMockSessionData();

      setUser(data.user);
      setHasToken(false);

      // Clear cached data on login to force fresh data from Canvas
      clearCachedAsync();

      // Verify session is working and check token status
      try {
        const meRes = await fetch(`${API_BASE}/api/auth/me`, {
          credentials: "include",
        });
        if (meRes.ok) {
          const userData = await meRes.json();
          setUser(userData);
        }
      } catch (err) {
        console.error("Failed to verify session:", err);
      }

      // Check if user already has a saved token
      try {
        const tokenRes = await fetch(`${API_BASE}/api/auth/token/status`, {
          credentials: "include",
        });
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          setHasToken(tokenData.has_token);

          // If they already have a token, trigger data fetches
          if (tokenData.has_token) {
            window.dispatchEvent(new CustomEvent("auth:changed"));
          }
        } else {
          setHasToken(false);
        }
      } catch (err) {
        console.error("Failed to check token status:", err);
        setHasToken(false);
      }
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      loggingInRef.current = false;
      setLoading(false);
    }
  }, []);

  const register = useCallback(async (email, password) => {
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(parseErrorDetail(data, "Registration failed"));
      }

      // Registration successful, now try to log in
      await login(email, password);
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [login]);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch (err) {
      console.error("Logout failed:", err);
    } finally {
      setUser(null);
      setHasToken(false);
      clearDemoMode();
      clearMockSessionData();
      // Clear cached data on logout
      clearCachedAsync();
      // Emit auth change event so all data fetches re-run
      window.dispatchEvent(new CustomEvent("auth:changed"));
      setLoading(false);
    }
  }, []);

  const setTokenStatus = useCallback((status) => {
    setHasToken(status);
    if (status) setTokenExpired(false);
  }, []);

  const clearTokenExpired = useCallback(() => {
    setTokenExpired(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const forgotPassword = useCallback(async (email) => {
    setError(null);
    const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(parseErrorDetail(data, "Failed to request password reset"));
    }

    return res.json();
  }, []);

  const resetPassword = useCallback(async (token, newPassword) => {
    setError(null);
    const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, new_password: newPassword }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(parseErrorDetail(data, "Failed to reset password"));
    }

    return res.json();
  }, []);

  const value = {
    user,
    loading,
    error,
    hasToken,
    tokenExpired,
    login,
    register,
    logout,
    checkAuth,
    setTokenStatus,
    clearTokenExpired,
    clearError,
    forgotPassword,
    resetPassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export { AuthContext };
