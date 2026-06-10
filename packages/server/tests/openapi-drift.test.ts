// Drift-guard for the committed OpenAPI spec (packages/server/openapi.json),
// which the web package's `generate:api` consumes. This test regenerates the
// spec in-memory from the live routes and compares it against the committed
// file. Both tiers are intentional and must NOT be "simplified" away:
//   - Tier 1 (parsed equality) gives a human-legible property-path diff for
//     diagnosing WHAT drifted.
//   - Tier 2 (byte-exact string compare) is the formatting seal — it also
//     catches pure formatting drift that parsed equality would miss.
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp, type TestApp } from "./utils.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("OpenAPI spec drift-guard", () => {
  let testApp: TestApp;

  afterEach(() => {
    testApp.cleanup();
  });

  it("committed openapi.json matches the spec generated from the live routes", async () => {
    // Resolve the committed file cwd-independently.
    const here = dirname(fileURLToPath(import.meta.url));
    const committedPath = resolve(here, "../openapi.json");
    const committed = readFileSync(committedPath, "utf-8");

    testApp = createTestApp();
    const res = await testApp.app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const spec = await res.json();
    const generated = JSON.stringify(spec, null, 2); // mirrors scripts/export-openapi.ts EXACTLY — no trailing newline

    try {
      // Tier 1: parsed equality — human-legible property-path diff on failure.
      expect(spec).toEqual(JSON.parse(committed));
      // Tier 2: byte-exact seal — catches pure formatting drift too.
      expect(generated).toBe(committed);
    } catch (err) {
      throw new Error(
        "openapi.json is out of sync with the server routes. " +
          "Run `pnpm --filter @pm/server openapi:export` and commit the result.\n\n" +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  });
});
