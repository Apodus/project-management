import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWorktree } from "../src/worktree.js";
import { PmClient } from "../src/pm-client.js";

describe("worktree path construction", () => {
  it("joins root + name", () => {
    const wt = createWorktree({
      worktreeRoot: "/tmp/wt",
      worktreeName: "demo-integrator",
      gitRemote: "origin",
      gitMainBranch: "main",
      gitRepoUrl: "https://example.com/repo.git",
      cleanKeep: [],
    });
    expect(wt.path).toBe("/tmp/wt/demo-integrator");
  });

  it("normalizes trailing slashes", () => {
    const wt = createWorktree({
      worktreeRoot: "/tmp/wt///",
      worktreeName: "demo",
      gitRemote: "origin",
      gitMainBranch: "main",
      gitRepoUrl: "https://example.com/repo.git",
      cleanKeep: [],
    });
    expect(wt.path).toBe("/tmp/wt/demo");
  });
});

describe("PmClient HTTP construction", () => {
  it("normalizes baseUrl and sends Authorization header", async () => {
    let calledUrl = "";
    let calledHeaders: Record<string, string> = {};
    const fakeFetch: typeof fetch = async (url, init) => {
      calledUrl = String(url);
      calledHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          data: { id: "p1", name: "P", slug: "p", status: "active", settings: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new PmClient({
      baseUrl: "http://x/",
      token: "t",
      fetchImpl: fakeFetch,
    });
    const project = await client.getProject("p1");
    expect(calledUrl).toBe("http://x/api/v1/projects/p1");
    expect(calledHeaders["Authorization"]).toBe("Bearer t");
    expect(project.id).toBe("p1");
  });
});

const distExists = existsSync(new URL("../dist/index.js", import.meta.url).pathname);

describe.skipIf(!distExists)("CLI smoke", () => {
  it("starts, prints ready line, exits cleanly on SIGTERM", async () => {
    const proc = spawn("node", [new URL("../dist/index.js", import.meta.url).pathname, "--help"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const [code] = (await once(proc, "exit")) as [number, ...unknown[]];
    expect(code).toBe(0);
    expect(stdout).toContain("pm-integrator");
  }, 5000);
});
