import { eq, and, asc, desc } from "drizzle-orm";
import { createId } from "@pm/shared";
import type {
  CreateEscalation,
  CreateEscalationMessage,
  EscalationAnchorType,
  EscalationKind,
  EscalationMessageType,
  EscalationSeverity,
  EscalationStatus,
  ListEscalationsQuery,
  UserType,
} from "@pm/shared";
import { getDb, escalations, escalationMessages, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";

// ─── Escalation service (Campaign C1 §P2) ─────────────────────────
// The lifecycle core for the bidirectional cross-team escalation channel.
// A worker raises an escalation; a human (or another worker) holds,
// acknowledges, answers, and resolves it through an append-only thread.
//
// Status machine (open → acknowledged → answered → resolved, with
// needs_human as a side-channel from any non-terminal state) is enforced
// by the centralized ESCALATION_TRANSITIONS table + assertTransition.
// Per-thread seq is allocated atomically inside a write transaction
// (UNIQUE(escalationId, seq) is the backstop). Authz is gated BEFORE any
// mutation (404 re-select → 403 gate → assertTransition → mutate),
// mirroring note.service's dismiss ordering.
//
// SSE id projection + activity_log mapping for the escalation.* events
// land in P5; here we only emit the typed events.

type Actor = { id: string; type: UserType };

// A row as read back from Drizzle. Enum columns are bare text() in the
// schema, so we cast to the shared enum types in toView (like
// merge-attempt.service's toView).
type EscalationRow = typeof escalations.$inferSelect;

/**
 * Cast a raw escalation row's bare-text enum columns to the shared enum
 * types. Mirrors merge-attempt.service's toView precedent.
 */
function toView(row: EscalationRow) {
  return {
    ...row,
    kind: row.kind as EscalationKind,
    status: row.status as EscalationStatus,
    severity: row.severity as EscalationSeverity | null,
    anchorType: row.anchorType as EscalationAnchorType | null,
  };
}

/**
 * Centralized status transition table — the NON-AUTHOR baseline.
 * `assertTransition` enforces it. resolved is terminal. needs_human is a
 * side-channel reachable from every non-terminal state. (Amendment B
 * widens the resolve SOURCE states for the origin author in resolve()
 * itself, without mutating this table.)
 */
const ESCALATION_TRANSITIONS: Record<EscalationStatus, EscalationStatus[]> = {
  open: ["acknowledged", "needs_human"],
  acknowledged: ["answered", "needs_human"],
  answered: ["resolved", "needs_human"],
  resolved: [],
  needs_human: ["resolved"],
};

/**
 * Assert that `to` is a legal next status from `esc.status`, else 409.
 */
function assertTransition(esc: { id: string; status: EscalationStatus }, to: EscalationStatus): void {
  if (!ESCALATION_TRANSITIONS[esc.status].includes(to)) {
    throw new AppError(
      409,
      "INVALID_STATUS",
      `Escalation ${esc.id} cannot transition ${esc.status} → ${to}`,
    );
  }
}

/**
 * Assert that an escalation is not in its terminal (resolved) state, else
 * 409. Used by addMessage (a resolved thread is append-frozen).
 */
function assertNotTerminal(esc: { id: string; status: EscalationStatus }): void {
  if (esc.status === "resolved") {
    throw new AppError(
      409,
      "INVALID_STATUS",
      `Escalation ${esc.id} is resolved and is append-frozen`,
    );
  }
}

/**
 * Ensure a project exists, else 404. Mirrors note.service's project guard.
 */
function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

/**
 * Re-select an escalation by id, else 404.
 */
function getRowOr404(id: string): EscalationRow {
  const db = getDb();
  const row = db.select().from(escalations).where(eq(escalations.id, id)).get();
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Escalation not found: ${id}`);
  }
  return row;
}

/**
 * Atomically append a message to a thread, allocating the next 1-based
 * seq under the write lock. MUST be called from inside a
 * getDb().transaction((tx) => {...}) so the SELECT MAX(seq)+1 and the
 * INSERT are one critical section — better-sqlite3 is single-writer (see
 * merge-attempt.service ~L292), and UNIQUE(escalationId, seq) is the
 * backstop on a race.
 */
function appendMessageTx(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  escalationId: string,
  authorId: string,
  body: string,
  messageType: EscalationMessageType | null,
  metadata: Record<string, unknown> | null,
  now: string,
): void {
  const maxRow = tx
    .select({ maxSeq: escalationMessages.seq })
    .from(escalationMessages)
    .where(eq(escalationMessages.escalationId, escalationId))
    .orderBy(desc(escalationMessages.seq))
    .limit(1)
    .get();
  const nextSeq = (maxRow?.maxSeq ?? 0) + 1;

  tx.insert(escalationMessages)
    .values({
      id: createId(),
      escalationId,
      seq: nextSeq,
      authorId,
      body,
      messageType,
      metadata,
      createdAt: now,
    })
    .run();
}

/**
 * Create (raise) a new escalation (status defaults "open"). Any
 * authenticated caller may raise — no extra gate. The author is the
 * caller, never accepted from the body.
 */
export function create(projectId: string, input: CreateEscalation, actor: Actor) {
  ensureProjectExists(projectId);

  const db = getDb();
  const id = createId();
  const now = new Date().toISOString();

  db.insert(escalations)
    .values({
      id,
      projectId,
      kind: input.kind,
      status: "open",
      severity: input.severity ?? null,
      title: input.title,
      body: input.body ?? null,
      codeLocator: input.codeLocator ?? null,
      anchorType: input.anchorType ?? null,
      anchorId: input.anchorId ?? null,
      originRepo: input.originRepo,
      originWorkerKey: input.originWorkerKey,
      holderId: null,
      authorId: actor.id,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolvedBy: null,
    })
    .run();

  const row = toView(getRowOr404(id));

  getEventBus().emit(EVENT_NAMES.ESCALATION_OPENED, {
    entity: row,
    entityType: "escalation",
    entityId: id,
    projectId: row.projectId,
    actorId: actor.id,
    timestamp: now,
  });

  return row;
}

/**
 * Add a thread message (reply). Authz: a human OR the author OR the
 * holder may reply; else 403. A resolved thread is append-frozen (409).
 * 404 re-select → 403 gate → assertNotTerminal → atomic append.
 */
export function addMessage(id: string, input: CreateEscalationMessage, actor: Actor) {
  const db = getDb();
  const esc = getRowOr404(id);

  if (actor.type !== "human" && actor.id !== esc.authorId && actor.id !== esc.holderId) {
    throw new AppError(403, "FORBIDDEN", `User "${actor.id}" is not allowed to reply to escalation ${id}`);
  }
  assertNotTerminal(toView(esc));

  const now = new Date().toISOString();
  db.transaction((tx) => {
    appendMessageTx(
      tx,
      id,
      actor.id,
      input.body,
      (input.messageType ?? "reply") as EscalationMessageType,
      input.metadata ?? null,
      now,
    );
    tx.update(escalations).set({ updatedAt: now }).where(eq(escalations.id, id)).run();
  });

  const row = toView(getRowOr404(id));

  getEventBus().emit(EVENT_NAMES.ESCALATION_REPLIED, {
    entity: row,
    entityType: "escalation",
    entityId: id,
    projectId: row.projectId,
    actorId: actor.id,
    timestamp: now,
  });

  return row;
}

/**
 * Acknowledge an open escalation (open → acknowledged). Authz: a human OR
 * the holder; else 403. Auto-claim: a non-human acknowledger with no
 * holder set becomes the holder in the SAME update.
 * 404 → 403 gate → assertTransition → mutate.
 */
export function acknowledge(id: string, actor: Actor) {
  const db = getDb();
  const esc = getRowOr404(id);

  if (actor.type !== "human" && actor.id !== esc.holderId) {
    throw new AppError(403, "FORBIDDEN", `User "${actor.id}" is not allowed to acknowledge escalation ${id}`);
  }
  assertTransition(toView(esc), "acknowledged");

  const now = new Date().toISOString();
  const values: Record<string, unknown> = { status: "acknowledged", updatedAt: now };
  // Auto-claim: an ai_agent acknowledging an unheld escalation becomes the holder.
  if (actor.type !== "human" && esc.holderId == null) {
    values.holderId = actor.id;
  }
  db.update(escalations).set(values).where(eq(escalations.id, id)).run();

  const row = toView(getRowOr404(id));

  getEventBus().emit(EVENT_NAMES.ESCALATION_ACKNOWLEDGED, {
    entity: row,
    entityType: "escalation",
    entityId: id,
    projectId: row.projectId,
    actorId: actor.id,
    timestamp: now,
  });

  return row;
}

/**
 * Answer an acknowledged escalation (acknowledged → answered). Amendment
 * A — authz: a human OR the holder OR an UNCLAIMED escalation (holderId
 * null); else 403. Self-claim-on-answer: if unheld, the answerer (human
 * OR ai_agent) becomes the holder in the SAME transaction — removing the
 * dead-end where a human-acknowledged escalation could never be answered
 * by an ai_agent. An optional `body` is appended as a `diagnosis`
 * message in the same transaction.
 * 404 → 403 gate → assertTransition → mutate.
 */
export function answer(id: string, input: { body?: string }, actor: Actor) {
  const db = getDb();
  const esc = getRowOr404(id);

  if (actor.type !== "human" && actor.id !== esc.holderId && esc.holderId != null) {
    throw new AppError(403, "FORBIDDEN", `User "${actor.id}" is not allowed to answer escalation ${id}`);
  }
  assertTransition(toView(esc), "answered");

  const now = new Date().toISOString();
  db.transaction((tx) => {
    const values: Record<string, unknown> = { status: "answered", updatedAt: now };
    // Self-claim-on-answer (Amendment A): an unheld escalation binds to the
    // answerer (human OR ai_agent).
    if (esc.holderId == null) {
      values.holderId = actor.id;
    }
    tx.update(escalations).set(values).where(eq(escalations.id, id)).run();

    if (input.body !== undefined && input.body.length > 0) {
      appendMessageTx(tx, id, actor.id, input.body, "diagnosis", null, now);
    }
  });

  const row = toView(getRowOr404(id));

  getEventBus().emit(EVENT_NAMES.ESCALATION_ANSWERED, {
    entity: row,
    entityType: "escalation",
    entityId: id,
    projectId: row.projectId,
    actorId: actor.id,
    timestamp: now,
  });

  return row;
}

/**
 * Resolve an escalation. Authz: a human OR the author OR the holder; else
 * 403. Amendment B — the legal SOURCE states depend on the actor:
 *   - origin author (actor.id === esc.authorId): withdrawal from ANY
 *     non-terminal state (open/acknowledged/answered/needs_human). The
 *     system message body is prefixed "(withdrawn by author) ".
 *   - else (human non-author, or PM holder): legal only from answered or
 *     needs_human (assertTransition).
 * A double-resolve (from resolved) is always 409 for everyone. Sets
 * status resolved, resolvedAt=now, resolvedBy=actor.id, and appends a
 * `system` message with the reason — all in one transaction.
 * 404 → 403 gate → source-state check → mutate.
 */
export function resolve(id: string, input: { reason: string }, actor: Actor) {
  const db = getDb();
  const esc = getRowOr404(id);

  if (actor.type !== "human" && actor.id !== esc.authorId && actor.id !== esc.holderId) {
    throw new AppError(403, "FORBIDDEN", `User "${actor.id}" is not allowed to resolve escalation ${id}`);
  }

  const view = toView(esc);
  const isAuthorWithdrawal = actor.id === esc.authorId;
  if (isAuthorWithdrawal) {
    // Withdrawal: any non-terminal source state. A double-resolve is still 409.
    assertNotTerminal(view);
  } else {
    // Non-author baseline: only answered / needs_human → resolved.
    assertTransition(view, "resolved");
  }

  const now = new Date().toISOString();
  const systemBody = isAuthorWithdrawal ? `(withdrawn by author) ${input.reason}` : input.reason;
  db.transaction((tx) => {
    tx.update(escalations)
      .set({ status: "resolved", resolvedAt: now, resolvedBy: actor.id, updatedAt: now })
      .where(eq(escalations.id, id))
      .run();
    appendMessageTx(tx, id, actor.id, systemBody, "system", null, now);
  });

  const row = toView(getRowOr404(id));

  getEventBus().emit(EVENT_NAMES.ESCALATION_RESOLVED, {
    entity: row,
    entityType: "escalation",
    entityId: id,
    projectId: row.projectId,
    actorId: actor.id,
    timestamp: now,
  });

  return row;
}

/**
 * Escalate to a human (any non-terminal state → needs_human). Authz: a
 * human OR the author OR the holder; else 403. Appends a `system` message
 * with the reason. 404 → 403 gate → assertTransition → mutate.
 */
export function escalateToHuman(id: string, input: { reason: string }, actor: Actor) {
  const db = getDb();
  const esc = getRowOr404(id);

  if (actor.type !== "human" && actor.id !== esc.authorId && actor.id !== esc.holderId) {
    throw new AppError(403, "FORBIDDEN", `User "${actor.id}" is not allowed to escalate ${id} to a human`);
  }
  assertTransition(toView(esc), "needs_human");

  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(escalations)
      .set({ status: "needs_human", updatedAt: now })
      .where(eq(escalations.id, id))
      .run();
    appendMessageTx(tx, id, actor.id, input.reason, "system", null, now);
  });

  const row = toView(getRowOr404(id));

  getEventBus().emit(EVENT_NAMES.ESCALATION_NEEDS_HUMAN, {
    entity: row,
    entityType: "escalation",
    entityId: id,
    projectId: row.projectId,
    actorId: actor.id,
    timestamp: now,
  });

  return row;
}

/**
 * List escalations for a project, newest first, with optional filters.
 * The projectId equality is the cross-project isolation boundary.
 */
export function list(projectId: string, filters: ListEscalationsQuery) {
  const db = getDb();
  const conditions = [eq(escalations.projectId, projectId)];

  if (filters.status) conditions.push(eq(escalations.status, filters.status));
  if (filters.kind) conditions.push(eq(escalations.kind, filters.kind));
  if (filters.severity) conditions.push(eq(escalations.severity, filters.severity));
  if (filters.originRepo) conditions.push(eq(escalations.originRepo, filters.originRepo));
  if (filters.originWorkerKey) conditions.push(eq(escalations.originWorkerKey, filters.originWorkerKey));
  if (filters.holderId) conditions.push(eq(escalations.holderId, filters.holderId));

  const rows = db
    .select()
    .from(escalations)
    .where(and(...conditions))
    .orderBy(desc(escalations.createdAt))
    .all();

  return rows.map(toView);
}

/**
 * Get a single escalation by id with its full ordered thread (asc by
 * seq). Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const esc = toView(getRowOr404(id));
  const messages = db
    .select()
    .from(escalationMessages)
    .where(eq(escalationMessages.escalationId, id))
    .orderBy(asc(escalationMessages.seq))
    .all()
    .map((m) => ({ ...m, messageType: m.messageType as EscalationMessageType | null }));

  return { ...esc, messages };
}
