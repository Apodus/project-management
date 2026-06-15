import { describe, it, expect } from "vitest";
import {
  LEASE_TTL_MS_DEFAULT,
  LEASE_GRACE_MS_DEFAULT,
  LEASE_PICK_MARGIN_MS_DEFAULT,
  LEASE_ENTITY_TYPES,
  LEASE_LIVENESS,
  CLAIM_LEASE_RECLAIMED_EVENT,
  AUDIT_ACTIONS,
  claimLeaseSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-30T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────
// (The lease engine has no off/shadow/on mode — it is always active; only the
// timing defaults below remain.)

describe("lease timing defaults", () => {
  it("TTL and grace are positive", () => {
    expect(LEASE_TTL_MS_DEFAULT).toBeGreaterThan(0);
    expect(LEASE_GRACE_MS_DEFAULT).toBeGreaterThan(0);
  });

  it("grace is at least the TTL (long grace before reclaim)", () => {
    expect(LEASE_GRACE_MS_DEFAULT).toBeGreaterThanOrEqual(LEASE_TTL_MS_DEFAULT);
  });

  it("the pick margin is positive (stricter-than-sweep pick takeover threshold)", () => {
    expect(LEASE_PICK_MARGIN_MS_DEFAULT).toBeGreaterThan(0);
  });
});

describe("CLAIM_LEASE_RECLAIMED_EVENT", () => {
  it("is the canonical event name", () => {
    expect(CLAIM_LEASE_RECLAIMED_EVENT).toBe("claim.lease.reclaimed");
  });
});

describe("AUDIT_ACTIONS", () => {
  it("includes the claim_reclaimed action", () => {
    expect(AUDIT_ACTIONS).toContain("claim_reclaimed");
  });
});

describe("LEASE_ENTITY_TYPES / LEASE_LIVENESS", () => {
  it("entity types are task/epic/proposal", () => {
    expect([...LEASE_ENTITY_TYPES]).toEqual(["task", "epic", "proposal"]);
  });

  it("liveness is live/stale", () => {
    expect([...LEASE_LIVENESS]).toEqual(["live", "stale"]);
  });
});

// ─── claimLeaseSchema ─────────────────────────────────────────────

describe("claimLeaseSchema", () => {
  const validRow = {
    id: VALID_ULID,
    entityType: "task" as const,
    entityId: VALID_ULID,
    holderId: null,
    claimedAt: VALID_TIMESTAMP,
    heartbeatAt: VALID_TIMESTAMP,
    expiresAt: VALID_TIMESTAMP,
    lastActivityAt: VALID_TIMESTAMP,
    sessionId: null,
    createdAt: VALID_TIMESTAMP,
    updatedAt: VALID_TIMESTAMP,
  };

  it("accepts a valid row with null holderId/sessionId", () => {
    expect(claimLeaseSchema.parse(validRow)).toEqual(validRow);
  });

  it("accepts a held lease with a holder and a session", () => {
    const held = { ...validRow, holderId: VALID_ULID, sessionId: "session-abc" };
    expect(claimLeaseSchema.parse(held)).toBeTruthy();
  });

  it("accepts every valid entity type", () => {
    for (const entityType of LEASE_ENTITY_TYPES) {
      expect(claimLeaseSchema.parse({ ...validRow, entityType })).toBeTruthy();
    }
  });

  it("rejects an unknown entity type", () => {
    expect(() => claimLeaseSchema.parse({ ...validRow, entityType: "milestone" })).toThrow();
  });
});
