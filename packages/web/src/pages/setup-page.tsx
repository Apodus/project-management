import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { McpConfigSnippet } from "@/components/mcp-config-snippet";
import { useSetup, useSetupStatus } from "@/hooks/use-auth";
import { useCreateProject } from "@/hooks/use-projects";
import { useCreatePool, useCreatePoolAgents } from "@/hooks/use-agent-pool";
import { ApiError } from "@/lib/api";

type Step = "admin" | "project" | "connect" | "done";

/** Generate a short URL-safe LAN-trust secret client-side. */
function generateSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36))
    .join("")
    .slice(0, 20);
}

export function SetupPage() {
  const navigate = useNavigate();
  const { data: setupStatus, isLoading: statusLoading } = useSetupStatus();
  const setupMutation = useSetup();
  const createProjectMutation = useCreateProject();
  const createPoolMutation = useCreatePool();
  const createPoolAgentsMutation = useCreatePoolAgents();

  const [step, setStep] = useState<Step>("admin");

  // ── Admin step state ──
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ── Project step state ──
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectError, setProjectError] = useState("");

  // ── Connect step state ──
  const [poolName, setPoolName] = useState("default");
  const [poolSecret, setPoolSecret] = useState(() => generateSecret());
  const [agentCount, setAgentCount] = useState("5");
  const [connectError, setConnectError] = useState("");
  const [createdPool, setCreatedPool] = useState<{
    name: string;
    secret: string;
  } | null>(null);

  // If setup is already complete, redirect to login — but ONLY on the admin
  // step. Once the admin account is created, setupStatus.needsSetup flips to
  // false; without this guard that flip would eject the user out of the
  // remaining wizard steps. The /setup route has no beforeLoad guard, so this
  // effect is the sole redirect.
  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup && step === "admin") {
      navigate({ to: "/login" });
    }
  }, [setupStatus, navigate, step]);

  function validate(): boolean {
    const newErrors: Record<string, string> = {};

    if (!username.trim()) {
      newErrors.username = "Username is required";
    }
    if (!displayName.trim()) {
      newErrors.displayName = "Display name is required";
    }
    if (!password) {
      newErrors.password = "Password is required";
    } else if (password.length < 6) {
      newErrors.password = "Password must be at least 6 characters";
    }
    if (!confirmPassword) {
      newErrors.confirmPassword = "Please confirm your password";
    } else if (password !== confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    try {
      await setupMutation.mutateAsync({
        username: username.trim(),
        displayName: displayName.trim(),
        password,
      });
      setStep("project");
    } catch {
      // Error is handled by mutation state
    }
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    setProjectError("");
    if (!projectName.trim()) {
      setProjectError("Project name is required");
      return;
    }
    try {
      await createProjectMutation.mutateAsync({
        name: projectName.trim(),
        ...(projectDescription.trim() ? { description: projectDescription.trim() } : {}),
      });
      setStep("connect");
    } catch (err) {
      setProjectError(
        err instanceof ApiError ? err.message : "Could not create the project. Please try again.",
      );
    }
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setConnectError("");
    const name = poolName.trim() || "default";
    const secret = poolSecret.trim();
    if (!secret) {
      setConnectError("A pool secret is required");
      return;
    }
    const count = Number.parseInt(agentCount, 10) || 1;
    try {
      const pool = await createPoolMutation.mutateAsync({ name, secret });
      await createPoolAgentsMutation.mutateAsync({
        poolId: pool.id,
        count,
        namePrefix: name,
      });
      // The API never returns the secret, so capture it client-side here.
      setCreatedPool({ name, secret });
    } catch (err) {
      setConnectError(
        err instanceof ApiError
          ? err.message
          : "Could not create the agent pool. Please try again.",
      );
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
        {step === "admin" && (
          <>
            <CardHeader className="text-center">
              <div className="bg-primary text-primary-foreground mx-auto mb-4 flex size-12 items-center justify-center rounded-xl text-lg font-bold">
                PM
              </div>
              <CardTitle className="text-2xl">Welcome to Project Management</CardTitle>
              <CardDescription>Set up your admin account to get started.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="setup-username">Username</Label>
                  <Input
                    id="setup-username"
                    placeholder="admin"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      if (errors.username) {
                        setErrors((prev) => ({ ...prev, username: "" }));
                      }
                    }}
                    autoFocus
                    autoComplete="username"
                  />
                  {errors.username && <p className="text-destructive text-xs">{errors.username}</p>}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="setup-displayname">Display Name</Label>
                  <Input
                    id="setup-displayname"
                    placeholder="Admin User"
                    value={displayName}
                    onChange={(e) => {
                      setDisplayName(e.target.value);
                      if (errors.displayName) {
                        setErrors((prev) => ({ ...prev, displayName: "" }));
                      }
                    }}
                    autoComplete="name"
                  />
                  {errors.displayName && (
                    <p className="text-destructive text-xs">{errors.displayName}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="setup-password">Password</Label>
                  <Input
                    id="setup-password"
                    type="password"
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (errors.password) {
                        setErrors((prev) => ({ ...prev, password: "" }));
                      }
                    }}
                    autoComplete="new-password"
                  />
                  {errors.password && <p className="text-destructive text-xs">{errors.password}</p>}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="setup-confirm-password">Confirm Password</Label>
                  <Input
                    id="setup-confirm-password"
                    type="password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (errors.confirmPassword) {
                        setErrors((prev) => ({
                          ...prev,
                          confirmPassword: "",
                        }));
                      }
                    }}
                    autoComplete="new-password"
                  />
                  {errors.confirmPassword && (
                    <p className="text-destructive text-xs">{errors.confirmPassword}</p>
                  )}
                </div>

                {setupMutation.isError && (
                  <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
                    {setupMutation.error instanceof ApiError
                      ? setupMutation.error.message
                      : "An unexpected error occurred. Please try again."}
                  </div>
                )}

                <Button type="submit" className="w-full" disabled={setupMutation.isPending}>
                  {setupMutation.isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Creating account...
                    </>
                  ) : (
                    "Create Admin Account"
                  )}
                </Button>
              </form>
            </CardContent>
          </>
        )}

        {step === "project" && (
          <>
            <CardHeader className="text-center">
              <CardTitle className="text-2xl">Create your first project</CardTitle>
              <CardDescription>
                Projects hold your proposals, tasks, and the merge train.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreateProject} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="setup-project-name">Project name</Label>
                  <Input
                    id="setup-project-name"
                    placeholder="My Project"
                    value={projectName}
                    onChange={(e) => {
                      setProjectName(e.target.value);
                      if (projectError) setProjectError("");
                    }}
                    autoFocus
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="setup-project-description">
                    Description <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="setup-project-description"
                    placeholder="What this project is about"
                    value={projectDescription}
                    onChange={(e) => setProjectDescription(e.target.value)}
                  />
                </div>

                {projectError && (
                  <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
                    {projectError}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setStep("connect")}
                  >
                    Skip
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1"
                    disabled={createProjectMutation.isPending}
                  >
                    {createProjectMutation.isPending ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      "Create project"
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </>
        )}

        {step === "connect" && (
          <>
            <CardHeader className="text-center">
              <CardTitle className="text-2xl">Connect your agents</CardTitle>
              <CardDescription>
                Create an agent pool, then point your MCP client at it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {createdPool ? (
                <div className="space-y-4">
                  <McpConfigSnippet poolName={createdPool.name} poolSecret={createdPool.secret} />
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                    Pool secrets are LAN-trust credentials — only share them on a network you trust.
                    Copy the MCP bundle into your project — see{" "}
                    <code className="font-mono">docs/SETUP.md</code>.
                  </div>
                  <Button
                    type="button"
                    className="w-full"
                    onClick={() => navigate({ to: "/projects" })}
                  >
                    Finish
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleConnect} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="setup-pool-name">Pool name</Label>
                    <Input
                      id="setup-pool-name"
                      value={poolName}
                      onChange={(e) => setPoolName(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="setup-pool-secret">Pool secret</Label>
                    <div className="flex gap-2">
                      <Input
                        id="setup-pool-secret"
                        value={poolSecret}
                        onChange={(e) => setPoolSecret(e.target.value)}
                        className="font-mono"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="Generate secret"
                        onClick={() => setPoolSecret(generateSecret())}
                      >
                        <RefreshCw className="size-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="setup-agent-count">Number of agents</Label>
                    <Select value={agentCount} onValueChange={setAgentCount}>
                      <SelectTrigger id="setup-agent-count">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 5, 10].map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {connectError && (
                    <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
                      {connectError}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => navigate({ to: "/projects" })}
                    >
                      Skip
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1"
                      disabled={createPoolMutation.isPending || createPoolAgentsMutation.isPending}
                    >
                      {createPoolMutation.isPending || createPoolAgentsMutation.isPending ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        "Create pool"
                      )}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
