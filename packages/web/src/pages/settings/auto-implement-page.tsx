import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Bot, Check, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useProject,
  useUpdateAutoImplementConfig,
} from "@/hooks/use-projects";
import { useCurrentUser } from "@/hooks/use-auth";
import { ApiError, type AutoImplementConfig, type Project } from "@/lib/api";
import { useProjectStore } from "@/stores/project-store";

type AutoImplementMode = AutoImplementConfig["mode"];

// Read-through the persisted `settings.autoImplement` block tolerantly: a project
// with no block (or no per-field) falls back to the safe defaults (off / shadow).
function autoImplementConfigFromProject(
  project: Project | undefined,
): AutoImplementConfig {
  const block = (project?.settings as { autoImplement?: AutoImplementConfig } | null | undefined)
    ?.autoImplement;
  return {
    enabled: block?.enabled ?? false,
    mode: block?.mode ?? "shadow",
  };
}

const MODE_HELP: Record<AutoImplementMode, string> = {
  shadow:
    "Observe: the responder prepares the branch/diff and opens it as a proposal without landing it.",
  on: "Autonomous: the responder lands changes directly. The merge-train verify gate is still the floor — nothing lands without passing verify.",
  off: "Disabled at the mode level even if the toggle is on.",
};

export function AutoImplementPage() {
  const params = useParams({ strict: false });
  const { currentProjectId } = useProjectStore();
  const projectId =
    (params as Record<string, string | undefined>).projectId ??
    currentProjectId ??
    undefined;

  const { data: user } = useCurrentUser();
  const isAdmin = user?.role === "admin";

  const { data: project, isLoading, error, refetch } = useProject(projectId);
  const updateMutation = useUpdateAutoImplementConfig(projectId);

  // Form state.
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<AutoImplementMode>("shadow");
  const [saved, setSaved] = useState(false);

  // Hydrate the form from the project's persisted autoImplement block.
  useEffect(() => {
    if (!project) return;
    const config = autoImplementConfigFromProject(project);
    setEnabled(config.enabled);
    setMode(config.mode);
    setSaved(false);
  }, [project]);

  async function handleSave() {
    if (!projectId) return;
    try {
      await updateMutation.mutateAsync({ enabled, mode });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      // Surfaced via updateMutation.isError below.
    }
  }

  // ── No project selected ─────────────────────────────────────────
  if (!projectId) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Bot className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium">No Project Selected</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Select a project to configure auto-implement.
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
              Only project administrators can configure auto-implement.
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
            <CardTitle className="text-base">Auto-implement</CardTitle>
            <CardDescription>
              Let the responder turn escalations into landed changes for this
              project (off by default).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Enabled */}
            <div className="flex items-center justify-between rounded-md border px-4 py-3">
              <div className="space-y-0.5">
                <Label htmlFor="auto-implement-enabled">Enabled</Label>
                <p className="text-xs text-muted-foreground">
                  Turn auto-implement on for this project. Off by default.
                </p>
              </div>
              <Switch
                id="auto-implement-enabled"
                checked={enabled}
                onCheckedChange={(checked) => {
                  setEnabled(checked);
                  if (saved) setSaved(false);
                }}
              />
            </div>

            {/* Mode */}
            <div className="space-y-2">
              <Label htmlFor="auto-implement-mode">Mode</Label>
              <Select
                value={mode}
                onValueChange={(value) => {
                  setMode(value as AutoImplementMode);
                  if (saved) setSaved(false);
                }}
              >
                <SelectTrigger
                  id="auto-implement-mode"
                  aria-label="Mode"
                  className="w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">off</SelectItem>
                  <SelectItem value="shadow">shadow</SelectItem>
                  <SelectItem value="on">on</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{MODE_HELP[mode]}</p>
            </div>

            {/* Deployment knobs that stay daemon-level (env) */}
            <p className="text-xs text-muted-foreground">
              Deployment knobs stay daemon-level (environment, not in the UI):
              the git clone URL (PM_RESPONDER_GIT_REPO_URL), token/cost budget
              caps, the path allowlist, and the verify command. Also: the
              daemon's PM_AUTO_IMPLEMENT_ENABLED env is a master kill-switch — if
              set to false it forces auto-implement off for every project
              regardless of this toggle. Set PM_RESPONDER_GIT_REPO_URL on any
              responder where a project enables auto-implement.
            </p>

            {updateMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {updateMutation.error instanceof ApiError
                  ? updateMutation.error.message
                  : "Failed to save auto-implement settings. Please try again."}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={handleSave}
                disabled={updateMutation.isPending}
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
      <Bot className="size-6 text-muted-foreground" />
      <h1 className="text-2xl font-bold tracking-tight">Auto-implement</h1>
    </div>
  );
}
