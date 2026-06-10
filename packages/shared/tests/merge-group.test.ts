import { describe, it, expect } from "vitest";
import {
  MERGE_GROUP_STATES,
  mergeRequestGroupSchema,
  createMergeGroupSchema,
  mergeGroupMemberSpecSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-27T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────

describe("MERGE_GROUP_STATES", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...MERGE_GROUP_STATES]).toEqual([
      "forming",
      "integrating",
      "landed",
      "rejected",
      "partially_landed",
    ]);
  });

  it("starts with 'forming' (the DB column default)", () => {
    expect(MERGE_GROUP_STATES[0]).toBe("forming");
  });
});

// ─── mergeRequestGroupSchema ──────────────────────────────────────

describe("mergeRequestGroupSchema", () => {
  const validGroup = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    resource: "main",
    state: "forming" as const,
    submittedBy: VALID_ULID,
    integratorId: null,
    resolvedAt: null,
    resolutionReason: null,
    createdAt: VALID_TIMESTAMP,
    updatedAt: VALID_TIMESTAMP,
  };

  it("accepts a valid forming group with nullable fields null", () => {
    expect(mergeRequestGroupSchema.parse(validGroup)).toEqual(validGroup);
  });

  it("accepts a landed group with integratorId + resolvedAt set", () => {
    const landed = {
      ...validGroup,
      state: "landed" as const,
      integratorId: VALID_ULID,
      resolvedAt: VALID_TIMESTAMP,
    };
    expect(mergeRequestGroupSchema.parse(landed)).toBeTruthy();
  });

  it("accepts a partially_landed group with resolutionReason set", () => {
    const partial = {
      ...validGroup,
      state: "partially_landed" as const,
      integratorId: VALID_ULID,
      resolvedAt: VALID_TIMESTAMP,
      resolutionReason: "outer push failed; inner orphaned",
    };
    expect(mergeRequestGroupSchema.parse(partial)).toBeTruthy();
  });

  it("accepts all valid states", () => {
    for (const state of MERGE_GROUP_STATES) {
      expect(mergeRequestGroupSchema.parse({ ...validGroup, state })).toBeTruthy();
    }
  });

  it("rejects unknown state", () => {
    expect(() => mergeRequestGroupSchema.parse({ ...validGroup, state: "in_progress" })).toThrow();
  });

  it("rejects missing projectId", () => {
    const { projectId: _, ...g } = validGroup;
    expect(() => mergeRequestGroupSchema.parse(g)).toThrow();
  });

  it("rejects missing submittedBy", () => {
    const { submittedBy: _, ...g } = validGroup;
    expect(() => mergeRequestGroupSchema.parse(g)).toThrow();
  });
});

// ─── createMergeGroupSchema ───────────────────────────────────────

describe("createMergeGroupSchema", () => {
  it("defaults resource to 'main'", () => {
    const parsed = createMergeGroupSchema.parse({
      memberRequestIds: [VALID_ULID, VALID_ULID],
    });
    expect(parsed.resource).toBe("main");
  });

  it("accepts a resource override", () => {
    const parsed = createMergeGroupSchema.parse({
      resource: "release-x",
      memberRequestIds: [VALID_ULID, VALID_ULID],
    });
    expect(parsed.resource).toBe("release-x");
  });

  it("accepts a fully-populated body", () => {
    const body = {
      resource: "main",
      memberRequestIds: [VALID_ULID, VALID_ULID, VALID_ULID],
    };
    expect(createMergeGroupSchema.parse(body)).toEqual(body);
  });

  it("rejects fewer than 2 memberRequestIds", () => {
    expect(() => createMergeGroupSchema.parse({ memberRequestIds: [VALID_ULID] })).toThrow();
  });

  it("rejects empty memberRequestIds", () => {
    expect(() => createMergeGroupSchema.parse({ memberRequestIds: [] })).toThrow();
  });

  it("rejects an empty-string member id", () => {
    expect(() => createMergeGroupSchema.parse({ memberRequestIds: [VALID_ULID, ""] })).toThrow();
  });

  it("rejects empty-string resource", () => {
    expect(() =>
      createMergeGroupSchema.parse({
        resource: "",
        memberRequestIds: [VALID_ULID, VALID_ULID],
      }),
    ).toThrow();
  });

  // ── Exactly-one-of: ids arm vs members arm ──────────────────────────
  const validSpec = { branch: "feat/inner" };
  const validSpec2 = { commitSha: "abc1234" };

  it("accepts a members-only body (atomic submit-and-group arm)", () => {
    const parsed = createMergeGroupSchema.parse({
      members: [validSpec, validSpec2],
    });
    expect(parsed.members).toHaveLength(2);
    expect(parsed.resource).toBe("main");
    expect(parsed.memberRequestIds).toBeUndefined();
  });

  it("accepts an ids-only body (back-compat arm)", () => {
    const parsed = createMergeGroupSchema.parse({
      memberRequestIds: [VALID_ULID, VALID_ULID],
    });
    expect(parsed.memberRequestIds).toHaveLength(2);
    expect(parsed.members).toBeUndefined();
  });

  it("REJECTS a body with BOTH memberRequestIds and members", () => {
    expect(() =>
      createMergeGroupSchema.parse({
        memberRequestIds: [VALID_ULID, VALID_ULID],
        members: [validSpec, validSpec2],
      }),
    ).toThrow(/exactly one/i);
  });

  it("REJECTS a body with NEITHER memberRequestIds nor members", () => {
    expect(() => createMergeGroupSchema.parse({ resource: "main" })).toThrow(/exactly one/i);
  });

  it("rejects a member spec with no branch and no commitSha", () => {
    expect(() =>
      createMergeGroupSchema.parse({
        members: [validSpec, { verifyCmd: "pnpm test" }],
      }),
    ).toThrow();
  });

  it("rejects fewer than 2 members", () => {
    expect(() => createMergeGroupSchema.parse({ members: [validSpec] })).toThrow();
  });

  // ── Inner-only form: synthesizeOuter (campaign 2026-06-10) ──────────
  it("accepts exactly ONE member spec with synthesizeOuter: true (inner-only form)", () => {
    const parsed = createMergeGroupSchema.parse({
      members: [validSpec],
      synthesizeOuter: true,
    });
    expect(parsed.members).toHaveLength(1);
    expect(parsed.synthesizeOuter).toBe(true);
  });

  it("REJECTS one member spec without the flag (no accidental semantics change)", () => {
    expect(() => createMergeGroupSchema.parse({ members: [validSpec] })).toThrow(
      /at least 2 member specs/,
    );
  });

  it("REJECTS one member spec with an EXPLICIT synthesizeOuter: false (strict === true)", () => {
    expect(() =>
      createMergeGroupSchema.parse({
        members: [validSpec],
        synthesizeOuter: false,
      }),
    ).toThrow(/at least 2 member specs/);
  });

  it("REJECTS synthesizeOuter: true with 2 member specs", () => {
    expect(() =>
      createMergeGroupSchema.parse({
        members: [validSpec, validSpec2],
        synthesizeOuter: true,
      }),
    ).toThrow(/exactly one member spec/);
  });

  it("REJECTS synthesizeOuter: true combined with memberRequestIds", () => {
    expect(() =>
      createMergeGroupSchema.parse({
        memberRequestIds: [VALID_ULID, VALID_ULID],
        synthesizeOuter: true,
      }),
    ).toThrow(/cannot be combined with memberRequestIds/);
  });

  it("REJECTS synthesizeOuter: true with a spec missing branch+commitSha", () => {
    expect(() =>
      createMergeGroupSchema.parse({
        members: [{ verifyCmd: "x" }],
        synthesizeOuter: true,
      }),
    ).toThrow(/branch \/ commitSha/);
  });

  it("accepts synthesizeOuter: false with >=2 members (behaves like absent)", () => {
    const parsed = createMergeGroupSchema.parse({
      members: [validSpec, validSpec2],
      synthesizeOuter: false,
    });
    expect(parsed.members).toHaveLength(2);
    expect(parsed.synthesizeOuter).toBe(false);
  });
});

// ─── mergeGroupMemberSpecSchema ───────────────────────────────────

describe("mergeGroupMemberSpecSchema", () => {
  it("accepts a branch-only spec", () => {
    expect(mergeGroupMemberSpecSchema.parse({ branch: "feat/x" })).toEqual({
      branch: "feat/x",
    });
  });

  it("accepts a commitSha-only spec", () => {
    expect(mergeGroupMemberSpecSchema.parse({ commitSha: "deadbee" })).toEqual({
      commitSha: "deadbee",
    });
  });

  it("accepts a fully-populated spec (camelCase fields)", () => {
    const spec = {
      branch: "feat/x",
      commitSha: "deadbee",
      verifyCmd: "pnpm test",
      taskId: VALID_ULID,
    };
    expect(mergeGroupMemberSpecSchema.parse(spec)).toEqual(spec);
  });

  it("rejects a spec with neither branch nor commitSha", () => {
    expect(() => mergeGroupMemberSpecSchema.parse({ verifyCmd: "pnpm test" })).toThrow(
      /branch \/ commitSha/,
    );
  });

  it("rejects an empty spec", () => {
    expect(() => mergeGroupMemberSpecSchema.parse({})).toThrow();
  });
});
