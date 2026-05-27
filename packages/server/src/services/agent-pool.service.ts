import { eq, and, lt, isNull, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import { getDb, getRawDb, agentClaims, users, tasks, workspaces } from "../db/index.js";
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

export interface PoolAgentStatus {
  user: {
    id: string;
    username: string;
    displayName: string;
    type: string;
    isActive: boolean;
    poolMember: boolean;
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

// ─── Pool secret management ─────────────────────────────────────────

/**
 * Get the first workspace (there's always exactly one).
 */
function getDefaultWorkspace() {
  const db = getDb();
  return db.select().from(workspaces).limit(1).get();
}

/**
 * Set the pool secret (hashes and stores in workspace).
 */
export async function setPoolSecret(secret: string): Promise<void> {
  const db = getDb();
  const ws = getDefaultWorkspace();
  if (!ws) {
    throw new AppError(500, "NO_WORKSPACE", "No workspace found");
  }

  const hash = await bcrypt.hash(secret, BCRYPT_ROUNDS);
  db.update(workspaces)
    .set({ poolSecretHash: hash, updatedAt: new Date().toISOString() })
    .where(eq(workspaces.id, ws.id))
    .run();
}

/**
 * Check if a pool secret is configured (DB or env var).
 */
export function getPoolSecretStatus(): { isSet: boolean } {
  const ws = getDefaultWorkspace();
  const dbHasSecret = !!(ws?.poolSecretHash);
  const envHasSecret = !!process.env.PM_POOL_SECRET;
  return { isSet: dbHasSecret || envHasSecret };
}

/**
 * Validate the pool secret against the DB hash, falling back to PM_POOL_SECRET env var.
 */
async function validatePoolSecret(poolSecret: string): Promise<void> {
  // First try DB-stored secret
  const ws = getDefaultWorkspace();
  if (ws?.poolSecretHash) {
    const valid = await bcrypt.compare(poolSecret, ws.poolSecretHash);
    if (valid) return;
    throw new AppError(401, "INVALID_POOL_SECRET", "Invalid pool secret");
  }

  // Fall back to env var
  const expected = process.env.PM_POOL_SECRET;
  if (!expected) {
    throw new AppError(
      503,
      "POOL_NOT_CONFIGURED",
      "Agent pool is not configured. Set the pool secret via the UI or PM_POOL_SECRET environment variable.",
    );
  }
  if (poolSecret !== expected) {
    throw new AppError(401, "INVALID_POOL_SECRET", "Invalid pool secret");
  }
}

// ─── Batch agent creation ───────────────────────────────────────────

/**
 * Create N AI agent users as pool members.
 * Uses Greek alphabet names by default, or "{prefix} N" for custom prefixes.
 */
export async function createAgentPool(
  count: number,
  namePrefix?: string,
): Promise<Array<{ id: string; username: string; displayName: string; role: string; type: string; poolMember: boolean }>> {
  const db = getDb();
  const ts = new Date().toISOString();
  const created: Array<{ id: string; username: string; displayName: string; role: string; type: string; poolMember: boolean }> = [];

  for (let i = 0; i < count; i++) {
    const id = createId();
    let displayName: string;
    let username: string;

    if (namePrefix) {
      displayName = `${namePrefix} ${i + 1}`;
      username = `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${i + 1}`;
    } else {
      const greekName = i < GREEK_NAMES.length ? GREEK_NAMES[i] : `Agent ${i + 1}`;
      displayName = i < GREEK_NAMES.length ? `Agent ${greekName}` : greekName;
      username = `agent-${greekName.toLowerCase()}`;
      // If the name is "Agent 11", "Agent 12" etc
      if (i >= GREEK_NAMES.length) {
        username = `agent-${i + 1}`;
      }
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
        poolMember: true,
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
      poolMember: true,
    });
  }

  return created;
}

// ─── Service functions ──────────────────────────────────────────────

/**
 * Claim an available AI agent from the pool.
 *
 * - Validates the pool secret
 * - Finds the first active AI agent user that is a pool member with no active (non-expired) claim
 * - Atomically creates a claim and generates a fresh API token
 * - Returns the user info and raw token, or null if no agents available
 */
export async function claimAgent(poolSecret: string): Promise<ClaimResult | null> {
  await validatePoolSecret(poolSecret);

  const rawDb = getRawDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  // Use a transaction to atomically find and claim an agent
  const claimedUserId = rawDb.transaction(() => {
    // Clean expired claims first
    rawDb
      .prepare(`DELETE FROM agent_claims WHERE expires_at < ?`)
      .run(now);

    // Find first active AI agent pool member with no active claim
    const candidate = rawDb
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.type
         FROM users u
         WHERE u.type = 'ai_agent'
           AND u.pool_member = 1
           AND u.is_active = 1
           AND u.id NOT IN (
             SELECT ac.user_id FROM agent_claims ac
             WHERE ac.expires_at >= ?
           )
         ORDER BY u.username ASC
         LIMIT 1`,
      )
      .get(now) as
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
  const db = getDb();
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
 * Get the status of all AI agents in the pool (pool members only).
 */
export function getPoolStatus(): PoolAgentStatus[] {
  const db = getDb();
  const now = new Date().toISOString();

  // Get all AI agent users that are pool members
  const agents = db
    .select()
    .from(users)
    .where(and(eq(users.type, "ai_agent"), eq(users.poolMember, true)))
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
        poolMember: agent.poolMember,
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

  // Find and reset stale tasks:
  // - status = in_progress
  // - assigned to an AI agent user
  // - the AI agent has no active (non-expired) claim
  // - started_at is older than the threshold
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
