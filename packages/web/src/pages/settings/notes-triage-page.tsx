import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Check, Inbox, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { useProject, useUpdateNotesTriageConfig } from "@/hooks/use-projects";
import { useCurrentUser } from "@/hooks/use-auth";
import { ApiError, type NotesTriageConfig, type Project } from "@/lib/api";
import { useProjectStore } from "@/stores/project-store";

type NotesTriageMode = NotesTriageConfig["mode"];

// Read-through the persisted `settings.notesTriage` block tolerantly: a project
// with no block (or no per-field) falls back to the safe defaults (off / shadow).
function notesTriageConfigFromProject(project: Project | undefined): {
  enabled: boolean;
  mode: NotesTriageMode;
  triageAgentId: string;
} {
  const block = (project?.settings as { notesTriage?: NotesTriageConfig } | null | undefined)
    ?.notesTriage;
  return {
    enabled: block?.enabled ?? false,
    mode: block?.mode ?? "shadow",
    triageAgentId: block?.triageAgentId ?? "",
  };
}

const MODE_HELP: Record<NotesTriageMode, string> = {
  off: "Inert: the triager does nothing for this project, even if the toggle is on.",
  shadow:
    "Observe: the triager records would-be decisions to the audit side-log and mutates nothing. Safe to run in production.",
  on: "Autonomous: the triager acts on its decisions (flag needs-human, dismiss, promote). Dismiss requires the triage agent ID below to match the daemon's API-token identity.",
};

export function NotesTriagePage() {
  const params = useParams({ strict: false });
  const { currentProjectId } = useProjectStore();
  const projectId =
    (params as Record<string, string | undefined>).projectId ?? currentProjectId ?? undefined;

  const { data: user } = useCurrentUser();
  const isAdmin = user?.role === "admin";

  const { data: project, isLoading, error, refetch } = useProject(projectId);
  const updateMutation = useUpdateNotesTriageConfig(projectId);

  // Form state.
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<NotesTriageMode>("shadow");
  const [triageAgentId, setTriageAgentId] = useState("");
  const [saved, setSaved] = useState(false);

  // Hydrate the form from the project's persisted notesTriage block.
  useEffect(() => {
    if (!project) return;
    const config = notesTriageConfigFromProject(project);
    setEnabled(config.enabled);
    setMode(config.mode);
    setTriageAgentId(config.triageAgentId);
    setSaved(false);
  }, [project]);

  async function handleSave() {
    if (!projectId) return;
    try {
      // Omit triageAgentId when blank — the server schema is
      // z.string().min(1).optional(), so an empty string is a 400.
      const block: NotesTriageConfig = { enabled, mode };
      if (triageAgentId.trim()) block.triageAgentId = triageAgentId.trim();
      await updateMutation.mutateAsync(block);
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
            <Inbox className="text-muted-foreground/50 mb-4 size-12" />
            <h3 className="text-lg font-medium">No Project Selected</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Select a project to configure notes triage.
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
            <ShieldAlert className="text-muted-foreground/50 mb-4 size-12" />
            <h3 className="text-lg font-medium">Admin access required</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Only project administrators can configure notes triage.
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
            <p className="text-destructive text-sm">
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
            <CardTitle className="text-base">Notes triage</CardTitle>
            <CardDescription>
              Let the triager daemon classify and act on incoming notes for this project (ships off;
              defaults to shadow when first enabled). Saving replaces only settings.notesTriage —
              every other settings block is preserved.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Enabled */}
            <div className="flex items-center justify-between rounded-md border px-4 py-3">
              <div className="space-y-0.5">
                <Label htmlFor="notes-triage-enabled">Enabled</Label>
                <p className="text-muted-foreground text-xs">
                  Turn notes triage on for this project. Off by default.
                </p>
              </div>
              <Switch
                id="notes-triage-enabled"
                checked={enabled}
                onCheckedChange={(checked) => {
                  setEnabled(checked);
                  if (saved) setSaved(false);
                }}
              />
            </div>

            {/* Mode */}
            <div className="space-y-2">
              <Label htmlFor="notes-triage-mode">Mode</Label>
              <Select
                value={mode}
                onValueChange={(value) => {
                  setMode(value as NotesTriageMode);
                  if (saved) setSaved(false);
                }}
              >
                <SelectTrigger id="notes-triage-mode" aria-label="Mode" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">off</SelectItem>
                  <SelectItem value="shadow">shadow</SelectItem>
                  <SelectItem value="on">on</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">{MODE_HELP[mode]}</p>
            </div>

            {/* Triage agent ID (optional) */}
            <div className="space-y-2">
              <Label htmlFor="notes-triage-agent-id">Triage agent ID</Label>
              <Input
                id="notes-triage-agent-id"
                value={triageAgentId}
                placeholder="(optional)"
                onChange={(e) => {
                  setTriageAgentId(e.target.value);
                  if (saved) setSaved(false);
                }}
                className="max-w-md"
              />
              <p className="text-muted-foreground text-xs">
                Optional. The triager daemon's API-token identity. Used by the on-mode dismiss authz
                — <code>on</code> mode can only dismiss a note if this matches the daemon's
                identity. Leave blank in off/shadow mode.
              </p>
            </div>

            {/* Deployment knobs that stay daemon-level (env) */}
            <p className="text-muted-foreground text-xs">
              The triager reads resolveNotesTriage(env, settings), so a daemon-level env kill-switch
              (PM_NOTES_TRIAGE_ENABLED) overrides this toggle — if set to false it forces notes
              triage off for every project regardless of this setting.
            </p>

            {updateMutation.isError && (
              <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
                {updateMutation.error instanceof ApiError
                  ? updateMutation.error.message
                  : "Failed to save notes triage settings. Please try again."}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={updateMutation.isPending}>
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
      <Inbox className="text-muted-foreground size-6" />
      <h1 className="text-2xl font-bold tracking-tight">Notes triage</h1>
    </div>
  );
}
