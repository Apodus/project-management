import { describe, it, expect } from "vitest";
import {
  MERGE_RESOLUTION_STATES,
  MERGE_ESCALATION_TARGETS,
  mergeResolutionSchema,
  mergeResolutionDetailSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-27T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────

describe("MERGE_RESOLUTION_STATES", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...MERGE_RESOLUTION_STATES]).toEqual([
      "pending",
      "resolving",
      "resolved",
      "escalated",
      "failed",
    ]);
  });

  it("starts with 'pending' (the DB column default)", () => {
    expect(MERGE_RESOLUTION_STATES[0]).toBe("pending");
  });
});

describe("MERGE_ESCALATION_TARGETS", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...MERGE_ESCALATION_TARGETS]).toEqual(["author", "human"]);
  });
});

// ─── mergeResolutionDetailSchema ──────────────────────────────────

describe("mergeResolutionDetailSchema", () => {
  it("accepts a full detail payload", () => {
    const body = {
      budgetConsumedSec: 120,
      tokensConsumed: 8000,
      verifyVerdict: "pass" as const,
      escalationReason: "budget exceeded",
      logUrl: "file:///tmp/resolver.log",
    };
    expect(mergeResolutionDetailSchema.parse(body)).toEqual(body);
  });

  it("accepts an empty detail (all fields optional)", () => {
    expect(mergeResolutionDetailSchema.parse({})).toEqual({});
  });

  it("accepts a fail verdict", () => {
    expect(
      mergeResolutionDetailSchema.parse({ verifyVerdict: "fail" }),
    ).toBeTruthy();
  });

  it("rejects an unknown verifyVerdict", () => {
    expect(() =>
      mergeResolutionDetailSchema.parse({ verifyVerdict: "maybe" }),
    ).toThrow();
  });

  it("rejects a non-number budgetConsumedSec", () => {
    expect(() =>
      mergeResolutionDetailSchema.parse({ budgetConsumedSec: "lots" }),
    ).toThrow();
  });
});

// ─── mergeResolutionSchema ────────────────────────────────────────

describe("mergeResolutionSchema", () => {
  const validResolution = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    resource: "main",
    originRequestId: VALID_ULID,
    resolvedRequestId: null,
    state: "pending" as const,
    conflictingFiles: ["src/foo.ts"],
    attemptStartedAt: null,
    attemptEndedAt: null,
    escalationTarget: null,
    detail: null,
    createdAt: VALID_TIMESTAMP,
    updatedAt: VALID_TIMESTAMP,
  };

  it("accepts a valid pending resolution", () => {
    expect(mergeResolutionSchema.parse(validResolution)).toEqual(
      validResolution,
    );
  });

  it("accepts a resolution with all nullable columns null", () => {
    const nulled = {
      ...validResolution,
      originRequestId: null,
      resolvedRequestId: null,
      conflictingFiles: null,
      attemptStartedAt: null,
      attemptEndedAt: null,
      escalationTarget: null,
      detail: null,
    };
    expect(mergeResolutionSchema.parse(nulled)).toBeTruthy();
  });

  it("accepts a resolved resolution with resolvedRequestId + detail populated", () => {
    const resolved = {
      ...validResolution,
      state: "resolved" as const,
      resolvedRequestId: VALID_ULID,
      attemptStartedAt: VALID_TIMESTAMP,
      attemptEndedAt: VALID_TIMESTAMP,
      detail: { verifyVerdict: "pass" as const, budgetConsumedSec: 90 },
    };
    expect(mergeResolutionSchema.parse(resolved)).toBeTruthy();
  });

  it("accepts an escalated resolution routed to author", () => {
    const escalated = {
      ...validResolution,
      state: "escalated" as const,
      escalationTarget: "author" as const,
      detail: { escalationReason: "could not reconcile" },
    };
    expect(mergeResolutionSchema.parse(escalated)).toBeTruthy();
  });

  it("accepts all valid states", () => {
    for (const state of MERGE_RESOLUTION_STATES) {
      expect(
        mergeResolutionSchema.parse({ ...validResolution, state }),
      ).toBeTruthy();
    }
  });

  it("accepts both escalation targets", () => {
    for (const escalationTarget of MERGE_ESCALATION_TARGETS) {
      expect(
        mergeResolutionSchema.parse({ ...validResolution, escalationTarget }),
      ).toBeTruthy();
    }
  });

  it("rejects an unknown state", () => {
    expect(() =>
      mergeResolutionSchema.parse({ ...validResolution, state: "done" }),
    ).toThrow();
  });

  it("rejects an unknown escalationTarget", () => {
    expect(() =>
      mergeResolutionSchema.parse({
        ...validResolution,
        escalationTarget: "robot",
      }),
    ).toThrow();
  });

  it("rejects a malformed detail (bad verifyVerdict)", () => {
    expect(() =>
      mergeResolutionSchema.parse({
        ...validResolution,
        detail: { verifyVerdict: "maybe" },
      }),
    ).toThrow();
  });

  it("rejects missing projectId", () => {
    const { projectId: _, ...r } = validResolution;
    expect(() => mergeResolutionSchema.parse(r)).toThrow();
  });
});
