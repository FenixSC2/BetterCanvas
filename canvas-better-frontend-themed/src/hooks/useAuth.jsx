import { createContext, useState, useEffect, useCallback, useContext } from "react";
import { clearCachedAsync } from "./useCachedAsync";

const AuthContext = createContext(null);

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:8000" : "");

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

  // Check if user is logged in on mount
  useEffect(() => {
    checkAuth();
  }, []);

  // Listen for 401 unauthorized events from API
  useEffect(() => {
    function handleUnauthorized() {
      setUser(null);
      setHasToken(false);
      setError("Your session has expired. Please log in again.");
    }

    window.addEventListener("auth:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", handleUnauthorized);
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
      }
    } catch (err) {
      console.error("Auth check failed:", err);
      setUser(null);
      setHasToken(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (email, password) => {
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

      // Clear any demo mode state before setting user
      localStorage.removeItem("demoMode");

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
      // Clear cached data on logout
      clearCachedAsync();
      // Emit auth change event so all data fetches re-run
      window.dispatchEvent(new CustomEvent("auth:changed"));
      setLoading(false);
    }
  }, []);

  const setTokenStatus = useCallback((status) => {
    setHasToken(status);
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
    login,
    register,
    logout,
    checkAuth,
    setTokenStatus,
    clearError,
    forgotPassword,
    resetPassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
