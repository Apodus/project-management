import { describe, it, expect } from "vitest";
import { buildDrivePrompt, DEFAULT_DRIVE_PROMPT } from "../src/drive-prompt.js";
import { DEFAULT_RESPONDER_PROMPT } from "../src/prompt.js";
import { DEFAULT_IMPLEMENT_PROMPT } from "../src/implement-prompt.js";
import type { Escalation, EscalationMessage } from "@pm/shared";

function mkEscalation(over: Partial<Escalation> = {}): Escalation {
  return {
    id: "e1",
    projectId: "p",
    kind: "request",
    status: "open",
    severity: "high",
    title: "the architecture is wrong",
    body: "we need a systemic rework",
    codeLocator: null,
    anchorType: null,
    anchorId: null,
    originRepo: "client-repo",
    originWorkerKey: "wk",
    holderId: null,
    authorId: "human",
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

const NO_THREAD: EscalationMessage[] = [];

describe("buildDrivePrompt", () => {
  it("substitutes {escalation} + {thread}; no raw placeholders survive", () => {
    const thread: EscalationMessage[] = [
      {
        id: "m1",
        escalationId: "e1",
        seq: 1,
        authorId: "human",
        body: "the systemic detail",
        messageType: "reply",
        metadata: null,
        createdAt: "2026-06-13T00:00:00.000Z",
      },
    ];
    const out = buildDrivePrompt(mkEscalation({ title: "the-title" }), thread);
    expect(out).toContain("the-title");
    expect(out).toContain("the systemic detail");
    expect(out).not.toContain("{escalation}");
    expect(out).not.toContain("{thread}");
  });

  it("carries the drive sentinel contract: PM_DRIVE_STATUS_PATH + vision_ready/give_up + the breakdown fields", () => {
    const out = buildDrivePrompt(mkEscalation(), NO_THREAD);
    expect(out).toContain("PM_DRIVE_STATUS_PATH");
    expect(out).toContain("vision_ready");
    expect(out).toContain("give_up");
    expect(out).toContain("visionPath");
    expect(out).toContain("epicName");
    expect(out).toContain("campaigns");
  });

  it("references the /vision methodology + the MCP-unavailable / no-PM-write-back instruction", () => {
    const out = buildDrivePrompt(mkEscalation(), NO_THREAD);
    expect(out).toContain("/vision methodology");
    // MCP is NOT available in the clone; the daemon does the PM write-back.
    expect(out).toContain("MCP server is NOT available");
    expect(out).toContain("pm_create_epic");
    expect(out).toContain("HTTP");
  });

  it("a custom template is preserved (replace-if-present)", () => {
    const out = buildDrivePrompt(
      mkEscalation({ title: "boom" }),
      NO_THREAD,
      "VISION FOR: {escalation}",
    );
    expect(out.startsWith("VISION FOR: ")).toBe(true);
    expect(out).toContain("boom");
    expect(out).not.toContain("{thread}");
  });

  it("DEFAULT_DRIVE_PROMPT carries the {escalation}/{thread} placeholders", () => {
    expect(DEFAULT_DRIVE_PROMPT).toContain("{escalation}");
    expect(DEFAULT_DRIVE_PROMPT).toContain("{thread}");
  });
});

// ── BYTE-IDENTITY SEAL ──
// The read-only responder + bounded implement prompts MUST remain untouched (the
// drive module duplicates the formatters; it never edits/exports them).
describe("answer-mode + implement byte-identity", () => {
  it("DEFAULT_RESPONDER_PROMPT still forbids mutation (read-only seal intact)", () => {
    expect(DEFAULT_RESPONDER_PROMPT).toContain("MUST NOT edit, commit, push, or branch");
    expect(DEFAULT_RESPONDER_PROMPT).toContain("PM_RESPONDER_STATUS_PATH");
    expect(DEFAULT_RESPONDER_PROMPT).toContain("answered");
  });

  it("DEFAULT_IMPLEMENT_PROMPT still mandates the implement sentinel (bounded seal intact)", () => {
    expect(DEFAULT_IMPLEMENT_PROMPT).toContain("PM_IMPLEMENT_STATUS_PATH");
    expect(DEFAULT_IMPLEMENT_PROMPT).toContain("branch_ready");
    expect(DEFAULT_IMPLEMENT_PROMPT).toContain("{verifyCmd}");
  });
});
