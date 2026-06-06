import { describe, expect, it } from "vitest";
import { getInvalidationKeys } from "./use-sse";
import { trainKeys } from "./use-train";

describe("getInvalidationKeys — merge-train wiring", () => {
  it("invalidates trainKeys on train.* alert events", () => {
    expect(getInvalidationKeys("train.stuck")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("train.paused")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("train.integrator_unhealthy")).toEqual([
      trainKeys.all,
    ]);
    expect(getInvalidationKeys("train.abandon_rate_high")).toEqual([
      trainKeys.all,
    ]);
    expect(getInvalidationKeys("train.integration_stalled")).toEqual([
      trainKeys.all,
    ]);
  });

  it("invalidates trainKeys on audit.recorded (the audit query lives under trainKeys.all)", () => {
    expect(getInvalidationKeys("audit.recorded")).toEqual([trainKeys.all]);
  });

  it("invalidates trainKeys on merge.* lifecycle events (queue/in-flight moved)", () => {
    expect(getInvalidationKeys("merge.request.landed")).toEqual([
      trainKeys.all,
    ]);
    expect(getInvalidationKeys("merge.request.rejected")).toEqual([
      trainKeys.all,
    ]);
    expect(getInvalidationKeys("merge.group.landed")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("merge.batch.formed")).toEqual([trainKeys.all]);
  });

  it("leaves unrelated event prefixes untouched", () => {
    expect(getInvalidationKeys("unknown.thing")).toEqual([]);
  });

  // Campaign C3 §P5a — the stale-claim alert is a toast-only banner event (no
  // cache invalidation: the always-open useClaimsHealth poll owns the refresh,
  // the SSE frame just surfaces the banner). The "claim" prefix has no
  // invalidation map entry, so it correctly returns no keys.
  it("does not invalidate caches on claim.stale_alert (toast-only banner)", () => {
    expect(getInvalidationKeys("claim.stale_alert")).toEqual([]);
  });
});
