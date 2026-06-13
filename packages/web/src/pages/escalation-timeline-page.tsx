import { Link, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  MessageSquare,
  Siren,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useEscalation } from "@/hooks/use-escalations";
import {
  formatRelativeTime,
  formatStatus,
  getPriorityColor,
  getStatusColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Escalation, EscalationMessage } from "@/lib/api";

// ─── Helpers ─────────────────────────────────────────────────────

function safeRelative(at: string | null | undefined): string {
  if (!at) return "—";
  return formatRelativeTime(at);
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
            {i < HAPPY_STAGES.length - 1 && (
              <span className="text-muted-foreground/40">→</span>
            )}
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

function MessageRow({
  message,
  isLast,
}: {
  message: EscalationMessage;
  isLast: boolean;
}) {
  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {!isLast && (
        <span
          className="bg-border absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px"
          aria-hidden
        />
      )}
      <span className="bg-background relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border text-muted-foreground">
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
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
          {message.body}
        </p>
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
          <Badge
            variant="secondary"
            className={cn("text-[10px]", getKindColor(escalation.kind))}
          >
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
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {escalation.body}
          </p>
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
                {" "}@ {loc.commitSha.slice(0, 10)}
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
          {escalation.resolvedAt && (
            <span>resolved {safeRelative(escalation.resolvedAt)}</span>
          )}
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
          <p className="text-muted-foreground text-sm">
            Could not load this escalation.
          </p>
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
          <CardTitle className="text-muted-foreground text-sm font-medium">
            Lifecycle
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LifecycleStrip status={data.status} />
        </CardContent>
      </Card>

      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">
            Thread
          </CardTitle>
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
                <MessageRow
                  key={message.id}
                  message={message}
                  isLast={i === messages.length - 1}
                />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
