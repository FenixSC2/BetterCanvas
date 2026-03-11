import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

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
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">CanvAssist</CardTitle>
          <CardDescription>Sign in to your account</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {(error || localError) && (
            <Alert variant="destructive">
              <AlertDescription>{error || localError}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                placeholder="your@email.com"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="flex gap-2">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  placeholder="••••••••"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPassword((prev) => !prev)}
                  disabled={loading}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? "Hide" : "Show"}
                </Button>
              </div>
            </div>

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>

          <div className="flex flex-col items-center gap-3 pt-2">
            <p className="text-sm text-muted-foreground">Or try the demo first:</p>
            <Button
              type="button"
              variant="outline"
              onClick={handleMockMode}
              className="w-full"
            >
              View Mock Data
            </Button>
          </div>

          <p className="text-center text-sm text-muted-foreground">
            Don't have an account?{" "}
            <Button
              variant="link"
              className="h-auto p-0 text-sm"
              onClick={(e) => {
                e.preventDefault();
                clearError();
                window.location.hash = "#register";
              }}
            >
              Sign up
            </Button>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
