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
