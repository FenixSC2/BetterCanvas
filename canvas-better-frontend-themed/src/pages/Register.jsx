import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

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
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">CanvAssist</CardTitle>
          <CardDescription>Create your account</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {(error || localError) && (
            <Alert variant="destructive">
              <AlertDescription>{error || localError}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleRegister} className="flex flex-col gap-4">
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
              <p className="text-xs text-muted-foreground">
                At least 8 characters, including a letter and a number
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <div className="flex gap-2">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={loading}
                  placeholder="••••••••"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowConfirmPassword((prev) => !prev)}
                  disabled={loading}
                  aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
                  aria-pressed={showConfirmPassword}
                >
                  {showConfirmPassword ? "Hide" : "Show"}
                </Button>
              </div>
            </div>

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "Creating account..." : "Create account"}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Button
              variant="link"
              className="h-auto p-0 text-sm"
              onClick={(e) => {
                e.preventDefault();
                clearError();
                window.location.hash = "#login";
              }}
            >
              Sign in
            </Button>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
