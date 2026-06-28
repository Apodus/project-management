import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  ListChecks,
  Timer,
  UserCheck,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTriageMetrics } from "@/hooks/use-triage-decisions";
import { useProjectActivity } from "@/hooks/use-activity";
import { formatDurationMs, formatFreshness, formatPercent, formatRelativeTime } from "@/lib/format";
import type { TriageMetrics } from "@/lib/api";

// ─── Metric card (re-defined locally, as the train dashboard does) ───

function MetricCard({
  label,
  value,
  icon: Icon,
  sub,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  sub?: string;
}) {
  return (
    <Card className="py-4">
      <CardContent className="flex items-center gap-3">
        <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          <p className="text-muted-foreground truncate text-xs">{label}</p>
          {sub && <p className="text-muted-foreground/70 truncate text-[10px]">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

// The five decision kinds, in display order. Wire keys are already snake_case
// and stable; the label is humanized.
const DECISION_KINDS = [
  { key: "promote_standard", label: "Promote (standard)" },
  { key: "promote_fast_track", label: "Promote (fast-track)" },
  { key: "dismiss", label: "Dismiss" },
  { key: "needs_human", label: "Needs human" },
  { key: "give_up", label: "Give up" },
] as const;

// The activity entityTypes that belong to the triage audit chain (AMENDMENT 1:
// filter by entityType, NOT by action — action vocabulary collides across
// proposals/epics/tasks/escalations).
const TRIAGE_ENTITY_TYPES = new Set(["note", "triage_decision"]);

// ─── Scope section ───────────────────────────────────────────────

function ScopeSection({ scope }: { scope: TriageMetrics["scope"] }) {
  if (scope.filtered && scope.triage_agent_id) {
    return (
      <Badge variant="secondary" className="text-xs">
        <UserCheck className="mr-1 size-3.5" />
        Scoped to agent {scope.triage_agent_id}
      </Badge>
    );
  }

  return (
    <Card className="w-full border-amber-300 bg-amber-50 py-3 dark:border-amber-900/40 dark:bg-amber-950/20">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 shrink-0 text-amber-500" />
          <CardTitle className="text-sm font-medium text-amber-700 dark:text-amber-400">
            No triage agent designated — showing all actors
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-amber-600/70 dark:text-amber-400/60">
          Set <code>settings.notesTriage.triageAgentId</code> to scope these metrics to the triage
          daemon's identity and exclude other actors.
        </p>
        {scope.by_actor.length === 0 ? (
          <p className="text-muted-foreground text-sm">No triage decisions recorded yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Actor</TableHead>
                <TableHead className="text-right">Decisions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scope.by_actor.map((a) => (
                <TableRow key={a.actor_id}>
                  <TableCell className="font-mono text-xs">{a.actor_id}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Lane counts ─────────────────────────────────────────────────

function LaneCountsSection({ lanes }: { lanes: TriageMetrics["lane_counts"] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <MetricCard label="Open" value={String(lanes.open)} icon={Inbox} />
      <MetricCard label="Needs human" value={String(lanes.needs_human)} icon={Users} />
      <MetricCard label="Triaged" value={String(lanes.triaged)} icon={CheckCircle2} />
    </div>
  );
}

// ─── Decision mix ────────────────────────────────────────────────

function DecisionMixSection({ mix }: { mix: TriageMetrics["decision_mix"] }) {
  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">Decision mix</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {mix.total === 0 ? (
          <div className="flex flex-col items-center py-6">
            <ListChecks className="text-muted-foreground/40 mb-2 size-8" />
            <p className="text-muted-foreground text-sm">No triage decisions yet</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Decision</TableHead>
                <TableHead className="text-right">Shadow</TableHead>
                <TableHead className="text-right">On</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {DECISION_KINDS.map(({ key, label }) => {
                const shadow = mix.shadow[key];
                const on = mix.on[key];
                const kindTotal = shadow + on;
                return (
                  <TableRow key={key}>
                    <TableCell className="text-sm">{label}</TableCell>
                    <TableCell className="text-right tabular-nums">{shadow}</TableCell>
                    <TableCell className="text-right tabular-nums">{on}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {kindTotal}
                      <span className="text-muted-foreground/60 ml-1 text-[10px]">
                        {formatPercent(mix.total > 0 ? kindTotal / mix.total : null)}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <MetricCard label="Shadow decisions" value={String(mix.shadow_total)} icon={ListChecks} />
          <MetricCard label="On decisions" value={String(mix.on_total)} icon={CheckCircle2} />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Latency + heartbeat ─────────────────────────────────────────

function LatencySection({ latency }: { latency: TriageMetrics["latency"] }) {
  return (
    <MetricCard
      label="Triage latency (p95)"
      value={formatDurationMs(latency.p95_ms)}
      icon={Timer}
      sub={`p50 ${formatDurationMs(latency.p50_ms)} · n=${latency.sample_size}`}
    />
  );
}

function HeartbeatSection({ heartbeat }: { heartbeat: TriageMetrics["heartbeat"] }) {
  // Local 1s tick so "last decision Ns ago" advances between the 30s refetches.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  let displayAge: number | null = null;
  if (heartbeat.last_decision_at) {
    displayAge = Date.now() - new Date(heartbeat.last_decision_at).getTime();
  } else if (heartbeat.age_ms != null) {
    displayAge = heartbeat.age_ms;
  }

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">
          Last triage decision
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Clock className="text-muted-foreground size-5 shrink-0" />
        <div>
          <p className="text-lg font-semibold tabular-nums">{formatFreshness(displayAge)}</p>
          {/* Last-DECISION freshness, NOT daemon liveness — a quiet-but-alive
              daemon records nothing, so this lagging is not a down signal. */}
          <p className="text-muted-foreground text-xs">last triage decision recorded</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Audit chain ─────────────────────────────────────────────────

function AuditChainSection({ projectId }: { projectId: string }) {
  // Fetch project activity and client-filter to the triage audit chain by
  // ENTITY TYPE (AMENDMENT 1) — note + triage_decision rows only.
  const { data, isLoading } = useProjectActivity(projectId, { per_page: 50 });
  const rows = (data?.data ?? []).filter((e) => TRIAGE_ENTITY_TYPES.has(e.entityType));

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-muted-foreground text-sm font-medium">Audit chain</CardTitle>
          <Link
            to="/projects/$projectId/activity"
            params={{ projectId }}
            className="text-muted-foreground hover:text-foreground text-xs font-medium"
          >
            View all activity
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        )}

        {!isLoading && rows.length === 0 && (
          <div className="flex flex-col items-center py-6">
            <Activity className="text-muted-foreground/40 mb-2 size-8" />
            <p className="text-muted-foreground text-sm">No triage activity yet</p>
          </div>
        )}

        {!isLoading && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-sm">{e.actorName ?? e.actorId ?? "System"}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{e.action}</TableCell>
                  <TableCell className="text-xs">
                    <span className="text-muted-foreground">{e.entityType}</span>{" "}
                    <span className="font-medium">{e.entityTitle ?? e.entityId.slice(0, 8)}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground/60 whitespace-nowrap text-right text-xs">
                    {formatRelativeTime(e.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────

export function TriageDashboardPage() {
  const { projectId } = useParams({ strict: false });
  const { data: metrics, isLoading } = useTriageMetrics(projectId);

  if (!projectId) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <ListChecks className="text-muted-foreground size-6" />
        <h1 className="text-2xl font-bold tracking-tight">Triage</h1>
        {metrics && metrics.scope.filtered && <ScopeSection scope={metrics.scope} />}
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="py-4">
              <CardContent>
                <Skeleton className="h-8 w-16" />
                <Skeleton className="mt-2 h-4 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!isLoading && !metrics && (
        <Card className="py-4">
          <CardContent className="flex flex-col items-center py-6">
            <ListChecks className="text-muted-foreground/40 mb-2 size-8" />
            <p className="text-muted-foreground text-sm">No triage metrics available</p>
          </CardContent>
        </Card>
      )}

      {metrics && (
        <>
          {/* Unfiltered scope warning + by-actor breakdown */}
          {!metrics.scope.filtered && <ScopeSection scope={metrics.scope} />}

          {/* Lane counts */}
          <LaneCountsSection lanes={metrics.lane_counts} />

          {/* Decision mix */}
          <DecisionMixSection mix={metrics.decision_mix} />

          {/* Latency + heartbeat */}
          <div className="grid gap-6 lg:grid-cols-2">
            <LatencySection latency={metrics.latency} />
            <HeartbeatSection heartbeat={metrics.heartbeat} />
          </div>

          {/* Audit chain */}
          <AuditChainSection projectId={projectId} />
        </>
      )}
    </div>
  );
}
