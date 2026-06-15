import { Link, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  GitBranch,
  GitMerge,
  MessageSquare,
  Siren,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useEscalation, useEscalationMergeRequests } from "@/hooks/use-escalations";
import { formatRelativeTime, formatStatus, getPriorityColor, getStatusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Escalation, EscalationMessage, MergeRequest } from "@/lib/api";

// ─── Helpers ─────────────────────────────────────────────────────

function safeRelative(at: string | null | undefined): string {
  if (!at) return "—";
  return formatRelativeTime(at);
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

function getKindColor(kind: string): string {
  switch (kind) {
    case "bug_report":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    case "question":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case "request":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
    case "blocked":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300";
  }
}

// ─── Lifecycle stage strip ───────────────────────────────────────
//
// GUARDRAIL: this is derived PURELY from the row `status` — NOT from fabricated
// per-transition timestamps (acknowledge appends no message and writes no
// acknowledged_at; answer/resolve/escalate are the only message-bearing
// transitions). The strip shows which stages a status has REACHED; the message
// thread below shows the real diagnosis/system rows that actually exist.

type Stage = { key: string; label: string };

// The happy path; needs_human is a side-channel rendered separately.
const HAPPY_STAGES: Stage[] = [
  { key: "open", label: "Open" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "answered", label: "Answered" },
  { key: "resolved", label: "Resolved" },
];

// How far along the happy path each status counts as having reached.
const STATUS_REACH: Record<Escalation["status"], number> = {
  open: 0,
  acknowledged: 1,
  answered: 2,
  resolved: 3,
  // needs_human branches off — treat as having at least been acknowledged for
  // the strip's "reached" shading, but it is flagged distinctly below.
  needs_human: 1,
};

function LifecycleStrip({ status }: { status: Escalation["status"] }) {
  const reach = STATUS_REACH[status];
  const isResolved = status === "resolved";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {HAPPY_STAGES.map((stage, i) => {
        const reached = i <= reach;
        const isResolvedStage = stage.key === "resolved";
        return (
          <div key={stage.key} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs",
                reached
                  ? isResolvedStage && isResolved
                    ? "border-green-500/40 bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                    : "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground/50",
              )}
            >
              {isResolvedStage && isResolved ? (
                <CheckCircle2 className="size-3" />
              ) : (
                <CircleDot className="size-3" />
              )}
              {stage.label}
            </span>
            {i < HAPPY_STAGES.length - 1 && <span className="text-muted-foreground/40">→</span>}
          </div>
        );
      })}
      {status === "needs_human" && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-100 px-2.5 py-0.5 text-xs text-red-800 dark:bg-red-900/40 dark:text-red-300">
          <AlertTriangle className="size-3" />
          Needs human
        </span>
      )}
    </div>
  );
}

// ─── Message thread row ──────────────────────────────────────────

function messageTypeBadgeClass(type: string | null | undefined): string {
  switch (type) {
    case "system":
      return "bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300";
    case "diagnosis":
      return "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300";
    case "instruction":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case "reply":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300";
  }
}

function MessageRow({ message, isLast }: { message: EscalationMessage; isLast: boolean }) {
  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {!isLast && (
        <span
          className="bg-border absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px"
          aria-hidden
        />
      )}
      <span className="bg-background text-muted-foreground relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border">
        <MessageSquare className="size-4" />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{message.authorId}</span>
          {message.messageType && (
            <Badge
              variant="secondary"
              className={cn("text-[10px]", messageTypeBadgeClass(message.messageType))}
            >
              {formatStatus(message.messageType)}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-1 whitespace-pre-wrap text-sm">{message.body}</p>
        <p className="text-muted-foreground/70 mt-1 text-[11px]">
          {safeRelative(message.createdAt)}
        </p>
      </div>
    </li>
  );
}

// ─── Header ──────────────────────────────────────────────────────

function EscalationHeader({ escalation }: { escalation: Escalation }) {
  const loc = escalation.codeLocator;
  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Siren className="text-muted-foreground size-5" />
          <Badge variant="secondary" className={cn("text-[10px]", getKindColor(escalation.kind))}>
            {formatStatus(escalation.kind)}
          </Badge>
          <Badge
            variant="secondary"
            className={cn("text-[10px]", getStatusColor(escalation.status))}
          >
            {formatStatus(escalation.status)}
          </Badge>
          {escalation.severity && (
            <Badge
              variant="secondary"
              className={cn("text-[10px]", getPriorityColor(escalation.severity))}
            >
              {formatStatus(escalation.severity)}
            </Badge>
          )}
        </div>
        <CardTitle className="text-base">{escalation.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {escalation.body && (
          <p className="text-muted-foreground whitespace-pre-wrap text-sm">{escalation.body}</p>
        )}

        {loc && (
          <div className="text-muted-foreground text-xs">
            <span className="text-muted-foreground/70">Code locator </span>
            <span className="font-mono">
              {loc.path}
              {typeof loc.line === "number" ? `:${loc.line}` : ""}
            </span>
            {loc.commitSha && (
              <span className="text-muted-foreground/60 font-mono">
                {" "}
                @ {loc.commitSha.slice(0, 10)}
              </span>
            )}
          </div>
        )}

        <div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <span className="font-mono">
            origin: {escalation.originRepo} · {escalation.originWorkerKey}
          </span>
          {escalation.holderId && <span>holder: {escalation.holderId}</span>}
          <span>author: {escalation.authorId}</span>
          <span>opened {safeRelative(escalation.createdAt)}</span>
          <span>updated {safeRelative(escalation.updatedAt)}</span>
          {escalation.resolvedAt && <span>resolved {safeRelative(escalation.resolvedAt)}</span>}
          {escalation.resolvedBy && <span>by {escalation.resolvedBy}</span>}
        </div>

        <Link
          to="/projects/$projectId/escalations"
          params={{ projectId: escalation.projectId }}
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          <ArrowLeft className="size-3" />
          Back to escalations
        </Link>
      </CardContent>
    </Card>
  );
}

// ─── Audit chain (A5 P2 — auto-implement legibility) ─────────────
//
// The responder writes thread markers as it drives an escalation through the
// autonomous implement/drive → train → land arc (see responder-ref/src/loop.ts):
//   - pendingDrive {visionPath, epicId}          — a vision + epic was created
//   - pendingArc   {epicId, phaseTaskId, ...}     — a campaign phase MR is in flight
//   - arcComplete  {epicId, landedShas}           — every phase landed
//   - pendingLand  {mergeRequestId, branch, ...}  — a bounded fix MR is in flight
//   - shadowProposal {branch, commitSha, ...}     — shadow mode produced, did NOT land
// extractAuditChain walks the messages newest-first and reads those markers to
// classify the disposition + pull the vision epic. Pure + unit-testable; mirrors
// loop.ts's own marker selection (a `metadata.<flag> === true` membership test).

type MarkerMeta = Record<string, unknown>;

function markerOf(m: EscalationMessage): MarkerMeta | null {
  return m.metadata != null ? (m.metadata as MarkerMeta) : null;
}

function readString(meta: MarkerMeta, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

export type AuditChain = {
  disposition: "auto_driven" | "auto_implemented" | "shadow_proposal" | null;
  epicId: string | null;
  visionPath: string | null;
  arcComplete: boolean;
  hasShadow: boolean;
};

/**
 * Classify an escalation's auto-implement disposition from its thread markers.
 * Walks newest-first so the LATEST drive/arc marker wins for the vision epic.
 * Returns `disposition: null` when no auto-implement marker is present at all
 * (a plain human escalation — the card renders nothing).
 */
export function extractAuditChain(messages: EscalationMessage[]): AuditChain {
  const newestFirst = [...messages].sort((a, b) => b.seq - a.seq);

  let epicId: string | null = null;
  let visionPath: string | null = null;
  let hasDrive = false;
  let hasLand = false;
  let hasShadow = false;
  let arcComplete = false;

  for (const m of newestFirst) {
    const meta = markerOf(m);
    if (!meta) continue;

    if (meta.pendingDrive === true || meta.pendingArc === true) {
      hasDrive = true;
      // Newest-first walk → keep the FIRST (latest) epicId/visionPath seen.
      if (epicId === null) epicId = readString(meta, "epicId");
      if (visionPath === null) visionPath = readString(meta, "visionPath");
      if (meta.arcComplete === true) arcComplete = true;
    }
    if (meta.pendingLand === true) hasLand = true;
    if (meta.shadowProposal === true) hasShadow = true;
  }

  let disposition: AuditChain["disposition"] = null;
  if (hasDrive) disposition = "auto_driven";
  else if (hasLand) disposition = "auto_implemented";
  else if (hasShadow) disposition = "shadow_proposal";

  return { disposition, epicId, visionPath, arcComplete, hasShadow };
}

function dispositionLabel(d: NonNullable<AuditChain["disposition"]>): string {
  switch (d) {
    case "auto_driven":
      return "Auto-driven (arc)";
    case "auto_implemented":
      return "Auto-implemented (bounded)";
    case "shadow_proposal":
      return "Shadow proposal";
  }
}

function mrStatusIsLanded(status: MergeRequest["status"]): boolean {
  return status === "landed";
}

function MergeRequestRow({ mr }: { mr: MergeRequest }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <GitMerge className="text-muted-foreground size-3.5" />
        <Link
          to="/merge-requests/$requestId/timeline"
          params={{ requestId: mr.id }}
          className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          {mr.id.slice(0, 8)}
        </Link>
        <Badge variant="secondary" className={cn("text-[10px]", getStatusColor(mr.status))}>
          {formatStatus(mr.status)}
        </Badge>
        {mr.revertOf && (
          <Badge
            variant="secondary"
            className="bg-orange-100 text-[10px] text-orange-800 dark:bg-orange-900/40 dark:text-orange-300"
          >
            revert of {shortSha(mr.revertOf)}
          </Badge>
        )}
      </div>
      <div className="text-muted-foreground/80 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        {mr.branch && <span className="font-mono">{mr.branch}</span>}
        {mr.landedSha && <span className="font-mono">landed {shortSha(mr.landedSha)}</span>}
        {mr.taskId && (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: mr.taskId }}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            phase task
          </Link>
        )}
        <Link
          to="/merge-requests/$requestId/timeline"
          params={{ requestId: mr.id }}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          View timeline
        </Link>
      </div>
    </li>
  );
}

function AuditChainCard({
  escalation,
}: {
  escalation: Escalation & { messages?: EscalationMessage[] };
}) {
  const chain = extractAuditChain(escalation.messages ?? []);
  const { data: mrs } = useEscalationMergeRequests(escalation.projectId, escalation.id);
  const mergeRequests = mrs ?? [];

  // Render ONLY for an auto-implement escalation: it has a disposition marker OR
  // at least one escalation-linked MR. A plain escalation → null (byte-identical).
  if (chain.disposition === null && mergeRequests.length === 0) return null;

  // If markers are absent but escalation-linked MRs exist, it was at least
  // auto-implemented (a bounded fix submitted before any marker the thread shows).
  const disposition = chain.disposition ?? "auto_implemented";

  // Arc progress: phase MRs are those NOT reverts. Landed vs the rest.
  const phaseMrs = mergeRequests.filter((m) => !m.revertOf);
  const revertMrs = mergeRequests.filter((m) => m.revertOf);
  const landedCount = phaseMrs.filter((m) => mrStatusIsLanded(m.status)).length;

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">Audit chain</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Disposition */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="secondary"
            className="bg-violet-100 text-[11px] text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
          >
            {dispositionLabel(disposition)}
          </Badge>
          {chain.arcComplete && (
            <Badge
              variant="secondary"
              className="bg-green-100 text-[11px] text-green-800 dark:bg-green-900/40 dark:text-green-300"
            >
              <CheckCircle2 className="mr-1 size-3" />
              arc complete
            </Badge>
          )}
        </div>

        {/* Vision epic (drive only) */}
        {chain.epicId && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground/70">Vision epic</span>
            <Link
              to="/epics/$epicId"
              params={{ epicId: chain.epicId }}
              className="font-mono text-blue-600 hover:underline dark:text-blue-400"
            >
              {chain.epicId}
            </Link>
            {chain.visionPath && (
              <span className="text-muted-foreground/60 font-mono">{chain.visionPath}</span>
            )}
          </div>
        )}

        {/* Merge requests */}
        {mergeRequests.length > 0 && (
          <div className="space-y-2">
            <div className="text-muted-foreground/70 flex items-center gap-1.5 text-xs">
              <GitBranch className="size-3.5" />
              Merge requests
            </div>
            <ul className="m-0 list-none space-y-1.5 p-0">
              {mergeRequests.map((mr) => (
                <MergeRequestRow key={mr.id} mr={mr} />
              ))}
            </ul>
          </div>
        )}

        {/* Arc progress (drive, >1 phase MR) */}
        {disposition === "auto_driven" && phaseMrs.length > 1 && (
          <p className="text-muted-foreground text-xs">
            {landedCount} of {phaseMrs.length} phases landed
          </p>
        )}

        {/* Revert chain */}
        {revertMrs.length > 0 && (
          <div className="space-y-1">
            <p className="text-muted-foreground/70 text-xs">Revert chain</p>
            <ul className="m-0 list-none space-y-1 p-0">
              {revertMrs.map((mr) => (
                <li key={mr.id} className="text-xs">
                  <Link
                    to="/merge-requests/$requestId/timeline"
                    params={{ requestId: mr.id }}
                    className="text-orange-700 hover:underline dark:text-orange-300"
                  >
                    revert of {shortSha(mr.revertOf)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────

export function EscalationTimelinePage() {
  const { escalationId } = useParams({ strict: false });
  const { data, isLoading, isError } = useEscalation(escalationId);

  if (!escalationId) return null;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card className="py-4">
        <CardContent className="flex flex-col items-center py-10">
          <AlertTriangle className="text-muted-foreground/40 mb-2 size-8" />
          <p className="text-muted-foreground text-sm">Could not load this escalation.</p>
        </CardContent>
      </Card>
    );
  }

  // Render the thread in ascending seq order (the message log is the truth).
  const messages = [...(data.messages ?? [])].sort((a, b) => a.seq - b.seq);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Escalation</h1>
      </div>

      <EscalationHeader escalation={data} />

      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">Lifecycle</CardTitle>
        </CardHeader>
        <CardContent>
          <LifecycleStrip status={data.status} />
        </CardContent>
      </Card>

      <AuditChainCard escalation={data} />

      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">Thread</CardTitle>
        </CardHeader>
        <CardContent>
          {messages.length === 0 ? (
            <div className="flex flex-col items-center py-6">
              <MessageSquare className="text-muted-foreground/40 mb-2 size-8" />
              <p className="text-muted-foreground text-sm">No messages yet</p>
            </div>
          ) : (
            <ol className="m-0 list-none p-0">
              {messages.map((message, i) => (
                <MessageRow key={message.id} message={message} isLast={i === messages.length - 1} />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
