import { eq } from "drizzle-orm";
import type {
  AuditLogView,
  ClaimState,
  ClaimStatus,
  LeaseEntityType,
  UserType,
} from "@pm/shared";
import { AppError } from "../types.js";
import { getDb } from "../db/index.js";
import { getEventBus, EVENT_NAMES, type EventName } from "../events/event-bus.js";
import {
  record as recordAudit,
  emitAuditRecorded,
} from "./audit.service.js";
import { getById as getUserById } from "./user.service.js";
import {
  acquireLease,
  deriveLiveness,
  readLease,
  renewLease,
} from "./claim-lease.service.js";

// Re-export so callers don't need an additional import for the event name set.
export { EVENT_NAMES };

export interface Actor {
  id: string;
  type: UserType;
}

export type ClaimFilter = "available" | "mine" | "all";

/**
 * Compute the claim_status enum relative to a caller.
 * Returns "unclaimed" when no caller is supplied (e.g. server-internal call).
 */
export function deriveClaimStatus(
  claimedBy: string | null | undefined,
  caller?: { id: string } | null,
): ClaimStatus {
  if (!claimedBy) return "unclaimed";
  if (caller && claimedBy === caller.id) return "claimed_by_you";
  return "claimed_by_other";
}

/**
 * Compute the identity-masked claim_state enum — the liveness view of a claim
 * relative to a caller, folding in the lease via deriveLiveness:
 *
 *   - no holder                       → "unclaimed"
 *   - caller IS the holder            → "yours"  (BEFORE liveness — a self-stale
 *                                        lease still reads "yours" to the holder)
 *   - held by another, lease ABSENT   → "stale"  (no lease ⇒ stale by definition:
 *                                        every live claim creates a lease on the
 *                                        claim path, so a holder without one is a
 *                                        legacy/abandoned claim)
 *   - held by another, lease stale    → "stale"
 *   - held by another, lease live     → "live"
 *
 * Returns the enum only — never the holder id (identity-masked, like
 * deriveClaimStatus). The lease is read by the caller (get path) or pre-fetched
 * (list path) and passed in.
 */
export function deriveClaimState(
  holderId: string | null | undefined,
  lease: { expiresAt: string | null } | null,
  now: Date,
  caller?: { id: string } | null,
): ClaimState {
  if (!holderId) return "unclaimed";
  if (caller && holderId === caller.id) return "yours";
  // A held entity with no lease row is a legacy/abandoned claim — stale by
  // definition (post-backfill there are no leaseless holders; this is the
  // belt-and-suspenders for any that slip through).
  if (!lease) return "stale";
  return deriveLiveness(now, lease.expiresAt) === "stale" ? "stale" : "live";
}

/**
 * Enforce that an AI agent holds the claim on an entity before writing — and,
 * for the holder, treat every write as a heartbeat (the SINGLE liveness seam).
 *
 * Humans always pass and create no lease (they hold no claim-lease). An AI
 * agent that holds the claim passes AND renews its lease (a write IS activity);
 * if the lease is absent — a legacy/pre-lease holder, or one whose lease lapsed
 * and was reclaimed/never-created — the holder's own write self-heals it via
 * acquire (create-if-missing). The non-holder still hits the 409, with NO lease
 * side effect (a rejected agent never touches the lease).
 *
 * Note: this deliberately does NOT consult lease liveness to GATE the write.
 * The holder's identity (claimedBy === actor.id) is the authz; the lease is the
 * activity ledger the sweep reclaims against. A holder writing past its TTL is
 * not denied — it heals its own lease forward.
 */
export function assertClaimOk(
  claimedBy: string | null | undefined,
  actor: Actor,
  entityName: string,
  entityType: LeaseEntityType,
  entityId: string,
): void {
  if (actor.type === "human") return;
  if (claimedBy === actor.id) {
    // The holder is writing — renew (heartbeat). A null return means no lease
    // exists for this holder (legacy holder, or lapsed-and-reclaimed) — acquire
    // to (re)establish it so the activity is recorded going forward.
    const renewed = renewLease(entityType, entityId, { id: actor.id });
    if (renewed === null) acquireLease(entityType, entityId, { id: actor.id });
    return;
  }
  throw new AppError(
    409,
    "CLAIM_DENIED",
    claimedBy
      ? `This ${entityName} is claimed by another agent.`
      : `You have not claimed this ${entityName}. Call claim first.`,
  );
}

// ─── Force-claim (reason-required claim takeover) ─────────────────
//
// A force-claim takes over a claim held by another identity (the motivating
// scenario: an AI agent's MCP session identity flips on reconnect — a new
// `users` row — stranding its epic/task under the old assigneeId; the new
// identity then gets 409 CLAIM_DENIED on re-claim/complete). Force-claim is
// the graceful self-recovery primitive: reason-required + audited.
//
// This is the DRY home for the accountability/authz/reason logic shared by
// task/epic/proposal. It mirrors train.service.forceLand EXACTLY: the
// reason-check, the synchronous better-sqlite3 db.transaction with the audit
// row written INSIDE the txn, the inline auditView build, and the
// emit + emitAuditRecorded AFTER commit.

export interface ForceClaimResult {
  ok: true;
  status: "force_claimed";
  /**
   * The displaced holder's id, or "" when the entity was unheld at takeover
   * time. Never null so the API contract (z.string()) stays simple; the MCP
   * render never interpolates it anyway (no-leak).
   */
  previousHolder: string;
  newHolder: string;
}

/**
 * A minimal structural view of the entity table. Drizzle tables carry far
 * richer column types, but the helper only ever touches id/status/projectId
 * plus the dynamic holder column (accessed via the computed-key house pattern,
 * never as a static `.set({ [key]: ... })` literal — FOLDED-FIX 2).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EntityTable = any;

interface EntityRow {
  id: string;
  status: string;
  projectId: string | null;
  assigneeId?: string | null;
  claimedBy?: string | null;
  [key: string]: unknown;
}

export interface ForceClaimConfig {
  table: EntityTable;
  holderKey: "assigneeId" | "claimedBy";
  holderJsonKey: "assignee_id" | "claimed_by";
  terminalStatuses: ReadonlySet<string>;
  eventName: EventName;
  entityType: "task" | "epic" | "proposal";
}

/**
 * The audited-transfer CORE shared by every claim handoff (force-claim,
 * release-to, request-takeover). It performs ONLY the parts that are identical
 * across handoffs — the terminal guard, the txn (clear old holder + set new
 * holder + ONE audit row), and the post-commit event + audit.recorded + lease
 * transfer to the new holder. It performs **no authz** of its own: each caller
 * applies its OWN gate first (forceClaim's self-or-human-to-target rule;
 * releaseTo's holder-only-for-agents rule) and then delegates here.
 *
 * Pre-resolved inputs (the caller validated them): `targetId` is the resolved
 * server-side target (a real user), `reason` is non-empty, `projectId` is the
 * entity's non-null project, and `auditAction` is the audit-log action to
 * record (currently always `"force_claim"` — the reason carries the intent of a
 * release-to vs a takeover, avoiding an audit-enum change).
 *
 * Returns the displaced holder (or "" when the entity was unheld). Mirrors the
 * old forceClaim txn shape EXACTLY (this is a pure extraction).
 */
function performClaimTransfer(
  id: string,
  actor: Actor,
  opts: {
    targetId: string;
    reason: string;
    projectId: string;
    auditAction: "force_claim";
  },
  cfg: ForceClaimConfig,
): { previousHolder: string; newHolder: string } {
  const { targetId: target, reason, projectId, auditAction } = opts;

  // Terminal entities cannot be transferred.
  const row = getDb()
    .select()
    .from(cfg.table)
    .where(eq(cfg.table.id, id))
    .get() as EntityRow;
  if (cfg.terminalStatuses.has(row.status)) {
    throw new AppError(
      409,
      "CLAIM_CLOSED",
      `This ${cfg.entityType} is closed and cannot be claimed.`,
    );
  }

  const now = new Date().toISOString();
  let oldHolder: string | null = null;
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  const db = getDb();
  db.transaction((tx) => {
    const fresh = tx
      .select()
      .from(cfg.table)
      .where(eq(cfg.table.id, id))
      .get() as EntityRow;
    oldHolder = (fresh[cfg.holderKey] as string | null | undefined) ?? null;

    // FOLDED-FIX 2: computed-key via a Record (house pattern — NOT a computed
    // literal into .set()).
    const values: Record<string, unknown> = {
      [cfg.holderKey]: target,
      updatedAt: now,
    };
    tx.update(cfg.table).set(values).where(eq(cfg.table.id, id)).run();

    const before = { [cfg.holderJsonKey]: oldHolder };
    const after = { [cfg.holderJsonKey]: target };
    auditId = recordAudit(tx, {
      projectId,
      actorId: actor.id,
      action: auditAction,
      targetType: cfg.entityType,
      targetId: id,
      reason,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId,
      actorId: actor.id,
      action: auditAction,
      targetType: cfg.entityType,
      targetId: id,
      reason,
      metadataBefore: before,
      metadataAfter: after,
      createdAt: now,
    };
  });

  // After commit: emit the domain event + audit.recorded.
  const updated = getDb()
    .select()
    .from(cfg.table)
    .where(eq(cfg.table.id, id))
    .get() as EntityRow;
  getEventBus().emit(cfg.eventName, {
    entity: updated,
    entityType: cfg.entityType,
    entityId: id,
    projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { [cfg.holderJsonKey]: { from: oldHolder, to: target } },
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, projectId, actor.id, auditView);
  }

  // Transfer the lease to the new holder (acquire = create-or-overwrite), so
  // the displaced holder's lease never lingers and the takeover is recorded as
  // the new holder's activity. cfg.entityType is "task"|"epic"|"proposal" —
  // exactly LeaseEntityType.
  acquireLease(cfg.entityType, id, { id: target });

  return { previousHolder: oldHolder ?? "", newHolder: target };
}

export function forceClaim(
  id: string,
  actor: Actor,
  opts: { reason: string; newAssigneeId?: string | null },
  cfg: ForceClaimConfig,
): ForceClaimResult {
  // 1. reason required (mirrors forceLand — route enforces z.min(1) too).
  if (!opts.reason || opts.reason.trim() === "") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "force-claim requires a non-empty reason.",
    );
  }

  // 2. load the row.
  const row = getDb()
    .select()
    .from(cfg.table)
    .where(eq(cfg.table.id, id))
    .get() as EntityRow | undefined;
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `${cfg.entityType} not found: ${id}`);
  }

  // 3. FOLDED-FIX 1: audit_log.projectId is NOT NULL — a proposal with a null
  //    projectId cannot be audited, so refuse BEFORE the txn (uniform + harmless
  //    for tasks/epics whose projectId is NOT NULL).
  if (row.projectId == null) {
    throw new AppError(
      409,
      "NO_PROJECT",
      `This ${cfg.entityType} is not associated with a project and cannot be force-claimed.`,
    );
  }
  const projectId = row.projectId;

  // 4. resolve the target (server-side — never trust the client).
  const target = opts.newAssigneeId ?? actor.id;

  // 5. authz: claim-to-self → any authenticated actor; targeting another
  //    identity → human director only.
  if (target !== actor.id && actor.type !== "human") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only a human director may force-claim on behalf of another agent.",
    );
  }

  // 6. if an explicit target was supplied, it must be a real user.
  if (opts.newAssigneeId != null) {
    const targetUser = getUserById(target);
    if (!targetUser) {
      throw new AppError(404, "NOT_FOUND", "Target user not found.");
    }
  }

  // 7. delegate to the shared audited-transfer core (terminal guard + txn +
  //    event + lease transfer).
  const { previousHolder, newHolder } = performClaimTransfer(
    id,
    actor,
    { targetId: target, reason: opts.reason, projectId, auditAction: "force_claim" },
    cfg,
  );

  return {
    ok: true,
    status: "force_claimed",
    previousHolder,
    newHolder,
  };
}

// ─── Handoff primitives (Campaign C3.P5b) ─────────────────────────
//
// release-to + request-takeover compose the audited transfer core
// (performClaimTransfer) with handoff-specific authz/state logic. Both reuse
// the "force_claim" audit action (the reason carries the handoff intent) so no
// audit-enum change is needed. CARDINAL INVARIANT (request-takeover): a LIVE
// claim is NEVER mutated — a takeover request against a live holder only
// notifies; only a STALE (lease-lapsed) claim is auto-granted.

export interface ReleaseToResult {
  ok: true;
  status: "force_claimed";
  previousHolder: string;
  newHolder: string;
}

export type RequestTakeoverResult =
  | {
      ok: true;
      // force_claimed = a stale claim was auto-granted to the requester;
      // already_claimed_by_you = the requester already holds it (no-op);
      // not_held = the entity was free (call claim instead).
      status: "force_claimed" | "already_claimed_by_you" | "not_held";
      previousHolder?: string;
      newHolder?: string;
    }
  | {
      ok: false;
      // notified_holder = the claim is LIVE; the holder was notified, nothing
      // was mutated (the cardinal invariant).
      status: "notified_holder";
    };

/**
 * release-to — hand a claim to a NAMED target worker, audited.
 *
 * authz (DISTINCT from forceClaim's): a human may always release-to anyone; an
 * AI agent may release-to another worker ONLY if it CURRENTLY HOLDS the claim
 * (`row[holderKey] === actor.id`). This is the load-bearing case forceClaim
 * could NOT serve — its `target !== actor.id && !human → 403` gate would reject
 * an AI holder handing off to another named worker. release-to never claims to
 * self (that would be a no-op handoff); a target is REQUIRED and must be a real
 * user.
 */
export function releaseTo(
  id: string,
  actor: Actor,
  opts: { reason: string; targetId: string },
  cfg: ForceClaimConfig,
): ReleaseToResult {
  // reason required (route enforces z.min(1) too).
  if (!opts.reason || opts.reason.trim() === "") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "release-to requires a non-empty reason.",
    );
  }
  // target required.
  if (!opts.targetId || opts.targetId.trim() === "") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "release-to requires a target worker id.",
    );
  }

  const row = getDb()
    .select()
    .from(cfg.table)
    .where(eq(cfg.table.id, id))
    .get() as EntityRow | undefined;
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `${cfg.entityType} not found: ${id}`);
  }

  // audit_log.projectId is NOT NULL — refuse BEFORE the txn (uniform with
  // forceClaim FOLDED-FIX 1).
  if (row.projectId == null) {
    throw new AppError(
      409,
      "NO_PROJECT",
      `This ${cfg.entityType} is not associated with a project and cannot be released to another worker.`,
    );
  }
  const projectId = row.projectId;

  // authz: a human may always; an AI agent may ONLY if it holds the claim.
  const currentHolder =
    (row[cfg.holderKey] as string | null | undefined) ?? null;
  if (actor.type !== "human" && currentHolder !== actor.id) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only the current claim holder (or a human director) may release this claim to another worker.",
    );
  }

  // the target must be a real user.
  const targetUser = getUserById(opts.targetId);
  if (!targetUser) {
    throw new AppError(404, "NOT_FOUND", "Target user not found.");
  }

  const { previousHolder, newHolder } = performClaimTransfer(
    id,
    actor,
    {
      targetId: opts.targetId,
      reason: opts.reason,
      projectId,
      auditAction: "force_claim",
    },
    cfg,
  );

  return { ok: true, status: "force_claimed", previousHolder, newHolder };
}

/**
 * Emit the identity-masked CLAIM_TAKEOVER_REQUESTED notification. The payload is
 * a full EventPayload (onAll forwards it to SSE + the activity listener) but
 * carries NO holder id — `actorId` is the REQUESTER (safe to surface), `entity`
 * is null, and `changes` is omitted. This is a pure notification: the live
 * holder's claim is untouched.
 */
function emitTakeoverRequested(
  id: string,
  actor: Actor,
  projectId: string | null,
  cfg: ForceClaimConfig,
): void {
  getEventBus().emit(EVENT_NAMES.CLAIM_TAKEOVER_REQUESTED, {
    entity: null,
    entityType: cfg.entityType,
    entityId: id,
    projectId,
    actorId: actor.id,
    timestamp: new Date().toISOString(),
  });
}

/**
 * request-takeover — ask to take over a claim, stomp-safe.
 *
 * Computes the identity-masked claim_state, then:
 *   - **stale** → auto-grant: transfer to the requester (self-target, atomic;
 *     on a race exactly one winner — the loser sees the entity already held by
 *     the winner and would re-derive live/yours).
 *   - **live**  → NO mutation (cardinal invariant). Emit
 *     CLAIM_TAKEOVER_REQUESTED (identity-masked payload — NO holder id) so the
 *     live holder is notified, and return `notified_holder`.
 *   - **unclaimed** → return `not_held` (the entity is free; call claim).
 *   - **yours** → no-op success (`already_claimed_by_you`).
 *
 * reason required (it is recorded in the audit row on the stale auto-grant).
 */
export function requestTakeover(
  id: string,
  actor: Actor,
  opts: { reason: string },
  cfg: ForceClaimConfig,
): RequestTakeoverResult {
  if (!opts.reason || opts.reason.trim() === "") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "request-takeover requires a non-empty reason.",
    );
  }

  const row = getDb()
    .select()
    .from(cfg.table)
    .where(eq(cfg.table.id, id))
    .get() as EntityRow | undefined;
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `${cfg.entityType} not found: ${id}`);
  }

  const holder = (row[cfg.holderKey] as string | null | undefined) ?? null;
  const lease = readLease(cfg.entityType, id);
  const state = deriveClaimState(holder, lease, new Date(), { id: actor.id });

  if (state === "unclaimed") {
    return { ok: true, status: "not_held" };
  }
  if (state === "yours") {
    return { ok: true, status: "already_claimed_by_you" };
  }

  if (state === "live") {
    // CARDINAL INVARIANT: never mutate a live claim. Notify the holder with an
    // identity-masked payload (NO holder id) and return.
    emitTakeoverRequested(id, actor, row.projectId, cfg);
    return { ok: false, status: "notified_holder" };
  }

  // state === "stale": auto-grant to the requester. audit_log.projectId is NOT
  // NULL — a stale claim with a null projectId cannot be audited; treat as
  // un-grantable and (fail-safe) notify instead of mutating without a record.
  if (row.projectId == null) {
    emitTakeoverRequested(id, actor, row.projectId, cfg);
    return { ok: false, status: "notified_holder" };
  }

  const { previousHolder, newHolder } = performClaimTransfer(
    id,
    actor,
    {
      targetId: actor.id,
      reason: opts.reason,
      projectId: row.projectId,
      auditAction: "force_claim",
    },
    cfg,
  );

  return { ok: true, status: "force_claimed", previousHolder, newHolder };
}
