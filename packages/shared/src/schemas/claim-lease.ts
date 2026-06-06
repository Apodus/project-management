import { z } from "zod";

// ─── Event ────────────────────────────────────────────────────────
// SSE event emitted when the reclaim sweep reclaims a lapsed claim lease.
export const CLAIM_LEASE_RECLAIMED_EVENT = "claim.lease.reclaimed" as const;

// ─── Enums ────────────────────────────────────────────────────────
// The entity a claim lease can be held against. Plain text in the DB
// (claim_leases.entityType), validated against this enum.
export const LEASE_ENTITY_TYPES = ["task", "epic", "proposal"] as const;
export type LeaseEntityType = (typeof LEASE_ENTITY_TYPES)[number];

// The computed liveness of a lease at read time: "live" while the holder
// is heartbeating within the TTL, "stale" once it has lapsed. Derived
// on-read (not stored) — the column set is the timestamps, the liveness is
// a function of expiresAt vs now.
export const LEASE_LIVENESS = ["live", "stale"] as const;
export type LeaseLiveness = (typeof LEASE_LIVENESS)[number];

// ─── View shapes ──────────────────────────────────────────────────
// Full GET response shape for a claim_leases row. Field names mirror the
// Drizzle TS property names (camelCase) from
// packages/server/src/db/schema.ts §claimLeases. holderId/sessionId are
// nullable (a deleted holder nulls holderId via ON DELETE SET NULL;
// sessionId is optional at claim time).
export const claimLeaseSchema = z.object({
  id: z.string(),
  entityType: z.enum(LEASE_ENTITY_TYPES),
  entityId: z.string(),
  holderId: z.string().nullable(),
  claimedAt: z.string(),
  heartbeatAt: z.string(),
  expiresAt: z.string(),
  lastActivityAt: z.string(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClaimLeaseView = z.infer<typeof claimLeaseSchema>;
