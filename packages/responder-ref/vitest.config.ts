import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The responder tests inject a FakeClient + a stub fetchImpl — no real
    // claude binary (none is spawned until P2), no real PM server. There is no
    // contention to serialize; default parallelism is fine.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
