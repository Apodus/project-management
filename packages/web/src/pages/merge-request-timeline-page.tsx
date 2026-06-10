import { Link, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  FlaskConical,
  Flag,
  GitMerge,
  Loader2,
  ShieldAlert,
  Wrench,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMergeRequestTimeline } from "@/hooks/use-train";
import { formatDurationMs, formatRelativeTime, formatStatus, getStatusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MergeRequest, MergeRequestTimelineEvent } from "@/lib/api";

// ─── Helpers ─────────────────────────────────────────────────────

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

function safeRelative(at: string | null | undefined): string {
  if (!at) return "—";
  return formatRelativeTime(at);
}

// Each timeline kind maps to an icon + an accent color for its node dot.
function kindVisual(event: MergeRequestTimelineEvent): {
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  label: string;
} {
  switch (event.kind) {
    case "queued":
      return { icon: CircleDot, accent: "text-blue-500", label: "Queued" };
    case "integrating":
      return {
        icon: GitMerge,
        accent: "text-amber-500",
        label: "Integrating",
      };
    case "attempt":
      return {
        icon: FlaskConical,
        accent: "text-indigo-500",
        label: "Verify attempt",
      };
    case "audit": {
      const override = event.action === "force_land" || event.action === "force_reject";
      return {
        icon: override ? ShieldAlert : Flag,
        accent: override ? "text-red-500" : "text-muted-foreground",
        label: "Audit",
      };
    }
    case "incident":
      return {
        icon: AlertTriangle,
        accent: "text-red-500",
        label: "Incident",
      };
    case "resolution": {
      // Accent by resolver outcome: in-flight (resolving/pending) = amber,
      // resolved = green, escalated/failed = red.
      const state = event.resolutionState;
      const accent =
        state === "resolved"
          ? "text-green-500"
          : state === "escalated" || state === "failed"
            ? "text-red-500"
            : "text-amber-500";
      return { icon: Wrench, accent, label: "Conflict resolution" };
    }
    case "resolution_origin":
      return {
        icon: GitMerge,
        accent: "text-muted-foreground",
        label: "Resolved from origin",
      };
    case "landed":
      return { icon: CheckCircle2, accent: "text-green-500", label: "Landed" };
    case "rejected":
      return { icon: XCircle, accent: "text-red-500", label: "Rejected" };
    case "abandoned":
      return {
        icon: XCircle,
        accent: "text-muted-foreground",
        label: "Abandoned",
      };
    default:
      return { icon: CircleDot, accent: "text-muted-foreground", label: "Event" };
  }
}

// ─── Per-kind event body ─────────────────────────────────────────

function AttemptBody({ event }: { event: MergeRequestTimelineEvent }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Attempt {event.attemptNumber ?? "—"}</span>
        {event.status && (
          <Badge variant="secondary" className={cn("text-[10px]", getStatusColor(event.status))}>
            {formatStatus(event.status)}
          </Badge>
        )}
        {event.failureCategory && (
          <Badge
            variant="secondary"
            className="bg-red-100 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300"
          >
            {formatStatus(event.failureCategory)}
          </Badge>
        )}
      </div>

      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="font-mono">base {shortSha(event.baseSha)}</span>
        <span className="font-mono">tree {shortSha(event.treeSha)}</span>
      </div>

      {/* Phase 7.5: per-step pipeline results (fail-fast short-circuit visible —
          later steps simply absent). Null/absent → renders nothing (7.4 view). */}
      {event.steps && event.steps.length > 0 && (
        <div className="space-y-1">
          {event.steps.map((step) => {
            const passed = step.outcome === "pass";
            return (
              <div key={step.stepId} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground font-mono">{step.stepId}</span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "text-[10px]",
                    passed
                      ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                      : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
                  )}
                >
                  {passed ? "pass" : "fail"}
                </Badge>
                {step.cached && (
                  <Badge variant="outline" className="text-[10px]">
                    hit
                  </Badge>
                )}
                <span className="text-muted-foreground/70 tabular-nums">
                  {formatDurationMs(step.durationMs)}
                </span>
                {step.logUrl && (
                  <a
                    href={step.logUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
                  >
                    <ExternalLink className="size-3" />
                    log
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Log pointer: prefer a real link, else surface the excerpt inline. */}
      {event.logUrl ? (
        <a
          href={event.logUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          <ExternalLink className="size-3" />
          View verify log
        </a>
      ) : event.logExcerpt ? (
        <details className="text-xs">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
            Log excerpt
          </summary>
          <pre className="bg-muted mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded p-2 font-mono text-[11px]">
            {event.logExcerpt}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function AuditBody({ event }: { event: MergeRequestTimelineEvent }) {
  const action = event.action ?? "action";
  const isOverride = event.action === "force_land" || event.action === "force_reject";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("text-sm font-medium", isOverride && "text-red-600 dark:text-red-400")}>
          {formatStatus(action)}
        </span>
        {isOverride && (
          <Badge
            variant="secondary"
            className="bg-red-100 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300"
          >
            Override
          </Badge>
        )}
      </div>
      {/* The override accountability line: who + why. */}
      <p className="text-muted-foreground text-xs">
        by <span className="text-foreground font-medium">{event.actorId ?? "unknown"}</span>
        {event.reason ? (
          <>
            {" — "}
            <span className="italic">reason: {event.reason}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

function IncidentBody({ event }: { event: MergeRequestTimelineEvent }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-red-600 dark:text-red-400">
          {event.type ? formatStatus(event.type) : "Incident"}
        </span>
        {event.state && (
          <Badge
            variant="secondary"
            className="bg-red-100 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300"
          >
            {formatStatus(event.state)}
          </Badge>
        )}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {event.orphanedSha && (
          <span className="font-mono">orphaned {shortSha(event.orphanedSha)}</span>
        )}
        {event.resolvedAt && <span>resolved {safeRelative(event.resolvedAt)}</span>}
        {event.resolution != null && <span>resolution: {String(event.resolution)}</span>}
      </div>
    </div>
  );
}

function resolutionStateBadgeClass(state: string | undefined): string {
  if (state === "resolved") {
    return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  }
  if (state === "escalated" || state === "failed") {
    return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
  }
  return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
}

// Origin-branch event: a textual conflict on THIS request spun an off-lane
// resolver attempt. Shows the resolver state, the conflicting files, a live
// in-flight indicator while resolving, and a forward link to the resolved
// request's own timeline once it has been resubmitted.
function ResolutionBody({ event }: { event: MergeRequestTimelineEvent }) {
  const state = event.resolutionState;
  const inFlight =
    state === "pending" || state === "resolving" || (!event.attemptEndedAt && state !== "resolved");
  const files = event.conflictingFiles ?? [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Conflict resolution</span>
        {state && (
          <Badge
            variant="secondary"
            className={cn("text-[10px]", resolutionStateBadgeClass(state))}
          >
            {formatStatus(state)}
          </Badge>
        )}
        {inFlight && (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
            <Loader2 className="size-3 animate-spin" />
            in flight
          </span>
        )}
        {event.escalationTarget && (
          <Badge variant="outline" className="text-[10px]">
            → {formatStatus(event.escalationTarget)}
          </Badge>
        )}
      </div>

      {files.length > 0 && (
        <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {files.map((f) => (
            <span key={f} className="font-mono">
              {f}
            </span>
          ))}
        </div>
      )}

      {event.detail?.escalationReason && (
        <p className="text-muted-foreground text-xs italic">{event.detail.escalationReason}</p>
      )}

      {event.resolvedRequestId && (
        <Link
          to="/merge-requests/$requestId/timeline"
          params={{ requestId: event.resolvedRequestId }}
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          <ExternalLink className="size-3" />
          View resolved request
        </Link>
      )}
    </div>
  );
}

// Resolved-branch event: THIS request was itself resubmitted by a resolver —
// a back-link to the origin request that conflicted.
function ResolutionOriginBody({ event }: { event: MergeRequestTimelineEvent }) {
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium">Resolved from origin</span>
      {event.originRequestId && (
        <div>
          <Link
            to="/merge-requests/$requestId/timeline"
            params={{ requestId: event.originRequestId }}
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            <ArrowLeft className="size-3" />
            View origin request
          </Link>
        </div>
      )}
    </div>
  );
}

function TerminalBody({ event }: { event: MergeRequestTimelineEvent }) {
  if (event.kind === "landed") {
    return (
      <div className="space-y-1">
        <span className="text-sm font-medium text-green-600 dark:text-green-400">Landed</span>
        <p className="text-muted-foreground font-mono text-xs">{shortSha(event.landedSha)}</p>
      </div>
    );
  }
  if (event.kind === "rejected") {
    return (
      <div className="space-y-1">
        <span className="text-sm font-medium text-red-600 dark:text-red-400">Rejected</span>
        <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {event.rejectCategory && (
            <Badge
              variant="secondary"
              className="bg-red-100 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300"
            >
              {formatStatus(event.rejectCategory)}
            </Badge>
          )}
          {event.rejectReason && <span>{event.rejectReason}</span>}
        </div>
      </div>
    );
  }
  return <span className="text-muted-foreground text-sm font-medium">Abandoned</span>;
}

function MilestoneBody({ event }: { event: MergeRequestTimelineEvent }) {
  const visual = kindVisual(event);
  return <span className="text-sm font-medium">{visual.label}</span>;
}

function EventBody({ event }: { event: MergeRequestTimelineEvent }) {
  switch (event.kind) {
    case "attempt":
      return <AttemptBody event={event} />;
    case "audit":
      return <AuditBody event={event} />;
    case "incident":
      return <IncidentBody event={event} />;
    case "resolution":
      return <ResolutionBody event={event} />;
    case "resolution_origin":
      return <ResolutionOriginBody event={event} />;
    case "landed":
    case "rejected":
    case "abandoned":
      return <TerminalBody event={event} />;
    case "queued":
    case "integrating":
      return <MilestoneBody event={event} />;
    default:
      return <MilestoneBody event={event} />;
  }
}

// ─── Timeline row ────────────────────────────────────────────────

function TimelineRow({ event, isLast }: { event: MergeRequestTimelineEvent; isLast: boolean }) {
  const { icon: Icon, accent } = kindVisual(event);
  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {/* Connector line (drawn for all but the last node). */}
      {!isLast && (
        <span
          className="bg-border absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px"
          aria-hidden
        />
      )}
      {/* Node */}
      <span
        className={cn(
          "bg-background relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border",
          accent,
        )}
      >
        <Icon className="size-4" />
      </span>
      {/* Body */}
      <div className="min-w-0 flex-1 pt-1">
        <EventBody event={event} />
        <p className="text-muted-foreground/70 mt-1 text-[11px]">{safeRelative(event.at)}</p>
      </div>
    </li>
  );
}

// ─── Request header ──────────────────────────────────────────────

function RequestHeader({ request, projectId }: { request: MergeRequest; projectId?: string }) {
  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-3">
          <GitMerge className="text-muted-foreground size-5" />
          <CardTitle className="font-mono text-base">{request.id.slice(0, 12)}</CardTitle>
          <Badge variant="secondary" className={cn("text-[10px]", getStatusColor(request.status))}>
            {formatStatus(request.status)}
          </Badge>
          {/* Inner-only groups: a synthetic member has no branch/commit — the
              integrator synthesizes the outer gitlink-bump candidate. */}
          {request.synthetic && (
            <Badge variant="secondary" className="text-[10px]">
              synthetic gitlink bump
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <span>resource: {request.resource}</span>
        {request.branch && <span>branch: {request.branch}</span>}
        {request.taskId && (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: request.taskId }}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            task {request.taskId.slice(0, 8)}
          </Link>
        )}
        {request.landedSha && (
          <span className="font-mono">landed {shortSha(request.landedSha)}</span>
        )}
        {request.rejectCategory && <span>rejected: {formatStatus(request.rejectCategory)}</span>}
        {projectId && (
          <Link
            to="/projects/$projectId/train"
            params={{ projectId }}
            className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
          >
            <ArrowLeft className="size-3" />
            Back to train
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────

export function MergeRequestTimelinePage() {
  const { requestId } = useParams({ strict: false });
  const { data, isLoading, isError } = useMergeRequestTimeline(requestId);

  if (!requestId) return null;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full" />
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
            Could not load this merge request timeline.
          </p>
        </CardContent>
      </Card>
    );
  }

  const events = data.events ?? [];
  const projectId = data.request?.projectId;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Request Timeline</h1>
      </div>

      <RequestHeader request={data.request} projectId={projectId} />

      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">Events</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <div className="flex flex-col items-center py-6">
              <CircleDot className="text-muted-foreground/40 mb-2 size-8" />
              <p className="text-muted-foreground text-sm">No timeline events yet</p>
            </div>
          ) : (
            <ol className="m-0 list-none p-0">
              {events.map((event, i) => (
                <TimelineRow
                  key={`${event.kind}-${event.at}-${i}`}
                  event={event}
                  isLast={i === events.length - 1}
                />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
