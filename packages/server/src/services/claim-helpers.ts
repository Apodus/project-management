import { eq } from "drizzle-orm";
import type { AuditLogView, ClaimStatus, UserType } from "@pm/shared";
import { AppError } from "../types.js";
import { getDb } from "../db/index.js";
import { getEventBus, type EventName } from "../events/event-bus.js";
import {
  record as recordAudit,
  emitAuditRecorded,
} from "./audit.service.js";
import { getById as getUserById } from "./user.service.js";

// Re-export so callers don't need an additional import for the event name set.
export { EVENT_NAMES } from "../events/event-bus.js";

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
 * Enforce that an AI agent holds the claim on an entity before writing.
 * Humans always pass. AI agents must hold the claim — unclaimed entities also
 * reject AI-agent writes (the agent must call claim first).
 */
export function assertClaimOk(
  claimedBy: string | null | undefined,
  actor: Actor,
  entityName: string,
): void {
  if (actor.type === "human") return;
  if (claimedBy === actor.id) return;
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

  // 7. terminal entities cannot be force-claimed.
  if (cfg.terminalStatuses.has(row.status)) {
    throw new AppError(
      409,
      "CLAIM_CLOSED",
      `This ${cfg.entityType} is closed and cannot be force-claimed.`,
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
      action: "force_claim",
      targetType: cfg.entityType,
      targetId: id,
      reason: opts.reason,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId,
      actorId: actor.id,
      action: "force_claim",
      targetType: cfg.entityType,
      targetId: id,
      reason: opts.reason,
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

  return {
    ok: true,
    status: "force_claimed",
    previousHolder: oldHolder ?? "",
    newHolder: target,
  };
}
