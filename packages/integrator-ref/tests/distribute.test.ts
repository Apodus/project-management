import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — the distribute script is plain ESM (.mjs) with no .d.ts.
import { distribute, loadConfig, parseArgs } from "../../../scripts/distribute.mjs";

/**
 * These tests exercise the distribute.mjs helpers hermetically: a FAKE repo
 * root with stub bundle/doc source files and temp target dirs. Every call
 * passes `build: false`, so pnpm is NEVER spawned (fast, no real build).
 */

let workDir: string;
let fakeRepoRoot: string;

/** Lay down the four source artifacts the distributor expects under a fake root. */
function seedSources(root: string): void {
  mkdirSync(join(root, "packages", "mcp-server", "dist", "bundle"), { recursive: true });
  mkdirSync(join(root, "packages", "integrator-ref", "dist", "bundle"), {
    recursive: true,
  });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "packages", "mcp-server", "dist", "bundle", "pm-mcp-server.mjs"),
    "MCP_BUNDLE_CONTENT",
  );
  writeFileSync(
    join(root, "packages", "integrator-ref", "dist", "bundle", "pm-integrator.mjs"),
    "INTEGRATOR_BUNDLE_CONTENT",
  );
  writeFileSync(join(root, "docs", "integrator-deployment.md"), "OPERATOR_GUIDE");
  writeFileSync(join(root, "docs", "worker-pm-workflow.md"), "WORKER_WORKFLOW");
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "distribute-test-"));
  fakeRepoRoot = join(workDir, "repo");
  mkdirSync(fakeRepoRoot, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("distribute (build: false)", () => {
  it("copies all 4 artifacts to a target, creating nested dest dirs", () => {
    seedSources(fakeRepoRoot);
    const targetDir = join(workDir, "deep", "nested", "target");
    const config = {
      targets: [
        {
          name: "t1",
          mcpDest: join(targetDir, "tools", "pm-mcp-server", "pm-mcp-server.mjs"),
          integratorDest: join(targetDir, "tools", "pm-integrator", "pm-integrator.mjs"),
          docsDest: join(targetDir, "docs", "integrator-deployment.md"),
          // Worker doc must land AS pm-workflow.md (the rename) per the dest path.
          workerDocDest: join(targetDir, "docs", "pm-workflow.md"),
        },
      ],
    };

    distribute({ config, repoRoot: fakeRepoRoot, build: false });

    const t = config.targets[0];
    expect(readFileSync(t.mcpDest, "utf8")).toBe("MCP_BUNDLE_CONTENT");
    expect(readFileSync(t.integratorDest, "utf8")).toBe("INTEGRATOR_BUNDLE_CONTENT");
    expect(readFileSync(t.docsDest, "utf8")).toBe("OPERATOR_GUIDE");
    expect(readFileSync(t.workerDocDest, "utf8")).toBe("WORKER_WORKFLOW");
  });

  it("throws clearly naming the missing bundle path, with no partial copy", () => {
    seedSources(fakeRepoRoot);
    // Remove the MCP bundle to simulate a skipped build.
    rmSync(join(fakeRepoRoot, "packages", "mcp-server", "dist", "bundle", "pm-mcp-server.mjs"));

    const targetDir = join(workDir, "target");
    const config = {
      targets: [
        {
          name: "t1",
          mcpDest: join(targetDir, "pm-mcp-server.mjs"),
          integratorDest: join(targetDir, "pm-integrator.mjs"),
          docsDest: join(targetDir, "integrator-deployment.md"),
          workerDocDest: join(targetDir, "pm-workflow.md"),
        },
      ],
    };

    expect(() => distribute({ config, repoRoot: fakeRepoRoot, build: false })).toThrow(
      /pm-mcp-server\.mjs/,
    );
    // Source assertion happens before any copy — nothing should have landed.
    expect(existsSync(config.targets[0].docsDest)).toBe(false);
  });

  it("dryRun writes zero files", () => {
    seedSources(fakeRepoRoot);
    const targetDir = join(workDir, "target");
    const config = {
      targets: [
        {
          name: "t1",
          mcpDest: join(targetDir, "pm-mcp-server.mjs"),
          integratorDest: join(targetDir, "pm-integrator.mjs"),
          docsDest: join(targetDir, "integrator-deployment.md"),
          workerDocDest: join(targetDir, "pm-workflow.md"),
        },
      ],
    };

    distribute({ config, repoRoot: fakeRepoRoot, build: false, dryRun: true });

    expect(existsSync(targetDir)).toBe(false);
    for (const dest of Object.values(config.targets[0])) {
      if (typeof dest === "string" && dest.includes(workDir)) {
        expect(existsSync(dest)).toBe(false);
      }
    }
  });
});

describe("loadConfig", () => {
  it("throws a clear error when the config path is missing", () => {
    const missing = join(workDir, "nope.json");
    expect(() => loadConfig(missing)).toThrow(/not found/);
    expect(() => loadConfig(missing)).toThrow(/distribute\.config\.example\.json/);
  });

  it("throws a distinct error on malformed JSON", () => {
    const bad = join(workDir, "bad.json");
    writeFileSync(bad, "{ not valid json ");
    expect(() => loadConfig(bad)).toThrow(/not valid JSON/);
  });

  it("rejects an empty targets array", () => {
    const empty = join(workDir, "empty.json");
    writeFileSync(empty, JSON.stringify({ targets: [] }));
    expect(() => loadConfig(empty)).toThrow(/non-empty "targets"/);
  });

  it("rejects a target missing a required field", () => {
    const partial = join(workDir, "partial.json");
    writeFileSync(
      partial,
      JSON.stringify({
        targets: [{ name: "t1", mcpDest: "/a", integratorDest: "/b", docsDest: "/c" }],
      }),
    );
    expect(() => loadConfig(partial)).toThrow(/workerDocDest/);
  });

  it("accepts a well-formed config", () => {
    const ok = join(workDir, "ok.json");
    const config = {
      targets: [
        {
          name: "t1",
          mcpDest: "/a",
          integratorDest: "/b",
          docsDest: "/c",
          workerDocDest: "/d",
        },
      ],
    };
    writeFileSync(ok, JSON.stringify(config));
    expect(loadConfig(ok).targets).toHaveLength(1);
  });
});

describe("parseArgs", () => {
  it("defaults config to repoRoot/distribute.config.json and dryRun false", () => {
    const args = parseArgs([]);
    expect(args.dryRun).toBe(false);
    expect(args.config).toMatch(/distribute\.config\.json$/);
  });

  it("parses --config <path> and --dry-run", () => {
    const args = parseArgs(["--config", "/custom/cfg.json", "--dry-run"]);
    expect(args.config).toBe("/custom/cfg.json");
    expect(args.dryRun).toBe(true);
  });

  it("parses --config=<path> form", () => {
    const args = parseArgs(["--config=/inline/cfg.json"]);
    expect(args.config).toBe("/inline/cfg.json");
  });

  it("throws on --config with no value", () => {
    expect(() => parseArgs(["--config"])).toThrow(/requires a path/);
  });

  it("throws on an unknown argument", () => {
    expect(() => parseArgs(["--wat"])).toThrow(/Unknown argument/);
  });
});
