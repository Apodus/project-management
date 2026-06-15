import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, lt } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, users, sessions } from "../db/index.js";
import type { AuthUser } from "../types.js";

const BCRYPT_ROUNDS = 10;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Token utilities ──────────────────────────────────────────────

/**
 * Hash a raw token using bcrypt.
 */
export async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, BCRYPT_ROUNDS);
}

/**
 * Compare a raw token against a bcrypt hash.
 */
export async function compareToken(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash);
}

/**
 * Generate a cryptographically random 64-character hex token.
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ─── API Token operations ─────────────────────────────────────────

/**
 * Create a new API token for a user.
 * Generates a random token, stores its bcrypt hash in users.api_token_hash,
 * and returns the raw token (shown once to the caller).
 */
export async function createApiToken(userId: string): Promise<string> {
  const db = getDb();
  const token = generateToken();
  const hash = await hashToken(token);

  db.update(users)
    .set({ apiTokenHash: hash, updatedAt: new Date().toISOString() })
    .where(eq(users.id, userId))
    .run();

  return token;
}

/**
 * Validate an API token by checking it against all active users
 * that have an api_token_hash set. Returns the matching user or null.
 */
export async function validateApiToken(token: string): Promise<AuthUser | null> {
  const db = getDb();

  const activeUsers = db
    .select()
    .from(users)
    .where(eq(users.isActive, true))
    .all()
    .filter((u) => u.apiTokenHash !== null);

  for (const user of activeUsers) {
    const matches = await compareToken(token, user.apiTokenHash!);
    if (matches) {
      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        type: user.type,
      };
    }
  }

  return null;
}

// ─── Session operations ───────────────────────────────────────────

/**
 * Create a new session for a user.
 * Returns the raw session token and its expiry timestamp.
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: string }> {
  const db = getDb();
  const token = generateToken();
  const hash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  const createdAt = new Date().toISOString();

  db.insert(sessions)
    .values({
      id: createId(),
      userId,
      tokenHash: hash,
      expiresAt,
      createdAt,
    })
    .run();

  return { token, expiresAt };
}

/**
 * Validate a session token.
 * Finds all non-expired sessions, compares the token against each,
 * and returns the user for the matching session, or null.
 */
export async function validateSession(token: string): Promise<AuthUser | null> {
  const db = getDb();
  const now = new Date().toISOString();

  const activeSessions = db
    .select({
      sessionId: sessions.id,
      tokenHash: sessions.tokenHash,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      type: users.type,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .all()
    .filter((s) => s.isActive && new Date(s.expiresAt) > new Date(now));

  for (const session of activeSessions) {
    const matches = await compareToken(token, session.tokenHash);
    if (matches) {
      return {
        id: session.userId,
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        type: session.type,
      };
    }
  }

  return null;
}

/**
 * Delete a session by its raw token.
 * Finds the matching session and removes it.
 */
export async function deleteSession(sessionToken: string): Promise<void> {
  const db = getDb();

  const allSessions = db.select().from(sessions).all();

  for (const session of allSessions) {
    const matches = await compareToken(sessionToken, session.tokenHash);
    if (matches) {
      db.delete(sessions).where(eq(sessions.id, session.id)).run();
      return;
    }
  }
}

/**
 * Delete all expired sessions.
 */
export function cleanExpiredSessions(): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
}
