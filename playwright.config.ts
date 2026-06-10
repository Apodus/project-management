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
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm build && cross-env NODE_ENV=production PM_DB_PATH=${RUN_DB} PM_PORT=${E2E_PORT} node packages/server/dist/index.js`,
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
