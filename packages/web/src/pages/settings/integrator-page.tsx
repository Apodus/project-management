import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Boxes, Check, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useProject, useUpdateIntegratorConfig } from "@/hooks/use-projects";
import { useCurrentUser } from "@/hooks/use-auth";
import { integratorConfigFromProject } from "@/lib/integrator";
import { ApiError, type IntegratorConfig, type LinkedRepo } from "@/lib/api";
import { useProjectStore } from "@/stores/project-store";

export function IntegratorPage() {
  const params = useParams({ strict: false });
  const { currentProjectId } = useProjectStore();
  const projectId =
    (params as Record<string, string | undefined>).projectId ??
    currentProjectId ??
    undefined;

  const { data: user } = useCurrentUser();
  const isAdmin = user?.role === "admin";

  const { data: project, isLoading, error, refetch } = useProject(projectId);
  const updateMutation = useUpdateIntegratorConfig(projectId);

  // Form state — strings for number inputs so we can validate/show partials.
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [parallelism, setParallelism] = useState("1");
  const [verifyTimeoutSec, setVerifyTimeoutSec] = useState("600");
  const [gitRemote, setGitRemote] = useState("origin");
  const [gitMainBranch, setGitMainBranch] = useState("main");
  const [verifyCommand, setVerifyCommand] = useState("");
  const [cleanKeep, setCleanKeep] = useState<string[]>([]);
  const [linkedRepos, setLinkedRepos] = useState<LinkedRepo[]>([]);
  const [saved, setSaved] = useState(false);

  // Hydrate the form from the project's persisted integrator block.
  useEffect(() => {
    if (!project) return;
    const config = integratorConfigFromProject(project);
    setEnabled(config.enabled);
    setParallelism(String(config.parallelism));
    setVerifyTimeoutSec(String(config.verify_timeout_sec));
    setGitRemote(config.git_remote);
    setGitMainBranch(config.git_main_branch);
    setVerifyCommand(config.verify_command ?? "");
    setWorktreeRoot(config.worktree_root ?? "");
    setCleanKeep(config.clean_keep);
    setLinkedRepos(config.linked_repos);
    setGitRepoUrl(project.gitRepoUrl ?? "");
    setSaved(false);
  }, [project]);

  // ── Validation ──────────────────────────────────────────────────
  const parallelismNum = Number(parallelism);
  const verifyTimeoutNum = Number(verifyTimeoutSec);
  const parallelismValid =
    Number.isInteger(parallelismNum) && parallelismNum >= 1;
  const verifyTimeoutValid =
    Number.isInteger(verifyTimeoutNum) && verifyTimeoutNum >= 1;
  const enabledReqsMet =
    !enabled || (verifyCommand.trim() !== "" && worktreeRoot.trim() !== "");
  const linkedReposValid = linkedRepos.every(
    (r) =>
      (r.name.trim() === "" && r.path.trim() === "") ||
      (r.name.trim() !== "" && r.path.trim() !== ""),
  );
  const isValid =
    parallelismValid &&
    verifyTimeoutValid &&
    enabledReqsMet &&
    linkedReposValid;

  // ── clean_keep editors ──────────────────────────────────────────
  function updateCleanKeep(i: number, value: string) {
    setCleanKeep((prev) => prev.map((p, idx) => (idx === i ? value : p)));
    if (saved) setSaved(false);
  }
  function addCleanKeep() {
    setCleanKeep((prev) => [...prev, ""]);
    if (saved) setSaved(false);
  }
  function removeCleanKeep(i: number) {
    setCleanKeep((prev) => prev.filter((_, idx) => idx !== i));
    if (saved) setSaved(false);
  }

  // ── linked_repos editors ────────────────────────────────────────
  function updateRow(i: number, patch: Partial<LinkedRepo>) {
    setLinkedRepos((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
    if (saved) setSaved(false);
  }
  function addRow() {
    setLinkedRepos((prev) => [...prev, { name: "", path: "", role: "inner" }]);
    if (saved) setSaved(false);
  }
  function removeRow(i: number) {
    setLinkedRepos((prev) => prev.filter((_, idx) => idx !== i));
    if (saved) setSaved(false);
  }

  async function handleSave() {
    if (!projectId || !isValid) return;

    const config: IntegratorConfig = {
      enabled,
      verify_timeout_sec: verifyTimeoutNum,
      git_remote: gitRemote.trim(),
      git_main_branch: gitMainBranch.trim(),
      parallelism: parallelismNum,
      linked_repos: linkedRepos
        .filter((r) => r.name.trim() !== "" && r.path.trim() !== "")
        .map((r) => {
          const row: LinkedRepo = {
            name: r.name.trim(),
            path: r.path.trim(),
            role: r.role,
          };
          if (r.gitlink_parent && r.gitlink_parent.trim() !== "")
            row.gitlink_parent = r.gitlink_parent.trim();
          if (r.gitlink_path && r.gitlink_path.trim() !== "")
            row.gitlink_path = r.gitlink_path.trim();
          return row;
        }),
      clean_keep: cleanKeep.map((s) => s.trim()).filter((s) => s !== ""),
    };
    // Absent verify_command/worktree_root stay absent (server omitted them).
    if (verifyCommand.trim()) config.verify_command = verifyCommand;
    if (worktreeRoot.trim()) config.worktree_root = worktreeRoot;

    const url = gitRepoUrl.trim();

    try {
      await updateMutation.mutateAsync({
        config,
        gitRepoUrl: url === "" ? null : url,
      });
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
            <Boxes className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium">No Project Selected</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Select a project to configure the integrator.
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
              Only project administrators can configure the integrator.
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
            <CardTitle className="text-base">Integrator daemon</CardTitle>
            <CardDescription>
              Configure how the merge-train integrator clones, verifies, and
              lands changes for this project. These fields map to the editable
              part of <code className="text-xs">settings.integrator</code>;
              every other integrator field is preserved untouched on save.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Git repository URL */}
            <div className="space-y-2">
              <Label htmlFor="integrator-git-repo-url">
                Git repository URL
              </Label>
              <Input
                id="integrator-git-repo-url"
                value={gitRepoUrl}
                onChange={(e) => {
                  setGitRepoUrl(e.target.value);
                  if (saved) setSaved(false);
                }}
                placeholder="git@github.com:org/repo.git"
                className="max-w-xl"
              />
              <p className="text-xs text-muted-foreground">
                Clone URL the integrator pushes/pulls; blank to unset.
              </p>
            </div>

            {/* Enabled */}
            <div className="flex items-center justify-between rounded-md border px-4 py-3">
              <div className="space-y-0.5">
                <Label htmlFor="integrator-enabled">Enabled</Label>
                <p className="text-xs text-muted-foreground">
                  Turn the integrator on for this project.
                </p>
              </div>
              <Switch
                id="integrator-enabled"
                checked={enabled}
                onCheckedChange={(checked) => {
                  setEnabled(checked);
                  if (saved) setSaved(false);
                }}
              />
            </div>
            {enabled && !enabledReqsMet && (
              <p className="text-xs text-destructive">
                Enabling the integrator requires a verify command and a worktree
                root.
              </p>
            )}

            {/* Worktree root */}
            <div className="space-y-2">
              <Label htmlFor="integrator-worktree-root">Worktree root</Label>
              <Input
                id="integrator-worktree-root"
                value={worktreeRoot}
                onChange={(e) => {
                  setWorktreeRoot(e.target.value);
                  if (saved) setSaved(false);
                }}
                aria-invalid={enabled && worktreeRoot.trim() === ""}
                placeholder="/var/integrator/worktrees"
                className="max-w-xl"
              />
              <p className="text-xs text-muted-foreground">
                Directory under which the integrator creates isolated worktree
                clones.
              </p>
            </div>

            {/* Parallelism */}
            <div className="space-y-2">
              <Label htmlFor="integrator-parallelism">Parallelism</Label>
              <Input
                id="integrator-parallelism"
                type="number"
                min={1}
                step={1}
                value={parallelism}
                onChange={(e) => {
                  setParallelism(e.target.value);
                  if (saved) setSaved(false);
                }}
                aria-invalid={!parallelismValid}
                className="max-w-xs"
              />
              {parallelismValid ? (
                <p className="text-xs text-muted-foreground">
                  Number of integrations to run in flight at once (1 = serial).
                </p>
              ) : (
                <p className="text-xs text-destructive">
                  Must be a whole number ≥ 1.
                </p>
              )}
            </div>

            {/* Verify timeout */}
            <div className="space-y-2">
              <Label htmlFor="integrator-verify-timeout">
                Verify timeout (seconds)
              </Label>
              <Input
                id="integrator-verify-timeout"
                type="number"
                min={1}
                step={1}
                value={verifyTimeoutSec}
                onChange={(e) => {
                  setVerifyTimeoutSec(e.target.value);
                  if (saved) setSaved(false);
                }}
                aria-invalid={!verifyTimeoutValid}
                className="max-w-xs"
              />
              {verifyTimeoutValid ? (
                <p className="text-xs text-muted-foreground">
                  Wall-clock budget for a verify run before it is killed.
                </p>
              ) : (
                <p className="text-xs text-destructive">
                  Must be a whole number ≥ 1.
                </p>
              )}
            </div>

            {/* Git remote */}
            <div className="space-y-2">
              <Label htmlFor="integrator-git-remote">Git remote</Label>
              <Input
                id="integrator-git-remote"
                value={gitRemote}
                onChange={(e) => {
                  setGitRemote(e.target.value);
                  if (saved) setSaved(false);
                }}
                className="max-w-xs"
              />
              <p className="text-xs text-muted-foreground">
                Remote name the integrator fetches from and pushes to.
              </p>
            </div>

            {/* Git main branch */}
            <div className="space-y-2">
              <Label htmlFor="integrator-git-main-branch">
                Git main branch
              </Label>
              <Input
                id="integrator-git-main-branch"
                value={gitMainBranch}
                onChange={(e) => {
                  setGitMainBranch(e.target.value);
                  if (saved) setSaved(false);
                }}
                className="max-w-xs"
              />
              <p className="text-xs text-muted-foreground">
                Branch that changes land onto.
              </p>
            </div>

            {/* Verify command */}
            <div className="space-y-2">
              <Label htmlFor="integrator-verify-command">Verify command</Label>
              <Input
                id="integrator-verify-command"
                value={verifyCommand}
                onChange={(e) => {
                  setVerifyCommand(e.target.value);
                  if (saved) setSaved(false);
                }}
                aria-invalid={enabled && verifyCommand.trim() === ""}
                placeholder="pnpm verify"
                className="max-w-xl"
              />
              <p className="text-xs text-muted-foreground">
                Command run in the worktree to gate a land. Required when the
                integrator is enabled.
              </p>
            </div>

            {/* clean_keep editor */}
            <div className="space-y-2">
              <Label>Clean keep paths</Label>
              <div className="space-y-2">
                {cleanKeep.map((value, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      aria-label={`Clean keep ${i + 1}`}
                      value={value}
                      onChange={(e) => updateCleanKeep(i, e.target.value)}
                      className="max-w-xl"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Remove clean keep ${i + 1}`}
                      onClick={() => removeCleanKeep(i)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={addCleanKeep}>
                Add path
              </Button>
              <p className="text-xs text-muted-foreground">
                Glob paths preserved when the integrator cleans a worktree.
                Blank entries are dropped on save.
              </p>
            </div>

            {/* linked_repos editor */}
            <div className="space-y-2">
              <Label>Linked repositories</Label>
              <div className="space-y-3">
                {linkedRepos.map((repo, i) => (
                  <div key={i} className="space-y-2 rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label={`Linked repo name ${i + 1}`}
                        placeholder="name"
                        value={repo.name}
                        onChange={(e) =>
                          updateRow(i, { name: e.target.value })
                        }
                        className="max-w-xs"
                      />
                      <Input
                        aria-label={`Linked repo path ${i + 1}`}
                        placeholder="path"
                        value={repo.path}
                        onChange={(e) =>
                          updateRow(i, { path: e.target.value })
                        }
                        className="max-w-xs"
                      />
                      <Select
                        value={repo.role}
                        onValueChange={(value) =>
                          updateRow(i, {
                            role: value as LinkedRepo["role"],
                          })
                        }
                      >
                        <SelectTrigger
                          aria-label={`Linked repo role ${i + 1}`}
                          className="w-32"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="inner">inner</SelectItem>
                          <SelectItem value="outer">outer</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Remove linked repo ${i + 1}`}
                        onClick={() => removeRow(i)}
                      >
                        Remove
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label={`Linked repo gitlink parent ${i + 1}`}
                        placeholder="gitlink parent (optional)"
                        value={repo.gitlink_parent ?? ""}
                        onChange={(e) =>
                          updateRow(i, { gitlink_parent: e.target.value })
                        }
                        className="max-w-xs"
                      />
                      <Input
                        aria-label={`Linked repo gitlink path ${i + 1}`}
                        placeholder="gitlink path (optional)"
                        value={repo.gitlink_path ?? ""}
                        onChange={(e) =>
                          updateRow(i, { gitlink_path: e.target.value })
                        }
                        className="max-w-xs"
                      />
                    </div>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={addRow}>
                Add repository
              </Button>
              <p className="text-xs text-muted-foreground">
                Inner/outer repos that land atomically as a cross-repo group.
                Rows with a blank name and path are dropped on save.
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              Advanced integrator fields (verify steps DAG, cache, SLO,
              resolver) are REST-only for now — see
              docs/integrator-deployment.md.
            </p>

            {updateMutation.isError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {updateMutation.error instanceof ApiError
                  ? updateMutation.error.message
                  : "Failed to save integrator settings. Please try again."}
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
      <Boxes className="size-6 text-muted-foreground" />
      <h1 className="text-2xl font-bold tracking-tight">Integrator</h1>
    </div>
  );
}
