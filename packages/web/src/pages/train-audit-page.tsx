import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  PauseCircle,
  PlayCircle,
  ShieldAlert,
  ShieldX,
  Unlock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  useAuditLog,
  useForceCancel,
  useForceLand,
  useForceReject,
  useForceReleaseLock,
  useMergeRequests,
  usePauseTrain,
  useResumeTrain,
  useTrainState,
} from "@/hooks/use-train";
import { useCurrentUser } from "@/hooks/use-auth";
import type { AuditFilters, AuditLogEntry, MergeRequest } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// ─── Typed filter option lists (catch api-types drift via `satisfies`) ──

const AUDIT_ACTION_OPTIONS = [
  "pause",
  "resume",
  "force_release_lock",
  "force_land",
  "force_reject",
  "force_cancel",
  "land",
  "reject",
] as const satisfies readonly AuditLogEntry["action"][];

const AUDIT_TARGET_TYPE_OPTIONS = [
  "merge_request",
  "merge_group",
  "merge_lock",
  "train",
] as const satisfies readonly AuditLogEntry["targetType"][];

// Override actions get a prominent amber/red badge so they stand out.
const OVERRIDE_ACTIONS = new Set<AuditLogEntry["action"]>([
  "force_land",
  "force_reject",
  "force_cancel",
]);

const ALL = "__all__";

function formatActionLabel(action: string): string {
  return action.replace(/_/g, " ");
}

// ─── Merge-request picker (shared by the force dialogs) ──────────

/** Human-readable option label: branch handle · status · age · short id. */
function mergeRequestLabel(r: MergeRequest): string {
  const handle =
    r.branch ?? (r.commitSha ? r.commitSha.slice(0, 7) : "(no branch)");
  const age = r.enqueuedAt ? formatRelativeTime(r.enqueuedAt) : "";
  return `${handle} · ${r.status}${age ? ` · ${age}` : ""} · …${r.id.slice(-5)}`;
}

/**
 * A Select of the merge requests valid for the calling operation (filtered to
 * `statuses` server-side), so the operator picks a request instead of typing a
 * ULID. Defers the fetch until `open`, and refreshes after any force-* mutation
 * (the hook lives under trainKeys.all).
 */
function MergeRequestPicker({
  projectId,
  open,
  statuses,
  value,
  onChange,
}: {
  projectId: string;
  open: boolean;
  statuses: readonly string[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { data, isLoading } = useMergeRequests(projectId, statuses, {
    enabled: open,
  });
  const requests = data ?? [];
  const empty = !isLoading && requests.length === 0;
  const statusList = statuses.join(" or ");

  return (
    <div className="space-y-2">
      <Label htmlFor="mr-picker">Merge request</Label>
      <Select value={value} onValueChange={onChange} disabled={isLoading || empty}>
        <SelectTrigger id="mr-picker" className="w-full">
          <SelectValue
            placeholder={
              isLoading
                ? "Loading…"
                : empty
                  ? `No ${statusList} requests`
                  : "Select a request"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {requests.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {mergeRequestLabel(r)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {empty && (
        <p className="text-xs text-muted-foreground">
          No {statusList} requests in this lane — nothing to act on.
        </p>
      )}
    </div>
  );
}

// ─── Force-land dialog (two-step R1-override) ────────────────────

function ForceLandDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const [requestId, setRequestId] = useState("");
  const [landedSha, setLandedSha] = useState("");
  const [reason, setReason] = useState("");
  const forceLandMutation = useForceLand();

  function reset() {
    setRequestId("");
    setLandedSha("");
    setReason("");
    forceLandMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const canSubmit =
    requestId.trim().length > 0 &&
    reason.trim().length > 0 &&
    landedSha.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      await forceLandMutation.mutateAsync({
        requestId: requestId.trim(),
        landedSha: landedSha.trim(),
        reason: reason.trim(),
      });
      handleOpenChange(false);
    } catch {
      // onError toast surfaces the backend message.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-red-500" />
            Force-land merge request
          </DialogTitle>
          <DialogDescription>
            Land an integrating request without the verify gate. Admin-only,
            reason-required.
          </DialogDescription>
        </DialogHeader>

        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            This bypasses the verify gate and advances main past an unverified
            tree. Recorded in the audit log.
          </span>
        </div>

        <div className="space-y-4">
          <MergeRequestPicker
            projectId={projectId}
            open={open}
            statuses={["integrating"]}
            value={requestId}
            onChange={setRequestId}
          />
          <div className="space-y-2">
            <Label htmlFor="force-land-sha">Landed SHA</Label>
            <Input
              id="force-land-sha"
              placeholder="abc1234"
              value={landedSha}
              onChange={(e) => setLandedSha(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="force-land-reason">Reason</Label>
            <Textarea
              id="force-land-reason"
              placeholder="hotfix for prod outage; verify infra down"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={!canSubmit || forceLandMutation.isPending}
          >
            {forceLandMutation.isPending ? "Force-landing…" : "Force-land"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Force-reject dialog ─────────────────────────────────────────

function ForceRejectDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const [requestId, setRequestId] = useState("");
  const [reason, setReason] = useState("");
  const forceRejectMutation = useForceReject();

  function reset() {
    setRequestId("");
    setReason("");
    forceRejectMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const canSubmit = requestId.trim().length > 0 && reason.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      await forceRejectMutation.mutateAsync({
        requestId: requestId.trim(),
        reason: reason.trim(),
      });
      handleOpenChange(false);
    } catch {
      // onError toast surfaces the backend message.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldX className="size-5 text-amber-500" />
            Force-reject merge request
          </DialogTitle>
          <DialogDescription>
            Reject a stuck integrating request on policy grounds. Admin-only,
            reason-required.
          </DialogDescription>
        </DialogHeader>

        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Rejects on policy grounds (overridden). Recorded in the audit log.
          </span>
        </div>

        <div className="space-y-4">
          <MergeRequestPicker
            projectId={projectId}
            open={open}
            statuses={["integrating"]}
            value={requestId}
            onChange={setRequestId}
          />
          <div className="space-y-2">
            <Label htmlFor="force-reject-reason">Reason</Label>
            <Textarea
              id="force-reject-reason"
              placeholder="obsoleted by a newer request; clearing the lane"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={!canSubmit || forceRejectMutation.isPending}
          >
            {forceRejectMutation.isPending ? "Force-rejecting…" : "Force-reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Force-cancel dialog ─────────────────────────────────────────

function ForceCancelDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const [requestId, setRequestId] = useState("");
  const [reason, setReason] = useState("");
  const forceCancelMutation = useForceCancel();

  function reset() {
    setRequestId("");
    setReason("");
    forceCancelMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const canSubmit = requestId.trim().length > 0 && reason.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      await forceCancelMutation.mutateAsync({
        requestId: requestId.trim(),
        reason: reason.trim(),
      });
      handleOpenChange(false);
    } catch {
      // onError toast surfaces the backend message.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="size-5 text-amber-500" />
            Force-cancel merge request
          </DialogTitle>
          <DialogDescription>
            Abandon a stuck request — works on a <strong>queued</strong> or
            integrating request (the queued-state escape hatch force-reject
            cannot reach). Admin-only, reason-required.
          </DialogDescription>
        </DialogHeader>

        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Abandons the request (overridden). Recorded in the audit log.
          </span>
        </div>

        <div className="space-y-4">
          <MergeRequestPicker
            projectId={projectId}
            open={open}
            statuses={["queued", "integrating"]}
            value={requestId}
            onChange={setRequestId}
          />
          <div className="space-y-2">
            <Label htmlFor="force-cancel-reason">Reason</Label>
            <Textarea
              id="force-cancel-reason"
              placeholder="content hand-landed out-of-band; clearing the stale queued entry"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={!canSubmit || forceCancelMutation.isPending}
          >
            {forceCancelMutation.isPending ? "Force-cancelling…" : "Force-cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Force-release-lock dialog ───────────────────────────────────

function ForceReleaseLockDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const [reason, setReason] = useState("");
  const forceReleaseMutation = useForceReleaseLock();

  function reset() {
    setReason("");
    forceReleaseMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSubmit() {
    try {
      await forceReleaseMutation.mutateAsync({
        projectId,
        resource: "main",
        reason: reason.trim() || undefined,
      });
      handleOpenChange(false);
    } catch {
      // onError toast surfaces the backend message.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Unlock className="size-5" />
            Force-release merge lock
          </DialogTitle>
          <DialogDescription>
            Force-release the <code className="font-mono">main</code> merge lock
            held by the integrator. Recorded in the audit log.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="force-release-reason">Reason (optional)</Label>
          <Textarea
            id="force-release-reason"
            placeholder="integrator crashed holding the lock"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={forceReleaseMutation.isPending}
          >
            {forceReleaseMutation.isPending ? "Releasing…" : "Force-release"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pause / Resume control ──────────────────────────────────────

function PauseResumeControl({ projectId }: { projectId: string }) {
  const { data: state } = useTrainState(projectId);
  const pauseMutation = usePauseTrain();
  const resumeMutation = useResumeTrain();
  const [reason, setReason] = useState("");

  const isPaused = state?.state === "paused";

  function handlePause() {
    pauseMutation.mutate({
      projectId,
      resource: "main",
      reason: reason.trim() || undefined,
    });
  }

  function handleResume() {
    resumeMutation.mutate({
      projectId,
      resource: "main",
      reason: reason.trim() || undefined,
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Train state:</span>
        <Badge
          variant="secondary"
          className={cn(
            "text-xs",
            isPaused
              ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400",
          )}
        >
          {isPaused ? "Paused" : "Running"}
        </Badge>
      </div>
      <div className="space-y-2">
        <Label htmlFor="pause-reason">Reason (optional)</Label>
        <Input
          id="pause-reason"
          placeholder="why are you pausing/resuming the train?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {isPaused ? (
        <Button onClick={handleResume} disabled={resumeMutation.isPending}>
          <PlayCircle className="size-4" />
          Resume train
        </Button>
      ) : (
        <Button
          variant="outline"
          onClick={handlePause}
          disabled={pauseMutation.isPending}
        >
          <PauseCircle className="size-4" />
          Pause train
        </Button>
      )}
    </div>
  );
}

// ─── Break-glass controls section ────────────────────────────────

function BreakGlassControls({ projectId }: { projectId: string }) {
  const [forceLandOpen, setForceLandOpen] = useState(false);
  const [forceRejectOpen, setForceRejectOpen] = useState(false);
  const [forceCancelOpen, setForceCancelOpen] = useState(false);
  const [forceReleaseOpen, setForceReleaseOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4 text-red-500" />
          Break-glass controls
        </CardTitle>
        <CardDescription>
          Deliberate human R1-overrides. Every action below is recorded in the
          audit log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Pause / resume */}
        <PauseResumeControl projectId={projectId} />

        {/* Override actions */}
        <div className="grid gap-3 border-t pt-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Button
              variant="destructive"
              className="w-full"
              onClick={() => setForceLandOpen(true)}
            >
              <ShieldAlert className="size-4" />
              Force-land…
            </Button>
            <p className="text-xs text-muted-foreground">
              Land an integrating request without verify.
            </p>
          </div>
          <div className="space-y-2">
            <Button
              variant="destructive"
              className="w-full"
              onClick={() => setForceRejectOpen(true)}
            >
              <ShieldX className="size-4" />
              Force-reject…
            </Button>
            <p className="text-xs text-muted-foreground">
              Reject a stuck integrating request on policy grounds.
            </p>
          </div>
          <div className="space-y-2">
            <Button
              variant="destructive"
              className="w-full"
              onClick={() => setForceCancelOpen(true)}
            >
              <Ban className="size-4" />
              Force-cancel…
            </Button>
            <p className="text-xs text-muted-foreground">
              Abandon a stuck queued or integrating request.
            </p>
          </div>
          <div className="space-y-2">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setForceReleaseOpen(true)}
            >
              <Unlock className="size-4" />
              Force-release lock…
            </Button>
            <p className="text-xs text-muted-foreground">
              Release the main merge lock.
            </p>
          </div>
        </div>
      </CardContent>

      <ForceLandDialog
        open={forceLandOpen}
        onOpenChange={setForceLandOpen}
        projectId={projectId}
      />
      <ForceRejectDialog
        open={forceRejectOpen}
        onOpenChange={setForceRejectOpen}
        projectId={projectId}
      />
      <ForceCancelDialog
        open={forceCancelOpen}
        onOpenChange={setForceCancelOpen}
        projectId={projectId}
      />
      <ForceReleaseLockDialog
        open={forceReleaseOpen}
        onOpenChange={setForceReleaseOpen}
        projectId={projectId}
      />
    </Card>
  );
}

// ─── Audit log section ───────────────────────────────────────────

function AuditLogSection({ projectId }: { projectId: string }) {
  const [filters, setFilters] = useState<AuditFilters>({ page: 1 });
  const { data, isLoading } = useAuditLog(projectId, filters);

  const rows = data?.data ?? [];
  const pagination = data?.pagination;
  const page = filters.page ?? 1;
  const perPage = pagination?.perPage ?? 50;
  const total = pagination?.total ?? 0;
  const totalPages = total > 0 ? Math.ceil(total / perPage) : 1;

  function setFilter<K extends keyof AuditFilters>(
    key: K,
    value: AuditFilters[K],
  ) {
    // Any filter change resets to page 1.
    setFilters((prev) => ({ ...prev, [key]: value, page: 1 }));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Audit log</CardTitle>
        <CardDescription>
          Append-only record of who did what to the train and why.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="audit-filter-user">Actor</Label>
            <Input
              id="audit-filter-user"
              placeholder="user id"
              value={filters.userId ?? ""}
              onChange={(e) =>
                setFilter("userId", e.target.value || undefined)
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-filter-action">Action</Label>
            <Select
              value={filters.action ?? ALL}
              onValueChange={(v) =>
                setFilter(
                  "action",
                  v === ALL ? undefined : (v as AuditLogEntry["action"]),
                )
              }
            >
              <SelectTrigger id="audit-filter-action" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All actions</SelectItem>
                {AUDIT_ACTION_OPTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {formatActionLabel(a)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-filter-target">Target type</Label>
            <Select
              value={filters.targetType ?? ALL}
              onValueChange={(v) =>
                setFilter(
                  "targetType",
                  v === ALL ? undefined : (v as AuditLogEntry["targetType"]),
                )
              }
            >
              <SelectTrigger id="audit-filter-target" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All targets</SelectItem>
                {AUDIT_TARGET_TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {formatActionLabel(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-filter-from">From</Label>
            <Input
              id="audit-filter-from"
              type="date"
              value={filters.from ?? ""}
              onChange={(e) => setFilter("from", e.target.value || undefined)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-filter-to">To</Label>
            <Input
              id="audit-filter-to"
              type="date"
              value={filters.to ?? ""}
              onChange={(e) => setFilter("to", e.target.value || undefined)}
            />
          </div>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-sm text-muted-foreground">
            <ShieldAlert className="mb-2 size-8 text-muted-foreground/40" />
            No audit entries match these filters.
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {entry.actorId.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs",
                          OVERRIDE_ACTIONS.has(entry.action)
                            ? entry.action === "force_land"
                              ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
                              : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                            : undefined,
                        )}
                      >
                        {formatActionLabel(entry.action)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="text-muted-foreground">
                        {formatActionLabel(entry.targetType)}
                      </span>{" "}
                      <span className="font-mono">
                        {entry.targetId.slice(0, 8)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-sm">
                      {entry.reason ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelativeTime(entry.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination footer */}
        {rows.length > 0 && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Page {page} of {totalPages} · {total} entr
              {total === 1 ? "y" : "ies"}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() =>
                  setFilters((prev) => ({
                    ...prev,
                    page: Math.max(1, (prev.page ?? 1) - 1),
                  }))
                }
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() =>
                  setFilters((prev) => ({
                    ...prev,
                    page: (prev.page ?? 1) + 1,
                  }))
                }
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────

export function TrainAuditPage() {
  const { projectId } = useParams({ strict: false });
  const { data: user } = useCurrentUser();

  // PAGE GATE: the whole break-glass + audit surface is admin-only.
  // Defense-in-depth — the backend 403 is the real gate.
  if (user && user.role !== "admin") {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <ShieldAlert className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">
            Break-glass / Audit
          </h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <ShieldAlert className="mb-4 size-12 text-muted-foreground/50" />
            <h3 className="text-lg font-medium">Access Denied</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Only administrators can use break-glass controls and view the
              audit log.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!projectId) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <ShieldAlert className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">
          Break-glass / Audit
        </h1>
      </div>

      <BreakGlassControls projectId={projectId} />
      <AuditLogSection projectId={projectId} />
    </div>
  );
}
