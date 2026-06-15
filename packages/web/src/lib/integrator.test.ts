import { describe, expect, it } from "vitest";
import type { IntegratorConfig, Project } from "./api";
import {
  cacheConfigWarnings,
  integratorConfigFromProject,
  mergeIntegratorSettings,
} from "./integrator";

const DEFAULTS: IntegratorConfig = {
  enabled: false,
  verify_timeout_sec: 600,
  git_remote: "origin",
  git_main_branch: "main",
  parallelism: 1,
  linked_repos: [],
  clean_keep: [],
};

// A minimal Project-shaped wrapper for the extractor's `Pick<Project, "settings">`.
const withSettings = (settings: unknown): Pick<Project, "settings"> =>
  ({ settings }) as Pick<Project, "settings">;

describe("integratorConfigFromProject — defaulting", () => {
  it("applies schema defaults for undefined / empty settings / empty integrator", () => {
    expect(integratorConfigFromProject(undefined)).toEqual(DEFAULTS);
    expect(integratorConfigFromProject(withSettings({}))).toEqual(DEFAULTS);
    expect(integratorConfigFromProject(withSettings({ integrator: {} }))).toEqual(DEFAULTS);
  });

  it("does not fabricate optional keys when absent", () => {
    const config = integratorConfigFromProject(undefined);
    expect(config).not.toHaveProperty("verify_command");
    expect(config).not.toHaveProperty("worktree_root");
  });
});

describe("integratorConfigFromProject — read-through", () => {
  it("carries stored values and omits absent optionals", () => {
    const config = integratorConfigFromProject(
      withSettings({
        integrator: {
          parallelism: 4,
          clean_keep: ["dist"],
          git_main_branch: "master",
          linked_repos: [{ name: "rynx", path: "p", role: "inner" }],
        },
      }),
    );
    expect(config.parallelism).toBe(4);
    expect(config.clean_keep).toEqual(["dist"]);
    expect(config.git_main_branch).toBe("master");
    expect(config.linked_repos).toEqual([{ name: "rynx", path: "p", role: "inner" }]);
    // unset fields still fall back to defaults
    expect(config.git_remote).toBe("origin");
    expect(config.enabled).toBe(false);
    expect(config).not.toHaveProperty("verify_command");
    expect(config).not.toHaveProperty("worktree_root");
  });

  it("passes through optional verify_command / worktree_root when present", () => {
    const config = integratorConfigFromProject(
      withSettings({
        integrator: {
          verify_command: "pnpm verify",
          worktree_root: "/tmp/wt",
        },
      }),
    );
    expect(config.verify_command).toBe("pnpm verify");
    expect(config.worktree_root).toBe("/tmp/wt");
  });

  it("never surfaces deferred / non-config integrator fields", () => {
    const config = integratorConfigFromProject(
      withSettings({
        integrator: {
          enabled: true,
          resolver: { enabled: true, max_concurrent: 3 },
          verify_steps: [{ id: "a", command: "x" }],
          cache_mode: "shadow",
          slo: { time_to_land_p95_sec: 900 },
        },
      }),
    );
    expect(config.enabled).toBe(true);
    expect(config).not.toHaveProperty("resolver");
    expect(config).not.toHaveProperty("verify_steps");
    expect(config).not.toHaveProperty("cache_mode");
    expect(config).not.toHaveProperty("slo");
  });
});

describe("mergeIntegratorSettings — preservation (load-bearing)", () => {
  it("preserves every sibling block and every un-edited integrator sub-field", () => {
    const existing = {
      ai_autonomy: { level: "high" },
      workflow: { board: "kanban" },
      git: { default_branch: "main" },
      webhooks: { discord_url: "https://discord/x" },
      epic_categories: ["infra", "ux"],
      integrator: {
        resolver: { enabled: true, max_concurrent: 3 },
        verify_steps: [{ id: "a", command: "x" }],
        cache_mode: "shadow",
        slo: { time_to_land_p95_sec: 900 },
        worktree_name: "w",
        heartbeat_interval_sec: 45,
        parallelism: 1,
      },
    };
    const config: IntegratorConfig = {
      enabled: true,
      verify_timeout_sec: 600,
      git_remote: "origin",
      git_main_branch: "main",
      parallelism: 4,
      linked_repos: [],
      clean_keep: ["dist"],
    };

    const result = mergeIntegratorSettings(existing, config);
    const integrator = result.integrator as Record<string, unknown>;

    // Sibling settings blocks preserved byte-identical.
    expect(result.ai_autonomy).toEqual({ level: "high" });
    expect(result.workflow).toEqual({ board: "kanban" });
    expect(result.git).toEqual({ default_branch: "main" });
    expect(result.webhooks).toEqual({ discord_url: "https://discord/x" });
    expect(result.epic_categories).toEqual(["infra", "ux"]);

    // Deferred integrator sub-fields preserved byte-identical.
    expect(integrator.resolver).toEqual({ enabled: true, max_concurrent: 3 });
    expect(integrator.verify_steps).toEqual([{ id: "a", command: "x" }]);
    expect(integrator.cache_mode).toBe("shadow");
    expect(integrator.slo).toEqual({ time_to_land_p95_sec: 900 });
    expect(integrator.worktree_name).toBe("w");
    expect(integrator.heartbeat_interval_sec).toBe(45);

    // Config fields overlaid.
    expect(integrator.parallelism).toBe(4);
    expect(integrator.clean_keep).toEqual(["dist"]);
    expect(integrator.enabled).toBe(true);
  });

  it("seeds integrator block from empty / missing settings", () => {
    const result = mergeIntegratorSettings(undefined, DEFAULTS);
    expect(result.integrator).toEqual(DEFAULTS);
  });
});

// ── cacheConfigWarnings (C2 — web mirror of @pm/shared) ───────────

describe("cacheConfigWarnings", () => {
  it("warns ONLY when cache_enabled true AND cache_mode on AND a step lacks cache_key_inputs", () => {
    const warnings = cacheConfigWarnings({
      cache_enabled: true,
      cache_mode: "on",
      verify_steps: [{ id: "lint" }, { id: "test", cache_key_inputs: ["node -v"] }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"lint"');
    expect(warnings[0]).not.toContain('"test"');
    expect(warnings[0]).toContain("§16.2");
    expect(warnings[0]).toContain("shadow");
  });

  it("empty verify_steps → warns on the synthetic verify_command step", () => {
    const warnings = cacheConfigWarnings({
      cache_enabled: true,
      cache_mode: "on",
      verify_steps: [],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("synthetic verify_command step");
  });

  it("returns [] for shadow / off / kill-switch off / inputs declared / absent integrator", () => {
    const step = [{ id: "lint" }];
    expect(
      cacheConfigWarnings({ cache_enabled: true, cache_mode: "shadow", verify_steps: step }),
    ).toEqual([]);
    expect(
      cacheConfigWarnings({ cache_enabled: true, cache_mode: "off", verify_steps: step }),
    ).toEqual([]);
    expect(
      cacheConfigWarnings({ cache_enabled: false, cache_mode: "on", verify_steps: step }),
    ).toEqual([]);
    expect(
      cacheConfigWarnings({
        cache_enabled: true,
        cache_mode: "on",
        verify_steps: [{ id: "lint", cache_key_inputs: ["node -v"] }],
      }),
    ).toEqual([]);
    expect(cacheConfigWarnings(null)).toEqual([]);
    expect(cacheConfigWarnings(undefined)).toEqual([]);
  });
});
