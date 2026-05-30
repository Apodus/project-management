import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  createId,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  type AuditAction,
  type AuditTargetType,
  type AuditLogView,
} from "@pm/shared";
import { auditLog, getDb, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";

// ─── Append-only contract ─────────────────────────────────────────
//
// `record` is the ONLY writer in this module. There is deliberately no
// public `update` or `delete` counterpart, and the audit_log table has no
// updatedAt column — immutability is enforced by construction (an audit row
// is written once inside the caller's db.transaction and never mutated). The
// only other export, `list`, is read-only.

// ─── Enums (Step 8 hoisted these to @pm/shared) ───────────────────
// The audit taxonomy + the AuditLogView now live canonically in
// packages/shared/src/schemas/audit.ts (consumed by server/web/mcp). They are
// RE-EXPORTED here for back-compat — existing consumers import these from
// ./audit.service.js and must keep working after the relocation.
export { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from "@pm/shared";
export type { AuditAction, AuditTargetType, AuditLogView } from "@pm/shared";

// ─── Types ────────────────────────────────────────────────────────

/**
 * The tx handle a db.transaction callback receives. Same inline pattern as
 * merge-request.service.ts:attachLandedRef — `record` MUST be called inside
 * the caller's transaction so the audit row and the state change it records
 * commit atomically (the §1.4 invariant).
 */
type TxHandle = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export interface RecordArgs {
  projectId: string;
  actorId: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  now: string;
}

export interface ListArgs {
  projectId: string;
  userId?: string; // actorId filter
  action?: AuditAction;
  targetType?: AuditTargetType;
  targetId?: string;
  from?: string; // ISO 8601 inclusive lower bound on createdAt
  to?: string; // ISO 8601 inclusive upper bound
  page?: number;
  perPage?: number;
}

// AuditLogView is now the canonical @pm/shared type (imported + re-exported
// above). Its `action`/`targetType` are the AUDIT_ACTIONS/AUDIT_TARGET_TYPES
// enum unions (the prior local mirror typed them as plain `string`). The DB
// row stores them as plain text but only `record` (enum-validated) ever writes
// them, so toView narrows the row strings to the enum types (sound by
// construction).

export interface ListResult {
  data: AuditLogView[];
  pagination: { total: number; page: number; perPage: number };
}

// ─── Internal row shape ───────────────────────────────────────────

interface AuditLogRow {
  id: string;
  projectId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  metadataBefore: Record<string, unknown> | null;
  metadataAfter: Record<string, unknown> | null;
  createdAt: string;
}

// ─── Internal helpers ─────────────────────────────────────────────

function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

function toView(row: AuditLogRow): AuditLogView {
  return {
    id: row.id,
    projectId: row.projectId,
    actorId: row.actorId,
    action: row.action as AuditAction,
    targetType: row.targetType as AuditTargetType,
    targetId: row.targetId,
    reason: row.reason,
    metadataBefore: row.metadataBefore,
    metadataAfter: row.metadataAfter,
    createdAt: row.createdAt,
  };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Append one immutable audit row. MUST be called inside the caller's
 * db.transaction (takes the tx handle) so the audit row and the state change
 * it records commit atomically (the §1.4 invariant). Emits NOTHING inside the
 * tx — the caller emits audit.recorded AFTER commit via emitAuditRecorded
 * (§2.6). Returns the new audit row id.
 */
export function record(tx: TxHandle, args: RecordArgs): string {
  const id = createId();
  tx.insert(auditLog)
    .values({
      id,
      projectId: args.projectId,
      actorId: args.actorId,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      reason: args.reason ?? null,
      metadataBefore: args.before ?? null,
      metadataAfter: args.after ?? null,
      createdAt: args.now,
    })
    .run();
  return id;
}

/**
 * Emit-only helper (§2.6). Fired by the caller AFTER its transaction commits,
 * mirroring how every other PM mutation drives the SSE stream. The `entity`
 * is the persisted audit row; entityType is "audit_log". Additive — costs
 * nothing when no client listens.
 */
export function emitAuditRecorded(
  auditId: string,
  projectId: string,
  actorId: string,
  row: AuditLogView,
): void {
  getEventBus().emit(EVENT_NAMES.AUDIT_RECORDED, {
    entity: row,
    entityType: "audit_log",
    entityId: auditId,
    projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Query the audit log. All filters optional EXCEPT projectId. Ordered
 * createdAt DESC (newest first), paginated (page/perPage, default 1/50,
 * max 200 — the merge-request list convention). Composes the three indexes
 * (§2.2) depending on which filters are present.
 */
export function list(args: ListArgs): ListResult {
  ensureProjectExists(args.projectId);
  const db = getDb();

  const conditions = [eq(auditLog.projectId, args.projectId)];
  if (args.userId) conditions.push(eq(auditLog.actorId, args.userId));
  if (args.action) conditions.push(eq(auditLog.action, args.action));
  if (args.targetType) {
    conditions.push(eq(auditLog.targetType, args.targetType));
  }
  if (args.targetId) conditions.push(eq(auditLog.targetId, args.targetId));
  if (args.from) conditions.push(gte(auditLog.createdAt, args.from));
  if (args.to) conditions.push(lte(auditLog.createdAt, args.to));

  const whereClause = and(...conditions);

  const total = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(auditLog)
      .where(whereClause)
      .get()?.c ?? 0,
  );

  const page = Math.max(1, args.page ?? 1);
  const perPage = Math.max(1, Math.min(200, args.perPage ?? 50));
  const offset = (page - 1) * perPage;

  const rows = db
    .select()
    .from(auditLog)
    .where(whereClause)
    .orderBy(desc(auditLog.createdAt))
    .limit(perPage)
    .offset(offset)
    .all() as AuditLogRow[];

  return {
    data: rows.map(toView),
    pagination: { total, page, perPage },
  };
}
