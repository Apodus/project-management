import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkRaiseRate,
  resetRaiseRateLimiter,
} from "../../src/services/escalation-rate-limit.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C4 §P4: the per-origin_worker_key raise rate-limiter — an
// in-memory sliding window mirroring the responder spawn-budget gate.
// DB-pure; `now` is injected for determinism. Env defaults: MAX=20,
// WINDOW=60s. We shrink the window via env for a tight test.
// ──────────────────────────────────────────────────────────────────

describe("escalation raise rate-limit", () => {
  const prevMax = process.env.ESCALATION_RAISE_MAX;
  const prevWindow = process.env.ESCALATION_RAISE_WINDOW_SEC;

  beforeEach(() => {
    resetRaiseRateLimiter();
    process.env.ESCALATION_RAISE_MAX = "3";
    process.env.ESCALATION_RAISE_WINDOW_SEC = "60";
  });

  afterEach(() => {
    resetRaiseRateLimiter();
    if (prevMax === undefined) delete process.env.ESCALATION_RAISE_MAX;
    else process.env.ESCALATION_RAISE_MAX = prevMax;
    if (prevWindow === undefined) delete process.env.ESCALATION_RAISE_WINDOW_SEC;
    else process.env.ESCALATION_RAISE_WINDOW_SEC = prevWindow;
  });

  it("admits up to MAX within the window, then limits the (MAX+1)th", () => {
    const t0 = 1_000_000;
    expect(checkRaiseRate("worker-a", t0)).toBe(true); // 1
    expect(checkRaiseRate("worker-a", t0 + 1)).toBe(true); // 2
    expect(checkRaiseRate("worker-a", t0 + 2)).toBe(true); // 3 (== MAX)
    expect(checkRaiseRate("worker-a", t0 + 3)).toBe(false); // 4th → limited
  });

  it("isolates windows per origin worker key", () => {
    const t0 = 2_000_000;
    expect(checkRaiseRate("worker-a", t0)).toBe(true);
    expect(checkRaiseRate("worker-a", t0 + 1)).toBe(true);
    expect(checkRaiseRate("worker-a", t0 + 2)).toBe(true);
    expect(checkRaiseRate("worker-a", t0 + 3)).toBe(false);
    // A different key has its own fresh budget.
    expect(checkRaiseRate("worker-b", t0 + 3)).toBe(true);
  });

  it("does NOT consume budget on a rejected raise (a later in-window raise still limited)", () => {
    const t0 = 3_000_000;
    checkRaiseRate("worker-a", t0);
    checkRaiseRate("worker-a", t0 + 1);
    checkRaiseRate("worker-a", t0 + 2);
    expect(checkRaiseRate("worker-a", t0 + 3)).toBe(false); // rejected, not recorded
    expect(checkRaiseRate("worker-a", t0 + 4)).toBe(false); // still 3 in window → limited
  });

  it("pruning lets a later raise through once the window slides", () => {
    const t0 = 4_000_000;
    checkRaiseRate("worker-a", t0);
    checkRaiseRate("worker-a", t0 + 1);
    checkRaiseRate("worker-a", t0 + 2);
    expect(checkRaiseRate("worker-a", t0 + 3)).toBe(false);
    // 61s later → all three earlier timestamps fall outside the 60s window.
    const later = t0 + 61_000;
    expect(checkRaiseRate("worker-a", later)).toBe(true);
  });

  it("resetRaiseRateLimiter clears all windows", () => {
    const t0 = 5_000_000;
    checkRaiseRate("worker-a", t0);
    checkRaiseRate("worker-a", t0 + 1);
    checkRaiseRate("worker-a", t0 + 2);
    expect(checkRaiseRate("worker-a", t0 + 3)).toBe(false);
    resetRaiseRateLimiter();
    expect(checkRaiseRate("worker-a", t0 + 4)).toBe(true);
  });
});
