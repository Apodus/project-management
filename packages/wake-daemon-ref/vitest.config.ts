import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unlike integrator-ref, the wake-daemon tests inject the WorkerRunner and a
    // stub fetchImpl — no real claude binary, no real PM server, no git I/O — so
    // there is no contention to serialize. The worker-runner suite spawns only a
    // trivial cross-platform `node -e` command. Default parallelism is fine.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
