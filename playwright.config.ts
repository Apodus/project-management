import { defineConfig, devices } from "@playwright/test";

const E2E_PORT = parseInt(process.env.E2E_PORT || "3099", 10);

// Per-run DB path: each `pnpm test:e2e` invocation gets its own fresh SQLite
// file. This config module loads in the same main process that runs
// globalSetup, so the path computed here is visible to global-setup via
// process.env.PM_E2E_RUN_DB. A unique path per run eliminates the Windows
// zombie-handle stale-data cascade by construction (we never reuse a file a
// dead prior server may still hold a lock on).
const RUN_DB = `./data/test-e2e-${Date.now()}.db`;
process.env.PM_E2E_RUN_DB = RUN_DB;

export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "html",
  // 60s test budget: this box runs concurrent agent sessions whose CPU spikes
  // can slow a full SPA load past the Playwright 30s default. Assertions still
  // resolve as fast as the app does — this only caps the worst case; a broken
  // app still fails (just later).
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    // The first-run wizard test (spec 01) can only run against a fresh DB and is
    // the sole seeder of the admin account every other spec logs in as. Modeling
    // it as a setup dependency makes that ordering tooling-enforced instead of
    // relying on filename order — running any single spec (e.g. `playwright test
    // 05`) auto-runs setup first, so 02-09 are no longer order-dependent.
    {
      name: "setup",
      testMatch: /01-setup-and-login\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: /01-setup-and-login\.spec\.ts/,
    },
  ],
  webServer: {
    // PM_LEASE_TTL_SEC=1 PM_LEASE_GRACE_SEC=1 (Campaign C3 claims-surface E2E):
    // lets spec 07 drive a claim to STALE inside a test budget. Verified safe:
    // specs 01-06 contain zero claim calls; "yours" derives before liveness so a
    // self-held claim never reads stale; request-takeover auto-grants on a stale
    // claim. The claims read paths (the panel + its poll) never sweep, so the
    // always-on reclaim engine never clears the seeded stale claim out from under
    // the assertions. NOTE: claims-health (the alert aggregate) pins the 24h
    // default grace and intentionally diverges — 07 never asserts stale COUNTS,
    // only per-row claim_state.
    command: `pnpm build && cross-env NODE_ENV=production PM_DB_PATH=${RUN_DB} PM_PORT=${E2E_PORT} PM_LEASE_TTL_SEC=1 PM_LEASE_GRACE_SEC=1 node packages/server/dist/index.js`,
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
