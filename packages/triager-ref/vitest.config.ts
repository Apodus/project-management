import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // P3's injection-sniffer / assessment-runner tests spawn REAL `node`
    // subprocess doubles (the sniff/assessment spawn lifecycle), so a loaded box
    // (concurrent agent sessions) can make a spawn slow. 60s mirrors the repo's
    // documented concurrent-agent-session CPU-load budget; pure-fake tests
    // (decide/loop/decision/prompt) finish instantly regardless.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
