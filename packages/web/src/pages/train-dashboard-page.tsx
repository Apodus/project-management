import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  Gauge,
  Hash,
  Layers,
  PauseCircle,
  ShieldAlert,
  TrainFront,
  Timer,
  TrendingUp,
  Wrench,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useTrainHealth,
  useTrainInFlight,
  useTrainMetrics,
  useTrainState,
} from "@/hooks/use-train";
import {
  formatDurationMs,
  formatFreshness,
  formatPercent,
  formatStatus,
  getStatusColor,
} from "@/lib/format";
import { useCurrentUser } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { TrainInFlight } from "@/lib/api";

// ─── Metric card ─────────────────────────────────────────────────

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
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          {sub && (
            <p className="truncate text-[10px] text-muted-foreground/70">{sub}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Train state header ──────────────────────────────────────────

function TrainStateBadge({ projectId }: { projectId: string }) {
  const { data: state } = useTrainState(projectId);
  const isPaused = state?.state === "paused";

  return (
    <Badge
      variant="secondary"
      className={cn("text-xs", getStatusColor(isPaused ? "paused" : "active"))}
    >
      {isPaused ? "Paused" : "Running"}
    </Badge>
  );
}

function PausedBanner({ projectId }: { projectId: string }) {
  const { data: state } = useTrainState(projectId);
  if (state?.state !== "paused") return null;

  return (
    <Card className="w-full border-amber-300 bg-amber-50 py-3 dark:border-amber-900/40 dark:bg-amber-950/20">
      <CardContent className="flex items-center gap-3">
        <PauseCircle className="size-5 shrink-0 text-amber-500" />
        <div>
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            Merge train is paused
          </p>
          {state.reason && (
            <p className="text-xs text-amber-600/70 dark:text-amber-400/60">
              {state.reason}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Metrics section ─────────────────────────────────────────────

function MetricsSection({ projectId }: { projectId: string }) {
  const { data: metrics, isLoading } = useTrainMetrics(projectId);

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="py-4">
            <CardContent>
              <Skeleton className="h-8 w-16" />
              <Skeleton className="mt-2 h-4 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!metrics) {
    return (
      <Card className="py-4">
        <CardContent className="flex flex-col items-center py-6">
          <Gauge className="mb-2 size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No metrics available</p>
        </CardContent>
      </Card>
    );
  }

  const ttl = metrics.time_to_land;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <MetricCard
        label="Queue depth"
        value={String(metrics.queue_depth)}
        icon={Layers}
      />
      <MetricCard
        label="In flight"
        value={String(metrics.in_flight)}
        icon={TrainFront}
      />
      <MetricCard
        label="Time to land (p95)"
        value={formatDurationMs(ttl.p95_ms)}
        icon={Activity}
        sub={`p50 ${formatDurationMs(ttl.p50_ms)} · p99 ${formatDurationMs(ttl.p99_ms)} · n=${ttl.sample_size}`}
      />
      <MetricCard
        label="Verify success rate"
        value={formatPercent(metrics.verify_success_rate.ratio)}
        icon={CheckCircle2}
        sub={`${metrics.verify_success_rate.passed}/${metrics.verify_success_rate.total} passed`}
      />
      <MetricCard
        label="Abandon rate"
        value={formatPercent(metrics.abandon_rate.ratio)}
        icon={AlertTriangle}
        sub={`${metrics.abandon_rate.abandoned}/${metrics.abandon_rate.resolved} resolved`}
      />
      <MetricCard
        label="Pool utilization"
        value={formatPercent(metrics.pool_utilization.ratio)}
        icon={Gauge}
        sub={
          metrics.pool_utilization.size != null
            ? `${metrics.pool_utilization.leased ?? 0}/${metrics.pool_utilization.size} leased`
            : "—"
        }
      />
    </div>
  );
}

// ─── Health freshness widget ─────────────────────────────────────

function HealthFreshnessSection({ projectId }: { projectId: string }) {
  const { data: health, isLoading } = useTrainHealth(projectId);

  // Local 1s tick so "last heard Ns ago" advances between the 10s refetches.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (isLoading) {
    return (
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Integrator Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-32" />
        </CardContent>
      </Card>
    );
  }

  // Derive a live staleness from last_seen_at when available, else fall back
  // to the server-computed staleness_ms (kept fresh by the 10s refetch).
  let displayStaleness: number | null = null;
  if (health?.last_seen_at) {
    displayStaleness = Date.now() - new Date(health.last_seen_at).getTime();
  } else if (health?.staleness_ms != null) {
    displayStaleness = health.staleness_ms;
  }

  const healthy = health?.healthy ?? false;

  return (
    <Card
      className={cn(
        "py-4",
        health && !healthy && "border-red-300 dark:border-red-900/50",
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Integrator Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "inline-block size-3 shrink-0 rounded-full",
              !health
                ? "bg-gray-300 dark:bg-gray-600"
                : healthy
                  ? "bg-green-500"
                  : "bg-red-500",
            )}
          />
          <div>
            <p
              className={cn(
                "text-lg font-semibold tabular-nums",
                health && !healthy && "text-red-600 dark:text-red-400",
                !health && "text-muted-foreground",
              )}
            >
              {formatFreshness(displayStaleness)}
            </p>
            <p className="text-xs text-muted-foreground">
              last heard from integrator
            </p>
          </div>
        </div>
        {health && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Status: {formatStatus(health.status)}</span>
            {health.version && <span>v{health.version}</span>}
            {health.pool_size != null && (
              <span>
                Pool {health.pool_leased ?? 0}/{health.pool_size}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── In-flight table ─────────────────────────────────────────────

function memberLane(member: TrainInFlight["members"][number]): string {
  // A non-null group_id means the member rides a speculative group;
  // null means it's a standalone batch member.
  return member.group_id ? `Group ${member.group_id.slice(0, 8)}` : "Batch";
}

function InFlightSection({ projectId }: { projectId: string }) {
  const { data: inFlight, isLoading } = useTrainInFlight(projectId);
  const members = inFlight?.members ?? [];

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          In Flight
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        )}

        {!isLoading && members.length === 0 && (
          <div className="flex flex-col items-center py-6">
            <TrainFront className="mb-2 size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              Nothing currently integrating
            </p>
          </div>
        )}

        {!isLoading && members.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Lane</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      to="/merge-requests/$requestId/timeline"
                      params={{ requestId: member.id }}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {member.id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {memberLane(member)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px]", getStatusColor(member.status))}
                    >
                      {formatStatus(member.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {member.attempt ? (
                      <Badge variant="outline" className="text-[10px]">
                        {formatStatus(member.attempt.status)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
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

// ─── SLO compliance ──────────────────────────────────────────────

function SloChip({
  label,
  dim,
}: {
  label: string;
  dim: { compliant: boolean } | undefined;
}) {
  if (!dim) {
    return (
      <Badge variant="secondary" className="text-[10px]">
        {label}: n/a
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      className={cn(
        "text-[10px]",
        dim.compliant
          ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
          : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
      )}
    >
      {label}: {dim.compliant ? "OK" : "Breach"}
    </Badge>
  );
}

function SloSection({ projectId }: { projectId: string }) {
  const { data: metrics, isLoading } = useTrainMetrics(projectId);

  if (isLoading) {
    return (
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            SLO Compliance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-6 w-48" />
        </CardContent>
      </Card>
    );
  }

  const slo = metrics?.slo;

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            SLO Compliance
          </CardTitle>
          {slo &&
            (slo.overall_compliant == null ? (
              <Badge variant="secondary" className="text-[10px]">
                No SLO set
              </Badge>
            ) : (
              <Badge
                variant="secondary"
                className={cn(
                  "text-[10px]",
                  slo.overall_compliant
                    ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                    : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
                )}
              >
                {slo.overall_compliant ? "All clear" : "Breach"}
              </Badge>
            ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {!slo && (
          <p className="text-sm text-muted-foreground">No SLO set</p>
        )}
        {slo && (
          <>
            <SloChip label="p95 time-to-land" dim={slo.p95_time_to_land} />
            <SloChip label="Verify rate" dim={slo.verify_success_rate} />
            <SloChip label="Abandon rate" dim={slo.abandon_rate} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Verify cache + per-step section (Phase 7.5) ─────────────────

function VerifyCacheSection({ projectId }: { projectId: string }) {
  const { data: metrics, isLoading } = useTrainMetrics(projectId);

  if (isLoading) {
    return (
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Verify Cache
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-48" />
        </CardContent>
      </Card>
    );
  }

  const verify = metrics?.verify;
  if (!verify) return null;

  // Default deployment: cache disabled → a muted notice, no metric cards.
  if (!verify.cache_enabled) {
    return (
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Verify Cache
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center py-6">
          <Database className="mb-2 size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Verify cache disabled</p>
        </CardContent>
      </Card>
    );
  }

  const hr = verify.cache_hit_rate;

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Verify Cache
          </CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {verify.cache_mode === "shadow"
              ? "Shadow"
              : verify.cache_mode === "on"
                ? "On"
                : "Off"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard
            label="Cache hit rate"
            value={formatPercent(hr.ratio)}
            icon={Zap}
            sub={`${hr.hits}/${hr.lookups} lookups`}
          />
          <MetricCard
            label="Time saved"
            value={formatDurationMs(verify.time_saved_ms)}
            icon={Timer}
          />
          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <div
                className={cn(
                  "flex size-10 items-center justify-center rounded-lg",
                  verify.cache_mismatches > 0
                    ? "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <AlertTriangle className="size-5" />
              </div>
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-2xl font-bold tabular-nums",
                    verify.cache_mismatches > 0 &&
                      "text-red-600 dark:text-red-400",
                  )}
                >
                  {verify.cache_mismatches}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Cache mismatches
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {verify.per_step.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Runs</TableHead>
                <TableHead>Cached</TableHead>
                <TableHead>Pass rate</TableHead>
                <TableHead>Avg duration</TableHead>
                <TableHead>Failures</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {verify.per_step.map((step) => (
                <TableRow key={step.step_id}>
                  <TableCell className="font-mono text-xs">
                    {step.step_id}
                  </TableCell>
                  <TableCell className="tabular-nums">{step.runs}</TableCell>
                  <TableCell className="tabular-nums">{step.cached}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatPercent(step.pass_rate)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatDurationMs(step.avg_duration_ms)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "tabular-nums",
                      step.fail_count > 0 && "text-red-600 dark:text-red-400",
                    )}
                  >
                    {step.fail_count}
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

// ─── Resolution lineage section (Phase 7.6) ──────────────────────

function ResolutionSection({ projectId }: { projectId: string }) {
  const { data: metrics, isLoading } = useTrainMetrics(projectId);

  if (isLoading) {
    return (
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Conflict Resolution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-48" />
        </CardContent>
      </Card>
    );
  }

  const resolution = metrics?.resolution;
  if (!resolution) return null;

  // No resolutions in the window (resolver off, or simply none) → muted notice.
  if (resolution.attempts === 0) {
    return (
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Conflict Resolution
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center py-6">
          <Wrench className="mb-2 size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No resolutions yet</p>
        </CardContent>
      </Card>
    );
  }

  const budget = resolution.budget_utilization;
  const budgetSub =
    budget.mean_consumed_sec !== null
      ? `${Math.round(budget.mean_consumed_sec)}s / ${budget.budget_sec}s`
      : `budget ${budget.budget_sec}s`;

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Conflict Resolution
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard
            label="Attempts"
            value={String(resolution.attempts)}
            icon={Hash}
          />
          <MetricCard
            label="Auto-resolve success"
            value={formatPercent(resolution.auto_resolve_success_rate.ratio)}
            icon={CheckCircle2}
            sub={`${resolution.auto_resolve_success_rate.resolved_and_landed}/${resolution.auto_resolve_success_rate.attempts} landed`}
          />
          <MetricCard
            label="Escalation rate"
            value={formatPercent(resolution.escalation_rate.ratio)}
            icon={TrendingUp}
            sub={`${resolution.escalation_rate.escalated}/${resolution.escalation_rate.attempts} escalated`}
          />
          <MetricCard
            label="Mean resolver wall-clock"
            value={formatDurationMs(resolution.mean_wall_clock_ms)}
            icon={Timer}
          />
          <MetricCard
            label="Budget utilization"
            value={formatPercent(budget.ratio)}
            icon={Gauge}
            sub={budgetSub}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────

export function TrainDashboardPage() {
  const { projectId } = useParams({ strict: false });
  const { data: user } = useCurrentUser();

  if (!projectId) return null;

  const isAdmin = user?.role === "admin";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <TrainFront className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Merge Train</h1>
        <TrainStateBadge projectId={projectId} />
        {isAdmin && (
          <Link
            to="/projects/$projectId/train/audit"
            params={{ projectId }}
            className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ShieldAlert className="size-4" />
            Break-glass / Audit
          </Link>
        )}
      </div>

      {/* Paused banner */}
      <PausedBanner projectId={projectId} />

      {/* Metric cards */}
      <MetricsSection projectId={projectId} />

      {/* Verify cache + per-step metrics */}
      <VerifyCacheSection projectId={projectId} />

      {/* Conflict-resolution lineage metrics (Phase 7.6) */}
      <ResolutionSection projectId={projectId} />

      {/* Health + SLO */}
      <div className="grid gap-6 lg:grid-cols-2">
        <HealthFreshnessSection projectId={projectId} />
        <SloSection projectId={projectId} />
      </div>

      {/* In-flight table */}
      <InFlightSection projectId={projectId} />
    </div>
  );
}
