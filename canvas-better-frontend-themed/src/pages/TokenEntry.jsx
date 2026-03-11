import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { clearCachedAsync } from "../hooks/useCachedAsync";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

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
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle className="text-2xl">Canvas Token</CardTitle>
          <CardDescription>Logged in as {user.email}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {(authError || localError) && (
            <Alert variant="destructive">
              <AlertDescription>{authError || localError}</AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert className="border-green-500 text-green-700 dark:text-green-400">
              <AlertDescription>Token saved successfully</AlertDescription>
            </Alert>
          )}

          <div className="rounded-lg border bg-muted/50 p-4 text-sm flex flex-col gap-2">
            <p>To use CanvAssist, you need to provide your Canvas personal access token.</p>
            <p className="font-semibold">How to get your token:</p>
            <ol className="list-decimal list-inside flex flex-col gap-1 text-muted-foreground">
              <li>Go to Canvas (your institution's Canvas URL)</li>
              <li>Click your profile icon → <strong className="text-foreground">Settings</strong></li>
              <li>Scroll to <strong className="text-foreground">Approved Integrations</strong></li>
              <li>Click <strong className="text-foreground">New Access Token</strong></li>
              <li>Give it a name like "CanvAssist"</li>
              <li>Click <strong className="text-foreground">Generate Token</strong> and copy it</li>
              <li>Paste it below</li>
            </ol>
          </div>

          {!hasToken ? (
            <form onSubmit={handleSubmitToken} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token">Canvas Access Token</Label>
                <textarea
                  id="token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={loading}
                  placeholder="Paste your Canvas token here..."
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  Your token is encrypted and stored securely. It will never be exposed in URLs or logs.
                </p>
              </div>

              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Saving..." : "Save Token"}
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-4">
              <Alert className="border-green-500 text-green-700 dark:text-green-400">
                <AlertDescription>✓ Canvas token is saved and ready to use</AlertDescription>
              </Alert>

              <Button
                type="button"
                onClick={() => window.location.reload()}
                className="w-full"
              >
                Continue to Dashboard
              </Button>

              <p className="text-sm text-muted-foreground">
                Want to update your token? Enter a new one below, or revoke the current one.
              </p>

              <form onSubmit={handleSubmitToken} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="newToken">New Canvas Token (optional)</Label>
                  <textarea
                    id="newToken"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    disabled={loading}
                    placeholder="Leave empty to keep current token..."
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                  />
                </div>

                <div className="flex gap-2">
                  <Button type="submit" disabled={loading || !token.trim()} className="flex-1">
                    {loading ? "Updating..." : "Update Token"}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={handleRevokeToken}
                    disabled={loading}
                    className="flex-1"
                  >
                    {loading ? "Revoking..." : "Revoke"}
                  </Button>
                </div>
              </form>
            </div>
          )}
        </CardContent>
        <CardFooter className="justify-center">
          <Button variant="link" className="h-auto p-0 text-sm" onClick={logout}>
            Sign out
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}