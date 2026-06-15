import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseBranchName,
  parseCommitMessage,
  autoLinkBranch,
  linkCommitToTasks,
} from "../../src/services/git-auto-link.service.js";
import { createTestApp, createTestProject, createTestTask, type TestApp } from "../utils.js";
import { createId } from "@pm/shared";

// ─── parseBranchName ──────────────────────────────────────────────

describe("parseBranchName", () => {
  // Use a fixed valid ULID for tests
  const VALID_ULID = "01J5KXYZ1234567890ABCDEF01";

  it("should parse a valid branch name with feat prefix", () => {
    const result = parseBranchName(`feat/${VALID_ULID}-add-auth`);
    expect(result).toEqual({ taskId: VALID_ULID, slug: "add-auth" });
  });

  it("should parse a valid branch name with fix prefix", () => {
    const result = parseBranchName(`fix/${VALID_ULID}-bug-fix`);
    expect(result).toEqual({ taskId: VALID_ULID, slug: "bug-fix" });
  });

  it("should parse a valid branch name with chore prefix", () => {
    const result = parseBranchName(`chore/${VALID_ULID}-cleanup`);
    expect(result).toEqual({ taskId: VALID_ULID, slug: "cleanup" });
  });

  it("should uppercase the task ID", () => {
    const lowerId = VALID_ULID.toLowerCase();
    const result = parseBranchName(`feat/${lowerId}-some-slug`);
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe(VALID_ULID);
  });

  it("should handle multi-segment slugs", () => {
    const result = parseBranchName(`feat/${VALID_ULID}-add-user-authentication-flow`);
    expect(result).toEqual({
      taskId: VALID_ULID,
      slug: "add-user-authentication-flow",
    });
  });

  it("should return null for branch without prefix separator", () => {
    const result = parseBranchName(`${VALID_ULID}-some-slug`);
    expect(result).toBeNull();
  });

  it("should return null for branch with invalid ULID", () => {
    const result = parseBranchName("feat/INVALID-ID-TOO-SHORT-slug");
    expect(result).toBeNull();
  });

  it("should return null for branch without slug", () => {
    // 26 chars + no "-" separator
    const result = parseBranchName(`feat/${VALID_ULID}`);
    expect(result).toBeNull();
  });

  it("should return null for branch with just separator but no slug", () => {
    const result = parseBranchName(`feat/${VALID_ULID}-`);
    expect(result).toBeNull();
  });

  it("should filter by branchPrefix when provided", () => {
    const result = parseBranchName(`feat/${VALID_ULID}-slug`, "feat");
    expect(result).not.toBeNull();

    const rejected = parseBranchName(`fix/${VALID_ULID}-slug`, "feat");
    expect(rejected).toBeNull();
  });

  it("should accept any prefix when branchPrefix is not provided", () => {
    const result = parseBranchName(`custom/${VALID_ULID}-slug`);
    expect(result).not.toBeNull();
  });

  it("should return null for ULID with invalid characters", () => {
    // 'O' and 'I' and 'L' and 'U' are not in Crockford's Base32
    // 'O', 'I', 'L', 'U' are not in Crockford's Base32
    const result = parseBranchName("feat/01OILU12345678901234567890-slug");
    expect(result).toBeNull();
  });
});

// ─── parseCommitMessage ───────────────────────────────────────────

describe("parseCommitMessage", () => {
  const ID1 = "01J5KXYZ1234567890ABCDEF01";
  const ID2 = "01J5KXYZ1234567890ABCDEG02";

  it("should parse [PM-<id>] references", () => {
    const result = parseCommitMessage(`fix: resolve auth bug [PM-${ID1}]`);
    expect(result).toEqual([ID1]);
  });

  it("should parse multiple [PM-<id>] references", () => {
    const result = parseCommitMessage(`feat: implement auth [PM-${ID1}] and [PM-${ID2}]`);
    expect(result).toHaveLength(2);
    expect(result).toContain(ID1);
    expect(result).toContain(ID2);
  });

  it("should parse refs: <id> pattern", () => {
    const result = parseCommitMessage(`fix: something\nrefs: ${ID1}`);
    expect(result).toEqual([ID1]);
  });

  it("should parse refs: with multiple IDs", () => {
    const result = parseCommitMessage(`fix: something\nrefs: ${ID1} ${ID2}`);
    expect(result).toHaveLength(2);
    expect(result).toContain(ID1);
    expect(result).toContain(ID2);
  });

  it("should deduplicate task IDs", () => {
    const result = parseCommitMessage(`fix: something [PM-${ID1}]\nrefs: ${ID1}`);
    expect(result).toEqual([ID1]);
  });

  it("should return empty array for messages without references", () => {
    const result = parseCommitMessage("feat: add new feature");
    expect(result).toEqual([]);
  });

  it("should handle case-insensitive matching", () => {
    const lowerId = ID1.toLowerCase();
    const result = parseCommitMessage(`fix: thing [PM-${lowerId}]`);
    expect(result).toEqual([ID1]);
  });

  it("should not match invalid ULIDs in brackets", () => {
    const result = parseCommitMessage("fix: thing [PM-TOOSHORT]");
    expect(result).toEqual([]);
  });
});

// ─── autoLinkBranch ───────────────────────────────────────────────

describe("autoLinkBranch", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("should create a git ref for a valid branch matching a task", () => {
    const project = createTestProject(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });

    const branchName = `feat/${task.id}-add-feature`;
    const result = autoLinkBranch(branchName, project.id);

    expect(result).not.toBeNull();
    expect(result!.taskId).toBe(task.id);
    expect(result!.refType).toBe("branch");
    expect(result!.refValue).toBe(branchName);
  });

  it("should return null for a branch that doesn't match the pattern", () => {
    const project = createTestProject(testApp.db);
    const result = autoLinkBranch("main", project.id);
    expect(result).toBeNull();
  });

  it("should return null when task doesn't exist", () => {
    const project = createTestProject(testApp.db);
    const fakeId = createId();
    const result = autoLinkBranch(`feat/${fakeId}-something`, project.id);
    expect(result).toBeNull();
  });

  it("should return null when task belongs to a different project", () => {
    const project1 = createTestProject(testApp.db);
    const project2 = createTestProject(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project1.id });

    const result = autoLinkBranch(`feat/${task.id}-thing`, project2.id);
    expect(result).toBeNull();
  });

  it("should not create duplicate refs", () => {
    const project = createTestProject(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });

    const branchName = `feat/${task.id}-feature`;
    const ref1 = autoLinkBranch(branchName, project.id);
    const ref2 = autoLinkBranch(branchName, project.id);

    expect(ref1).not.toBeNull();
    expect(ref2).not.toBeNull();
    expect(ref1!.id).toBe(ref2!.id); // Same ref returned
  });
});

// ─── linkCommitToTasks ────────────────────────────────────────────

describe("linkCommitToTasks", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("should link a commit to tasks referenced in the message", () => {
    const project = createTestProject(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });

    const refs = linkCommitToTasks(
      "abc123",
      `feat: implement thing [PM-${task.id}]`,
      project.id,
      "https://github.com/org/repo/commit/abc123",
    );

    expect(refs).toHaveLength(1);
    expect(refs[0].taskId).toBe(task.id);
    expect(refs[0].refType).toBe("commit");
    expect(refs[0].refValue).toBe("abc123");
  });

  it("should return empty array when no tasks are referenced", () => {
    const project = createTestProject(testApp.db);
    const refs = linkCommitToTasks("abc123", "chore: clean up code", project.id);
    expect(refs).toEqual([]);
  });

  it("should skip tasks that don't exist", () => {
    const project = createTestProject(testApp.db);
    const fakeId = createId();
    const refs = linkCommitToTasks("abc123", `fix: thing [PM-${fakeId}]`, project.id);
    expect(refs).toEqual([]);
  });

  it("should not create duplicate commit refs", () => {
    const project = createTestProject(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });

    const msg = `fix: thing [PM-${task.id}]`;
    const refs1 = linkCommitToTasks("abc123", msg, project.id);
    const refs2 = linkCommitToTasks("abc123", msg, project.id);

    expect(refs1).toHaveLength(1);
    expect(refs2).toHaveLength(1);
    expect(refs1[0].id).toBe(refs2[0].id);
  });
});
