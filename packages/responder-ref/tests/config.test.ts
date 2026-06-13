import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

const baseEnv = { PM_API_TOKEN: "tok" };

describe("loadConfig", () => {
  it("derives a single project from PM_PROJECT_ID", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "proj-1" });
    expect(cfg.projectIds).toEqual(["proj-1"]);
    expect(cfg.token).toBe("tok");
  });

  it("accepts repeatable --project, taking precedence over env", () => {
    const cfg = loadConfig(
      { project: ["proj-a", "proj-b"] },
      { ...baseEnv, PM_PROJECT_ID: "ignored" },
    );
    expect(cfg.projectIds).toEqual(["proj-a", "proj-b"]);
  });

  it("is fatal (ConfigError) when the token is missing", () => {
    expect(() => loadConfig({}, { PM_PROJECT_ID: "proj-1" })).toThrow(ConfigError);
  });

  it("is fatal (ConfigError) when there is no project (watch-all rejected)", () => {
    expect(() => loadConfig({}, { ...baseEnv })).toThrow(ConfigError);
  });

  it("enabled defaults to false", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "proj-1" });
    expect(cfg.enabled).toBe(false);
  });

  it("PM_RESPONDER_ENABLED truthy turns enabled on; CLI --enabled overrides env", () => {
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_RESPONDER_ENABLED: "1" }).enabled,
    ).toBe(true);
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_RESPONDER_ENABLED: "true" }).enabled,
    ).toBe(true);
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_RESPONDER_ENABLED: "no" }).enabled,
    ).toBe(false);
    // CLI flag present ⇒ true even if env says off.
    expect(
      loadConfig(
        { enabled: true },
        { ...baseEnv, PM_PROJECT_ID: "p", PM_RESPONDER_ENABLED: "no" },
      ).enabled,
    ).toBe(true);
  });

  it("mode defaults to shadow", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" });
    expect(cfg.mode).toBe("shadow");
  });

  it("autoImplement.enabled defaults to false; PM_AUTO_IMPLEMENT_ENABLED truthy turns it on", () => {
    expect(loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" }).autoImplement).toEqual({
      enabled: false,
      verifyCmd: "",
    });
    expect(
      loadConfig(
        {},
        {
          ...baseEnv,
          PM_PROJECT_ID: "p",
          PM_AUTO_IMPLEMENT_ENABLED: "true",
          // P3: a repo url is required once auto_implement is enabled.
          PM_RESPONDER_GIT_REPO_URL: "https://example.com/repo.git",
        },
      ).autoImplement.enabled,
    ).toBe(true);
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_AUTO_IMPLEMENT_ENABLED: "no" })
        .autoImplement.enabled,
    ).toBe(false);
  });

  it("accepts off/shadow/on and honors CLI over env for mode", () => {
    expect(loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_RESPONDER_MODE: "on" }).mode).toBe(
      "on",
    );
    expect(loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_RESPONDER_MODE: "off" }).mode).toBe(
      "off",
    );
    expect(
      loadConfig({ mode: "off" }, { ...baseEnv, PM_PROJECT_ID: "p", PM_RESPONDER_MODE: "on" }).mode,
    ).toBe("off");
  });

  it("is fatal (ConfigError) on an invalid mode", () => {
    expect(() =>
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_RESPONDER_MODE: "bogus" }),
    ).toThrow(ConfigError);
  });

  it("applies the documented defaults", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" });
    expect(cfg.pollIntervalSec).toBe(15);
    expect(cfg.maxConcurrent).toBe(1);
    expect(cfg.spawnBudget).toEqual({ maxSpawns: 10, windowSec: 3600 });
    expect(cfg.timeBudgetSec).toBe(900);
    expect(cfg.tokenBudget).toBeUndefined();
    expect(cfg.pmUrl).toBe("http://localhost:3000");
    expect(cfg.logLevel).toBe("info");
    // P6a safety-seal defaults.
    expect(cfg.excludeOriginRepos).toEqual([]);
    expect(cfg.reclaimGraceSec).toBe(225); // max(120, floor(0.25 * 900))
    expect(cfg.maxReclaimAttempts).toBe(2);
  });

  it("P6a: parses PM_RESPONDER_EXCLUDE_ORIGIN_REPOS as a trimmed, non-empty CSV", () => {
    const cfg = loadConfig(
      {},
      {
        ...baseEnv,
        PM_PROJECT_ID: "p",
        PM_RESPONDER_EXCLUDE_ORIGIN_REPOS: " pm-repo , , client-repo ,",
      },
    );
    expect(cfg.excludeOriginRepos).toEqual(["pm-repo", "client-repo"]);
  });

  it("P6a: honors PM_RESPONDER_RECLAIM_GRACE_SEC and PM_RESPONDER_MAX_RECLAIM_ATTEMPTS overrides", () => {
    const cfg = loadConfig(
      {},
      {
        ...baseEnv,
        PM_PROJECT_ID: "p",
        PM_RESPONDER_RECLAIM_GRACE_SEC: "600",
        PM_RESPONDER_MAX_RECLAIM_ATTEMPTS: "5",
      },
    );
    expect(cfg.reclaimGraceSec).toBe(600);
    expect(cfg.maxReclaimAttempts).toBe(5);
  });

  it("autoImplement.verifyCmd defaults to '' and honors PM_AUTO_IMPLEMENT_VERIFY_CMD", () => {
    expect(loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" }).autoImplement.verifyCmd).toBe("");
    expect(
      loadConfig(
        {},
        { ...baseEnv, PM_PROJECT_ID: "p", PM_AUTO_IMPLEMENT_VERIFY_CMD: "pnpm test" },
      ).autoImplement.verifyCmd,
    ).toBe("pnpm test");
  });

  it("worktreeGit defaults: empty repoUrl, origin, main, [] when auto_implement disabled", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" });
    expect(cfg.worktreeGit).toEqual({
      repoUrl: "",
      remote: "origin",
      mainBranch: "main",
      cleanKeep: [],
    });
  });

  it("gitRepoUrl is REQUIRED iff auto_implement.enabled (ConfigError when enabled+missing)", () => {
    expect(() =>
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_AUTO_IMPLEMENT_ENABLED: "true" }),
    ).toThrow(ConfigError);
    // OK when enabled + a repo url is given.
    const cfg = loadConfig(
      {},
      {
        ...baseEnv,
        PM_PROJECT_ID: "p",
        PM_AUTO_IMPLEMENT_ENABLED: "true",
        PM_RESPONDER_GIT_REPO_URL: "https://example.com/repo.git",
      },
    );
    expect(cfg.worktreeGit.repoUrl).toBe("https://example.com/repo.git");
  });

  it("does NOT require gitRepoUrl when auto_implement is disabled", () => {
    expect(() =>
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_AUTO_IMPLEMENT_ENABLED: "false" }),
    ).not.toThrow();
  });

  it("honors worktree git remote/mainBranch/cleanKeep overrides", () => {
    const cfg = loadConfig(
      {},
      {
        ...baseEnv,
        PM_PROJECT_ID: "p",
        PM_RESPONDER_GIT_REMOTE: "upstream",
        PM_RESPONDER_GIT_MAIN_BRANCH: "trunk",
        PM_RESPONDER_GIT_CLEAN_KEEP: " node_modules , , dist ",
      },
    );
    expect(cfg.worktreeGit.remote).toBe("upstream");
    expect(cfg.worktreeGit.mainBranch).toBe("trunk");
    expect(cfg.worktreeGit.cleanKeep).toEqual(["node_modules", "dist"]);
  });

  it("strips a trailing slash from the pm url; CLI overrides env", () => {
    const cfg = loadConfig(
      { pmUrl: "http://host:3000///" },
      { ...baseEnv, PM_PROJECT_ID: "p", PM_API_URL: "http://ignored:9999" },
    );
    expect(cfg.pmUrl).toBe("http://host:3000");
  });
});
