import { describe, it, expect } from "vitest";
import {
  MERGE_REQUEST_STATUSES,
  MERGE_ATTEMPT_STATUSES,
  MERGE_REJECT_CATEGORIES,
  mergeRequestSchema,
  mergeAttemptSchema,
  mergeRequestSubmitSchema,
  mergeRequestRejectSchema,
  mergeRequestLandSchema,
  mergeAttemptStartSchema,
  mergeAttemptCompleteSchema,
  COMMENT_TYPES,
  GIT_REF_TYPES,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-27T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────

describe("MERGE_REQUEST_STATUSES", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...MERGE_REQUEST_STATUSES]).toEqual([
      "queued",
      "integrating",
      "landed",
      "rejected",
      "abandoned",
    ]);
  });

  it("starts with 'queued' (the DB column default)", () => {
    expect(MERGE_REQUEST_STATUSES[0]).toBe("queued");
  });
});

describe("MERGE_ATTEMPT_STATUSES", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...MERGE_ATTEMPT_STATUSES]).toEqual([
      "pending",
      "running",
      "passed",
      "failed",
      "cancelled",
    ]);
  });
});

describe("MERGE_REJECT_CATEGORIES", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...MERGE_REJECT_CATEGORIES]).toEqual([
      "conflict",
      "build_failed",
      "test_failed",
      "lint_failed",
      "verify_timeout",
      "policy",
      "other",
    ]);
  });
});

describe("COMMENT_TYPES (extended)", () => {
  it("includes 'merge_rejection' (appended for phase 7.1)", () => {
    expect(COMMENT_TYPES).toContain("merge_rejection");
  });
});

describe("GIT_REF_TYPES (extended)", () => {
  it("includes 'landed_sha' (appended for phase 7.1)", () => {
    expect(GIT_REF_TYPES).toContain("landed_sha");
  });
});

// ─── mergeRequestSchema ───────────────────────────────────────────

describe("mergeRequestSchema", () => {
  const validRequest = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    resource: "main",
    submittedBy: VALID_ULID,
    taskId: VALID_ULID,
    branch: "feat/auth",
    commitSha: "abc123",
    verifyCmd: "pnpm test",
    worktreePath: "/tmp/wt",
    status: "queued" as const,
    enqueuedAt: VALID_TIMESTAMP,
    pickedUpAt: null,
    resolvedAt: null,
    landedSha: null,
    rejectCategory: null,
    rejectReason: null,
    failedFiles: null,
    logExcerpt: null,
    logUrl: null,
    createdAt: VALID_TIMESTAMP,
    updatedAt: VALID_TIMESTAMP,
  };

  it("accepts a valid queued request", () => {
    expect(mergeRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it("accepts a landed request with landedSha + resolvedAt set", () => {
    const landed = {
      ...validRequest,
      status: "landed" as const,
      pickedUpAt: VALID_TIMESTAMP,
      resolvedAt: VALID_TIMESTAMP,
      landedSha: "def456",
    };
    expect(mergeRequestSchema.parse(landed)).toBeTruthy();
  });

  it("accepts a rejected request with category + reason + failedFiles", () => {
    const rejected = {
      ...validRequest,
      status: "rejected" as const,
      pickedUpAt: VALID_TIMESTAMP,
      resolvedAt: VALID_TIMESTAMP,
      rejectCategory: "test_failed" as const,
      rejectReason: "3 tests failed",
      failedFiles: ["src/foo.test.ts", "src/bar.test.ts"],
      logExcerpt: "FAIL src/foo.test.ts ...",
    };
    expect(mergeRequestSchema.parse(rejected)).toBeTruthy();
  });

  it("accepts a request with null taskId (post-task-deletion)", () => {
    expect(mergeRequestSchema.parse({ ...validRequest, taskId: null })).toBeTruthy();
  });

  it("accepts all valid statuses", () => {
    for (const status of MERGE_REQUEST_STATUSES) {
      expect(mergeRequestSchema.parse({ ...validRequest, status })).toBeTruthy();
    }
  });

  it("rejects unknown status", () => {
    expect(() =>
      mergeRequestSchema.parse({ ...validRequest, status: "in_progress" }),
    ).toThrow();
  });

  it("rejects unknown rejectCategory", () => {
    expect(() =>
      mergeRequestSchema.parse({ ...validRequest, rejectCategory: "flaky" }),
    ).toThrow();
  });

  it("rejects missing projectId", () => {
    const { projectId: _, ...r } = validRequest;
    expect(() => mergeRequestSchema.parse(r)).toThrow();
  });

  it("rejects missing submittedBy", () => {
    const { submittedBy: _, ...r } = validRequest;
    expect(() => mergeRequestSchema.parse(r)).toThrow();
  });
});

// ─── mergeAttemptSchema ───────────────────────────────────────────

describe("mergeAttemptSchema", () => {
  const validAttempt = {
    id: VALID_ULID,
    requestId: VALID_ULID,
    attemptNumber: 1,
    baseSha: "abc123",
    treeSha: null,
    status: "pending" as const,
    startedAt: null,
    completedAt: null,
    verifyDurationMs: null,
    failureCategory: null,
    failureReason: null,
    failedFiles: null,
    logExcerpt: null,
    logUrl: null,
    createdAt: VALID_TIMESTAMP,
  };

  it("accepts a valid pending attempt", () => {
    expect(mergeAttemptSchema.parse(validAttempt)).toEqual(validAttempt);
  });

  it("accepts a passed attempt with treeSha + verifyDurationMs", () => {
    const passed = {
      ...validAttempt,
      status: "passed" as const,
      treeSha: "def456",
      startedAt: VALID_TIMESTAMP,
      completedAt: VALID_TIMESTAMP,
      verifyDurationMs: 42_000,
    };
    expect(mergeAttemptSchema.parse(passed)).toBeTruthy();
  });

  it("accepts a failed attempt with failureCategory + failureReason", () => {
    const failed = {
      ...validAttempt,
      status: "failed" as const,
      startedAt: VALID_TIMESTAMP,
      completedAt: VALID_TIMESTAMP,
      verifyDurationMs: 12_345,
      failureCategory: "build_failed" as const,
      failureReason: "tsc error in src/foo.ts",
    };
    expect(mergeAttemptSchema.parse(failed)).toBeTruthy();
  });

  it("rejects unknown status", () => {
    expect(() =>
      mergeAttemptSchema.parse({ ...validAttempt, status: "queued" }),
    ).toThrow();
  });

  it("rejects non-integer attemptNumber", () => {
    expect(() =>
      mergeAttemptSchema.parse({ ...validAttempt, attemptNumber: 1.5 }),
    ).toThrow();
  });
});

// ─── mergeRequestSubmitSchema ─────────────────────────────────────

describe("mergeRequestSubmitSchema", () => {
  it("accepts an empty body and defaults resource to 'main'", () => {
    const parsed = mergeRequestSubmitSchema.parse({});
    expect(parsed.resource).toBe("main");
  });

  it("accepts a body with only resource override", () => {
    const parsed = mergeRequestSubmitSchema.parse({ resource: "release-x" });
    expect(parsed.resource).toBe("release-x");
  });

  it("accepts a fully-populated body", () => {
    const body = {
      resource: "main",
      taskId: VALID_ULID,
      branch: "feat/x",
      commitSha: "abc123",
      verifyCmd: "pnpm test",
      worktreePath: "/tmp/wt",
    };
    expect(mergeRequestSubmitSchema.parse(body)).toEqual(body);
  });

  it("accepts null taskId / branch / commitSha / verifyCmd / worktreePath", () => {
    const body = {
      taskId: null,
      branch: null,
      commitSha: null,
      verifyCmd: null,
      worktreePath: null,
    };
    const parsed = mergeRequestSubmitSchema.parse(body);
    expect(parsed.taskId).toBeNull();
    expect(parsed.resource).toBe("main");
  });

  it("rejects empty-string resource", () => {
    expect(() => mergeRequestSubmitSchema.parse({ resource: "" })).toThrow();
  });
});

// ─── mergeRequestRejectSchema ─────────────────────────────────────

describe("mergeRequestRejectSchema", () => {
  it("accepts a minimal reject body", () => {
    expect(
      mergeRequestRejectSchema.parse({ category: "conflict", reason: "merge conflict in X" }),
    ).toBeTruthy();
  });

  it("accepts a fully-populated reject body", () => {
    const body = {
      category: "test_failed" as const,
      reason: "3 tests failed",
      failedFiles: ["src/a.test.ts"],
      logExcerpt: "FAIL ...",
      logUrl: "file:///tmp/log.txt",
    };
    expect(mergeRequestRejectSchema.parse(body)).toEqual(body);
  });

  it("accepts every valid reject category", () => {
    for (const category of MERGE_REJECT_CATEGORIES) {
      expect(
        mergeRequestRejectSchema.parse({ category, reason: "r" }),
      ).toBeTruthy();
    }
  });

  it("rejects an unknown category", () => {
    expect(() =>
      mergeRequestRejectSchema.parse({ category: "flaky", reason: "r" }),
    ).toThrow();
  });

  it("rejects missing reason", () => {
    expect(() =>
      mergeRequestRejectSchema.parse({ category: "conflict" }),
    ).toThrow();
  });

  it("rejects empty reason", () => {
    expect(() =>
      mergeRequestRejectSchema.parse({ category: "conflict", reason: "" }),
    ).toThrow();
  });
});

// ─── mergeRequestLandSchema ───────────────────────────────────────

describe("mergeRequestLandSchema", () => {
  it("accepts a valid landedSha", () => {
    expect(mergeRequestLandSchema.parse({ landedSha: "abc123" })).toEqual({
      landedSha: "abc123",
    });
  });

  it("rejects missing landedSha", () => {
    expect(() => mergeRequestLandSchema.parse({})).toThrow();
  });

  it("rejects empty landedSha", () => {
    expect(() => mergeRequestLandSchema.parse({ landedSha: "" })).toThrow();
  });
});

// ─── mergeAttemptStartSchema ──────────────────────────────────────

describe("mergeAttemptStartSchema", () => {
  it("accepts a valid baseSha", () => {
    expect(mergeAttemptStartSchema.parse({ baseSha: "abc123" })).toEqual({
      baseSha: "abc123",
    });
  });

  it("rejects missing baseSha", () => {
    expect(() => mergeAttemptStartSchema.parse({})).toThrow();
  });

  it("rejects empty baseSha", () => {
    expect(() => mergeAttemptStartSchema.parse({ baseSha: "" })).toThrow();
  });
});

// ─── mergeAttemptCompleteSchema ───────────────────────────────────

describe("mergeAttemptCompleteSchema", () => {
  it("accepts a 'passed' body with treeSha", () => {
    expect(
      mergeAttemptCompleteSchema.parse({ status: "passed", treeSha: "abc123" }),
    ).toBeTruthy();
  });

  it("rejects a 'passed' body missing treeSha", () => {
    expect(() => mergeAttemptCompleteSchema.parse({ status: "passed" })).toThrow();
  });

  it("rejects a 'passed' body with empty treeSha", () => {
    expect(() =>
      mergeAttemptCompleteSchema.parse({ status: "passed", treeSha: "" }),
    ).toThrow();
  });

  it("accepts a 'failed' body with category + reason", () => {
    expect(
      mergeAttemptCompleteSchema.parse({
        status: "failed",
        failureCategory: "test_failed",
        failureReason: "3 tests failed",
      }),
    ).toBeTruthy();
  });

  it("accepts a 'failed' body with all optional fields", () => {
    const body = {
      status: "failed" as const,
      failureCategory: "build_failed" as const,
      failureReason: "tsc error",
      failedFiles: ["src/foo.ts"],
      logExcerpt: "TS2322: ...",
      logUrl: "file:///tmp/log",
    };
    expect(mergeAttemptCompleteSchema.parse(body)).toEqual(body);
  });

  it("rejects a 'failed' body missing failureCategory", () => {
    expect(() =>
      mergeAttemptCompleteSchema.parse({
        status: "failed",
        failureReason: "r",
      }),
    ).toThrow();
  });

  it("rejects a 'failed' body missing failureReason", () => {
    expect(() =>
      mergeAttemptCompleteSchema.parse({
        status: "failed",
        failureCategory: "conflict",
      }),
    ).toThrow();
  });

  it("rejects a 'failed' body with unknown failureCategory", () => {
    expect(() =>
      mergeAttemptCompleteSchema.parse({
        status: "failed",
        failureCategory: "flaky",
        failureReason: "r",
      }),
    ).toThrow();
  });

  it("accepts a 'cancelled' body with no extra fields", () => {
    expect(mergeAttemptCompleteSchema.parse({ status: "cancelled" })).toEqual({
      status: "cancelled",
    });
  });

  it("rejects unknown status values", () => {
    expect(() =>
      mergeAttemptCompleteSchema.parse({ status: "pending" }),
    ).toThrow();
    expect(() =>
      mergeAttemptCompleteSchema.parse({ status: "running" }),
    ).toThrow();
  });
});
