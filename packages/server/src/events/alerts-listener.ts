import { eq } from "drizzle-orm";
import { getDb, projects } from "../db/index.js";
import { EVENT_NAMES, getEventBus, type EventName, type EventPayload } from "./event-bus.js";

// ─── Outbound Discord alert delivery (Phase 7.4 §7.2 — half (b)) ───
//
// A minimal outbound webhook listener: on each train alert event it POSTs a
// Discord-shaped message ({ content }) to the project's configured
// discord_url, fire-and-forget. There is NO existing outbound delivery to
// reuse (§7.1) — this is the smallest mechanism that satisfies the intent. No
// queue, no retry daemon, no pluggable-provider abstraction.
//
// CRITICAL (NOTE 2): the listener handler body runs SYNCHRONOUSLY on the
// EventEmitter's emit() call inside computeMetrics. listeners.ts does NOT
// try/catch handler bodies, so a sync throw here (e.g. the settings DB read)
// would propagate up through emit() and 500 the metrics read. The handler
// therefore guards its ENTIRE sync path in try/catch, and the fetch is run via
// an un-awaited promise with a .catch — so a Discord POST failure can never
// block or break computeMetrics, and there is no unhandled rejection.

interface WebhookSettings {
  discord_url?: string;
  alerts_enabled?: boolean;
}

/**
 * Read projects.settings.webhooks for a project, defensively. Returns null if
 * the project / settings / webhooks block is absent or malformed.
 */
function readWebhookSettings(projectId: string | null): WebhookSettings | null {
  if (!projectId) return null;
  const db = getDb();
  const row = db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  const settings = row?.settings as { webhooks?: WebhookSettings } | null | undefined;
  return settings?.webhooks ?? null;
}

/**
 * Format a Discord webhook `content` string for a given alert event. The
 * payload.entity carries the per-event extras spread by the emitter.
 */
function formatAlert(event: EventName, payload: EventPayload): string {
  const e = (payload.entity ?? {}) as Record<string, unknown>;
  const resource = String(e.resource ?? "main");

  switch (event) {
    case EVENT_NAMES.TRAIN_STUCK: {
      const ageMs = Number(e.oldestQueuedAgeMs ?? 0);
      const ageMin = Math.round(ageMs / 60_000);
      const depth = Number(e.queueDepth ?? 0);
      return `:warning: Train stuck on \`${resource}\` — oldest queued ${ageMin}m, queue depth ${depth}.`;
    }
    case EVENT_NAMES.TRAIN_ABANDON_RATE_HIGH: {
      const ratio = Number(e.ratio ?? 0);
      const pct = Math.round(ratio * 100);
      const resolved = Number(e.resolved ?? 0);
      return `:warning: Abandon rate high on \`${resource}\` — ${pct}% of ${resolved} resolved requests abandoned (24h).`;
    }
    case EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY: {
      const lastSeenAt = e.lastSeenAt ? String(e.lastSeenAt) : "unknown";
      return `:rotating_light: Integrator unhealthy on \`${resource}\` — last heartbeat ${lastSeenAt}.`;
    }
    case EVENT_NAMES.TRAIN_INTEGRATION_STALLED: {
      const requestId = String(e.requestId ?? "unknown");
      const stalenessMs = Number(e.stalenessMs ?? 0);
      const stalenessMin = Math.round(stalenessMs / 60_000);
      return `:rotating_light: Integration stalled on \`${resource}\` — request ${requestId} stuck integrating ${stalenessMin}m with no attempt progress.`;
    }
    case EVENT_NAMES.CLAIM_STALE_ALERT: {
      // Identity-masked (Campaign C3 §P5a): aggregate count + oldest-stale age
      // only — never the holder id.
      const count = Number(e.staleCount ?? 0);
      const items = count === 1 ? "1 work item" : `${count} work items`;
      const ageMs = e.oldestStaleAgeMs == null ? null : Number(e.oldestStaleAgeMs);
      const oldest =
        ageMs == null ? "" : ` (oldest ${Math.max(1, Math.round(ageMs / 3_600_000))}h)`;
      return `:warning: Stale claims on project — ${items} claimed but inactive past grace${oldest}. Review or hand off.`;
    }
    case EVENT_NAMES.NOTE_BACKLOG_ALERT: {
      // Identity-masked (Campaign C2 §P5): aggregate count + oldest-open age
      // only — never a note id.
      const count = Number(e.openCount ?? 0);
      const items = count === 1 ? "1 untriaged note" : `${count} untriaged notes`;
      const ageMs = e.oldestUntriagedAgeMs == null ? null : Number(e.oldestUntriagedAgeMs);
      const oldest =
        ageMs == null ? "" : ` (oldest ${Math.max(1, Math.round(ageMs / 86_400_000))}d)`;
      return `:warning: Note backlog on project — ${items}${oldest}. Triage or dismiss.`;
    }
    case EVENT_NAMES.ESCALATION_SLA_BREACHED: {
      // Identity-masked (Campaign C4 §P3): aggregate count + oldest breaching
      // age only — never an escalation/holder id. Mirrors NOTE_BACKLOG_ALERT.
      const count = Number(e.breachCount ?? 0);
      const items = count === 1 ? "1 escalation unanswered" : `${count} escalations unanswered`;
      const ageMs = e.oldestBreachingAgeMs == null ? null : Number(e.oldestBreachingAgeMs);
      const oldest =
        ageMs == null ? "" : ` (oldest ${Math.max(1, Math.round(ageMs / 3_600_000))}h)`;
      return `:warning: Escalation SLA breach — ${items} past SLA${oldest}. Acknowledge or answer.`;
    }
    case EVENT_NAMES.TRIAGE_STALLED: {
      // Identity-masked (T3·P4): aggregate counts + ages only — never a note id.
      // HONEST wording: "triage not draining" (a stalled drain) — NOT
      // "daemon down" (a quiet-but-alive daemon records nothing, so we cannot
      // prove liveness from the absence of decisions).
      const count = Number(e.openCount ?? 0);
      const items = count === 1 ? "1 untriaged note" : `${count} untriaged notes`;
      const backlogMs = e.oldestUntriagedAgeMs == null ? null : Number(e.oldestUntriagedAgeMs);
      const oldest =
        backlogMs == null ? "" : ` (oldest ${Math.max(1, Math.round(backlogMs / 86_400_000))}d)`;
      const decisionMs = e.lastDecisionAgeMs == null ? null : Number(e.lastDecisionAgeMs);
      const since =
        decisionMs == null
          ? "no decisions recorded"
          : `no decisions in the last ${Math.max(1, Math.round(decisionMs / 3_600_000))}h`;
      return `:rotating_light: Triage not draining on a project — ${items}${oldest}, ${since} while on-mode triage is enabled. Check the triager daemon.`;
    }
    case EVENT_NAMES.ESCALATION_NEEDS_HUMAN: {
      // Campaign C2 §P5 — the ONE out-of-band escalation notification: a human
      // hand-off. Reads from payload.entity (the escalation toView — there is
      // NO `resource` field on an escalation). UNLIKE the masked aggregate
      // alerts above, this is intentionally SPECIFIC + actionable (id / title /
      // kind / origin) so a human can re-enter the exact thread for approval or
      // awareness — the human re-enters for the decision, never as transport.
      const title = String(e.title ?? "(untitled)");
      const kind = String(e.kind ?? "escalation");
      const severity = e.severity ? `/${String(e.severity)}` : "";
      const id = String(e.id ?? "unknown");
      const originRepo = String(e.originRepo ?? "unknown");
      const originWorkerKey = String(e.originWorkerKey ?? "unknown");
      return `:raised_hand: Escalation needs a human — "${title}" [${kind}${severity}] (id ${id}, from ${originRepo}/${originWorkerKey}).`;
    }
    default:
      return `:warning: Train alert (${event}) on \`${resource}\`.`;
  }
}

/**
 * POST the formatted alert to the project's Discord webhook URL. Returns
 * early (no-op) when there is no configured URL or alerts are explicitly
 * disabled. The settings read is sync; the fetch is awaited only INSIDE this
 * async function (the caller does NOT await it).
 */
async function deliverDiscordAlert(event: EventName, payload: EventPayload): Promise<void> {
  const settings = readWebhookSettings(payload.projectId);
  const url = settings?.discord_url;
  if (!url || settings?.alerts_enabled === false) return;

  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: formatAlert(event, payload) }),
  });
}

/**
 * Register the outbound Discord alert listener for the train alert events. The
 * handler guards its sync path (NOTE 2) and never awaits the
 * fetch — a failed POST is swallowed via .catch and logged, never crashing
 * the read path that emitted the event.
 */
export function registerWebhookAlertListener(): void {
  const bus = getEventBus();

  const handler = (event: EventName, payload: EventPayload): void => {
    try {
      void deliverDiscordAlert(event, payload).catch((err) => {
        console.warn(`[webhook-alert] Discord POST failed: ${err}`);
      });
    } catch (err) {
      // The sync path (settings read / format) threw — swallow so a misshapen
      // settings row can never 500 the metrics read.
      console.warn(`[webhook-alert] handler error: ${err}`);
    }
  };

  bus.on(EVENT_NAMES.TRAIN_STUCK, (p) => handler(EVENT_NAMES.TRAIN_STUCK, p));
  bus.on(EVENT_NAMES.TRAIN_ABANDON_RATE_HIGH, (p) =>
    handler(EVENT_NAMES.TRAIN_ABANDON_RATE_HIGH, p),
  );
  bus.on(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, (p) =>
    handler(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, p),
  );
  bus.on(EVENT_NAMES.TRAIN_INTEGRATION_STALLED, (p) =>
    handler(EVENT_NAMES.TRAIN_INTEGRATION_STALLED, p),
  );
  // Campaign C3 §P5a — the stale-claim alert rides the same outbound Discord
  // path (explicit B2 wiring, NOT auto). Identity-masked message; the handler's
  // settings read + format are guarded, the fetch un-awaited (NOTE 2).
  bus.on(EVENT_NAMES.CLAIM_STALE_ALERT, (p) => handler(EVENT_NAMES.CLAIM_STALE_ALERT, p));
  // Campaign C2 §P5 — the notes backlog-age alert rides the same outbound
  // Discord path (explicit wiring, NOT auto). Identity-masked message; the
  // handler's settings read + format are guarded, the fetch un-awaited (NOTE 2).
  bus.on(EVENT_NAMES.NOTE_BACKLOG_ALERT, (p) => handler(EVENT_NAMES.NOTE_BACKLOG_ALERT, p));
  // Campaign C2 §P5 — the needs_human escalation bridge: the ONE out-of-band
  // escalation notification. Per-event (NOT latched / no on-read eval — it
  // fires once in escalateToHuman, gated by assertTransition so needs_human is
  // never re-entered). Inherits the missing-url no-op + un-awaited-fetch
  // resilience of the shared handler.
  bus.on(EVENT_NAMES.ESCALATION_NEEDS_HUMAN, (p) => handler(EVENT_NAMES.ESCALATION_NEEDS_HUMAN, p));
  // Campaign C4 §P3 — the unanswered-SLA alert rides the same outbound Discord
  // path (explicit wiring, NOT auto). Identity-masked message; the handler's
  // settings read + format are guarded, the fetch un-awaited (NOTE 2).
  bus.on(EVENT_NAMES.ESCALATION_SLA_BREACHED, (p) =>
    handler(EVENT_NAMES.ESCALATION_SLA_BREACHED, p),
  );
  // T3·P4 — the triage.stalled ("triage not draining") alert rides the same
  // outbound Discord path (explicit wiring, NOT auto). Identity-masked message;
  // the handler's settings read + format are guarded, the fetch un-awaited
  // (NOTE 2). SSE is automatic via onAll.
  bus.on(EVENT_NAMES.TRIAGE_STALLED, (p) => handler(EVENT_NAMES.TRIAGE_STALLED, p));
}
