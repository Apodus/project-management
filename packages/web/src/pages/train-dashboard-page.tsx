import { Fragment, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Database,
  Gauge,
  Hash,
  Hourglass,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PhaseChip, PhaseShareBar, PhaseSpreadMark } from "@/components/phase-breakdown";
import {
  useMergeRequestPhases,
  useTrainHealth,
  useTrainInFlight,
  useTrainMetrics,
  useTrainState,
} from "@/hooks/use-train";
import { useNowTick } from "@/hooks/use-now-tick";
import { useProject, useUpdateResolverConfig } from "@/hooks/use-projects";
import { Switch } from "@/components/ui/switch";
import { resolverConfigFromProject } from "@/lib/resolver";
import {
  formatDurationMs,
  formatFreshness,
  formatPercent,
  formatStatus,
  getStatusColor,
} from "@/lib/format";
import {
  PHASE_BAR_COLOR,
  PHASE_LABEL,
  PHASE_MEANING,
  PHASE_ORDER,
  type PhaseName,
} from "@/lib/phases";
import { useCurrentUser } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { PhaseWindow, TrainInFlight } from "@/lib/api";

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
            <p className="text-xs text-amber-600/70 dark:text-amber-400/60">{state.reason}</p>
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
          <Gauge className="text-muted-foreground/40 mb-2 size-8" />
          <p className="text-muted-foreground text-sm">No metrics available</p>
        </CardContent>
      </Card>
    );
  }

  const ttl = metrics.time_to_land;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <MetricCard label="Queue depth" value={String(metrics.queue_depth)} icon={Layers} />
      <MetricCard label="In flight" value={String(metrics.in_flight)} icon={TrainFront} />
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

// ─── Phase timing: where the time goes (campaign 2026-08-03 §P4) ─

/**
 * One window as a small multiple: a caption naming the window and its sample,
 * then the share bar. Two of these side by side answer "is this trip normal?"
 * without a toggle widget — a toggle would hide exactly the comparison being
 * asked for.
 */
function PhaseWindowBar({ title, win }: { title: string; win: PhaseWindow }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-muted-foreground text-xs">{title}</p>
        <p className="text-muted-foreground/70 text-[10px] tabular-nums">
          {win.entity_count} trips · {win.sample_size} phase records
        </p>
      </div>
      {win.sample_size === 0 ? (
        <p className="text-muted-foreground/70 text-xs">Nothing measured in this window.</p>
      ) : (
        <PhaseShareBar
          stats={win.phases}
          ariaLabel={`Share of measured phase time, ${title.toLowerCase()}`}
        />
      )}
    </div>
  );
}

function PhaseTimingSection({ projectId }: { projectId: string }) {
  const { data: metrics, isLoading } = useTrainMetrics(projectId);
  // Which phases have their step breakdown open. A Set keyed by phase name, so
  // the state survives a refetch that reorders nothing but replaces the rows.
  const [expanded, setExpanded] = useState<ReadonlySet<PhaseName>>(() => new Set());

  const header = (sample?: PhaseWindow) => (
    <CardHeader className="pb-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="text-muted-foreground text-sm font-medium">
            Where the time goes
          </CardTitle>
          <p className="text-muted-foreground/70 mt-1 text-xs">
            Share of measured phase time · last 24 h
          </p>
        </div>
        {sample && (
          <Badge variant="secondary" className="text-[10px]">
            {sample.sample_size} phases · {sample.entity_count} trips
          </Badge>
        )}
      </div>
    </CardHeader>
  );

  if (isLoading) {
    return (
      <Card className="py-4">
        {header()}
        <CardContent>
          <Skeleton className="h-8 w-64" />
        </CardContent>
      </Card>
    );
  }

  const timing = metrics?.phase_timing;
  if (!timing) return null;

  const { window: windowStats, recent, recent_limit: recentLimit } = timing;
  const recentTitle = `Last ${recentLimit} trips`;

  // Nothing measured anywhere. This is the pre-instrumentation / quiet-lane
  // state, not an error — muted, in the verify-cache idiom, and emphatically
  // not a row of zeros.
  if (windowStats.sample_size === 0 && recent.sample_size === 0) {
    return (
      <Card className="py-4">
        {header()}
        <CardContent className="flex flex-col items-center py-6">
          <Hourglass className="text-muted-foreground/40 mb-2 size-8" />
          <p className="text-muted-foreground text-sm">No phase timings yet</p>
          <p className="text-muted-foreground/70 mt-1 max-w-sm text-center text-xs">
            Phases are recorded as they complete; nothing has completed in the last 24 h.
          </p>
        </CardContent>
      </Card>
    );
  }

  // The table shows the 24h window, falling back to the recent trips when the
  // window is empty but recent work exists (a lane that woke up after a long
  // quiet spell). Whichever it is, the table SAYS so — a table that silently
  // changes its window is worse than one that has none.
  const fellBack = windowStats.sample_size === 0 && recent.sample_size > 0;
  const source = fellBack ? recent : windowStats;
  const sourceName = fellBack ? `the last ${recentLimit} trips` : "the last 24 h";

  // Rows come from the PAYLOAD, in payload order. Nothing here indexes
  // PHASE_ORDER expecting a phase to be present — the server omits a phase it
  // never observed, and that absence is reported as absence below.
  const observed = new Set(source.phases.map((p) => p.phase));
  const absent = PHASE_ORDER.filter((p) => !observed.has(p));

  // Seeded reduce, never Math.max(...[]) — an empty spread is -Infinity and
  // every derived width becomes NaN. Sub-rows share this axis (their p95 is
  // bounded by their parent's), so a step is comparable to the phase it is in.
  const axisMaxMs = source.phases.reduce(
    (max, p) => Math.max(max, p.p95_ms, ...p.labels.map((l) => l.p95_ms)),
    0,
  );

  const verifyUnlabelled = source.phases.some((p) => p.phase === "verify" && p.labels.length === 0);

  const toggle = (phase: PhaseName) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(phase)) next.add(phase);
      return next;
    });

  return (
    <Card className="py-4">
      {header(windowStats)}
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <PhaseWindowBar title="Last 24 h" win={windowStats} />
          <PhaseWindowBar title={recentTitle} win={recent} />
        </div>

        <p className="text-muted-foreground text-xs">Per phase, over {sourceName}</p>

        <Table>
          <TableCaption className="sr-only">
            Merge-train phases over {sourceName}: each phase&apos;s share of measured phase time and
            its median, 95th-percentile and maximum duration. Phases with no samples are not listed.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Phase</TableHead>
              <TableHead className="text-right">n</TableHead>
              <TableHead className="text-right">Share of measured phase time</TableHead>
              <TableHead className="text-right">p50</TableHead>
              <TableHead className="text-right">p95</TableHead>
              <TableHead className="text-right">Max</TableHead>
              <TableHead>
                <span className="flex flex-col">
                  <span>Spread</span>
                  <span className="text-muted-foreground/70 text-[10px] font-normal">
                    ▬ p50 ● p95 · same scale across phases
                  </span>
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {source.phases.map((stat) => {
              // An expander ONLY where there is something inside. `labels: []`
              // means the integrator ran the phase as one opaque step (game_one's
              // single pm-verify.bat), and an empty disclosure would promise a
              // breakdown PM cannot see.
              const expandable = stat.labels.length > 0;
              const isOpen = expanded.has(stat.phase);
              return (
                <Fragment key={stat.phase}>
                  <TableRow>
                    <TableCell className="text-xs">
                      <div className="flex items-center gap-1.5">
                        {expandable ? (
                          <button
                            type="button"
                            onClick={() => toggle(stat.phase)}
                            aria-expanded={isOpen}
                            aria-label={`${PHASE_LABEL[stat.phase]} step breakdown`}
                            className="text-muted-foreground hover:text-foreground -ml-1 rounded p-0.5"
                          >
                            <ChevronRight
                              className={cn("size-3 transition-transform", isOpen && "rotate-90")}
                            />
                          </button>
                        ) : (
                          <span aria-hidden="true" className="w-4" />
                        )}
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            PHASE_BAR_COLOR[stat.phase],
                          )}
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="font-medium underline decoration-dotted underline-offset-2">
                              {PHASE_LABEL[stat.phase]}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-xs">
                            {PHASE_MEANING[stat.phase]}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{stat.count}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(stat.share)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDurationMs(stat.p50_ms)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDurationMs(stat.p95_ms)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDurationMs(stat.max_ms)}
                    </TableCell>
                    <TableCell>
                      <PhaseSpreadMark
                        phase={stat.phase}
                        p50Ms={stat.p50_ms}
                        p95Ms={stat.p95_ms}
                        axisMaxMs={axisMaxMs}
                      />
                    </TableCell>
                  </TableRow>

                  {isOpen &&
                    stat.labels.map((step) => (
                      <TableRow
                        key={`${stat.phase}:${step.label ?? ""}`}
                        className="bg-muted/30 text-muted-foreground"
                      >
                        <TableCell className="pl-10 text-xs">
                          {step.label ?? <span className="italic">(unlabelled)</span>}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {step.count}
                        </TableCell>
                        {/* Phase-SCOPED denominator, said outright: "78% of
                            Verify" can never be misread as 78% of the panel. */}
                        <TableCell className="text-right text-xs tabular-nums">
                          {formatPercent(step.share)} of {PHASE_LABEL[stat.phase]}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {formatDurationMs(step.p50_ms)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {formatDurationMs(step.p95_ms)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {formatDurationMs(step.max_ms)}
                        </TableCell>
                        <TableCell>
                          {/* Parent hue, shared axis — a step is a subdivision of
                              its phase, not a new categorical slot. */}
                          <PhaseSpreadMark
                            phase={stat.phase}
                            p50Ms={step.p50_ms}
                            p95Ms={step.p95_ms}
                            axisMaxMs={axisMaxMs}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>

        <div className="text-muted-foreground/80 space-y-1.5 text-xs">
          {absent.length > 0 && (
            <p>
              Not observed in {sourceName}: {absent.map((p) => PHASE_LABEL[p]).join(", ")} — left
              out rather than shown as zero. A lane that never enters a phase simply has no rows for
              it.
            </p>
          )}
          {verifyUnlabelled && (
            <p>
              Verify ran as one unlabelled step in this window, so there is no breakdown inside it.
            </p>
          )}
          <p>
            Share is of summed phase time, not elapsed wall clock: intervals that overlap are
            counted more than once — a group&apos;s Forming covers the same minutes as each
            member&apos;s Queue wait, and a cross-repo inner and outer verify genuinely run at the
            same time. What fraction of a merge is explained by these phases is a different number,
            and it is not computed here.
          </p>
          <p>A cross-repo group counts as one trip.</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Health freshness widget ─────────────────────────────────────

function HealthFreshnessSection({ projectId }: { projectId: string }) {
  const { data: health, isLoading } = useTrainHealth(projectId);

  // 1s tick so "last heard Ns ago" advances between the 10s refetches.
  const now = useNowTick();

  if (isLoading) {
    return (
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">
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
    displayStaleness = now - new Date(health.last_seen_at).getTime();
  } else if (health?.staleness_ms != null) {
    displayStaleness = health.staleness_ms;
  }

  const healthy = health?.healthy ?? false;

  return (
    <Card className={cn("py-4", health && !healthy && "border-red-300 dark:border-red-900/50")}>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">
          Integrator Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "inline-block size-3 shrink-0 rounded-full",
              !health ? "bg-gray-300 dark:bg-gray-600" : healthy ? "bg-green-500" : "bg-red-500",
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
            <p className="text-muted-foreground text-xs">last heard from integrator</p>
          </div>
        </div>
        {health && (
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>Status: {formatStatus(health.status)}</span>
            {health.version && <span>v{health.version}</span>}
            {health.pool_size != null && (
              <span>
                Pool {health.pool_leased ?? 0}/{health.pool_size}
              </span>
            )}
          </div>
        )}
        {health?.last_release_failure && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Lane lock release failed {new Date(health.last_release_failure.at).toLocaleString()}:{" "}
              {health.last_release_failure.message} — queued work may stall until the staleness
              sweep or a force-release
            </span>
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

/**
 * What this member IS, in human terms. A merge request has no name of its own,
 * so name it by the work: the linked task's title, else the branch, else the id
 * prefix (the last resort — a ULID tells an operator nothing about what is
 * currently occupying their train).
 */
function memberName(member: TrainInFlight["members"][number]): string {
  return member.task_title ?? member.branch ?? member.id.slice(0, 8);
}

/**
 * The phases this member has COMPLETED, as chips, plus the unaccounted time
 * since the last recorded boundary.
 *
 * WHAT THIS DELIBERATELY DOES NOT SAY, and the shortcut not to take: "currently
 * in phase X for Y". §P1 records a phase only when it ENDS — there is no
 * `ended_at` column, precisely so a crashed daemon strands no half-open row —
 * so the phase running right now has no name and inventing one would be
 * fiction. In particular do NOT infer `verify` from `attempt.status ===
 * "running"`: an attempt is equally "running" through assemble, materialize,
 * rebase and land, so that inference would mislabel most of the very wall clock
 * it claims to explain. The trailing chip states the honest fact instead.
 */
function MemberPhaseCell({ member }: { member: TrainInFlight["members"][number] }) {
  const { data: trace, isLoading, isError } = useMergeRequestPhases(member.id);
  // 1s tick scoped to THIS cell, so the unrecorded age advances without
  // re-rendering the whole dashboard every second.
  const now = useNowTick();

  if (isLoading) {
    // Sized like a chip row so the table does not jump when the trace lands.
    return <Skeleton className="h-4 w-28" />;
  }
  if (isError || !trace || trace.length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }

  const lastPhaseEndMs = trace.reduce(
    (end, entry) => Math.max(end, Date.parse(entry.startedAt) + entry.durationMs),
    0,
  );
  const pickedUpMs = member.picked_up_at ? Date.parse(member.picked_up_at) : null;
  // Anchored at the LATER of the last boundary and pickup, and only for a
  // member the train has actually picked up. A never-picked-up member gets no
  // chip: `now − enqueued_at` looks like the obvious fill-in and is exactly
  // wrong, because a re-queue NULLs picked_up_at while enqueued_at stands, so
  // that expression charges the whole prior integration to queue wait — the
  // dishonesty this campaign exists to remove. Leave it absent.
  const unrecordedMs =
    pickedUpMs === null ? 0 : Math.max(0, now - Math.max(lastPhaseEndMs, pickedUpMs));

  return (
    <div className="flex flex-wrap items-center gap-1">
      {trace.map((entry, i) => {
        // `derived` is a BOOLEAN on the wire; narrow on the literal, never on a
        // string. A derived entry carries no step label and only it can be
        // re-anchored by a re-queue.
        const requeueTitle =
          entry.derived === true && entry.basis === "requeued"
            ? `Re-queued — this is the last queue segment only. Total since submit: ${formatDurationMs(entry.originDurationMs)}.`
            : null;
        return (
          <PhaseChip
            key={entry.derived === false ? entry.id : `derived-${entry.phase}-${i}`}
            phase={entry.phase}
            durationMs={entry.durationMs}
            label={entry.derived === false ? entry.label : undefined}
            note={requeueTitle ? "(last segment)" : undefined}
            title={requeueTitle ?? PHASE_MEANING[entry.phase]}
          />
        );
      })}
      {unrecordedMs > 0 && (
        <span
          title="A phase is recorded only when it completes, so the phase running right now has no name yet — this is the time since the last recorded boundary."
          className="text-muted-foreground inline-flex items-center whitespace-nowrap rounded-full border border-dashed px-2 py-0.5 text-[10px]"
        >
          + {formatDurationMs(unrecordedMs)} unrecorded
        </span>
      )}
    </div>
  );
}

function InFlightSection({ projectId }: { projectId: string }) {
  const { data: inFlight, isLoading } = useTrainInFlight(projectId);
  const members = inFlight?.members ?? [];

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">In Flight</CardTitle>
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
            <TrainFront className="text-muted-foreground/40 mb-2 size-8" />
            <p className="text-muted-foreground text-sm">Nothing currently integrating</p>
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
                <TableHead>Phase progress</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="max-w-[22rem] text-xs">
                    <Link
                      to="/merge-requests/$requestId/timeline"
                      params={{ requestId: member.id }}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      <span className="block truncate font-medium" title={memberName(member)}>
                        {memberName(member)}
                      </span>
                    </Link>
                    {/* The branch stays visible under a task-titled row — it is
                        what the operator greps for in git; the id is the
                        last-resort name and never needs repeating. */}
                    {member.task_title && member.branch && (
                      <span className="text-muted-foreground block truncate font-mono text-[10px]">
                        {member.branch}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
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
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <MemberPhaseCell member={member} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!isLoading && members.length > 0 && (
          <p className="text-muted-foreground/80 mt-3 text-xs">
            Phase progress shows phases that have COMPLETED — a phase is recorded when it ends, so
            the one a member is running right now is deliberately unnamed, and the dashed chip is
            the time since its last recorded boundary.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── SLO compliance ──────────────────────────────────────────────

function SloChip({ label, dim }: { label: string; dim: { compliant: boolean } | undefined }) {
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
          <CardTitle className="text-muted-foreground text-sm font-medium">
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
          <CardTitle className="text-muted-foreground text-sm font-medium">
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
        {!slo && <p className="text-muted-foreground text-sm">No SLO set</p>}
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
          <CardTitle className="text-muted-foreground text-sm font-medium">Verify Cache</CardTitle>
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
          <CardTitle className="text-muted-foreground text-sm font-medium">Verify Cache</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center py-6">
          <Database className="text-muted-foreground/40 mb-2 size-8" />
          <p className="text-muted-foreground text-sm">Verify cache disabled</p>
        </CardContent>
      </Card>
    );
  }

  const hr = verify.cache_hit_rate;

  return (
    <Card className="py-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-muted-foreground text-sm font-medium">Verify Cache</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {verify.cache_mode === "shadow" ? "Shadow" : verify.cache_mode === "on" ? "On" : "Off"}
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
                    verify.cache_mismatches > 0 && "text-red-600 dark:text-red-400",
                  )}
                >
                  {verify.cache_mismatches}
                </p>
                <p className="text-muted-foreground truncate text-xs">Cache mismatches</p>
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
                  <TableCell className="font-mono text-xs">{step.step_id}</TableCell>
                  <TableCell className="tabular-nums">{step.runs}</TableCell>
                  <TableCell className="tabular-nums">{step.cached}</TableCell>
                  <TableCell className="tabular-nums">{formatPercent(step.pass_rate)}</TableCell>
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

// Admin-gated quick enable/disable toggle for the resolver, reading the
// project's persisted `settings.integrator.resolver.enabled`. A full-config
// surface lives at the conflict-resolution settings page.
function ResolverToggle({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { data: project } = useProject(projectId);
  const update = useUpdateResolverConfig(projectId);

  const config = resolverConfigFromProject(project);
  const enabled = config.enabled;

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Auto-resolve</span>
      <Switch
        aria-label="Auto-resolve conflicts"
        checked={enabled}
        disabled={!isAdmin || !project || update.isPending}
        onCheckedChange={(checked) => update.mutate({ ...config, enabled: checked })}
      />
    </div>
  );
}

function ResolutionSection({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { data: metrics, isLoading } = useTrainMetrics(projectId);

  const header = (
    <CardHeader className="pb-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <CardTitle className="text-muted-foreground text-sm font-medium">
            Conflict Resolution
          </CardTitle>
          <p className="text-muted-foreground/70 mt-1 text-xs">
            Spawn a bounded headless resolver on a textual conflict instead of rejecting the
            request.
          </p>
        </div>
        <ResolverToggle projectId={projectId} isAdmin={isAdmin} />
      </div>
    </CardHeader>
  );

  if (isLoading) {
    return (
      <Card className="py-4">
        {header}
        <CardContent>
          <Skeleton className="h-8 w-48" />
        </CardContent>
      </Card>
    );
  }

  const resolution = metrics?.resolution;

  // No resolutions in the window (resolver off, or simply none) → muted notice.
  // We still render the header + toggle so an admin can enable it from here.
  if (!resolution || resolution.attempts === 0) {
    return (
      <Card className="py-4">
        {header}
        <CardContent className="flex flex-col items-center py-6">
          <Wrench className="text-muted-foreground/40 mb-2 size-8" />
          <p className="text-muted-foreground text-sm">No resolutions yet</p>
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
      {header}
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard label="Attempts" value={String(resolution.attempts)} icon={Hash} />
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
        <TrainFront className="text-muted-foreground size-6" />
        <h1 className="text-2xl font-bold tracking-tight">Merge Train</h1>
        <TrainStateBadge projectId={projectId} />
        {isAdmin && (
          <Link
            to="/projects/$projectId/train/audit"
            params={{ projectId }}
            className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1.5 text-sm font-medium"
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

      {/* Phase breakdown — time-to-land p95 above is the headline, this is its
          decomposition, and the verify-cache card below then explains the
          biggest bar. */}
      <PhaseTimingSection projectId={projectId} />

      {/* Verify cache + per-step metrics */}
      <VerifyCacheSection projectId={projectId} />

      {/* Conflict-resolution lineage metrics + enable toggle (Phase 7.6) */}
      <ResolutionSection projectId={projectId} isAdmin={isAdmin} />

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
