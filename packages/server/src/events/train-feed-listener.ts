import { and, eq, sql } from "drizzle-orm";
import { mergeIncidentTypeInfo } from "@pm/shared";
import { getDb, mergeRequests, tasks, users } from "../db/index.js";
import { postDiscord } from "./alerts-listener.js";
import { EVENT_NAMES, getEventBus, type EventName, type EventPayload } from "./event-bus.js";
import { humanDuration, phaseLineForGroup, phaseLineForRequest } from "./phase-line.js";

// ─── Outbound Discord TRAIN EVENT FEED ────────────────────────────
//
// The alerts-listener (alerts-listener.ts) carries THRESHOLD alerts: something
// is wrong (stuck / unhealthy / stalled). This listener carries the ordinary
// merge-train NARRATION — "the train picked this up", "it landed", "it was
// rejected and here's why" — so an operator watching a Discord channel sees the
// event stream itself, not just its failures.
//
// Terminal events (land / reject, per request and per group) carry a SECOND
// line — the stopwatch segment from phase-line.ts, which says where the wall
// clock the first line reports actually went. One message with a `\n`, never a
// second POST. Pickup does not carry it (the line already says "waited 12m in
// queue"), requeue does not (the trip is not over — its minutes are accounted
// once, at the terminal event), abandon does not (no integration happened), and
// incident/pause/resume do not (no single subject to time).
//
// Deliberately NOT narrated (noise, no decision value): queue/submit
// (merge.request.queued), per-attempt start/complete, the Phase-7.2 batch
// markers, and per-member group landings (the ONE group.landed line already
// names every member).
//
// Design constraints inherited from alerts-listener.ts:
//   - The handler body runs SYNCHRONOUSLY inside the emitting service's
//     emit(); it must never throw and never block. Every sync path is
//     try/caught and the fetch is un-awaited with a .catch.
//   - Every emitter fires AFTER its transaction commits, so the enrichment
//     reads below (task title, group members, queue depth) see committed rows.
//
// Gate: postDiscord(..., "train_feed") — silenced by
// settings.webhooks.train_events_enabled === false, or by the master
// alerts_enabled === false. Absent ⇒ ON (an operator who configured a Discord
// URL wants the stream).

// ─── Formatting primitives ────────────────────────────────────────

const MAX_TITLE = 70;
const MAX_REASON = 320;

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function shortSha(sha: unknown): string {
  const s = String(sha ?? "");
  return s.length > 12 ? s.slice(0, 8) : s;
}

/** Elapsed time between an ISO instant and the event's own timestamp. */
function ageSince(iso: unknown, nowIso: string): string | null {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(nowIso) - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return humanDuration(ms);
}

// ─── Enrichment reads (all sync, all post-commit) ─────────────────

interface MemberLike {
  id: string;
  taskId: string | null;
  branch: string | null;
  synthetic: boolean;
  pickedUpAt: string | null;
}

function readTaskTitle(taskId: unknown): string | null {
  if (typeof taskId !== "string" || !taskId) return null;
  const row = getDb().select({ title: tasks.title }).from(tasks).where(eq(tasks.id, taskId)).get();
  return row?.title ?? null;
}

function readActorName(actorId: string | null): string | null {
  if (!actorId) return null;
  const row = getDb()
    .select({ name: users.displayName })
    .from(users)
    .where(eq(users.id, actorId))
    .get();
  return row?.name ?? null;
}

function readGroupMembers(groupId: unknown): MemberLike[] {
  if (typeof groupId !== "string" || !groupId) return [];
  return getDb()
    .select({
      id: mergeRequests.id,
      taskId: mergeRequests.taskId,
      branch: mergeRequests.branch,
      synthetic: mergeRequests.synthetic,
      pickedUpAt: mergeRequests.pickedUpAt,
    })
    .from(mergeRequests)
    .where(eq(mergeRequests.groupId, groupId))
    .all();
}

/**
 * How many requests are STILL waiting on this lane. Read after the emitting
 * commit, so a request that just flipped queued → integrating is already
 * excluded: this is the remaining depth, which is what an operator wants.
 */
function readQueueDepth(projectId: string | null, resource: string): number {
  if (!projectId) return 0;
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(mergeRequests)
    .where(
      and(
        eq(mergeRequests.projectId, projectId),
        eq(mergeRequests.resource, resource),
        eq(mergeRequests.status, "queued"),
      ),
    )
    .get();
  return Number(row?.n ?? 0);
}

// ─── Human-readable names ─────────────────────────────────────────

/**
 * The best human-readable name for a merge request, in preference order:
 * the linked task's title, then the branch, then the raw id. A synthetic
 * member (inner-only / lone-outer groups) has neither task nor branch by
 * construction — name it for what it is.
 */
function labelRequest(r: {
  id?: unknown;
  taskId?: unknown;
  branch?: unknown;
  synthetic?: unknown;
}): string {
  if (r.synthetic === true) return "_synthetic member_";
  const title = readTaskTitle(r.taskId);
  const branch = typeof r.branch === "string" && r.branch ? r.branch : null;
  if (title && branch) return `"${truncate(title, MAX_TITLE)}" (\`${branch}\`)`;
  if (title) return `"${truncate(title, MAX_TITLE)}"`;
  if (branch) return `\`${branch}\``;
  return `request \`${String(r.id ?? "unknown")}\``;
}

/**
 * A group has no name of its own — it is named by the work it carries. Use the
 * REAL (non-synthetic) members' labels; fall back to the group id.
 */
function labelGroup(groupId: unknown, members: MemberLike[]): string {
  const real = members.filter((m) => !m.synthetic);
  const named = (real.length > 0 ? real : members).slice(0, 2).map((m) => labelRequest(m));
  if (named.length === 0) return `group \`${String(groupId ?? "unknown")}\``;
  const more = (real.length > 0 ? real.length : members.length) - named.length;
  return more > 0 ? `${named.join(" + ")} +${more} more` : named.join(" + ");
}

/** The oldest pickup instant across a group's members (the group's own start). */
function groupPickedUpAt(members: MemberLike[]): string | null {
  const stamps = members.map((m) => m.pickedUpAt).filter((s): s is string => Boolean(s));
  if (stamps.length === 0) return null;
  return stamps.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/**
 * The stopwatch line for a request's OWN outcome — empty for a grouped member,
 * because the group's line already accounts for the same minutes.
 *
 * Mirrors the `if (e.groupId) return null` idiom of the INTEGRATING case, but
 * suppresses only the phase segment: a grouped member's land is already silent
 * (landGroup writes members inside the txn and emits the un-narrated
 * MERGE_GROUP_MEMBER_LANDED), and its ordinary reject is one group-level UPDATE
 * with no per-member event — but the PARTIALLY-LANDED path is not. There
 * (group-land.ts, "outer push failed after inner landed") the outer member is
 * rejected individually, so MERGE_REQUEST_REJECTED fires seconds before
 * MERGE_GROUP_REJECTED. Two stopwatch lines whose intervals are a strict
 * superset/subset pair is exactly the double-accounting the union prevents
 * WITHIN a line — so it must not be reintroduced BETWEEN lines. Same exposure for
 * an operator's force-land / force-reject of a grouped member.
 */
function memberPhaseLine(entity: Record<string, unknown>, requestId: string): string {
  return entity.groupId ? "" : phaseLineForRequest(requestId);
}

// ─── Formatter ────────────────────────────────────────────────────

/**
 * Format one lifecycle event as a Discord `content` line, or return null to
 * narrate nothing (e.g. a grouped member's own pickup — the group line already
 * covers it).
 *
 * Exported for tests.
 */
export function formatTrainFeedEvent(event: EventName, payload: EventPayload): string | null {
  const e = (payload.entity ?? {}) as Record<string, unknown>;
  const resource = String(e.resource ?? "main");
  const lane = `\`${resource}\``;
  const at = payload.timestamp;
  const reason = (raw: unknown): string =>
    typeof raw === "string" && raw.trim() ? truncate(raw, MAX_REASON) : "no reason given";

  switch (event) {
    // ── Pickup ────────────────────────────────────────────────────
    case EVENT_NAMES.MERGE_REQUEST_INTEGRATING: {
      // A grouped member is announced ONCE, by merge.group.started.
      if (e.groupId) return null;
      const waited = ageSince(e.enqueuedAt, at);
      const depth = readQueueDepth(payload.projectId, resource);
      return [
        `:arrow_forward: **Integrating** on ${lane} — ${labelRequest(e)}`,
        waited ? `waited ${waited} in queue` : null,
        `queue depth now ${depth}`,
        `id \`${payload.entityId}\``,
      ]
        .filter(Boolean)
        .join(" · ");
    }

    case EVENT_NAMES.MERGE_GROUP_STARTED: {
      const members = readGroupMembers(payload.entityId);
      const depth = readQueueDepth(payload.projectId, resource);
      const count = Number(e.memberCount ?? members.length);
      return [
        `:arrow_forward: **Integrating group** on ${lane} — ${labelGroup(payload.entityId, members)}`,
        `${count} ${count === 1 ? "member" : "members"} (cross-repo)`,
        `queue depth now ${depth}`,
        `group \`${payload.entityId}\``,
      ].join(" · ");
    }

    // ── Outcomes ──────────────────────────────────────────────────
    case EVENT_NAMES.MERGE_REQUEST_LANDED: {
      const took = ageSince(e.pickedUpAt, at);
      const base = [
        `:white_check_mark: **Landed** on ${lane} — ${labelRequest(e)}`,
        `sha \`${shortSha(e.landedSha)}\``,
        took ? `${took} since pickup` : null,
        e.overridden === true ? "**force-landed by an operator**" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return base + memberPhaseLine(e, payload.entityId);
    }

    case EVENT_NAMES.MERGE_REQUEST_REJECTED: {
      const took = ageSince(e.pickedUpAt, at);
      const category = String(e.category ?? e.rejectCategory ?? "unknown");
      const base = [
        `:x: **Rejected** on ${lane} — ${labelRequest(e)}`,
        `[${category}] ${reason(e.reason ?? e.rejectReason)}`,
        took ? `${took} since pickup` : null,
        e.overridden === true ? "**force-rejected by an operator**" : null,
        `id \`${payload.entityId}\``,
      ]
        .filter(Boolean)
        .join(" · ");
      return base + memberPhaseLine(e, payload.entityId);
    }

    case EVENT_NAMES.MERGE_GROUP_LANDED: {
      const members = readGroupMembers(payload.entityId);
      const took = ageSince(groupPickedUpAt(members), at);
      const shas: string[] = [];
      if (e.innerLandedSha) shas.push(`inner \`${shortSha(e.innerLandedSha)}\``);
      if (e.outerLandedSha) shas.push(`outer \`${shortSha(e.outerLandedSha)}\``);
      if (shas.length === 0 && Array.isArray(e.members)) {
        for (const m of e.members as Array<{ landedSha?: unknown }>) {
          shas.push(`\`${shortSha(m.landedSha)}\``);
        }
      }
      const base = [
        `:white_check_mark: **Group landed** on ${lane} — ${labelGroup(payload.entityId, members)}`,
        shas.length > 0 ? shas.join(" + ") : null,
        took ? `${took} since pickup` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return base + phaseLineForGroup(payload.entityId);
    }

    case EVENT_NAMES.MERGE_GROUP_REJECTED: {
      const members = readGroupMembers(payload.entityId);
      const label = labelGroup(payload.entityId, members);
      // markPartiallyLanded reuses this event with an outcome discriminator
      // (§10.2) — the inner landed and the outer did NOT, which is an incident,
      // not an ordinary reject.
      if (e.outcome === "partially_landed") {
        return (
          [
            `:rotating_light: **Group PARTIALLY landed** on ${lane} — ${label}`,
            `inner landed, outer did NOT: ${reason(e.reason ?? e.resolutionReason)}`,
            `group \`${payload.entityId}\``,
          ].join(" · ") + phaseLineForGroup(payload.entityId)
        );
      }
      return (
        [
          `:x: **Group rejected** on ${lane} — ${label}`,
          reason(e.reason ?? e.resolutionReason),
          `group \`${payload.entityId}\``,
        ].join(" · ") + phaseLineForGroup(payload.entityId)
      );
    }

    case EVENT_NAMES.MERGE_REQUEST_ABANDONED: {
      return [
        `:no_entry_sign: **Abandoned** on ${lane} — ${labelRequest(e)}`,
        reason(e.reason),
        `id \`${payload.entityId}\``,
      ].join(" · ");
    }

    case EVENT_NAMES.MERGE_REQUEST_REQUEUED: {
      // Not the worker's submit (that is merge.request.queued, deliberately
      // unnarrated) — this is a request FALLING BACK into the queue mid-flight.
      return [
        `:arrows_counterclockwise: **Re-queued** on ${lane} — ${labelRequest(e)}`,
        reason(e.reason),
      ].join(" · ");
    }

    // ── Incidents + lane control ──────────────────────────────────
    case EVENT_NAMES.MERGE_INCIDENT_OPENED: {
      const type = String(e.type ?? "incident");
      const inner = String(e.innerRepo ?? "inner");
      const outer = String(e.outerRepo ?? "outer");
      // One descriptor per incident type, owned by @pm/shared, so the feed
      // narrates the DIRECTION rather than shrugging. The vague line survives
      // as the defensive fallback for a wire string this build doesn't know.
      const info = mergeIncidentTypeInfo(type);
      const detail = info
        ? info.summary({ innerRepo: inner, outerRepo: outer, sha: shortSha(e.orphanedSha) })
        : `\`${inner}\` @ \`${shortSha(e.orphanedSha)}\` vs \`${outer}\``;
      return [
        `:rotating_light: **Merge incident opened** — ${type}`,
        detail,
        // The operator reading this at 2am is exactly who needs to know the
        // train will not fix this one. No cure advice here — that belongs to
        // the reject comment.
        info?.curedBy === "human"
          ? "the train will NOT auto-heal this — a human must decide"
          : null,
        `incident \`${payload.entityId}\``,
      ]
        .filter(Boolean)
        .join(" · ");
    }

    case EVENT_NAMES.TRAIN_PAUSED: {
      const who = readActorName(payload.actorId);
      return [
        `:pause_button: **Train paused** on ${lane} — ${reason(e.reason)}`,
        who ? `by ${who}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }

    case EVENT_NAMES.TRAIN_RESUMED: {
      const who = readActorName(payload.actorId);
      return [
        `:arrow_forward: **Train resumed** on ${lane} — ${reason(e.reason)}`,
        who ? `by ${who}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }

    default:
      return null;
  }
}

// ─── Registration ─────────────────────────────────────────────────

/** The lifecycle events narrated to Discord. Order = narrative order. */
const FEED_EVENTS: EventName[] = [
  EVENT_NAMES.MERGE_REQUEST_INTEGRATING,
  EVENT_NAMES.MERGE_GROUP_STARTED,
  EVENT_NAMES.MERGE_REQUEST_LANDED,
  EVENT_NAMES.MERGE_REQUEST_REJECTED,
  EVENT_NAMES.MERGE_REQUEST_REQUEUED,
  EVENT_NAMES.MERGE_REQUEST_ABANDONED,
  EVENT_NAMES.MERGE_GROUP_LANDED,
  EVENT_NAMES.MERGE_GROUP_REJECTED,
  EVENT_NAMES.MERGE_INCIDENT_OPENED,
  EVENT_NAMES.TRAIN_PAUSED,
  EVENT_NAMES.TRAIN_RESUMED,
];

/**
 * Register the outbound Discord train event feed. Mirrors
 * registerWebhookAlertListener's resilience contract exactly: the whole sync
 * path (enrichment reads + formatting) is guarded, and the POST is an
 * un-awaited promise with a .catch — a Discord outage, a misshapen settings
 * row, or a deleted task can never break a land, a reject, or a pickup.
 */
export function registerTrainFeedListener(): void {
  const bus = getEventBus();

  const handler = (event: EventName, payload: EventPayload): void => {
    try {
      const content = formatTrainFeedEvent(event, payload);
      if (content === null) return;
      void postDiscord(payload.projectId, content, "train_feed").catch((err) => {
        console.warn(`[train-feed] Discord POST failed: ${err}`);
      });
    } catch (err) {
      console.warn(`[train-feed] handler error: ${err}`);
    }
  };

  for (const event of FEED_EVENTS) {
    bus.on(event, (p) => handler(event, p));
  }
}
