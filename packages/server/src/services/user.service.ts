import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import { getDb, users } from "../db/index.js";
import * as authService from "./auth.service.js";

const BCRYPT_ROUNDS = 10;

/**
 * User data returned by the service.
 * Sensitive fields (password_hash, api_token_hash) are always excluded.
 */
export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  type: string;
  avatarUrl: string | null;
  poolId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input for creating a user.
 */
export interface CreateUserInput {
  username: string;
  displayName: string;
  email?: string | null;
  password?: string;
  role: string;
  type: string;
}

/**
 * Input for updating a user.
 */
export interface UpdateUserInput {
  username?: string;
  displayName?: string;
  email?: string | null;
  role?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

function toUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    type: row.type,
    avatarUrl: row.avatarUrl,
    poolId: row.poolId,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Service methods ─────────────────────────────────────────────

/**
 * List all users (sensitive fields excluded).
 */
export function list(): UserRecord[] {
  const db = getDb();
  const rows = db.select().from(users).all();
  return rows.map(toUserRecord);
}

/**
 * Get a user by ID (sensitive fields excluded).
 * Returns null if not found.
 */
export function getById(id: string): UserRecord | null {
  const db = getDb();
  const row = db.select().from(users).where(eq(users.id, id)).get();
  return row ? toUserRecord(row) : null;
}

/**
 * Get a user by username (sensitive fields excluded).
 * Returns null if not found.
 */
export function getByUsername(username: string): UserRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .get();
  return row ? toUserRecord(row) : null;
}

/**
 * Create a new user.
 *
 * - If type=human: password is required, hashed with bcrypt.
 * - If type=ai_agent: no password needed, an API token is auto-generated.
 *
 * Returns the created user record, plus the raw API token for ai_agent users.
 */
export async function create(
  input: CreateUserInput,
): Promise<{ user: UserRecord; apiToken?: string }> {
  const db = getDb();
  const ts = new Date().toISOString();
  const id = createId();

  // Check for duplicate username
  const existing = db
    .select()
    .from(users)
    .where(eq(users.username, input.username))
    .get();
  if (existing) {
    throw new DuplicateUsernameError(input.username);
  }

  let passwordHash: string | null = null;
  let apiToken: string | undefined;

  if (input.type === "human") {
    if (!input.password) {
      throw new Error("Password is required for human users");
    }
    passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  }

  db.insert(users)
    .values({
      id,
      username: input.username,
      displayName: input.displayName,
      email: input.email ?? null,
      role: input.role,
      type: input.type,
      passwordHash,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  // For AI agents, auto-generate an API token
  if (input.type === "ai_agent") {
    apiToken = await authService.createApiToken(id);
  }

  const user = getById(id)!;
  return { user, apiToken };
}

/**
 * Update user fields (username, displayName, email, role).
 * Does NOT update password or token.
 */
export function update(id: string, input: UpdateUserInput): UserRecord | null {
  const db = getDb();
  const existing = db.select().from(users).where(eq(users.id, id)).get();
  if (!existing) {
    return null;
  }

  // If changing username, check for duplicate
  if (input.username && input.username !== existing.username) {
    const dup = db
      .select()
      .from(users)
      .where(eq(users.username, input.username))
      .get();
    if (dup) {
      throw new DuplicateUsernameError(input.username);
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };

  if (input.username !== undefined) updates.username = input.username;
  if (input.displayName !== undefined)
    updates.displayName = input.displayName;
  if (input.email !== undefined) updates.email = input.email;
  if (input.role !== undefined) updates.role = input.role;

  db.update(users).set(updates).where(eq(users.id, id)).run();
  return getById(id);
}

/**
 * Change a user's password. Hashes and stores the new password.
 */
export async function changePassword(
  id: string,
  newPassword: string,
): Promise<void> {
  const db = getDb();
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  db.update(users)
    .set({ passwordHash: hash, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .run();
}

/**
 * Deactivate a user (set is_active = false).
 */
export function deactivate(id: string): UserRecord | null {
  const db = getDb();
  const existing = db.select().from(users).where(eq(users.id, id)).get();
  if (!existing) return null;

  db.update(users)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .run();

  return getById(id);
}

/**
 * Activate a user (set is_active = true).
 */
export function activate(id: string): UserRecord | null {
  const db = getDb();
  const existing = db.select().from(users).where(eq(users.id, id)).get();
  if (!existing) return null;

  db.update(users)
    .set({ isActive: true, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .run();

  return getById(id);
}

/**
 * Validate username + password for login.
 * Returns the user record if credentials are valid, null otherwise.
 */
export async function validateCredentials(
  username: string,
  password: string,
): Promise<UserRecord | null> {
  const db = getDb();
  const row = db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .get();

  if (!row) return null;
  if (!row.passwordHash) return null;
  if (!row.isActive) return null;

  const valid = await bcrypt.compare(password, row.passwordHash);
  if (!valid) return null;

  return toUserRecord(row);
}

/**
 * Count total users in the database. SQL COUNT (C2): the previous
 * select-all-rows-and-measure-length materialized every user row (with
 * password/token hashes) just to count them.
 */
export function count(): number {
  const db = getDb();
  const row = db.select({ c: sql<number>`count(*)` }).from(users).get();
  return Number(row?.c ?? 0);
}

/**
 * C2: transactional first-admin creation for POST /auth/setup. The previous
 * route-level read-then-create had a check/insert race: two concurrent setup
 * POSTs could both observe count()===0 and both create an admin. Structure
 * (pinned): bcrypt-hash FIRST (the only await), then a SYNCHRONOUS
 * db.transaction whose body does count-check → throw SetupAlreadyCompleteError
 * → insert with NO await between check and insert — better-sqlite3 txns are
 * synchronous, so the pair is atomic.
 */
export async function createFirstAdmin(input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<UserRecord> {
  // Hash FIRST — no await may sit between the count-check and the insert.
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const db = getDb();
  const ts = new Date().toISOString();
  const id = createId();

  db.transaction((tx) => {
    const row = tx.select({ c: sql<number>`count(*)` }).from(users).get();
    if (Number(row?.c ?? 0) > 0) {
      throw new SetupAlreadyCompleteError();
    }
    tx.insert(users)
      .values({
        id,
        username: input.username,
        displayName: input.displayName,
        email: null,
        role: "admin",
        type: "human",
        passwordHash,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  });

  return getById(id)!;
}

// ─── Error types ─────────────────────────────────────────────────

export class DuplicateUsernameError extends Error {
  public readonly username: string;

  constructor(username: string) {
    super(`Username "${username}" is already taken`);
    this.name = "DuplicateUsernameError";
    this.username = username;
  }
}

/**
 * C2: thrown by createFirstAdmin when a user already exists — the route maps
 * it to the existing 409 SETUP_COMPLETE envelope.
 */
export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super("Setup has already been completed. Users already exist.");
    this.name = "SetupAlreadyCompleteError";
  }
}
