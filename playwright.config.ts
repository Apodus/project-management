import { defineConfig, devices } from "@playwright/test";

const E2E_PORT = parseInt(process.env.E2E_PORT || "3099", 10);

export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "html",
  timeout: 30_000,
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
    command: `pnpm build && cross-env NODE_ENV=production PM_DB_PATH=./data/test-e2e.db PM_PORT=${E2E_PORT} node packages/server/dist/index.js`,
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
