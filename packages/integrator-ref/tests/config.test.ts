import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import type { ProjectDetail } from "../src/pm-client.js";

function stubClient(project: ProjectDetail): { getProject: (id: string) => Promise<ProjectDetail> } {
  return { getProject: async () => project };
}

const enabledProject: ProjectDetail = {
  id: "p1",
  name: "P1",
  slug: "p1",
  status: "active",
  gitRepoUrl: "https://github.com/test/repo.git",
  settings: {
    integrator: {
      enabled: true,
      verify_command: "pnpm test",
      worktree_root: "/tmp/wt",
    },
  },
};

describe("loadConfig", () => {
  it("returns full config with defaults applied", async () => {
    const config = await loadConfig(
      { project: "p1" },
      { PM_API_TOKEN: "t" } as never,
      stubClient(enabledProject),
    );
    expect(config.projectId).toBe("p1");
    expect(config.resource).toBe("main");
    expect(config.verifyCommand).toBe("pnpm test");
    expect(config.verifyTimeoutSec).toBe(600);
    expect(config.worktreeRoot).toBe("/tmp/wt");
    expect(config.worktreeName).toBe("p1-integrator");
    expect(config.gitRemote).toBe("origin");
    expect(config.gitMainBranch).toBe("main");
    expect(config.gitRepoUrl).toBe("https://github.com/test/repo.git");
    expect(config.parallelism).toBe(1);
    expect(config.linkedRepos).toEqual([]);
    // P1: clean_keep defaults to [] (plain git clean -fdx, pre-P1 behavior).
    expect(config.cleanKeep).toEqual([]);
    // Phase 7.4 §3.6: heartbeat cadence defaults to 30s when absent.
    expect(config.heartbeatIntervalSec).toBe(30);
  });

  it("surfaces heartbeat_interval_sec override (Phase 7.4 §3.6)", async () => {
    const withHeartbeat: ProjectDetail = {
      ...enabledProject,
      settings: {
        integrator: {
          ...enabledProject.settings!.integrator!,
          heartbeat_interval_sec: 10,
        },
      },
    };
    const config = await loadConfig(
      { project: "p1" },
      { PM_API_TOKEN: "t" } as never,
      stubClient(withHeartbeat),
    );
    expect(config.heartbeatIntervalSec).toBe(10);
  });

  it("reads parallelism override from integrator settings", async () => {
    const withParallelism: ProjectDetail = {
      ...enabledProject,
      settings: {
        integrator: { ...enabledProject.settings!.integrator!, parallelism: 4 },
      },
    };
    const config = await loadConfig(
      { project: "p1" },
      { PM_API_TOKEN: "t" } as never,
      stubClient(withParallelism),
    );
    expect(config.parallelism).toBe(4);
  });

  it("reads clean_keep override from integrator settings", async () => {
    const withCleanKeep: ProjectDetail = {
      ...enabledProject,
      settings: {
        integrator: {
          ...enabledProject.settings!.integrator!,
          clean_keep: ["dist"],
        },
      },
    };
    const config = await loadConfig(
      { project: "p1" },
      { PM_API_TOKEN: "t" } as never,
      stubClient(withCleanKeep),
    );
    expect(config.cleanKeep).toEqual(["dist"]);
  });

  it("surfaces linked_repos with snake→camel mapping", async () => {
    const withLinkedRepos: ProjectDetail = {
      ...enabledProject,
      settings: {
        integrator: {
          ...enabledProject.settings!.integrator!,
          linked_repos: [
            {
              name: "rynx-inner",
              path: "engine",
              role: "inner",
              gitlink_parent: "game_one",
              gitlink_path: "vendor/rynx",
            },
            {
              name: "game_one",
              path: ".",
              role: "outer",
            },
          ],
        },
      },
    };
    const config = await loadConfig(
      { project: "p1" },
      { PM_API_TOKEN: "t" } as never,
      stubClient(withLinkedRepos),
    );
    expect(config.linkedRepos).toHaveLength(2);
    expect(config.linkedRepos[0]).toEqual({
      name: "rynx-inner",
      path: "engine",
      role: "inner",
      gitlinkParent: "game_one",
      gitlinkPath: "vendor/rynx",
    });
    expect(config.linkedRepos[1]).toEqual({
      name: "game_one",
      path: ".",
      role: "outer",
      gitlinkParent: undefined,
      gitlinkPath: undefined,
    });
  });

  it("throws when project has no gitRepoUrl", async () => {
    const noRepo: ProjectDetail = { ...enabledProject, gitRepoUrl: null };
    await expect(
      loadConfig(
        { project: "p1" },
        { PM_API_TOKEN: "t" } as never,
        stubClient(noRepo),
      ),
    ).rejects.toThrow(/gitRepoUrl/);
  });

  it("throws when project id missing", async () => {
    await expect(
      loadConfig({}, {} as never, stubClient(enabledProject)),
    ).rejects.toThrow(ConfigError);
  });

  it("throws when integrator.enabled is false", async () => {
    const disabled: ProjectDetail = {
      ...enabledProject,
      settings: { integrator: { enabled: false } },
    };
    await expect(
      loadConfig(
        { project: "p1" },
        { PM_API_TOKEN: "t" } as never,
        stubClient(disabled),
      ),
    ).rejects.toThrow(/not enabled/);
  });

  it("throws when verify_command missing", async () => {
    const missing: ProjectDetail = {
      ...enabledProject,
      settings: {
        integrator: { enabled: true, worktree_root: "/tmp/wt" },
      },
    };
    await expect(
      loadConfig(
        { project: "p1" },
        { PM_API_TOKEN: "t" } as never,
        stubClient(missing),
      ),
    ).rejects.toThrow(/verify_command/);
  });

  it("throws when token env var is empty", async () => {
    await expect(
      loadConfig(
        { project: "p1" },
        {} as never,
        stubClient(enabledProject),
      ),
    ).rejects.toThrow(/Token env var/);
  });
});
