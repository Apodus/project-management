import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError, DEFAULT_WAKE_PROMPT } from "../src/config.js";

const baseEnv = { PM_API_TOKEN: "tok" };

describe("loadConfig", () => {
  it("auto-derives a single watch entry from PM_WORKER_KEY", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_WORKER_KEY: "worker-1" });
    expect(cfg.watch).toEqual([{ workerKey: "worker-1", projectId: undefined }]);
    expect(cfg.token).toBe("tok");
  });

  it("scopes the auto watch entry by PM_PROJECT_ID when present", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_WORKER_KEY: "worker-1", PM_PROJECT_ID: "proj-9" });
    expect(cfg.watch).toEqual([{ workerKey: "worker-1", projectId: "proj-9" }]);
  });

  it("accepts repeatable --watch with optional :projectId, taking precedence over env key", () => {
    const cfg = loadConfig(
      { watch: ["wk-a", "wk-b:proj-b"] },
      { ...baseEnv, PM_WORKER_KEY: "ignored" },
    );
    expect(cfg.watch).toEqual([{ workerKey: "wk-a" }, { workerKey: "wk-b", projectId: "proj-b" }]);
  });

  it("is fatal (ConfigError) when the token is missing", () => {
    expect(() => loadConfig({}, { PM_WORKER_KEY: "worker-1" })).toThrow(ConfigError);
  });

  it("is fatal (ConfigError) when there is zero watch", () => {
    expect(() => loadConfig({}, { ...baseEnv })).toThrow(ConfigError);
  });

  it("applies the documented defaults", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_WORKER_KEY: "worker-1" });
    expect(cfg.pollIntervalSec).toBe(15);
    expect(cfg.timeBudgetSec).toBe(900);
    expect(cfg.maxConcurrentWakes).toBe(1);
    expect(cfg.minWakeIntervalSec).toBe(60);
    expect(cfg.maxConsecutiveFailures).toBe(5);
    expect(cfg.workerCommand).toBe("claude -p");
    expect(cfg.promptTemplate).toBe(DEFAULT_WAKE_PROMPT);
    expect(cfg.pmUrl).toBe("http://localhost:3000");
  });

  it("strips a trailing slash from the pm url", () => {
    const cfg = loadConfig({ pmUrl: "http://host:3000///" }, { ...baseEnv, PM_WORKER_KEY: "w" });
    expect(cfg.pmUrl).toBe("http://host:3000");
  });

  it("honors PM_WAKE_WORKER_COMMAND and PM_WAKE_PROMPT overrides", () => {
    const cfg = loadConfig(
      {},
      {
        ...baseEnv,
        PM_WORKER_KEY: "w",
        PM_WAKE_WORKER_COMMAND: "my-agent",
        PM_WAKE_PROMPT: "hi {messages}",
      },
    );
    expect(cfg.workerCommand).toBe("my-agent");
    expect(cfg.promptTemplate).toBe("hi {messages}");
  });
});
