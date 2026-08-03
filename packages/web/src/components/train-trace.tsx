import { Link } from "@tanstack/react-router";
import { AlertTriangle, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTrainTrace } from "@/hooks/use-train";
import { formatDurationMs, formatRelativeTime } from "@/lib/format";
import { PHASE_BAR_COLOR, PHASE_LABEL, PHASE_MEANING } from "@/lib/phases";
import { cn } from "@/lib/utils";
import type { TrainTrace, TrainTraceElapsed, TrainTraceEntry } from "@/lib/api";

// ═══════════════════════════════════════════════════════════════════
// The lane event trace (campaign 2026-08-03 §P5) — "what happened lately, and
// what took how long".
//
// It lives beside In Flight and NOT inside train-audit-page.tsx, and the two
// must never absorb each other: the audit page is FORENSIC (admin-only,
// filterable, offset-paginated, no durations, complete) while this is
// OPERATIONAL (any reader, one lane, last 24 h, live, deliberately lossy). A
// surface that drops rows on purpose cannot be the surface of record.
//
// The phase taxonomy — hue, label, meaning — is imported from lib/phases.ts,
// never re-declared: a phase that is cyan "Queue wait" in the breakdown panel
// and green "queue_wait" here is two features telling one operator two stories.
// ═══════════════════════════════════════════════════════════════════

/**
 * THE one place a duration becomes a sentence.
 *
 * TOTAL over the union, with a `never` default — so adding a basis to the
 * contract breaks this build until someone writes its sentence, and a renderer
 * can NEVER print "took" over a since-pickup number, because it never sees a
 * bare `ms`. `none` returns the empty string: an event with no anchored
 * duration says nothing rather than "0s" or "—".
 */
export function formatElapsed(elapsed: TrainTraceElapsed): string {
  switch (elapsed.basis) {
    case "phase":
      return `took ${formatDurationMs(elapsed.ms)}`;
    case "queue_wait":
      return `waited ${formatDurationMs(elapsed.ms)} in queue`;
    case "forming":
      return `spent ${formatDurationMs(elapsed.ms)} forming`;
    // NOT "took": this is an instant that occurred `ms` after its trip started,
    // not a measurement of the instant itself.
    case "since_pickup":
      return `${formatDurationMs(elapsed.ms)} after pickup`;
    case "none":
      return "";
    default: {
      const exhaustive: never = elapsed;
      return exhaustive;
    }
  }
}

/**
 * A re-anchored wait renders its LAST segment, so the total since submit has to
 * be stated somewhere or the row quietly under-reports the wait. It goes in the
 * title, beside a visible "(last segment)" note that says a title exists.
 */
function requeueNote(elapsed: TrainTraceElapsed): string | null {
  if (elapsed.basis !== "queue_wait" && elapsed.basis !== "forming") return null;
  if (!elapsed.requeued) return null;
  return `Re-queued — this is the last segment only. Total since submit: ${formatDurationMs(
    elapsed.sinceSubmitMs,
  )}.`;
}

type Kind = TrainTraceEntry["kind"];

/** Sentence case, matching PHASE_LABEL — these are prose, not headings. */
const KIND_LABEL: Record<Kind, string> = {
  // `phase` is labelled from the phase taxonomy instead (see entryLabel).
  phase: "Phase",
  picked_up: "Picked up",
  group_started: "Group picked up",
  landed: "Landed",
  rejected: "Rejected",
  group_landed: "Group landed",
  group_rejected: "Group rejected",
  group_partially_landed: "Group PARTIALLY landed",
  requeued: "Re-queued",
  cancelled: "Cancelled",
  incident_opened: "Incident opened",
  paused: "Train paused",
  resumed: "Train resumed",
  lock_force_released: "Lock force-released",
  force_landed: "Force-landed",
  force_rejected: "Force-rejected",
  force_cancelled: "Force-cancelled",
  outer_converted: "Outer converted",
  outer_gitlink_normalized: "Outer gitlink normalized",
};

/**
 * SEMANTIC hues (good / bad / attention / neutral), deliberately NOT the
 * categorical phase palette: a phase entry takes its hue from PHASE_BAR_COLOR
 * so it keys to the breakdown panel, while a lifecycle entry's colour has to
 * carry outcome, which is an ordinal signal.
 */
const KIND_DOT: Record<Kind, string> = {
  phase: "bg-muted-foreground/40",
  picked_up: "bg-sky-500",
  group_started: "bg-sky-500",
  landed: "bg-green-500 dark:bg-green-600",
  group_landed: "bg-green-500 dark:bg-green-600",
  rejected: "bg-red-500",
  group_rejected: "bg-red-500",
  group_partially_landed: "bg-orange-500",
  requeued: "bg-amber-500",
  cancelled: "bg-gray-400 dark:bg-gray-600",
  incident_opened: "bg-orange-600",
  paused: "bg-amber-500",
  resumed: "bg-sky-500",
  lock_force_released: "bg-amber-500",
  force_landed: "bg-green-600",
  force_rejected: "bg-red-600",
  force_cancelled: "bg-gray-500",
  outer_converted: "bg-indigo-400",
  outer_gitlink_normalized: "bg-indigo-400",
};

function entryLabel(entry: TrainTraceEntry): string {
  if (entry.kind === "phase" && entry.phase) {
    return entry.label ? `${PHASE_LABEL[entry.phase]} · ${entry.label}` : PHASE_LABEL[entry.phase];
  }
  return KIND_LABEL[entry.kind];
}

function entryDot(entry: TrainTraceEntry): string {
  return entry.kind === "phase" && entry.phase
    ? PHASE_BAR_COLOR[entry.phase]
    : KIND_DOT[entry.kind];
}

// ─── Row ─────────────────────────────────────────────────────────

/**
 * One entry. Pure and prop-driven — no queries, no page knowledge — so the row
 * is testable against a fixture and reusable if a per-request view ever wants it.
 */
export function TrainTraceRow({ entry }: { entry: TrainTraceEntry }) {
  const elapsedText = formatElapsed(entry.elapsed);
  const note = requeueNote(entry.elapsed);
  const meaning = entry.kind === "phase" && entry.phase ? PHASE_MEANING[entry.phase] : undefined;

  return (
    <li className="flex items-start gap-3 border-b py-2 last:border-0" data-testid="trace-row">
      <span
        aria-hidden="true"
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", entryDot(entry))}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xs font-medium" title={meaning}>
            {entryLabel(entry)}
          </span>

          {/* A request links to its OWN timeline — the per-request history any
              authenticated user may read, and the right destination for
              "everything about this one trip". The audit page is admin-only and
              is deliberately not linked from here. */}
          {entry.subject.type === "request" ? (
            <Link
              to="/merge-requests/$requestId/timeline"
              params={{ requestId: entry.subject.id }}
              className="min-w-0 truncate text-xs text-blue-600 hover:underline dark:text-blue-400"
              title={entry.subject.name}
            >
              {entry.subject.name}
            </Link>
          ) : (
            <span
              className="text-muted-foreground min-w-0 truncate text-xs"
              title={entry.subject.name}
            >
              {entry.subject.name}
            </span>
          )}

          {entry.detail && (
            <span className="text-muted-foreground/80 font-mono text-[10px]">{entry.detail}</span>
          )}

          {entry.overridden && (
            <Badge
              variant="secondary"
              className="bg-amber-100 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
            >
              operator override
            </Badge>
          )}
        </div>

        {entry.reason && (
          <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
            {entry.reason}
            {entry.actor && <span className="text-muted-foreground/70"> — {entry.actor.name}</span>}
          </p>
        )}
      </div>

      <div className="shrink-0 text-right">
        {elapsedText && (
          <p className="text-xs tabular-nums" title={note ?? undefined}>
            {elapsedText}
            {note && <span className="text-muted-foreground"> (last segment)</span>}
          </p>
        )}
        <p
          className="text-muted-foreground/70 text-[10px]"
          title={new Date(entry.at).toISOString()}
        >
          {formatRelativeTime(entry.at)}
        </p>
      </div>
    </li>
  );
}

// ─── Section ─────────────────────────────────────────────────────

function header(sub?: string) {
  return (
    <CardHeader className="pb-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="text-muted-foreground text-sm font-medium">Recent events</CardTitle>
          <p className="text-muted-foreground/70 mt-1 text-xs">
            What happened on this lane lately, and what took how long
          </p>
        </div>
        {sub && (
          <Badge variant="secondary" className="text-[10px]">
            {sub}
          </Badge>
        )}
      </div>
    </CardHeader>
  );
}

/** "the last 24 h" / "the last 3 h", read off the window the server returned. */
function windowLabel(win: TrainTrace["window"]): string {
  const hours = Math.round((Date.parse(win.to) - Date.parse(win.from)) / 3_600_000);
  if (!Number.isFinite(hours) || hours <= 0) return "the window";
  return `the last ${hours} h`;
}

export function TrainTraceSection({ projectId }: { projectId: string }) {
  const { data: trace, isLoading, isError } = useTrainTrace(projectId);

  if (isLoading) {
    return (
      <Card className="py-4">
        {header()}
        <CardContent className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  // A BROKEN feed and a QUIET lane must never look alike: here that difference
  // is "the train has nothing to report" versus "you are flying blind". Hence a
  // red border and an alarm glyph, not the muted empty state below.
  if (isError || !trace) {
    return (
      <Card className="border-red-300 py-4 dark:border-red-900/50">
        {header()}
        <CardContent
          className="flex flex-col items-center py-6"
          data-testid="trace-error"
          role="alert"
        >
          <AlertTriangle className="mb-2 size-8 text-red-500" />
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            Could not load recent events
          </p>
          <p className="text-muted-foreground mt-1 max-w-sm text-center text-xs">
            This feed is unavailable — it is NOT a report that the lane is quiet.
          </p>
        </CardContent>
      </Card>
    );
  }

  const entries = trace.data;
  const scope = windowLabel(trace.window);

  if (entries.length === 0) {
    return (
      <Card className="py-4">
        {header()}
        <CardContent className="flex flex-col items-center py-6" data-testid="trace-empty">
          <History className="text-muted-foreground/40 mb-2 size-8" />
          <p className="text-muted-foreground text-sm">Nothing in {scope}</p>
          <p className="text-muted-foreground/70 mt-1 max-w-sm text-center text-xs">
            No pickups, lands, rejects or phase boundaries on this lane.
          </p>
        </CardContent>
      </Card>
    );
  }

  // The EXPECTED state until the integrator is redeployed with §P2's emitters:
  // lifecycle events but no phase rows. It is the good case, so the feed renders
  // normally and a footer explains the missing durations — never an empty state.
  const hasPhases = entries.some((e) => e.kind === "phase");

  return (
    <Card className="py-4">
      {header(`${entries.length} in ${scope}`)}
      <CardContent className="space-y-3">
        <ul className="divide-border">
          {/* The composite id (`phase:…` / `audit:…` / `entity:…`) is what keeps
              two entries sharing an instant from colliding as keys. */}
          {entries.map((entry) => (
            <TrainTraceRow key={entry.id} entry={entry} />
          ))}
        </ul>

        <div className="text-muted-foreground/80 space-y-1.5 text-xs">
          {!hasPhases && (
            <p>
              Durations appear once the integrator reports phase boundaries; the events above are
              already complete.
            </p>
          )}
          {trace.truncated && (
            <p>
              Showing the newest {entries.length} of {scope} — open a request&apos;s timeline for
              its full history.
            </p>
          )}
          <p>
            A recent view, not the record: per-attempt steps, batch markers and resolver activity
            are deliberately left out, and older entries are not reachable from here.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
