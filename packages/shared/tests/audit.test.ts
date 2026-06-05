import { describe, it, expect } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  auditLogSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-30T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────

describe("AUDIT_ACTIONS", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...AUDIT_ACTIONS]).toEqual([
      "pause",
      "resume",
      "force_release_lock",
      "force_land",
      "force_reject",
      "force_cancel",
      "land",
      "reject",
      "cancel",
      "force_claim",
    ]);
  });

  it("includes force_claim", () => {
    expect(AUDIT_ACTIONS).toContain("force_claim");
  });

  it("includes force_cancel (queued-state break-glass)", () => {
    expect(AUDIT_ACTIONS).toContain("force_cancel");
  });

  it("includes cancel (self-service integrating-cancel)", () => {
    expect(AUDIT_ACTIONS).toContain("cancel");
  });
});

describe("AUDIT_TARGET_TYPES", () => {
  it("contains exactly the canonical values in canonical order", () => {
    expect([...AUDIT_TARGET_TYPES]).toEqual([
      "merge_request",
      "merge_group",
      "merge_lock",
      "train",
      "task",
      "epic",
      "proposal",
    ]);
  });

  it("includes task/epic/proposal (force-claim targets)", () => {
    expect(AUDIT_TARGET_TYPES).toContain("task");
    expect(AUDIT_TARGET_TYPES).toContain("epic");
    expect(AUDIT_TARGET_TYPES).toContain("proposal");
  });
});

// ─── auditLogSchema ───────────────────────────────────────────────

describe("auditLogSchema", () => {
  const validRow = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    actorId: VALID_ULID,
    action: "force_land" as const,
    targetType: "merge_request" as const,
    targetId: VALID_ULID,
    reason: "hotfix for prod outage; verify infra down",
    metadataBefore: { status: "integrating", landedSha: null },
    metadataAfter: { status: "landed", landedSha: "abc123", overridden: true },
    createdAt: VALID_TIMESTAMP,
  };

  it("accepts a valid force_land row", () => {
    expect(auditLogSchema.parse(validRow)).toEqual(validRow);
  });

  it("accepts a natural land row with null reason + null metadata", () => {
    const natural = {
      ...validRow,
      action: "land" as const,
      reason: null,
      metadataBefore: null,
      metadataAfter: null,
    };
    expect(auditLogSchema.parse(natural)).toBeTruthy();
  });

  it("accepts every action against a train target", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(
        auditLogSchema.parse({
          ...validRow,
          action,
          targetType: "train",
          targetId: "main",
        }),
      ).toBeTruthy();
    }
  });

  it("accepts every target type", () => {
    for (const targetType of AUDIT_TARGET_TYPES) {
      expect(
        auditLogSchema.parse({ ...validRow, targetType }),
      ).toBeTruthy();
    }
  });

  it("rejects an unknown action", () => {
    expect(() =>
      auditLogSchema.parse({ ...validRow, action: "delete" }),
    ).toThrow();
  });

  it("rejects an unknown target type", () => {
    expect(() =>
      auditLogSchema.parse({ ...validRow, targetType: "comment" }),
    ).toThrow();
  });

  it("accepts a force_claim/task row", () => {
    const forceClaimRow = {
      ...validRow,
      action: "force_claim" as const,
      targetType: "task" as const,
      reason: "my session identity flipped",
      metadataBefore: { assignee_id: VALID_ULID },
      metadataAfter: { assignee_id: VALID_ULID },
    };
    expect(auditLogSchema.parse(forceClaimRow)).toEqual(forceClaimRow);
  });

  it("rejects a missing projectId", () => {
    const { projectId: _omit, ...row } = validRow;
    expect(() => auditLogSchema.parse(row)).toThrow();
  });

  it("rejects a missing actorId", () => {
    const { actorId: _omit, ...row } = validRow;
    expect(() => auditLogSchema.parse(row)).toThrow();
  });
});
