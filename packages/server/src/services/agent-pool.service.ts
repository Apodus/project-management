import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import { getDb, getRawDb, agentClaims, users, agentPools } from "../db/index.js";
import * as authService from "./auth.service.js";
import { AppError } from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────

const CLAIM_TTL_MS = 60 * 60 * 1000; // 1 hour
const BCRYPT_ROUNDS = 10;

/**
 * How long past its claim expiry a KEYED binding stays reserved for its worker
 * before the identity may be recycled under pressure. Default 24h.
 *
 * A keyed binding reserves its identity expiry-independently (C1's structural
 * guarantee against identity-sharing — see FREE_AGENT_SQL). That is correct for
 * a bounded, stable set of worker keys, but a deployment that mints a FRESH key
 * per task/session leaks one identity per session, permanently, until the pool
 * reads empty and every request fails. The grace bounds the reservation without
 * weakening the guarantee where it matters: reclamation is LAZY (only when no
 * genuinely free agent exists) and takes the coldest binding first, so stable
 * identity survives intact whenever the pool has any slack at all.
 */
const DEFAULT_BIND_GRACE_SEC = 24 * 60 * 60;

/**
 * Read the reservation grace (seconds) from PM_AGENT_BIND_GRACE_SEC.
 *
 * `off` (case-insensitive) disables reclamation entirely — the pre-2026-09
 * behavior, where a keyed binding is reserved forever. A non-negative integer
 * sets the grace; `0` recycles as soon as the claim TTL lapses. Anything else
 * falls back to the default. Read per-call, not at module load, so an operator
 * can change it with a restart and tests can set it per-case.
 */
export function bindGraceSec(): number | "off" {
  const raw = process.env.PM_AGENT_BIND_GRACE_SEC?.trim();
  if (raw === undefined || raw === "") return DEFAULT_BIND_GRACE_SEC;
  if (raw.toLowerCase() === "off") return "off";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BIND_GRACE_SEC;
  return parsed;
}

/**
 * The instant at or before which a lapsed keyed binding is recyclable, as an
 * ISO string — i.e. `now - grace`. Returns null when reclamation is disabled,
 * which every caller must read as "nothing is ever reclaimable".
 */
function reclaimCutoff(nowMs: number): string | null {
  const grace = bindGraceSec();
  if (grace === "off") return null;
  return new Date(nowMs - grace * 1000).toISOString();
}

const GREEK_NAMES = [
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Epsilon",
  "Zeta",
  "Eta",
  "Theta",
  "Iota",
  "Kappa",
];

// ─── Types ──────────────────────────────────────────────────────────

export interface PoolInfo {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

/**
 * The four states an agent identity can be in, in PRIORITY order — an agent is
 * classified by the first one that matches, so the buckets are disjoint and sum
 * to agentCount (pinned by test).
 *
 *  - `inactive`  — deactivated (`is_active = 0`). Not claimable, and won't be.
 *  - `claimed`   — a live claim (keyed or not). In use right now.
 *  - `reserved`  — a KEYED binding whose claim TTL lapsed. Still held for its
 *                  worker, so NOT claimable by anyone else; recyclable only
 *                  once past the reservation grace, and only under pressure.
 *  - `available` — free to claim right now.
 *
 * `reserved` is the state that had no name before 2026-09: it was reported as
 * available by the per-agent view (which only asked "is there a live claim?")
 * while the pool summary counted it in neither bucket, so it surfaced as
 * "inactive" residue. Twenty-three of them silently drained a live pool.
 */
export type PoolAgentState = "inactive" | "claimed" | "reserved" | "available";

export interface PoolSummary extends PoolInfo {
  agentCount: number;
  claimedCount: number;
  availableCount: number;
  /** Keyed bindings whose TTL lapsed — held for their worker, not claimable. */
  reservedCount: number;
  /**
   * The subset of `reservedCount` already past the grace, i.e. recyclable on
   * the next claim that would otherwise fail. `availableCount +
   * reclaimableCount` is what actually answers "will the next claim succeed?".
   */
  reclaimableCount: number;
  /** Deactivated identities (`is_active = 0`). */
  inactiveCount: number;
}

export interface PoolAgentStatus {
  user: {
    id: string;
    username: string;
    displayName: string;
    type: string;
    isActive: boolean;
    poolId: string | null;
  };
  /**
   * Live claim only. Retained for backward compatibility; it is NOT the
   * complement of claimable — a `reserved` agent reads `claimed: false` and
   * cannot be claimed. Read `state` instead.
   */
  claimed: boolean;
  state: PoolAgentState;
  claimedAt: string | null;
  expiresAt: string | null;
  heartbeatAt: string | null;
  /** The bound worker key, when this identity is keyed. */
  workerKey: string | null;
  /**
   * When a `reserved` identity becomes recyclable. Null when the state is not
   * `reserved`, or when reclamation is disabled (reserved forever).
   */
  reclaimableAt: string | null;
}

export interface ClaimResult {
  user: {
    id: string;
    username: string;
    displayName: string;
    role: string;
    type: string;
  };
  token: string;
  /**
   * Opaque per-binding correlation token, present only for keyed claims
   * (when a workerKey was supplied). Stable across reconnects for the same
   * (pool, workerKey) tuple — the client can use it to assert continuity.
   */
  bindHandle?: string;
}

// ─── Pool CRUD ──────────────────────────────────────────────────────

/**
 * Create a named agent pool with a hashed secret.
 */
export async function createPool(
  name: string,
  secret: string,
  description?: string,
  createdBy?: string,
): Promise<PoolInfo> {
  const db = getDb();

  // Check for duplicate name
  const existing = db.select().from(agentPools).where(eq(agentPools.name, name)).get();
  if (existing) {
    throw new AppError(409, "POOL_NAME_EXISTS", `A pool named "${name}" already exists`);
  }

  const id = createId();
  const ts = new Date().toISOString();
  const secretHash = await bcrypt.hash(secret, BCRYPT_ROUNDS);

  db.insert(agentPools)
    .values({
      id,
      name,
      secretHash,
      description: description ?? null,
      createdAt: ts,
      updatedAt: ts,
      createdBy: createdBy ?? null,
    })
    .run();

  return {
    id,
    name,
    description: description ?? null,
    createdAt: ts,
    updatedAt: ts,
    createdBy: createdBy ?? null,
  };
}

/**
 * Delete a pool and deactivate all its agents.
 */
export function deletePool(poolId: string): void {
  const db = getDb();

  const pool = db.select().from(agentPools).where(eq(agentPools.id, poolId)).get();
  if (!pool) {
    throw new AppError(404, "POOL_NOT_FOUND", "Pool not found");
  }

  // Deactivate all agents in this pool and clear pool_id FK
  db.update(users)
    .set({ isActive: false, poolId: null, updatedAt: new Date().toISOString() })
    .where(eq(users.poolId, poolId))
    .run();

  // Delete all claims for agents in this pool
  const rawDb = getRawDb();
  rawDb
    .prepare(`DELETE FROM agent_claims WHERE user_id IN (SELECT id FROM users WHERE pool_id = ?)`)
    .run(poolId);

  // Delete the pool
  db.delete(agentPools).where(eq(agentPools.id, poolId)).run();
}

/**
 * Update a pool's secret hash.
 */
export async function updatePoolSecret(poolId: string, newSecret: string): Promise<void> {
  const db = getDb();

  const pool = db.select().from(agentPools).where(eq(agentPools.id, poolId)).get();
  if (!pool) {
    throw new AppError(404, "POOL_NOT_FOUND", "Pool not found");
  }

  const secretHash = await bcrypt.hash(newSecret, BCRYPT_ROUNDS);
  db.update(agentPools)
    .set({ secretHash, updatedAt: new Date().toISOString() })
    .where(eq(agentPools.id, poolId))
    .run();
}

/**
 * Update a pool's name and/or description.
 */
export function updatePool(
  poolId: string,
  updates: { name?: string; description?: string },
): PoolInfo {
  const db = getDb();

  const pool = db.select().from(agentPools).where(eq(agentPools.id, poolId)).get();
  if (!pool) {
    throw new AppError(404, "POOL_NOT_FOUND", "Pool not found");
  }

  if (updates.name && updates.name !== pool.name) {
    const existing = db.select().from(agentPools).where(eq(agentPools.name, updates.name)).get();
    if (existing) {
      throw new AppError(409, "POOL_NAME_EXISTS", `A pool named "${updates.name}" already exists`);
    }
  }

  const ts = new Date().toISOString();
  const setValues: Partial<typeof agentPools.$inferInsert> = { updatedAt: ts };
  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.description !== undefined) setValues.description = updates.description;

  db.update(agentPools).set(setValues).where(eq(agentPools.id, poolId)).run();

  return {
    id: pool.id,
    name: updates.name ?? pool.name,
    description: updates.description ?? pool.description,
    createdAt: pool.createdAt,
    updatedAt: ts,
    createdBy: pool.createdBy,
  };
}

/**
 * Get pool details by ID.
 */
export function getPool(poolId: string): PoolInfo | null {
  const db = getDb();
  const pool = db.select().from(agentPools).where(eq(agentPools.id, poolId)).get();
  if (!pool) return null;

  return {
    id: pool.id,
    name: pool.name,
    description: pool.description,
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
    createdBy: pool.createdBy,
  };
}

/**
 * List all pools with agent counts and claim status.
 */
export function listPools(): PoolSummary[] {
  const rawDb = getRawDb();
  const now = new Date().toISOString();
  // No cutoff ⇒ reclamation disabled ⇒ nothing is reclaimable. An ISO string
  // ordered below every real timestamp makes that fall out of the same SQL.
  const cutoff = reclaimCutoff(Date.now()) ?? "";

  // The four CASE arms mirror the PRIORITY order documented on PoolAgentState,
  // each one excluding the arms above it, so the buckets are disjoint and sum
  // to agent_count. reclaimable_count is an OVERLAY on reserved_count, not a
  // fifth bucket — it deliberately does not participate in that sum.
  const rows = rawDb
    .prepare(
      `SELECT
         p.id, p.name, p.description, p.created_at, p.updated_at, p.created_by,
         COUNT(u.id) AS agent_count,
         COUNT(CASE WHEN u.is_active = 0 THEN 1 END) AS inactive_count,
         COUNT(CASE WHEN u.is_active = 1 AND ac.expires_at >= ? THEN 1 END) AS claimed_count,
         COUNT(CASE WHEN u.is_active = 1 AND ac.expires_at < ? AND ac.worker_key IS NOT NULL THEN 1 END) AS reserved_count,
         COUNT(CASE WHEN u.is_active = 1 AND (ac.id IS NULL OR (ac.expires_at < ? AND ac.worker_key IS NULL)) THEN 1 END) AS available_count,
         COUNT(CASE WHEN u.is_active = 1 AND ac.worker_key IS NOT NULL AND ac.expires_at < ? THEN 1 END) AS reclaimable_count
       FROM agent_pools p
       LEFT JOIN users u ON u.pool_id = p.id AND u.type = 'ai_agent'
       LEFT JOIN agent_claims ac ON ac.user_id = u.id
       GROUP BY p.id
       ORDER BY p.name ASC`,
    )
    .all(now, now, now, cutoff) as Array<{
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    updated_at: string;
    created_by: string | null;
    agent_count: number;
    inactive_count: number;
    claimed_count: number;
    reserved_count: number;
    available_count: number;
    reclaimable_count: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    agentCount: r.agent_count,
    claimedCount: r.claimed_count,
    availableCount: r.available_count,
    reservedCount: r.reserved_count,
    reclaimableCount: r.reclaimable_count,
    inactiveCount: r.inactive_count,
  }));
}

// ─── Agent creation ─────────────────────────────────────────────────

/**
 * Create N AI agent users in a specific pool.
 * Uses Greek alphabet names by default, or "{prefix} N" for custom prefixes.
 */
export async function createAgentPool(
  poolId: string,
  count: number,
  namePrefix?: string,
): Promise<
  Array<{
    id: string;
    username: string;
    displayName: string;
    role: string;
    type: string;
    poolId: string;
  }>
> {
  const db = getDb();
  const ts = new Date().toISOString();

  const pool = db.select().from(agentPools).where(eq(agentPools.id, poolId)).get();
  if (!pool) {
    throw new AppError(404, "POOL_NOT_FOUND", "Pool not found");
  }

  const created: Array<{
    id: string;
    username: string;
    displayName: string;
    role: string;
    type: string;
    poolId: string;
  }> = [];

  for (let i = 0; i < count; i++) {
    const id = createId();
    let displayName: string;
    let username: string;

    if (namePrefix) {
      displayName = `${namePrefix} ${i + 1}`;
      username = `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${i + 1}`;
    } else {
      const greekName = i < GREEK_NAMES.length ? GREEK_NAMES[i] : `Agent ${i + 1}`;
      displayName = i < GREEK_NAMES.length ? `${pool.name}-${greekName}` : greekName;
      username =
        i < GREEK_NAMES.length
          ? `${pool.name}-${greekName.toLowerCase()}`
          : `${pool.name}-agent-${i + 1}`;
    }

    // Check for duplicate username and append a suffix if needed
    const existing = db.select().from(users).where(eq(users.username, username)).get();
    if (existing) {
      const suffix = createId().slice(0, 4);
      username = `${username}-${suffix}`;
    }

    db.insert(users)
      .values({
        id,
        username,
        displayName,
        role: "member",
        type: "ai_agent",
        poolId,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    created.push({
      id,
      username,
      displayName,
      role: "member",
      type: "ai_agent",
      poolId,
    });
  }

  return created;
}

// ─── Claim / Release / Heartbeat ────────────────────────────────────

/**
 * Auto-create a "default" pool from PM_POOL_SECRET env var if no pools exist.
 * This is for backward compatibility.
 */
async function ensureDefaultPoolFromEnv(): Promise<void> {
  const envSecret = process.env.PM_POOL_SECRET;
  if (!envSecret) return;

  const db = getDb();
  const poolCount = db.select().from(agentPools).all().length;
  if (poolCount > 0) return;

  // Auto-create a default pool
  await createPool("default", envSecret, "Auto-created from PM_POOL_SECRET environment variable");
}

/**
 * Candidate predicate (shared by the keyless and keyed-first-bind paths):
 * a free AI agent in THIS pool. Two exclusions:
 *   1. no live (non-expired) claim of ANY kind, and
 *   2. no keyed binding at all (expiry-INDEPENDENT) — a keyed-bound agent is
 *      reserved for its worker forever, so it must never be grabbed by a
 *      keyless claim or by a DIFFERENT key's first-bind, even after its TTL
 *      lapses. This is the structural guarantee against identity-sharing
 *      (VERIFIER CORRECTION 1). Keyless rows have worker_key NULL, so the
 *      second exclusion is a no-op for them and keyless behavior for keyless
 *      rows is byte-identical to the pre-C1 implementation.
 */
const FREE_AGENT_SQL = `SELECT u.id, u.username, u.display_name, u.role, u.type
   FROM users u
   WHERE u.type = 'ai_agent'
     AND u.pool_id = ?
     AND u.is_active = 1
     AND u.id NOT IN (
       SELECT ac.user_id FROM agent_claims ac WHERE ac.expires_at >= ?
     )
     AND u.id NOT IN (
       SELECT ac.user_id FROM agent_claims ac WHERE ac.worker_key IS NOT NULL
     )
   ORDER BY u.username ASC
   LIMIT 1`;

/**
 * Reclamation candidate: an active agent whose KEYED binding lapsed longer ago
 * than the reservation grace. Ordered oldest-lapse-first so recycling always
 * takes the coldest identity in the pool.
 *
 * This is the only query that can return an already-bound agent, and it runs
 * ONLY when FREE_AGENT_SQL found nothing (see takeFreeAgent). The identity
 * transfer is safe because minting the new claimant's token overwrites
 * `users.api_token_hash` — the single per-user hash — so the previous worker's
 * token stops validating the moment the reclaim completes. There is no window
 * in which two live tokens address one identity.
 */
const RECLAIMABLE_AGENT_SQL = `SELECT u.id, u.username, u.display_name, u.role, u.type,
          ac.id AS claim_id, ac.worker_key AS prior_worker_key, ac.expires_at AS prior_expires_at
   FROM users u
   JOIN agent_claims ac ON ac.user_id = u.id
   WHERE u.type = 'ai_agent'
     AND u.pool_id = ?
     AND u.is_active = 1
     AND ac.worker_key IS NOT NULL
     AND ac.expires_at < ?
   ORDER BY ac.expires_at ASC
   LIMIT 1`;

interface AgentCandidate {
  id: string;
  username: string;
  display_name: string;
  role: string;
  type: string;
}

interface ReclaimCandidate extends AgentCandidate {
  claim_id: string;
  prior_worker_key: string;
  prior_expires_at: string;
}

/**
 * Resolve one agent to hand out, preferring a genuinely free identity and
 * falling back to recycling the coldest dead reservation.
 *
 * MUST be called inside the caller's transaction: the reclaim DELETEs the prior
 * binding row, and only transactional isolation stops two concurrent claims
 * from stealing the same identity.
 *
 * Reclamation is deliberately LAZY rather than a background reaper. A reaper
 * would expire bindings on a clock even when the pool has slack, weakening C1's
 * stable identity for no gain; taking one only when the alternative is failing
 * the request preserves stable identity in every case that isn't already an
 * outage.
 */
function takeFreeAgent(
  rawDb: ReturnType<typeof getRawDb>,
  poolId: string,
  poolName: string,
  now: string,
  logger: Pick<Console, "info"> = console,
): AgentCandidate | null {
  const free = rawDb.prepare(FREE_AGENT_SQL).get(poolId, now) as AgentCandidate | undefined;
  if (free) return free;

  const cutoff = reclaimCutoff(Date.parse(now));
  if (cutoff === null) return null; // PM_AGENT_BIND_GRACE_SEC=off

  const stale = rawDb.prepare(RECLAIMABLE_AGENT_SQL).get(poolId, cutoff) as
    | ReclaimCandidate
    | undefined;
  if (!stale) return null;

  rawDb.prepare(`DELETE FROM agent_claims WHERE id = ?`).run(stale.claim_id);

  // Never silent: an identity changed hands, and the only trace otherwise would
  // be a worker key that quietly stopped resolving to the same agent.
  logger.info(
    `[agent-pool] recycled identity ${stale.username} in pool "${poolName}": ` +
      `reservation for worker key "${stale.prior_worker_key}" lapsed at ${stale.prior_expires_at}, ` +
      `past the grace cutoff ${cutoff}, and no free agent remained`,
  );

  return {
    id: stale.id,
    username: stale.username,
    display_name: stale.display_name,
    role: stale.role,
    type: stale.type,
  };
}

/**
 * Claim an available AI agent from a named pool.
 *
 * Two modes:
 *   - **Keyless** (no `workerKey`): grab any free agent + mint a fresh token.
 *     Byte-identical to the pre-C1 behavior (modulo the additive exclusion of
 *     keyed-bound agents, which can never apply to a keyless-only deployment).
 *   - **Keyed** (`workerKey` present): resolve `(pool, workerKey)` to the SAME
 *     users row across reconnects. First call binds a free agent; subsequent
 *     calls refresh that same binding. Returns a stable `bindHandle`.
 */
export async function claimAgent(
  poolName: string,
  poolSecret: string,
  workerKey?: string,
): Promise<ClaimResult | null> {
  // Backward compat: auto-create default pool from env var
  await ensureDefaultPoolFromEnv();

  const db = getDb();

  // Find pool by name
  const pool = db.select().from(agentPools).where(eq(agentPools.name, poolName)).get();
  if (!pool) {
    throw new AppError(404, "POOL_NOT_FOUND", `Pool "${poolName}" not found`);
  }

  if (!pool.secretHash) {
    throw new AppError(503, "POOL_NOT_CONFIGURED", "Pool secret is not configured");
  }

  // Validate secret FIRST, before ANY key handling (security: a wrong secret
  // must never create or mutate a binding row).
  const valid = await bcrypt.compare(poolSecret, pool.secretHash);
  if (!valid) {
    throw new AppError(401, "INVALID_POOL_SECRET", "Invalid pool secret");
  }

  const rawDb = getRawDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  // ─── Keyless path (legacy / no stable identity) ────────────────────
  if (workerKey == null) {
    const claimedUserId = rawDb.transaction(() => {
      // Clean expired keyless claims first. NEVER reap keyed bindings — a
      // keyed binding outlives its TTL by design (it is reserved for its
      // worker across reconnects); only the keyed path itself refreshes or
      // tears one down.
      rawDb
        .prepare(`DELETE FROM agent_claims WHERE expires_at < ? AND worker_key IS NULL`)
        .run(now);

      const candidate = takeFreeAgent(rawDb, pool.id, pool.name, now);

      if (!candidate) {
        return null;
      }

      const claimId = createId();
      rawDb
        .prepare(
          `INSERT INTO agent_claims (id, user_id, claimed_at, expires_at, heartbeat_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(claimId, candidate.id, now, expiresAt, now);

      return candidate.id;
    })();

    if (!claimedUserId) {
      return null;
    }

    return buildClaimResult(db, claimedUserId, await authService.createApiToken(claimedUserId));
  }

  // ─── Keyed path (stable worker identity) ───────────────────────────
  // Resolve (pool, workerKey) to a single users row. The whole resolution is
  // a closure so it can be retried as a rebind if a concurrent first-bind
  // wins the unique-index race.
  const resolveKeyed = (): { userId: string; bindHandle: string } | null => {
    return rawDb.transaction(() => {
      // 1. Look up the binding IGNORING expiry — a keyed binding persists
      //    across TTL lapses.
      const binding = rawDb
        .prepare(
          `SELECT id, user_id, bind_handle FROM agent_claims
           WHERE worker_key_pool_id = ? AND worker_key = ?`,
        )
        .get(pool.id, workerKey) as
        | { id: string; user_id: string; bind_handle: string | null }
        | undefined;

      if (binding) {
        // 2. Rebind: the bound user must still be a valid agent in THIS pool.
        const boundUser = rawDb
          .prepare(
            `SELECT id FROM users
             WHERE id = ? AND type = 'ai_agent' AND is_active = 1 AND pool_id = ?`,
          )
          .get(binding.user_id, pool.id) as { id: string } | undefined;

        if (!boundUser) {
          // Stale binding (agent removed / deactivated / re-pooled). Drop it
          // and fall through to a fresh first-bind below.
          rawDb.prepare(`DELETE FROM agent_claims WHERE id = ?`).run(binding.id);
        } else {
          // Refresh the SAME row in place — same user_id + same bind_handle.
          rawDb
            .prepare(
              `UPDATE agent_claims SET claimed_at = ?, expires_at = ?, heartbeat_at = ? WHERE id = ?`,
            )
            .run(now, expiresAt, now, binding.id);
          return { userId: binding.user_id, bindHandle: binding.bind_handle ?? "" };
        }
      }

      // 3. First bind: grab a free agent (same predicate as keyless, INCLUDING
      //    the worker_key-bound exclusion), falling back to recycling the
      //    coldest dead reservation. A fresh key arriving at an exhausted pool
      //    is the exact shape of the leak this fallback exists for.
      const candidate = takeFreeAgent(rawDb, pool.id, pool.name, now);

      if (!candidate) {
        return null;
      }

      const claimId = createId();
      const bindHandle = authService.generateToken();
      rawDb
        .prepare(
          `INSERT INTO agent_claims
             (id, user_id, claimed_at, expires_at, heartbeat_at, worker_key, worker_key_pool_id, bind_handle)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(claimId, candidate.id, now, expiresAt, now, workerKey, pool.id, bindHandle);

      return { userId: candidate.id, bindHandle };
    })();
  };

  let resolved: { userId: string; bindHandle: string } | null;
  try {
    resolved = resolveKeyed();
  } catch (err: unknown) {
    // Concurrent first-bind won the unique index (idx_agent_claims_worker).
    // Retry once as a rebind — the binding row now exists.
    if (isUniqueConstraintError(err)) {
      resolved = resolveKeyed();
    } else {
      throw err;
    }
  }

  if (!resolved) {
    return null;
  }

  const token = await authService.createApiToken(resolved.userId);
  return buildClaimResult(db, resolved.userId, token, resolved.bindHandle);
}

/**
 * Build the ClaimResult envelope from a resolved user id + token.
 * Returns null if the user vanished between resolution and fetch.
 */
function buildClaimResult(
  db: ReturnType<typeof getDb>,
  userId: string,
  token: string,
  bindHandle?: string,
): ClaimResult | null {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) {
    return null;
  }
  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      type: user.type,
    },
    token,
    ...(bindHandle !== undefined ? { bindHandle } : {}),
  };
}

/** Detect a SQLite unique-constraint violation (better-sqlite3 error shape). */
function isUniqueConstraintError(err: unknown): boolean {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  const message = err instanceof Error ? err.message : undefined;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT" ||
    (typeof message === "string" && message.includes("UNIQUE constraint failed"))
  );
}

/**
 * Release an agent's claim, making them available for other instances.
 */
export function releaseAgent(userId: string): void {
  const db = getDb();
  db.delete(agentClaims).where(eq(agentClaims.userId, userId)).run();
}

/**
 * Force-release an agent's claim by admin. Takes the agent user ID.
 */
export function forceReleaseAgent(userId: string): void {
  const db = getDb();
  db.delete(agentClaims).where(eq(agentClaims.userId, userId)).run();
}

/**
 * Update the heartbeat for an agent's claim, extending its TTL.
 */
export function heartbeat(userId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  const result = db
    .update(agentClaims)
    .set({
      heartbeatAt: now,
      expiresAt,
    })
    .where(eq(agentClaims.userId, userId))
    .run();

  if (result.changes === 0) {
    throw new AppError(404, "NO_CLAIM", "No active claim found for this user");
  }
}

/**
 * Classify one agent + its (possibly lapsed) claim row into a PoolAgentStatus.
 *
 * The priority order here is the SAME one listPools' CASE arms encode; keeping
 * one classifier for the detail view and mirroring it in the summary SQL is
 * what stops the two surfaces disagreeing again. `claimedAt`/`expiresAt`/
 * `heartbeatAt` are now reported for a lapsed claim too — on a `reserved` row
 * those timestamps ARE the finding (how long the reservation has been dead),
 * and blanking them was half of why this state was invisible.
 */
function toAgentStatus(
  agent: typeof users.$inferSelect,
  claim: typeof agentClaims.$inferSelect | undefined,
  now: string,
  cutoff: string | null,
): PoolAgentStatus {
  const live = claim != null && claim.expiresAt >= now;
  const reserved = claim != null && !live && claim.workerKey != null;

  const state: PoolAgentState = !agent.isActive
    ? "inactive"
    : live
      ? "claimed"
      : reserved
        ? "reserved"
        : "available";

  return {
    user: {
      id: agent.id,
      username: agent.username,
      displayName: agent.displayName,
      type: agent.type,
      isActive: agent.isActive,
      poolId: agent.poolId,
    },
    claimed: state === "claimed",
    state,
    claimedAt: claim?.claimedAt ?? null,
    expiresAt: claim?.expiresAt ?? null,
    heartbeatAt: claim?.heartbeatAt ?? null,
    workerKey: claim?.workerKey ?? null,
    // Reserved-only, and null when reclamation is off — the UI must be able to
    // say "reserved forever" rather than imply a recycle that will never come.
    reclaimableAt:
      state === "reserved" && cutoff !== null && claim != null
        ? new Date(
            Date.parse(claim.expiresAt) + (Date.parse(now) - Date.parse(cutoff)),
          ).toISOString()
        : null,
  };
}

/**
 * Get the status of all AI agents in a specific pool.
 */
export function getPoolStatus(poolId: string): PoolAgentStatus[] {
  const db = getDb();
  const now = new Date().toISOString();

  // Get all AI agent users in this pool
  const agents = db
    .select()
    .from(users)
    .where(and(eq(users.type, "ai_agent"), eq(users.poolId, poolId)))
    .all();

  // All claim rows, live or lapsed — a lapsed keyed row is the whole point.
  const claimMap = new Map(
    db
      .select()
      .from(agentClaims)
      .all()
      .map((c) => [c.userId, c]),
  );
  const cutoff = reclaimCutoff(Date.now());

  return agents.map((agent) => toAgentStatus(agent, claimMap.get(agent.id), now, cutoff));
}

/**
 * Get status of ALL pool agents across all pools (backward compat).
 */
export function getAllPoolStatus(): PoolAgentStatus[] {
  const db = getDb();
  const now = new Date().toISOString();

  // Get all AI agent users that are in any pool
  const agents = db
    .select()
    .from(users)
    .where(eq(users.type, "ai_agent"))
    .all()
    .filter((u) => u.poolId != null);

  const claimMap = new Map(
    db
      .select()
      .from(agentClaims)
      .all()
      .map((c) => [c.userId, c]),
  );
  const cutoff = reclaimCutoff(Date.now());

  return agents.map((agent) => toAgentStatus(agent, claimMap.get(agent.id), now, cutoff));
}

// ─── Remove agent from pool ────────────────────────────────────────

export interface RemoveAgentResult {
  deleted: boolean;
  deactivated: boolean;
  reason?: string;
}

/**
 * Remove an agent from a pool.
 *
 * 1. Release any active claim for this user.
 * 2. Try to hard-delete the user from the database.
 * 3. If FK constraints prevent deletion, deactivate the user and
 *    remove them from the pool instead.
 */
export function removeAgentFromPool(poolId: string, userId: string): RemoveAgentResult {
  const db = getDb();
  const rawDb = getRawDb();

  // Verify the user exists and belongs to this pool
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }
  if (user.poolId !== poolId) {
    throw new AppError(400, "AGENT_NOT_IN_POOL", "Agent does not belong to this pool");
  }

  // Release any active claim
  db.delete(agentClaims).where(eq(agentClaims.userId, userId)).run();

  // Try hard delete
  try {
    rawDb.prepare("DELETE FROM users WHERE id = ?").run(userId);
    return { deleted: true, deactivated: false };
  } catch (err: unknown) {
    // FK constraint error — deactivate and remove from pool instead
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    const message = err instanceof Error ? err.message : undefined;
    if (
      code === "SQLITE_CONSTRAINT" ||
      code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
      (typeof message === "string" && message.includes("FOREIGN KEY"))
    ) {
      db.update(users)
        .set({
          isActive: false,
          poolId: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, userId))
        .run();
      return {
        deleted: false,
        deactivated: true,
        reason: "Agent has existing activity. Deactivated and removed from pool instead.",
      };
    }
    throw err;
  }
}
