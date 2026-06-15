import { describe, it, expect } from "vitest";
import {
  ESCALATION_KINDS,
  ESCALATION_STATUSES,
  ESCALATION_SEVERITIES,
  ESCALATION_ANCHOR_TYPES,
  ESCALATION_MESSAGE_TYPES,
  codeLocatorSchema,
  escalationSchema,
  escalationMessageSchema,
  escalationWithThreadSchema,
  createEscalationSchema,
  createMessageSchema,
  listEscalationsQuerySchema,
  answerEscalationSchema,
  resolveEscalationSchema,
  escalateToHumanSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-30T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────

describe("escalation enums", () => {
  it("ESCALATION_KINDS is the canonical ordered tuple", () => {
    expect([...ESCALATION_KINDS]).toEqual(["bug_report", "question", "request", "blocked"]);
  });

  it("ESCALATION_STATUSES is the canonical ordered tuple", () => {
    expect([...ESCALATION_STATUSES]).toEqual([
      "open",
      "acknowledged",
      "answered",
      "resolved",
      "needs_human",
    ]);
  });

  it("ESCALATION_SEVERITIES is the canonical ordered tuple", () => {
    expect([...ESCALATION_SEVERITIES]).toEqual(["low", "medium", "high"]);
  });

  it("ESCALATION_ANCHOR_TYPES is the canonical ordered tuple and has NO 'none' value", () => {
    expect([...ESCALATION_ANCHOR_TYPES]).toEqual(["task", "epic", "proposal"]);
    expect(ESCALATION_ANCHOR_TYPES as readonly string[]).not.toContain("none");
  });

  it("ESCALATION_MESSAGE_TYPES is the canonical ordered tuple", () => {
    expect([...ESCALATION_MESSAGE_TYPES]).toEqual(["reply", "diagnosis", "instruction", "system"]);
  });
});

// ─── codeLocator reuse round-trip ─────────────────────────────────

describe("escalation codeLocator reuse", () => {
  it("round-trips the shared codeLocatorSchema inside an escalation", () => {
    const cl = { path: "src/app.ts", line: 42, commitSha: "abc123" };
    expect(codeLocatorSchema.parse(cl)).toEqual(cl);
  });
});

// ─── escalationSchema ─────────────────────────────────────────────

describe("escalationSchema", () => {
  const validRow = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    kind: "bug_report" as const,
    status: "open" as const,
    severity: "high" as const,
    title: "Build is red",
    body: "Stack trace ...",
    codeLocator: { path: "src/app.ts", line: 10 },
    anchorType: "task" as const,
    anchorId: VALID_ULID,
    originRepo: "game_one",
    originWorkerKey: "worker-3",
    holderId: VALID_ULID,
    authorId: VALID_ULID,
    createdAt: VALID_TIMESTAMP,
    updatedAt: VALID_TIMESTAMP,
    resolvedAt: null,
    resolvedBy: null,
  };

  it("accepts a full valid row", () => {
    expect(escalationSchema.parse(validRow)).toEqual(validRow);
  });

  it("accepts null severity/body/codeLocator/anchorType/anchorId/holderId/resolvedAt/resolvedBy", () => {
    const nulled = {
      ...validRow,
      severity: null,
      body: null,
      codeLocator: null,
      anchorType: null,
      anchorId: null,
      holderId: null,
      resolvedAt: null,
      resolvedBy: null,
    };
    expect(escalationSchema.parse(nulled)).toEqual(nulled);
  });

  it("rejects an empty title", () => {
    expect(() => escalationSchema.parse({ ...validRow, title: "" })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => escalationSchema.parse({ ...validRow, kind: "feature" })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => escalationSchema.parse({ ...validRow, status: "archived" })).toThrow();
  });

  it("rejects an unknown severity", () => {
    expect(() => escalationSchema.parse({ ...validRow, severity: "critical" })).toThrow();
  });
});

// ─── escalationMessageSchema ──────────────────────────────────────

describe("escalationMessageSchema", () => {
  const validMessage = {
    id: VALID_ULID,
    escalationId: VALID_ULID,
    seq: 1,
    authorId: VALID_ULID,
    body: "On it.",
    messageType: "reply" as const,
    metadata: { k: "v" },
    createdAt: VALID_TIMESTAMP,
  };

  it("accepts a full valid message", () => {
    expect(escalationMessageSchema.parse(validMessage)).toEqual(validMessage);
  });

  it("accepts null messageType/metadata", () => {
    const nulled = { ...validMessage, messageType: null, metadata: null };
    expect(escalationMessageSchema.parse(nulled)).toEqual(nulled);
  });

  it("rejects an empty body", () => {
    expect(() => escalationMessageSchema.parse({ ...validMessage, body: "" })).toThrow();
  });

  it("rejects an unknown messageType", () => {
    expect(() =>
      escalationMessageSchema.parse({ ...validMessage, messageType: "shout" }),
    ).toThrow();
  });
});

// ─── escalationWithThreadSchema ───────────────────────────────────

describe("escalationWithThreadSchema", () => {
  it("round-trips an escalation with a messages array", () => {
    const withThread = {
      id: VALID_ULID,
      projectId: VALID_ULID,
      kind: "question" as const,
      status: "acknowledged" as const,
      severity: null,
      title: "How does X work?",
      body: null,
      codeLocator: null,
      anchorType: null,
      anchorId: null,
      originRepo: "game_one",
      originWorkerKey: "worker-1",
      holderId: VALID_ULID,
      authorId: VALID_ULID,
      createdAt: VALID_TIMESTAMP,
      updatedAt: VALID_TIMESTAMP,
      resolvedAt: null,
      resolvedBy: null,
      messages: [
        {
          id: VALID_ULID,
          escalationId: VALID_ULID,
          seq: 1,
          authorId: VALID_ULID,
          body: "Taking a look.",
          messageType: "reply" as const,
          metadata: null,
          createdAt: VALID_TIMESTAMP,
        },
      ],
    };
    expect(escalationWithThreadSchema.parse(withThread)).toEqual(withThread);
  });
});

// ─── createEscalationSchema ───────────────────────────────────────

describe("createEscalationSchema", () => {
  it("accepts a minimal { kind, title, originRepo, originWorkerKey }", () => {
    const minimal = {
      kind: "blocked" as const,
      title: "Stuck on merge",
      originRepo: "game_one",
      originWorkerKey: "worker-2",
    };
    expect(createEscalationSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects a missing originRepo", () => {
    expect(() =>
      createEscalationSchema.parse({ kind: "blocked", title: "x", originWorkerKey: "w" }),
    ).toThrow();
  });

  it("rejects a missing originWorkerKey", () => {
    expect(() =>
      createEscalationSchema.parse({ kind: "blocked", title: "x", originRepo: "r" }),
    ).toThrow();
  });

  it("rejects a missing title", () => {
    expect(() =>
      createEscalationSchema.parse({ kind: "blocked", originRepo: "r", originWorkerKey: "w" }),
    ).toThrow();
  });

  it("strips server-driven keys (status/id/authorId)", () => {
    const parsed = createEscalationSchema.parse({
      kind: "request",
      title: "Please review",
      originRepo: "r",
      originWorkerKey: "w",
      status: "resolved",
      id: VALID_ULID,
      authorId: VALID_ULID,
    });
    expect(parsed).not.toHaveProperty("status");
    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("authorId");
  });
});

// ─── createMessageSchema ──────────────────────────────────────────

describe("createMessageSchema", () => {
  it("accepts a body-only message", () => {
    expect(createMessageSchema.parse({ body: "hi" })).toEqual({ body: "hi" });
  });

  it("rejects a missing body", () => {
    expect(() => createMessageSchema.parse({ messageType: "reply" })).toThrow();
  });

  it("rejects an empty body", () => {
    expect(() => createMessageSchema.parse({ body: "" })).toThrow();
  });
});

// ─── listEscalationsQuerySchema ───────────────────────────────────

describe("listEscalationsQuerySchema", () => {
  it("accepts an empty query", () => {
    expect(listEscalationsQuerySchema.parse({})).toEqual({});
  });

  it("accepts all filters", () => {
    const q = {
      status: "open" as const,
      kind: "bug_report" as const,
      severity: "low" as const,
      originRepo: "r",
      originWorkerKey: "w",
      holderId: VALID_ULID,
    };
    expect(listEscalationsQuerySchema.parse(q)).toEqual(q);
  });
});

// ─── answer / resolve / escalateToHuman DTOs ──────────────────────

describe("answerEscalationSchema", () => {
  it("accepts an empty body (body is optional)", () => {
    expect(answerEscalationSchema.parse({})).toEqual({});
  });
  it("accepts a body", () => {
    expect(answerEscalationSchema.parse({ body: "diagnosis" })).toEqual({ body: "diagnosis" });
  });
});

describe("resolveEscalationSchema", () => {
  it("accepts a reason", () => {
    expect(resolveEscalationSchema.parse({ reason: "fixed" })).toEqual({ reason: "fixed" });
  });
  it("rejects an empty reason", () => {
    expect(() => resolveEscalationSchema.parse({ reason: "" })).toThrow();
  });
  it("rejects a missing reason", () => {
    expect(() => resolveEscalationSchema.parse({})).toThrow();
  });
});

describe("escalateToHumanSchema", () => {
  it("accepts a reason", () => {
    expect(escalateToHumanSchema.parse({ reason: "needs a human" })).toEqual({
      reason: "needs a human",
    });
  });
  it("rejects an empty reason", () => {
    expect(() => escalateToHumanSchema.parse({ reason: "" })).toThrow();
  });
});
