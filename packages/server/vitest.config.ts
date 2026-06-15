import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    // This is a migration-heavy integration suite: many tests spin a full app
    // and run every migration on a fresh in-memory DB, sometimes several times
    // per test, plus real in-process train/responder orchestration. Under a
    // full-concurrency run (all files across workers) the CPU contention can
    // stretch an otherwise-sub-second seal past vitest's 5s default — the
    // documented responder-seal load flake. 20s gives generous headroom while
    // still failing a genuinely-hung test promptly. The heaviest arc seals keep
    // their explicit per-test 30s overrides.
    testTimeout: 20_000,
  },
});
