import { eq, and, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import { getDb, getRawDb, agentClaims, users, tasks, agentPools } from "../db/index.js";
import * as authService from "./auth.service.js";
import { AppError } from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────

const CLAIM_TTL_MS = 60 * 60 * 1000; // 1 hour
const BCRYPT_ROUNDS = 10;

const GREEK_NAMES = [
  "Alpha", "Beta", "Gamma", "Delta", "Epsilon",
  "Zeta", "Eta", "Theta", "Iota", "Kappa",
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

export interface PoolSummary extends PoolInfo {
  agentCount: number;
  claimedCount: number;
  availableCount: number;
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
  claimed: boolean;
  claimedAt: string | null;
  expiresAt: string | null;
  heartbeatAt: string | null;
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
  const existing = db
    .select()
    .from(agentPools)
    .where(eq(agentPools.name, name))
    .get();
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

  return { id, name, description: description ?? null, createdAt: ts, updatedAt: ts, createdBy: createdBy ?? null };
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
  rawDb.prepare(
    `DELETE FROM agent_claims WHERE user_id IN (SELECT id FROM users WHERE pool_id = ?)`,
  ).run(poolId);

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
  const setValues: Record<string, unknown> = { updatedAt: ts };
  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.description !== undefined) setValues.description = updates.description;

  db.update(agentPools)
    .set(setValues as any)
    .where(eq(agentPools.id, poolId))
    .run();

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

  const rows = rawDb
    .prepare(
      `SELECT
         p.id, p.name, p.description, p.created_at, p.updated_at, p.created_by,
         COUNT(u.id) AS agent_count,
         COUNT(CASE WHEN ac.id IS NOT NULL AND ac.expires_at >= ? THEN 1 END) AS claimed_count,
         COUNT(CASE WHEN u.is_active = 1 AND (ac.id IS NULL OR ac.expires_at < ?) THEN 1 END) AS available_count
       FROM agent_pools p
       LEFT JOIN users u ON u.pool_id = p.id AND u.type = 'ai_agent'
       LEFT JOIN agent_claims ac ON ac.user_id = u.id
       GROUP BY p.id
       ORDER BY p.name ASC`,
    )
    .all(now, now) as Array<{
      id: string;
      name: string;
      description: string | null;
      created_at: string;
      updated_at: string;
      created_by: string | null;
      agent_count: number;
      claimed_count: number;
      available_count: number;
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
): Promise<Array<{ id: string; username: string; displayName: string; role: string; type: string; poolId: string }>> {
  const db = getDb();
  const ts = new Date().toISOString();

  const pool = db.select().from(agentPools).where(eq(agentPools.id, poolId)).get();
  if (!pool) {
    throw new AppError(404, "POOL_NOT_FOUND", "Pool not found");
  }

  const created: Array<{ id: string; username: string; displayName: string; role: string; type: string; poolId: string }> = [];

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
      username = i < GREEK_NAMES.length
        ? `${pool.name}-${greekName.toLowerCase()}`
        : `${pool.name}-agent-${i + 1}`;
    }

    // Check for duplicate username and append a suffix if needed
    const existing = db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .get();
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
 * Claim an available AI agent from a named pool.
 */
export async function claimAgent(poolName: string, poolSecret: string): Promise<ClaimResult | null> {
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

  // Validate secret
  const valid = await bcrypt.compare(poolSecret, pool.secretHash);
  if (!valid) {
    throw new AppError(401, "INVALID_POOL_SECRET", "Invalid pool secret");
  }

  const rawDb = getRawDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  // Use a transaction to atomically find and claim an agent
  const claimedUserId = rawDb.transaction(() => {
    // Clean expired claims first
    rawDb
      .prepare(`DELETE FROM agent_claims WHERE expires_at < ?`)
      .run(now);

    // Find first active AI agent in THIS pool with no active claim
    const candidate = rawDb
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.type
         FROM users u
         WHERE u.type = 'ai_agent'
           AND u.pool_id = ?
           AND u.is_active = 1
           AND u.id NOT IN (
             SELECT ac.user_id FROM agent_claims ac
             WHERE ac.expires_at >= ?
           )
         ORDER BY u.username ASC
         LIMIT 1`,
      )
      .get(pool.id, now) as
      | { id: string; username: string; display_name: string; role: string; type: string }
      | undefined;

    if (!candidate) {
      return null;
    }

    // Create the claim record
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

  // Generate a fresh API token for the claimed user (outside transaction since it's async)
  const token = await authService.createApiToken(claimedUserId);

  // Fetch the user record
  const user = db
    .select()
    .from(users)
    .where(eq(users.id, claimedUserId))
    .get();

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
  };
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

  // Get all active (non-expired) claims
  const activeClaims = db
    .select()
    .from(agentClaims)
    .all();

  const claimMap = new Map(
    activeClaims.map((c) => [c.userId, c]),
  );

  return agents.map((agent) => {
    const claim = claimMap.get(agent.id);
    const isExpired = claim ? new Date(claim.expiresAt) < new Date(now) : false;
    const isClaimed = claim && !isExpired;

    return {
      user: {
        id: agent.id,
        username: agent.username,
        displayName: agent.displayName,
        type: agent.type,
        isActive: agent.isActive,
        poolId: agent.poolId,
      },
      claimed: !!isClaimed,
      claimedAt: isClaimed ? claim.claimedAt : null,
      expiresAt: isClaimed ? claim.expiresAt : null,
      heartbeatAt: isClaimed ? claim.heartbeatAt : null,
    };
  });
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

  // Get all claims
  const activeClaims = db
    .select()
    .from(agentClaims)
    .all();

  const claimMap = new Map(
    activeClaims.map((c) => [c.userId, c]),
  );

  return agents.map((agent) => {
    const claim = claimMap.get(agent.id);
    const isExpired = claim ? new Date(claim.expiresAt) < new Date(now) : false;
    const isClaimed = claim && !isExpired;

    return {
      user: {
        id: agent.id,
        username: agent.username,
        displayName: agent.displayName,
        type: agent.type,
        isActive: agent.isActive,
        poolId: agent.poolId,
      },
      claimed: !!isClaimed,
      claimedAt: isClaimed ? claim.claimedAt : null,
      expiresAt: isClaimed ? claim.expiresAt : null,
      heartbeatAt: isClaimed ? claim.heartbeatAt : null,
    };
  });
}

/**
 * Delete all expired claims.
 */
export function cleanExpiredClaims(): void {
  const rawDb = getRawDb();
  const now = new Date().toISOString();

  rawDb.prepare(`DELETE FROM agent_claims WHERE expires_at < ?`).run(now);

  // Also reclaim stale tasks from agents with expired claims
  reclaimStaleTasks(4);
}

/**
 * Reclaim tasks that are in_progress and assigned to AI agents with
 * expired/no active claims, and have been started more than N hours ago.
 *
 * Moves them back to 'ready' and clears the assignee.
 */
export function reclaimStaleTasks(hoursThreshold: number): void {
  const rawDb = getRawDb();
  const now = new Date();
  const cutoff = new Date(now.getTime() - hoursThreshold * 60 * 60 * 1000).toISOString();
  const currentTime = now.toISOString();

  const result = rawDb
    .prepare(
      `UPDATE tasks
       SET status = 'ready',
           assignee_id = NULL,
           updated_at = ?
       WHERE status = 'in_progress'
         AND assignee_id IS NOT NULL
         AND started_at < ?
         AND assignee_id IN (
           SELECT u.id FROM users u
           WHERE u.type = 'ai_agent'
             AND u.id NOT IN (
               SELECT ac.user_id FROM agent_claims ac
               WHERE ac.expires_at >= ?
             )
         )`,
    )
    .run(currentTime, cutoff, currentTime);

  if (result.changes > 0) {
    // Log that we reclaimed tasks (silent for now)
  }
}
