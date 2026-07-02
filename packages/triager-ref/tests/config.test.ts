import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
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

  it("stores masterEnv VERBATIM (the raw string, NOT a parsed bool); resolveNotesTriage owns the parse", () => {
    // Truthy strings stay as-is — they are NOT coerced to `true` here.
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_NOTES_TRIAGE_ENABLED: "1" }).masterEnv,
    ).toBe("1");
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_NOTES_TRIAGE_ENABLED: "true" }).masterEnv,
    ).toBe("true");
    // A falsey string stays the string "no" (NOT coerced to false).
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_NOTES_TRIAGE_ENABLED: "no" }).masterEnv,
    ).toBe("no");
    // Unset ⇒ undefined (resolveNotesTriage treats undefined as master-allows).
    expect(loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" }).masterEnv).toBeUndefined();
  });

  it("there is NO separate `enabled` field — the master env is the single switch", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" }) as Record<string, unknown>;
    expect("enabled" in cfg).toBe(false);
  });

  it("applies the documented defaults", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" });
    expect(cfg.pollIntervalSec).toBe(15);
    expect(cfg.maxConcurrent).toBe(1);
    expect(cfg.spawnBudget).toEqual({ maxSpawns: 10, windowSec: 3600 });
    expect(cfg.timeBudgetSec).toBe(900);
    expect(cfg.command).toBe("claude -p");
    expect(cfg.logsDir).toBe(path.join(os.tmpdir(), "pm-triager-logs"));
    expect(cfg.pmUrl).toBe("http://localhost:3000");
    expect(cfg.logLevel).toBe("info");
  });

  it("poolSecret/workerKey are read + trimmed (shape only — unused in P2)", () => {
    const cfg = loadConfig(
      {},
      { ...baseEnv, PM_PROJECT_ID: "p", PM_POOL_SECRET: " sec ", PM_WORKER_KEY: " wk " },
    );
    expect(cfg.poolSecret).toBe("sec");
    expect(cfg.workerKey).toBe("wk");
    // Absent ⇒ undefined.
    const bare = loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" });
    expect(bare.poolSecret).toBeUndefined();
    expect(bare.workerKey).toBeUndefined();
  });

  it("PM_TRIAGE_* overrides parse via positiveInt; garbage falls back to the default", () => {
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_TRIAGE_POLL_INTERVAL_SEC: "30" })
        .pollIntervalSec,
    ).toBe(30);
    // CLI --poll-interval-sec takes precedence over the env.
    expect(
      loadConfig(
        { pollIntervalSec: "45" },
        { ...baseEnv, PM_PROJECT_ID: "p", PM_TRIAGE_POLL_INTERVAL_SEC: "30" },
      ).pollIntervalSec,
    ).toBe(45);
    // Garbage / non-positive ⇒ default.
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_TRIAGE_POLL_INTERVAL_SEC: "nope" })
        .pollIntervalSec,
    ).toBe(15);
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_TRIAGE_POLL_INTERVAL_SEC: "0" })
        .pollIntervalSec,
    ).toBe(15);
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_TRIAGE_TIME_BUDGET_SEC: "1200" })
        .timeBudgetSec,
    ).toBe(1200);
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_TRIAGE_TIME_BUDGET_SEC: "-5" })
        .timeBudgetSec,
    ).toBe(900);
  });

  it("honors PM_TRIAGE_COMMAND and PM_TRIAGE_LOGS_DIR overrides", () => {
    const cfg = loadConfig(
      {},
      {
        ...baseEnv,
        PM_PROJECT_ID: "p",
        PM_TRIAGE_COMMAND: "claude --headless",
        PM_TRIAGE_LOGS_DIR: "/var/log/triager",
      },
    );
    expect(cfg.command).toBe("claude --headless");
    expect(cfg.logsDir).toBe("/var/log/triager");
  });

  it("parses --project-repo <id>=<path> entries into projectRepos; defaults repoRef", () => {
    const cfg = loadConfig(
      { project: ["proj-a", "proj-b"], projectRepo: ["proj-a=/repos/a", "proj-b=/repos/b"] },
      { ...baseEnv },
    );
    expect(cfg.projectRepos.get("proj-a")).toBe("/repos/a");
    expect(cfg.projectRepos.get("proj-b")).toBe("/repos/b");
    expect(cfg.repoRef).toBe("origin/main");
  });

  it("reads the env single PM_TRIAGE_PROJECT_REPO; CLI wins on a duplicate id", () => {
    const cfg = loadConfig(
      { projectRepo: ["p=/cli/path"] },
      { ...baseEnv, PM_PROJECT_ID: "p", PM_TRIAGE_PROJECT_REPO: "p=/env/path" },
    );
    // CLI entry parsed after the env entry ⇒ CLI wins.
    expect(cfg.projectRepos.get("p")).toBe("/cli/path");
  });

  it("honors --repo-ref / PM_TRIAGE_REPO_REF (CLI wins); trims blanks to the default", () => {
    expect(
      loadConfig(
        { projectRepo: ["p=/r"], repoRef: "origin/release" },
        { ...baseEnv, PM_PROJECT_ID: "p" },
      ).repoRef,
    ).toBe("origin/release");
    expect(
      loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p", PM_TRIAGE_REPO_REF: "upstream/main" })
        .repoRef,
    ).toBe("upstream/main");
    // CLI precedence over env.
    expect(
      loadConfig(
        { repoRef: "origin/cli" },
        { ...baseEnv, PM_PROJECT_ID: "p", PM_TRIAGE_REPO_REF: "origin/env" },
      ).repoRef,
    ).toBe("origin/cli");
    // Whitespace-only ⇒ default.
    expect(loadConfig({ repoRef: "   " }, { ...baseEnv, PM_PROJECT_ID: "p" }).repoRef).toBe(
      "origin/main",
    );
  });

  it("a project with no configured repo is NOT a config error (it resolves needs_human later)", () => {
    const cfg = loadConfig({}, { ...baseEnv, PM_PROJECT_ID: "p" });
    expect(cfg.projectRepos.size).toBe(0);
  });

  it.each(["no-equals", "=only-path", "id=", "  =  "])(
    "is fatal (ConfigError) on a malformed --project-repo entry: %s",
    (entry) => {
      expect(() =>
        loadConfig({ projectRepo: [entry] }, { ...baseEnv, PM_PROJECT_ID: "p" }),
      ).toThrow(ConfigError);
    },
  );

  it("strips a trailing slash from the pm url; CLI overrides env", () => {
    const cfg = loadConfig(
      { pmUrl: "http://host:3000///" },
      { ...baseEnv, PM_PROJECT_ID: "p", PM_API_URL: "http://ignored:9999" },
    );
    expect(cfg.pmUrl).toBe("http://host:3000");
  });
});
