import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The git-ops, worktree, loop, and integration suites all perform real
    // git I/O (clone/fetch/rebase/push against temp bare repos) and the
    // integration suite additionally spawns a PM server + a child integrator
    // process. Running these files in parallel — especially under the
    // monorepo-wide `pnpm test` where every package's suite executes at once —
    // starves them of CPU/disk and trips their timeouts. They are correct in
    // isolation; the contention is purely a scheduling artifact. Run test
    // files sequentially so the heavy real-I/O tests don't race each other.
    fileParallelism: false,
    // Generous default per-test timeout for the real-git operations.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
