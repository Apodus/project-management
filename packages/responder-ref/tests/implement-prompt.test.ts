import { describe, it, expect } from "vitest";
import { buildImplementPrompt, DEFAULT_IMPLEMENT_PROMPT } from "../src/implement-prompt.js";
import type { Escalation, EscalationMessage } from "@pm/shared";

function mkEscalation(over: Partial<Escalation> = {}): Escalation {
  return {
    id: "e1",
    projectId: "p",
    kind: "bug_report",
    status: "open",
    severity: "high",
    title: "boom",
    body: "it broke",
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

describe("buildImplementPrompt", () => {
  it("with a verifyCmd: contains the command + a run-verify-until-green-before-branch_ready instruction", () => {
    const out = buildImplementPrompt(mkEscalation(), NO_THREAD, "pm/escalation-e1", "pnpm test");
    expect(out).toContain("pnpm test");
    expect(out).toContain("Iterate until green");
    expect(out).toContain("Only AFTER verify is green");
    expect(out).toContain("branch_ready");
    // The {branch} inside the verify block is substituted, not left raw.
    expect(out).not.toContain("{verifyCmd}");
    expect(out).not.toContain("{branch}");
  });

  it("empty verifyCmd → the no-verify line, never a raw {verifyCmd}", () => {
    const out = buildImplementPrompt(mkEscalation(), NO_THREAD, "pm/escalation-e1", "");
    expect(out).toContain("no verify command configured");
    expect(out).not.toContain("{verifyCmd}");
  });

  it("substitutes escalation + branch into the default template", () => {
    const out = buildImplementPrompt(mkEscalation({ title: "the-title" }), NO_THREAD, "br-1", "");
    expect(out).toContain("the-title");
    expect(out).toContain("br-1");
    expect(out).not.toContain("{escalation}");
    expect(out).not.toContain("{thread}");
  });

  it("formats thread messages", () => {
    const thread: EscalationMessage[] = [
      {
        id: "m1",
        escalationId: "e1",
        seq: 1,
        authorId: "human",
        body: "please fix",
        messageType: "reply",
        metadata: null,
        createdAt: "2026-06-13T00:00:00.000Z",
      },
    ];
    const out = buildImplementPrompt(mkEscalation(), thread, "br", "pnpm test");
    expect(out).toContain("please fix");
  });

  it("a custom template omitting {verifyCmd} simply does not receive that block", () => {
    const out = buildImplementPrompt(
      mkEscalation(),
      NO_THREAD,
      "br",
      "pnpm test",
      "Fix it on {branch}. Title: {escalation}",
    );
    expect(out).toContain("br");
    expect(out).not.toContain("pnpm test"); // no {verifyCmd} placeholder → not injected
  });

  it("DEFAULT_IMPLEMENT_PROMPT carries the {verifyCmd} placeholder (P3 seam)", () => {
    expect(DEFAULT_IMPLEMENT_PROMPT).toContain("{verifyCmd}");
  });
});
