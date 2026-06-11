/**
 * C2 (failure legibility): releaseLock-failure surfacing.
 *
 * Covers the two halves of the channel on the integrator side:
 *   1. `makeLaneLockReleaser` — the shared lane-lock releaser: once-guard,
 *      cleanup-before-release, laneHealth SET on a failed release / CLEARED on
 *      a later successful one, never throws.
 *   2. `buildHeartbeat` — carries `last_release_failure` when a laneHealth
 *      state is provided (value or explicit null) and OMITS the key entirely
 *      when absent (old payload shapes stay byte-identical — see the exact
 *      toEqual in batch.test.ts).
 */
import { describe, expect, it } from "vitest";
import { makeLaneLockReleaser } from "../src/batch.js";
import { buildHeartbeat, type LaneHealthState } from "../src/heartbeat.js";
import { createLogger } from "../src/logger.js";
import type { PmClient } from "../src/pm-client.js";

const logger = createLogger("silent");

function releasingClient(behavior: ("ok" | "fail")[]): {
  client: Pick<PmClient, "releaseLock">;
  calls: number[];
} {
  let i = 0;
  const calls: number[] = [];
  return {
    calls,
    client: {
      releaseLock: async () => {
        calls.push(i);
        const mode = behavior[Math.min(i, behavior.length - 1)];
        i += 1;
        if (mode === "fail") throw new Error("HTTP 500: lock release exploded");
        return { ok: true } as never;
      },
    } as Pick<PmClient, "releaseLock">,
  };
}

describe("makeLaneLockReleaser (C2)", () => {
  it("failed release → laneHealth.lastReleaseFailure SET with the error message; never throws", async () => {
    const laneHealth: LaneHealthState = { lastReleaseFailure: null };
    const { client } = releasingClient(["fail"]);
    const release = makeLaneLockReleaser({
      pmClient: client,
      logger,
      projectId: "proj-1",
      resource: "main",
      laneHealth,
    });

    await expect(release({ reason: "drained" })).resolves.toBeUndefined();
    expect(laneHealth.lastReleaseFailure).not.toBeNull();
    expect(laneHealth.lastReleaseFailure!.message).toContain(
      "lock release exploded",
    );
    // `at` is a parseable ISO timestamp.
    expect(Number.isNaN(Date.parse(laneHealth.lastReleaseFailure!.at))).toBe(
      false,
    );
  });

  it("successful release → laneHealth CLEARED (a prior failure heals)", async () => {
    const laneHealth: LaneHealthState = {
      lastReleaseFailure: { at: "2026-06-10T00:00:00.000Z", message: "old" },
    };
    const { client } = releasingClient(["ok"]);
    const release = makeLaneLockReleaser({
      pmClient: client,
      logger,
      projectId: "proj-1",
      resource: "main",
      laneHealth,
    });

    await release({ landedSha: "abc" });
    expect(laneHealth.lastReleaseFailure).toBeNull();
  });

  it("once-guard: a second call is a no-op (no second releaseLock POST, cleanup runs once)", async () => {
    const laneHealth: LaneHealthState = { lastReleaseFailure: null };
    const { client, calls } = releasingClient(["ok"]);
    let cleanups = 0;
    const release = makeLaneLockReleaser({
      pmClient: client,
      logger,
      projectId: "proj-1",
      resource: "main",
      laneHealth,
      cleanup: () => {
        cleanups += 1;
      },
    });

    await release({ reason: "first" });
    await release({ reason: "second" });
    expect(calls).toHaveLength(1);
    expect(cleanups).toBe(1);
  });

  it("absent laneHealth (tests / old wiring) → still releases and never throws on failure", async () => {
    const { client } = releasingClient(["fail"]);
    const release = makeLaneLockReleaser({
      pmClient: client,
      logger,
      projectId: "proj-1",
      resource: "main",
    });
    await expect(release({ reason: "x" })).resolves.toBeUndefined();
  });
});

describe("buildHeartbeat last_release_failure (C2)", () => {
  const base = {
    resource: "main",
    pool: { size: 2, leasedCount: 0 },
    inFlight: { requests: 0, batches: 0, groups: 0 },
    version: "1.2.3",
  };

  it("no laneHealth arg → key OMITTED entirely (old payload byte-identical)", () => {
    const hb = buildHeartbeat(base);
    expect("last_release_failure" in hb).toBe(false);
    expect(hb).toEqual({
      resource: "main",
      status: "idle",
      pool_utilization: { size: 2, leased: 0 },
      in_flight: { requests: 0, batches: 0, groups: 0 },
      version: "1.2.3",
    });
  });

  it("laneHealth with a failure → carried on the wire", () => {
    const hb = buildHeartbeat({
      ...base,
      laneHealth: {
        lastReleaseFailure: {
          at: "2026-06-10T12:00:00.000Z",
          message: "HTTP 500",
        },
      },
    });
    expect(hb.last_release_failure).toEqual({
      at: "2026-06-10T12:00:00.000Z",
      message: "HTTP 500",
    });
  });

  it("laneHealth with null → EXPLICIT null on the wire (the PM clear signal)", () => {
    const hb = buildHeartbeat({
      ...base,
      laneHealth: { lastReleaseFailure: null },
    });
    expect("last_release_failure" in hb).toBe(true);
    expect(hb.last_release_failure).toBeNull();
  });
});
