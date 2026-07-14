/**
 * Unit: `composeAbandonReason` — the count-level cause named on the lane lock's
 * `Last abandon:` when a batch drains with NO land (design-lock G, campaign:
 * integrator liveness legibility). Pure function → no git/harness needed.
 */
import { describe, expect, it } from "vitest";
import { composeAbandonReason } from "../src/batch.js";

describe("composeAbandonReason", () => {
  it("empty batch (nothing admitted, nothing rejected/requeued) → names the empty FIFO head", () => {
    expect(composeAbandonReason({ rejected: [], requeued: [] }, 0)).toBe(
      "batch drained with no land: no admittable request at the FIFO head (empty batch)",
    );
  });

  it("rejected>0 → names the rejected count", () => {
    expect(composeAbandonReason({ rejected: ["r1", "r2"], requeued: [] }, 2)).toBe(
      "batch drained with no land: 2 member(s) rejected at verify/conflict",
    );
  });

  it("requeued>0 (none rejected) → names the re-queued count", () => {
    expect(composeAbandonReason({ rejected: [], requeued: ["r1"] }, 1)).toBe(
      "batch drained with no land: 1 member(s) re-queued (drift/push-race), none landed",
    );
  });

  it("rejected takes precedence over requeued (a real rejection is named first)", () => {
    expect(composeAbandonReason({ rejected: ["r1"], requeued: ["r2"] }, 2)).toBe(
      "batch drained with no land: 1 member(s) rejected at verify/conflict",
    );
  });

  it("rejected-at-admit (member never pushed → admittedCount 0) is named a rejection, NOT empty", () => {
    // A conflict/lost-pickup at admit pushes to ctx.rejected but never grows
    // batch.members, so admittedCount can be 0 while rejected>0 — the ctx
    // accumulators are the authoritative record and must win over the empty msg.
    expect(composeAbandonReason({ rejected: ["r1"], requeued: [] }, 0)).toBe(
      "batch drained with no land: 1 member(s) rejected at verify/conflict",
    );
  });

  it("admitted but all invalidated, none landed/rejected/requeued → plain fallback", () => {
    expect(composeAbandonReason({ rejected: [], requeued: [] }, 3)).toBe(
      "batch drained with no land",
    );
  });
});
