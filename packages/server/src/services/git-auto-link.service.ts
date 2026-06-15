import { eq, and } from "drizzle-orm";
import { getDb, gitRefs, tasks } from "../db/index.js";
import { createId } from "@pm/shared";

// ─── Types ────────────────────────────────────────────────────────

export interface ParsedBranch {
  taskId: string;
  slug: string;
}

// ─── ULID pattern ─────────────────────────────────────────────────

/**
 * ULID: 26 chars from Crockford's Base32 alphabet [0-9A-HJKMNP-TV-Z].
 * We match case-insensitively since branch names are often lowercase.
 */
const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
const ULID_RE = new RegExp(`^${ULID_PATTERN}$`, "i");

// ─── Branch name parsing ──────────────────────────────────────────

/**
 * Parse a branch name following the `<prefix>/<task-id>-<slug>` convention.
 *
 * Examples:
 *   "feat/01J5KXYZ1234567890ABCDEF-add-auth"  -> { taskId: "01J5KXYZ1234567890ABCDEF", slug: "add-auth" }
 *   "fix/01J5KXYZ1234567890ABCDEF-bug"         -> { taskId: "01J5KXYZ1234567890ABCDEF", slug: "bug" }
 *
 * If branchPrefix is provided, the branch must start with that prefix.
 * Otherwise any single-segment prefix before the first `/` is accepted.
 *
 * Returns null if the branch name does not match the pattern.
 */
export function parseBranchName(branchName: string, branchPrefix?: string): ParsedBranch | null {
  // Branch must contain a "/"
  const slashIdx = branchName.indexOf("/");
  if (slashIdx === -1) return null;

  const prefix = branchName.slice(0, slashIdx);
  const rest = branchName.slice(slashIdx + 1);

  // If a specific prefix is required, validate it
  if (branchPrefix !== undefined && prefix !== branchPrefix) {
    return null;
  }

  // rest should be <taskId>-<slug>
  // ULID is always 26 chars, so we split at position 26
  if (rest.length < 27) return null; // 26 + at least 1 char for "-"

  const potentialId = rest.slice(0, 26);
  const separator = rest[26];
  const slug = rest.slice(27);

  if (separator !== "-") return null;
  if (!ULID_RE.test(potentialId)) return null;
  if (!slug || slug.length === 0) return null;

  return {
    taskId: potentialId.toUpperCase(),
    slug,
  };
}

// ─── Commit message parsing ───────────────────────────────────────

/**
 * Parse commit message for task ID references.
 *
 * Matches:
 *   [PM-<ULID>]
 *   refs: <ULID>
 *
 * Returns an array of unique task IDs found.
 */
export function parseCommitMessage(message: string): string[] {
  const ids = new Set<string>();

  // Pattern 1: [PM-<ULID>]
  const pmPattern = new RegExp(`\\[PM-(${ULID_PATTERN})\\]`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pmPattern.exec(message)) !== null) {
    ids.add(match[1].toUpperCase());
  }

  // Pattern 2: refs: <ULID> (can have multiple space-separated IDs)
  const refsPattern = new RegExp(`refs:\\s*(${ULID_PATTERN}(?:\\s+${ULID_PATTERN})*)`, "gi");
  while ((match = refsPattern.exec(message)) !== null) {
    const idStr = match[1];
    const individualIds = idStr.split(/\s+/);
    for (const id of individualIds) {
      if (ULID_RE.test(id)) {
        ids.add(id.toUpperCase());
      }
    }
  }

  return Array.from(ids);
}

// ─── Auto-link branch ─────────────────────────────────────────────

/**
 * Parse a branch name, verify the task exists in the given project,
 * and create a git_ref linking the branch to the task.
 *
 * Returns the created git_ref, or null if the branch doesn't match
 * the naming convention or the task doesn't exist.
 *
 * If a git_ref for this branch already exists on this task, returns
 * the existing ref without creating a duplicate.
 */
export function autoLinkBranch(
  branchName: string,
  projectId: string,
  branchPrefix?: string,
): ReturnType<typeof getRefById> | null {
  const parsed = parseBranchName(branchName, branchPrefix);
  if (!parsed) return null;

  const db = getDb();

  // Verify task exists and belongs to the project
  const task = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, parsed.taskId), eq(tasks.projectId, projectId)))
    .get();

  if (!task) return null;

  // Check if a branch ref already exists for this task + branch
  const existing = db
    .select()
    .from(gitRefs)
    .where(
      and(
        eq(gitRefs.taskId, parsed.taskId),
        eq(gitRefs.refType, "branch"),
        eq(gitRefs.refValue, branchName),
      ),
    )
    .get();

  if (existing) return existing;

  // Create the git ref
  const now = new Date().toISOString();
  const id = createId();

  db.insert(gitRefs)
    .values({
      id,
      taskId: parsed.taskId,
      refType: "branch",
      refValue: branchName,
      url: null,
      title: null,
      status: null,
      metadata: { slug: parsed.slug, autoLinked: true },
      createdAt: now,
    })
    .run();

  return getRefById(id);
}

/**
 * Link a commit to tasks found by parsing the commit message.
 * Returns an array of created git_refs.
 */
export function linkCommitToTasks(
  commitRef: string,
  message: string,
  projectId: string,
  url?: string,
  title?: string,
): Array<NonNullable<ReturnType<typeof getRefById>>> {
  const taskIds = parseCommitMessage(message);
  if (taskIds.length === 0) return [];

  const db = getDb();
  const refs: Array<NonNullable<ReturnType<typeof getRefById>>> = [];

  for (const taskId of taskIds) {
    // Verify task exists and belongs to the project
    const task = db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
      .get();

    if (!task) continue;

    // Check if this commit is already linked
    const existing = db
      .select()
      .from(gitRefs)
      .where(
        and(
          eq(gitRefs.taskId, taskId),
          eq(gitRefs.refType, "commit"),
          eq(gitRefs.refValue, commitRef),
        ),
      )
      .get();

    if (existing) {
      refs.push(existing);
      continue;
    }

    // Create the git ref
    const now = new Date().toISOString();
    const id = createId();

    db.insert(gitRefs)
      .values({
        id,
        taskId,
        refType: "commit",
        refValue: commitRef,
        url: url ?? null,
        title: title ?? null,
        status: null,
        metadata: { autoLinked: true },
        createdAt: now,
      })
      .run();

    const ref = getRefById(id);
    if (ref) refs.push(ref);
  }

  return refs;
}

// ─── Helper ───────────────────────────────────────────────────────

function getRefById(id: string) {
  const db = getDb();
  return db.select().from(gitRefs).where(eq(gitRefs.id, id)).get() ?? null;
}
