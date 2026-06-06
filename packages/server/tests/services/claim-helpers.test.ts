import { describe, expect, it } from "vitest";
import { CLAIM_STATES, LEASE_GRACE_MS_DEFAULT } from "@pm/shared";
import { deriveClaimState } from "../../src/services/claim-helpers.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C3 (liveness surfacing §P1): deriveClaimState — the pure,
// identity-masked liveness view of a claim derived from the C2 lease
// (deriveLiveness) + the caller. Truth table below.
//
// deriveClaimState reads only `lease.expiresAt` and threads the module
// default grace (24h) through deriveLiveness, so a "lapsed" lease here
// must be > expiresAt + grace before `now`.
// ──────────────────────────────────────────────────────────────────

describe("deriveClaimState", () => {
  const HOLDER = "user_holder";
  const CALLER = { id: "user_caller" };
  const SELF = { id: HOLDER };

  // A fixed clock + the two lease shapes relative to it.
  const NOW = new Date("2026-06-06T12:00:00.000Z");
  // live: expires in the future (well inside TTL).
  const liveLease = {
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
  // lapsed: expired AND past the 24h grace window.
  const lapsedLease = {
    expiresAt: new Date(
      NOW.getTime() - LEASE_GRACE_MS_DEFAULT - 60_000,
    ).toISOString(),
  };

  it("null/undefined holder → unclaimed", () => {
    expect(deriveClaimState(null, null, NOW, CALLER)).toBe("unclaimed");
    expect(deriveClaimState(undefined, liveLease, NOW, CALLER)).toBe("unclaimed");
  });

  it("caller IS holder + live lease → yours", () => {
    expect(deriveClaimState(HOLDER, liveLease, NOW, SELF)).toBe("yours");
  });

  it("caller IS holder + lapsed lease → yours (self-stale reads yours)", () => {
    expect(deriveClaimState(HOLDER, lapsedLease, NOW, SELF)).toBe("yours");
  });

  it("caller IS holder + null lease → yours", () => {
    expect(deriveClaimState(HOLDER, null, NOW, SELF)).toBe("yours");
  });

  it("other caller + live lease → live", () => {
    expect(deriveClaimState(HOLDER, liveLease, NOW, CALLER)).toBe("live");
  });

  it("other caller + lapsed lease → stale", () => {
    expect(deriveClaimState(HOLDER, lapsedLease, NOW, CALLER)).toBe("stale");
  });

  it("other caller + null lease → live (fail-safe-to-live)", () => {
    expect(deriveClaimState(HOLDER, null, NOW, CALLER)).toBe("live");
  });

  it("other caller + unparseable expiresAt → live (fail-safe-to-live)", () => {
    expect(
      deriveClaimState(HOLDER, { expiresAt: "not-a-date" }, NOW, CALLER),
    ).toBe("live");
  });

  it("no caller + holder → live/stale, never yours", () => {
    // caller-agnostic (e.g. awareness list): a held entity reads live or stale.
    expect(deriveClaimState(HOLDER, liveLease, NOW)).toBe("live");
    expect(deriveClaimState(HOLDER, liveLease, NOW, null)).toBe("live");
    expect(deriveClaimState(HOLDER, lapsedLease, NOW)).toBe("stale");
    expect(deriveClaimState(HOLDER, lapsedLease, NOW, null)).toBe("stale");
  });

  it("output is always a CLAIM_STATES member, never the holder id", () => {
    const cases: Array<ReturnType<typeof deriveClaimState>> = [
      deriveClaimState(null, null, NOW, CALLER),
      deriveClaimState(HOLDER, liveLease, NOW, SELF),
      deriveClaimState(HOLDER, lapsedLease, NOW, SELF),
      deriveClaimState(HOLDER, null, NOW, SELF),
      deriveClaimState(HOLDER, liveLease, NOW, CALLER),
      deriveClaimState(HOLDER, lapsedLease, NOW, CALLER),
      deriveClaimState(HOLDER, null, NOW, CALLER),
      deriveClaimState(HOLDER, { expiresAt: "x" }, NOW, CALLER),
      deriveClaimState(HOLDER, liveLease, NOW),
    ];
    for (const c of cases) {
      expect(CLAIM_STATES).toContain(c);
      expect(c).not.toBe(HOLDER);
    }
  });
});
