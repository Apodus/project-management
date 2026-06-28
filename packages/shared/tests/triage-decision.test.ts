import { describe, it, expect } from "vitest";
import {
  TRIAGE_DECISION_KINDS,
  NOTES_TRIAGE_MODES,
  triageDecisionSchema,
  createTriageDecisionSchema,
  listTriageDecisionsSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-06-28T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────

describe("triage decision enums", () => {
  it("TRIAGE_DECISION_KINDS is the canonical ordered tuple", () => {
    expect([...TRIAGE_DECISION_KINDS]).toEqual([
      "promote_standard",
      "promote_fast_track",
      "dismiss",
      "needs_human",
      "give_up",
    ]);
  });
});

// ─── createTriageDecisionSchema ───────────────────────────────────

describe("createTriageDecisionSchema", () => {
  it("accepts the minimal {noteId, mode, decision}", () => {
    const minimal = { noteId: VALID_ULID, mode: "shadow" as const, decision: "dismiss" as const };
    expect(createTriageDecisionSchema.parse(minimal)).toEqual(minimal);
  });

  it("accepts the optional nullable fields", () => {
    const full = {
      noteId: VALID_ULID,
      mode: "on" as const,
      decision: "promote_standard" as const,
      rationale: "duplicate of an open note",
      confidence: 0.82,
      resultingProposalId: VALID_ULID,
      resultingTaskId: null,
    };
    expect(createTriageDecisionSchema.parse(full)).toEqual(full);
  });

  it("rejects an unknown decision kind", () => {
    expect(() =>
      createTriageDecisionSchema.parse({ noteId: VALID_ULID, mode: "shadow", decision: "promote" }),
    ).toThrow();
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      createTriageDecisionSchema.parse({ noteId: VALID_ULID, mode: "auto", decision: "dismiss" }),
    ).toThrow();
  });
});

// ─── triageDecisionSchema (view shape) ────────────────────────────

describe("triageDecisionSchema", () => {
  const validRow = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    noteId: VALID_ULID,
    mode: "on" as const,
    decision: "promote_fast_track" as const,
    rationale: "high-severity bug",
    confidence: 0.95,
    resultingProposalId: VALID_ULID,
    resultingTaskId: null,
    actorId: VALID_ULID,
    createdAt: VALID_TIMESTAMP,
  };

  it("round-trips a full row", () => {
    expect(triageDecisionSchema.parse(validRow)).toEqual(validRow);
  });

  it("round-trips a row with null rationale/confidence (a shadow/give_up row)", () => {
    const nulled = {
      ...validRow,
      mode: "shadow" as const,
      decision: "give_up" as const,
      rationale: null,
      confidence: null,
      resultingProposalId: null,
      resultingTaskId: null,
    };
    expect(triageDecisionSchema.parse(nulled)).toEqual(nulled);
  });
});

// ─── listTriageDecisionsSchema ────────────────────────────────────

describe("listTriageDecisionsSchema", () => {
  it("accepts an empty filter", () => {
    expect(listTriageDecisionsSchema.parse({})).toEqual({});
  });

  it("accepts mode/decision/since filters", () => {
    const filters = {
      mode: "shadow" as const,
      decision: "dismiss" as const,
      since: VALID_TIMESTAMP,
    };
    expect(listTriageDecisionsSchema.parse(filters)).toEqual(filters);
  });

  it("mode reuses NOTES_TRIAGE_MODES (no second mode enum)", () => {
    expect([...NOTES_TRIAGE_MODES]).toEqual(["off", "shadow", "on"]);
  });
});
