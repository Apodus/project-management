import { eq, and, lt, isNull, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, getRawDb, agentClaims, users, tasks } from "../db/index.js";
import * as authService from "./auth.service.js";
import { AppError } from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────

const CLAIM_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Types ──────────────────────────────────────────────────────────

export interface PoolAgentStatus {
  user: {
    id: string;
    username: string;
    displayName: string;
    type: string;
    isActive: boolean;
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

// ─── Service functions ──────────────────────────────────────────────

/**
 * Validate the pool secret against the PM_POOL_SECRET env var.
 */
function validatePoolSecret(poolSecret: string): void {
  const expected = process.env.PM_POOL_SECRET;
  if (!expected) {
    throw new AppError(
      503,
      "POOL_NOT_CONFIGURED",
      "Agent pool is not configured. Set the PM_POOL_SECRET environment variable.",
    );
  }
  if (poolSecret !== expected) {
    throw new AppError(401, "INVALID_POOL_SECRET", "Invalid pool secret");
  }
}

/**
 * Claim an available AI agent from the pool.
 *
 * - Validates the pool secret
 * - Finds the first active AI agent user with no active (non-expired) claim
 * - Atomically creates a claim and generates a fresh API token
 * - Returns the user info and raw token, or null if no agents available
 */
export async function claimAgent(poolSecret: string): Promise<ClaimResult | null> {
  validatePoolSecret(poolSecret);

  const rawDb = getRawDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  // Use a transaction to atomically find and claim an agent
  const claimedUserId = rawDb.transaction(() => {
    // Clean expired claims first
    rawDb
      .prepare(`DELETE FROM agent_claims WHERE expires_at < ?`)
      .run(now);

    // Find first active AI agent user with no active claim
    const candidate = rawDb
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.type
         FROM users u
         WHERE u.type = 'ai_agent'
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
 * Get the status of all AI agents in the pool.
 */
export function getPoolStatus(): PoolAgentStatus[] {
  const db = getDb();
  const now = new Date().toISOString();

  // Get all AI agent users
  const agents = db
    .select()
    .from(users)
    .where(eq(users.type, "ai_agent"))
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
