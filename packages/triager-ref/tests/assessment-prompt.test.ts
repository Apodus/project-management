import { describe, it, expect } from "vitest";
import { buildAssessmentPrompt, DEFAULT_ASSESSMENT_PROMPT } from "../src/assessment-prompt.js";
import type { Note } from "@pm/shared";

function mkNote(over: Partial<Note> = {}): Note {
  return {
    id: "n-1",
    projectId: "p",
    kind: "bug",
    status: "open",
    title: "the build fails",
    body: "details here",
    anchorType: null,
    anchorId: null,
    codeLocator: null,
    severity: null,
    authorId: "human",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    triagedAt: null,
    triagedBy: null,
    triageOutcome: null,
    triageReason: null,
    promotedProposalId: null,
    promotedTaskId: null,
    ...over,
  };
}

describe("DEFAULT_ASSESSMENT_PROMPT", () => {
  it("names PM_TRIAGE_STATUS_PATH and all five decision kinds", () => {
    expect(DEFAULT_ASSESSMENT_PROMPT).toContain("PM_TRIAGE_STATUS_PATH");
    for (const kind of [
      "promote_standard",
      "promote_fast_track",
      "dismiss",
      "needs_human",
      "give_up",
    ]) {
      expect(DEFAULT_ASSESSMENT_PROMPT).toContain(kind);
    }
  });

  it("encodes the bias-to-reversible discipline", () => {
    // dismiss only on clear no-merit; ambiguity ⇒ needs_human; unsure size ⇒ standard.
    expect(DEFAULT_ASSESSMENT_PROMPT).toContain("NO MERIT");
    expect(DEFAULT_ASSESSMENT_PROMPT).toMatch(/ambiguity/i);
    expect(DEFAULT_ASSESSMENT_PROMPT).toContain("needs_human");
    expect(DEFAULT_ASSESSMENT_PROMPT).toContain("PREFER promote_standard");
  });

  it("encodes fast-track sizing (small/contained/no schema/cross-cutting + ≤3 breakdown)", () => {
    expect(DEFAULT_ASSESSMENT_PROMPT).toMatch(/self-contained/i);
    expect(DEFAULT_ASSESSMENT_PROMPT).toMatch(/schema/i);
    expect(DEFAULT_ASSESSMENT_PROMPT).toMatch(/cross-cutting/i);
    expect(DEFAULT_ASSESSMENT_PROMPT).toContain("at most 3");
  });

  it("encodes the proposal-gate (NEVER mint tasks directly)", () => {
    expect(DEFAULT_ASSESSMENT_PROMPT).toContain("NEVER mint tasks directly");
    expect(DEFAULT_ASSESSMENT_PROMPT).toMatch(/PROPOSAL/);
  });
});

describe("buildAssessmentPrompt", () => {
  it("substitutes the {note} fields and leaves no placeholder", () => {
    const note = mkNote({ title: "TITLE_MARKER", body: "BODY_MARKER", severity: "high" });
    const out = buildAssessmentPrompt(note);
    expect(out).toContain("TITLE_MARKER");
    expect(out).toContain("BODY_MARKER");
    expect(out).toContain("n-1");
    expect(out).toContain("high");
    expect(out).not.toContain("{note}");
  });

  it("renders a codeLocator when present", () => {
    const note = mkNote({ codeLocator: { path: "src/foo.ts", line: 42 } });
    const out = buildAssessmentPrompt(note);
    expect(out).toContain("src/foo.ts:42");
  });

  it("a custom template is preserved (replace-if-present)", () => {
    const out = buildAssessmentPrompt(mkNote(), "ONLY NOTE: {note}");
    expect(out.startsWith("ONLY NOTE: ")).toBe(true);
    expect(out).toContain("n-1");
    expect(out).not.toContain("{note}");
  });
});
