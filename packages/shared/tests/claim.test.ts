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
});
