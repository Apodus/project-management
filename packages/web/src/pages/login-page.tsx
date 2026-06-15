import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin, useSetupStatus } from "@/hooks/use-auth";
import { ApiError } from "@/lib/api";

export function LoginPage() {
  const navigate = useNavigate();
  const { data: setupStatus, isLoading: statusLoading } = useSetupStatus();
  const loginMutation = useLogin();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // If setup is needed, redirect to setup
  useEffect(() => {
    if (setupStatus?.needsSetup) {
      navigate({ to: "/setup" });
    }
  }, [setupStatus, navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;

    try {
      await loginMutation.mutateAsync({
        username: username.trim(),
        password,
      });
      navigate({ to: "/projects" });
    } catch {
      // Error is handled by mutation state
    }
  }

  if (statusLoading) {
    return (
      <div className="bg-background flex h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="bg-primary text-primary-foreground mx-auto mb-4 flex size-12 items-center justify-center rounded-xl text-lg font-bold">
            PM
          </div>
          <CardTitle className="text-2xl">Sign In</CardTitle>
          <CardDescription>Enter your credentials to access the system.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="login-username">Username</Label>
              <Input
                id="login-username"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            {loginMutation.isError && (
              <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
                {loginMutation.error instanceof ApiError
                  ? loginMutation.error.message
                  : "An unexpected error occurred. Please try again."}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={!username.trim() || !password || loginMutation.isPending}
            >
              {loginMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
