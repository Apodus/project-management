import { describe, it, expect } from "vitest";
import { CLAIM_RESULT_STATUSES, claimResultSchema } from "../src/index.js";

describe("CLAIM_RESULT_STATUSES", () => {
  it("includes force_claimed", () => {
    expect(CLAIM_RESULT_STATUSES).toContain("force_claimed");
  });

  it("accepts a force_claimed result", () => {
    const result = { ok: true, status: "force_claimed" as const };
    expect(claimResultSchema.parse(result)).toEqual(result);
  });

  // Campaign C3 §P5b — request-takeover against a LIVE claim.
  it("includes notified_holder", () => {
    expect(CLAIM_RESULT_STATUSES).toContain("notified_holder");
  });

  it("accepts a notified_holder result", () => {
    const result = { ok: false, status: "notified_holder" as const };
    expect(claimResultSchema.parse(result)).toEqual(result);
  });
});
