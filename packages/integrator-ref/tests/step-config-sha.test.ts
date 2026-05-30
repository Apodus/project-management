/**
 * Phase 7.5 Step 6 — unit tests for the pure `stepConfigSha` (design §3.3).
 *
 * Test class 11: determinism + order-independence of cache_key_inputs + that the
 * command/inputs ARE part of the hash while depends_on/timeout_sec/id are NOT.
 *
 * fileParallelism:false is configured for this package.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { stepConfigSha } from "../src/step-config-sha.js";

describe("stepConfigSha (Phase 7.5 Step 6, §3.3)", () => {
  it("11a. is deterministic: same step → same hash", () => {
    const a = stepConfigSha({ command: "pnpm test", cache_key_inputs: ["node-22"] });
    const b = stepConfigSha({ command: "pnpm test", cache_key_inputs: ["node-22"] });
    expect(a).toBe(b);
    // 64 hex chars = sha256.
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("11b. cache_key_inputs order is IRRELEVANT (sorted before hashing)", () => {
    const a = stepConfigSha({ command: "c", cache_key_inputs: ["z", "a", "m"] });
    const b = stepConfigSha({ command: "c", cache_key_inputs: ["a", "m", "z"] });
    expect(a).toBe(b);
  });

  it("11c. a DIFFERENT command → a different hash", () => {
    const a = stepConfigSha({ command: "pnpm test" });
    const b = stepConfigSha({ command: "pnpm test -- --strict" });
    expect(a).not.toBe(b);
  });

  it("11d. a DIFFERENT cache_key_input → a different hash", () => {
    const a = stepConfigSha({ command: "c", cache_key_inputs: ["node-22.4.0"] });
    const b = stepConfigSha({ command: "c", cache_key_inputs: ["node-22.5.0"] });
    expect(a).not.toBe(b);
  });

  it("11e. depends_on / timeout_sec / id changes → the SAME hash (excluded)", () => {
    const base = stepConfigSha({ command: "c", cache_key_inputs: ["x"] });
    // The function's typed input only reads command + cache_key_inputs, but the
    // real VerifyStep carries id/depends_on/timeout_sec — assert that passing a
    // full step object hashes identically regardless of those extra fields.
    const withExtras = stepConfigSha({
      command: "c",
      cache_key_inputs: ["x"],
      // @ts-expect-error — extra VerifyStep fields are intentionally ignored.
      id: "lint",
      // @ts-expect-error — depends_on is excluded from the config hash by design (§3.3).
      depends_on: ["format", "typecheck"],
      // @ts-expect-error — timeout_sec is excluded from the config hash by design (§3.3).
      timeout_sec: 999,
    });
    expect(withExtras).toBe(base);
  });

  it("11f. absent cache_key_inputs == empty array", () => {
    const a = stepConfigSha({ command: "c" });
    const b = stepConfigSha({ command: "c", cache_key_inputs: [] });
    expect(a).toBe(b);
  });

  it("11g. matches the design §3.3 canonical-JSON byte recipe exactly", () => {
    const step = { command: "pnpm test", cache_key_inputs: ["b", "a"] };
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          command: "pnpm test",
          cache_key_inputs: ["a", "b"], // sorted ascending, fixed key order
        }),
      )
      .digest("hex");
    expect(stepConfigSha(step)).toBe(expected);
  });
});
