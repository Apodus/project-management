import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Check, Loader2, ShieldAlert, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useProject,
  useResolverDefaults,
  useUpdateResolverConfig,
} from "@/hooks/use-projects";
import { useCurrentUser } from "@/hooks/use-auth";
import { resolverConfigFromProject } from "@/lib/resolver";
import { ApiError, type ResolverConfig } from "@/lib/api";
import { useProjectStore } from "@/stores/project-store";

export function ConflictResolutionPage() {
  const params = useParams({ strict: false });
  const { currentProjectId } = useProjectStore();
  const projectId =
    (params as Record<string, string | undefined>).projectId ??
    currentProjectId ??
    undefined;

  const { data: user } = useCurrentUser();
  const isAdmin = user?.role === "admin";

  const { data: project, isLoading, error, refetch } = useProject(projectId);
  const { data: defaults } = useResolverDefaults();
  const updateMutation = useUpdateResolverConfig(projectId);

  // Form state — strings for number inputs so we can validate/show partials.
  const [enabled, setEnabled] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState("1");
  const [timeBudgetSec, setTimeBudgetSec] = useState("600");
  const [tokenUnlimited, setTokenUnlimited] = useState(true);
  const [tokenBudget, setTokenBudget] = useState("");
  const [prompt, setPrompt] = useState("");
  // Preserve `command` verbatim (not exposed) so a save never drops it.
  const [command, setCommand] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  // Hydrate the form from the project's persisted resolver block.
  useEffect(() => {
    if (!project) return;
    const config = resolverConfigFromProject(project);
    setEnabled(config.enabled);
    setMaxConcurrent(String(config.max_concurrent));
    setTimeBudgetSec(String(config.time_budget_sec));
    if (config.token_budget != null) {
      setTokenUnlimited(false);
      setTokenBudget(String(config.token_budget));
    } else {
      setTokenUnlimited(true);
      setTokenBudget("");
    }
    setPrompt(config.prompt ?? "");
    setCommand(config.command);
    setSaved(false);
  }, [project]);

  function revertToDefaults() {
    if (!defaults) return;
    // Reset config fields to defaults, but KEEP `enabled` at its current value
    // so a revert never surprise-disables the feature.
    setMaxConcurrent(String(defaults.max_concurrent));
    setTimeBudgetSec(String(defaults.time_budget_sec));
    if (defaults.token_budget == null) {
      setTokenUnlimited(true);
      setTokenBudget("");
    } else {
      setTokenUnlimited(false);
      setTokenBudget(String(defaults.token_budget));
    }
    // Empty prompt = use the built-in default (don't send prompt).
    setPrompt("");
    setSaved(false);
  }

  // ── Validation ──────────────────────────────────────────────────
  const maxConcurrentNum = Number(maxConcurrent);
  const timeBudgetNum = Number(timeBudgetSec);
  const tokenBudgetNum = Number(tokenBudget);
  const maxConcurrentValid =
    Number.isInteger(maxConcurrentNum) && maxConcurrentNum >= 1;
  const timeBudgetValid = Number.isFinite(timeBudgetNum) && timeBudgetNum > 0;
  const tokenBudgetValid =
    tokenUnlimited ||
    (tokenBudget.trim() !== "" &&
      Number.isFinite(tokenBudgetNum) &&
      tokenBudgetNum > 0);
  const isValid = maxConcurrentValid && timeBudgetValid && tokenBudgetValid;

  async function handleSave() {
    if (!projectId || !isValid) return;

    const resolver: ResolverConfig = {
      enabled,
      max_concurrent: maxConcurrentNum,
      time_budget_sec: timeBudgetNum,
    };
    // Unlimited → omit token_budget (absent = no cap).
    if (!tokenUnlimited) resolver.token_budget = tokenBudgetNum;
    // Empty prompt → omit (absent = built-in default).
    if (prompt.trim()) resolver.prompt = prompt;
    // Preserve `command` if the project had one (never surfaced, never dropped).
    if (command != null) resolver.command = command;

    try {
      await updateMutation.mutateAsync(resolver);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      // Surfaced via updateMutation.isError below.
    }
  }

  const promptPlaceholder = defaults?.prompt ?? "";

  // ── No project selected ─────────────────────────────────────────
  if (!projectId) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Wrench className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium">No Project Selected</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Select a project to configure conflict resolution.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Non-admin gate ──────────────────────────────────────────────
  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <ShieldAlert className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium">Admin access required</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Only project administrators can configure auto-resolution.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader />

      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-destructive">
              Failed to load project settings. Please try again.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && project && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Auto-resolve conflicts</CardTitle>
            <CardDescription>
              When the integrator hits a textual rebase conflict, spawn a bounded
              headless resolver off-lane to reconcile and re-submit, instead of
              rejecting the request. The resolved tree still passes the real
              verify gate before landing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Enabled */}
            <div className="flex items-center justify-between rounded-md border px-4 py-3">
              <div className="space-y-0.5">
                <Label htmlFor="resolver-enabled">Enabled</Label>
                <p className="text-xs text-muted-foreground">
                  Turn auto-resolution on for this project.
                </p>
              </div>
              <Switch
                id="resolver-enabled"
                checked={enabled}
                onCheckedChange={(checked) => {
                  setEnabled(checked);
                  if (saved) setSaved(false);
                }}
              />
            </div>

            {/* Max concurrent */}
            <div className="space-y-2">
              <Label htmlFor="resolver-max-concurrent">Max concurrent</Label>
              <Input
                id="resolver-max-concurrent"
                type="number"
                min={1}
                step={1}
                value={maxConcurrent}
                onChange={(e) => {
                  setMaxConcurrent(e.target.value);
                  if (saved) setSaved(false);
                }}
                aria-invalid={!maxConcurrentValid}
                className="max-w-xs"
              />
              {maxConcurrentValid ? (
                <p className="text-xs text-muted-foreground">
                  Most resolvers to run in parallel (minimum 1).
                </p>
              ) : (
                <p className="text-xs text-destructive">
                  Must be a whole number ≥ 1.
                </p>
              )}
            </div>

            {/* Time budget */}
            <div className="space-y-2">
              <Label htmlFor="resolver-time-budget">Time budget (seconds)</Label>
              <Input
                id="resolver-time-budget"
                type="number"
                min={1}
                value={timeBudgetSec}
                onChange={(e) => {
                  setTimeBudgetSec(e.target.value);
                  if (saved) setSaved(false);
                }}
                aria-invalid={!timeBudgetValid}
                className="max-w-xs"
              />
              {timeBudgetValid ? (
                <p className="text-xs text-muted-foreground">
                  Wall-clock budget per resolution attempt.
                </p>
              ) : (
                <p className="text-xs text-destructive">
                  Must be greater than 0.
                </p>
              )}
            </div>

            {/* Token budget + unlimited */}
            <div className="space-y-2">
              <Label htmlFor="resolver-token-budget">Token budget</Label>
              <div className="flex flex-wrap items-center gap-4">
                <Input
                  id="resolver-token-budget"
                  type="number"
                  min={1}
                  placeholder="e.g. 100000"
                  value={tokenBudget}
                  disabled={tokenUnlimited}
                  onChange={(e) => {
                    setTokenBudget(e.target.value);
                    if (saved) setSaved(false);
                  }}
                  aria-invalid={!tokenBudgetValid}
                  className="max-w-xs"
                />
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={tokenUnlimited}
                    onCheckedChange={(checked) => {
                      const on = checked === true;
                      setTokenUnlimited(on);
                      if (on) setTokenBudget("");
                      if (saved) setSaved(false);
                    }}
                    aria-label="Unlimited token budget"
                  />
                  Unlimited
                </label>
              </div>
              {tokenBudgetValid ? (
                <p className="text-xs text-muted-foreground">
                  Cap the resolver's token spend. Unlimited = no cap.
                </p>
              ) : (
                <p className="text-xs text-destructive">
                  Enter a number greater than 0, or check Unlimited.
                </p>
              )}
            </div>

            {/* Prompt */}
            <div className="space-y-2">
              <Label htmlFor="resolver-prompt">Reconcile prompt</Label>
              <Textarea
                id="resolver-prompt"
                rows={8}
                value={prompt}
                placeholder={promptPlaceholder}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  if (saved) setSaved(false);
                }}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                The instruction handed to the resolver. Use{" "}
                <code className="text-xs">{"{files}"}</code> for the conflicted
                files and <code className="text-xs">{"{verify_command}"}</code>{" "}
                for the verify command. Leave blank to use the built-in default
                (shown as the placeholder).
              </p>
            </div>

            {updateMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {updateMutation.error instanceof ApiError
                  ? updateMutation.error.message
                  : "Failed to save resolver settings. Please try again."}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={handleSave}
                disabled={updateMutation.isPending || !isValid}
              >
                {updateMutation.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
              <Button
                variant="outline"
                onClick={revertToDefaults}
                disabled={!defaults || updateMutation.isPending}
              >
                Revert to defaults
              </Button>
              {saved && (
                <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                  <Check className="size-4" />
                  Saved
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <div className="flex items-center gap-3">
      <Wrench className="size-6 text-muted-foreground" />
      <h1 className="text-2xl font-bold tracking-tight">Conflict Resolution</h1>
    </div>
  );
}
