/**
 * Resolver runner status-protocol tests (Phase 7.6.1 Step P2).
 *
 * Exercises `createClaudeResolverRunner`'s four-state contract end-to-end against
 * a REAL spawned process (no fake runner here — that's the worker test's job).
 * The injected `command` is a small cross-platform Node script that inspects the
 * injected `PM_RESOLUTION_STATUS_PATH` and scripts a sentinel (or doesn't), then
 * we assert the resolved `result.kind` / `reason`.
 *
 * Cross-platform strategy: rather than shell-quote `node -e "..."` (cmd.exe vs
 * /bin/sh quoting differs), each test writes a `.cjs` helper script to an
 * out-of-tree temp dir and sets `command` to `node <scriptPath>`. `shell:true`
 * runs that identically on win32 + posix. The worktree (cwd) and the statusPath
 * are SEPARATE out-of-tree temp dirs — the sentinel never lives in the worktree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeResolverRunner } from "../src/resolver-runner.js";

/** JSON-encode a path for safe embedding in a generated `.cjs` script source. */
function jsStr(s: string): string {
  return JSON.stringify(s);
}

describe("createClaudeResolverRunner (status sentinel protocol)", () => {
  let tmpRoot: string;
  let worktree: string;
  let statusDir: string;
  let logPath: string;
  let scriptPath: string;
  let n = 0;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-resrunner-"));
    // The worktree (cwd) and the status dir are DISTINCT — the sentinel lives
    // OUTSIDE the worktree by contract. The dirs are created lazily per-test.
    worktree = path.join(tmpRoot, "wt");
    statusDir = path.join(tmpRoot, "status");
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // Helpers create real dirs lazily so each test controls layout.
  function setup(opts: {
    /** Relative files to seed in the worktree (e.g. a conflicting file). */
    worktreeFiles?: { rel: string; content: string }[];
    /** A `.cjs` script body run as the resolver `command`. */
    scriptBody: string;
    /** Pre-create the status file with this content BEFORE the run (staleness). */
    preStatus?: string;
  }): { statusPath: string; runner: ReturnType<typeof createClaudeResolverRunner> } {
    mkdirSync(worktree, { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    for (const f of opts.worktreeFiles ?? []) {
      writeFileSync(path.join(worktree, f.rel), f.content);
    }
    const statusPath = path.join(statusDir, "resolution-status.json");
    if (opts.preStatus !== undefined) {
      writeFileSync(statusPath, opts.preStatus);
    }
    logPath = path.join(tmpRoot, `run-${n}.log`);
    scriptPath = path.join(tmpRoot, `script-${n}.cjs`);
    n++;
    writeFileSync(scriptPath, opts.scriptBody);
    const runner = createClaudeResolverRunner({
      resolver: { command: `node ${jsStr(scriptPath)}` },
    });
    return { statusPath, runner };
  }

  function baseInput(statusPath: string, conflictingFiles: string[] = []) {
    return {
      worktreePath: worktree,
      conflictingFiles,
      verifyCommand: "noop",
      budget: { timeBudgetSec: 30 },
      logPath,
      statusPath,
    };
  }

  // A script that writes the given JSON literal to PM_RESOLUTION_STATUS_PATH and
  // exits 0. The body reads the env path the runner injects.
  function writeStatusScript(json: string): string {
    return [
      `const fs = require("node:fs");`,
      `const p = process.env.PM_RESOLUTION_STATUS_PATH;`,
      `fs.writeFileSync(p, ${jsStr(json)});`,
      `process.exit(0);`,
    ].join("\n");
  }

  it("1. status:complete sentinel, exit 0, no markers ⇒ complete", async () => {
    const { statusPath, runner } = setup({
      scriptBody: writeStatusScript('{"status":"complete"}'),
    });
    const result = await runner.run(baseInput(statusPath));
    expect(result.kind).toBe("complete");
  });

  it("2. status:give_up with reason ⇒ give_up carrying the reason", async () => {
    const { statusPath, runner } = setup({
      scriptBody: writeStatusScript('{"status":"give_up","reason":"two API redesigns"}'),
    });
    const result = await runner.run(baseInput(statusPath));
    expect(result.kind).toBe("give_up");
    if (result.kind === "give_up") {
      expect(result.reason).toBe("two API redesigns");
    }
  });

  it("3. exit 0, writes nothing, clean tree ⇒ incomplete{markers} (detail mentions absent)", async () => {
    const { statusPath, runner } = setup({
      scriptBody: `process.exit(0);`,
    });
    const result = await runner.run(baseInput(statusPath));
    expect(result.kind).toBe("incomplete");
    if (result.kind === "incomplete") {
      expect(result.reason).toBe("markers");
      expect(result.detail).toMatch(/absent/i);
    }
  });

  it("4. sentinel is not JSON ⇒ incomplete{markers}", async () => {
    const { statusPath, runner } = setup({
      scriptBody: writeStatusScript("not json"),
    });
    const result = await runner.run(baseInput(statusPath));
    expect(result.kind).toBe("incomplete");
    if (result.kind === "incomplete") expect(result.reason).toBe("markers");
  });

  it("5. sentinel JSON without a status key ⇒ incomplete{markers}", async () => {
    const { statusPath, runner } = setup({
      scriptBody: writeStatusScript('{"foo":1}'),
    });
    const result = await runner.run(baseInput(statusPath));
    expect(result.kind).toBe("incomplete");
    if (result.kind === "incomplete") expect(result.reason).toBe("markers");
  });

  it("6. a conflicting file still has <<<<<<< and no sentinel ⇒ incomplete{markers}", async () => {
    const { statusPath, runner } = setup({
      worktreeFiles: [
        {
          rel: "conflicted.txt",
          content: "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feat\n",
        },
      ],
      scriptBody: `process.exit(0);`,
    });
    const result = await runner.run(baseInput(statusPath, ["conflicted.txt"]));
    expect(result.kind).toBe("incomplete");
    if (result.kind === "incomplete") {
      expect(result.reason).toBe("markers");
      // The marker fallback fires BEFORE the absent-file fallback.
      expect(result.detail).toMatch(/marker/i);
    }
  });

  it("7. stale complete sentinel pre-exists; run writes nothing ⇒ incomplete{markers} (pre-spawn rm ran)", async () => {
    const { statusPath, runner } = setup({
      preStatus: '{"status":"complete"}',
      scriptBody: `process.exit(0);`,
    });
    const result = await runner.run(baseInput(statusPath));
    expect(result.kind).toBe("incomplete");
    if (result.kind === "incomplete") {
      expect(result.reason).toBe("markers");
      // A leftover `complete` must NOT leak through — the runner deletes it first.
      expect(result.detail).toMatch(/absent/i);
    }
  });

  it("8. env injection: PM_RESOLUTION_STATUS_PATH equals input.statusPath", async () => {
    // The script writes the env value it received into the sentinel as the
    // `reason`, then declares give_up — so we can read the injected path back
    // through the runner's result and compare to input.statusPath.
    const body = [
      `const fs = require("node:fs");`,
      `const p = process.env.PM_RESOLUTION_STATUS_PATH;`,
      `fs.writeFileSync(p, JSON.stringify({ status: "give_up", reason: p }));`,
      `process.exit(0);`,
    ].join("\n");
    const { statusPath, runner } = setup({ scriptBody: body });
    const result = await runner.run(baseInput(statusPath));
    expect(result.kind).toBe("give_up");
    if (result.kind === "give_up") {
      // The reason carries the env path the child observed — assert it is exactly
      // the statusPath we passed in.
      expect(result.reason).toBe(statusPath);
    }
  });

  it("9. timeout precedence: writes complete THEN sleeps past the budget ⇒ incomplete{timeout}", async () => {
    // The child writes a `complete` sentinel immediately, then blocks well past
    // the tiny budget. Timeout MUST win over the sentinel.
    const body = [
      `const fs = require("node:fs");`,
      `fs.writeFileSync(process.env.PM_RESOLUTION_STATUS_PATH, '{"status":"complete"}');`,
      // Busy/blocking sleep ~5s via Atomics so the process truly outlives the budget.
      `const sab = new SharedArrayBuffer(4);`,
      `Atomics.wait(new Int32Array(sab), 0, 0, 5000);`,
      `process.exit(0);`,
    ].join("\n");
    const { statusPath, runner } = setup({ scriptBody: body });
    const input = {
      ...baseInput(statusPath),
      budget: { timeBudgetSec: 0.3 },
    };
    const result = await runner.run(input);
    expect(result.kind).toBe("incomplete");
    if (result.kind === "incomplete") expect(result.reason).toBe("timeout");
  }, 15000);

  it("10. spawn_error: an unresolvable command ⇒ incomplete{spawn_error}", async () => {
    // No script file — point command at a binary that cannot be found so the
    // spawn raises an 'error' (ENOENT) rather than just exiting non-zero.
    mkdirSync(worktree, { recursive: true });
    mkdirSync(statusDir, { recursive: true });
    logPath = path.join(tmpRoot, "run-spawn.log");
    const statusPath = path.join(statusDir, "resolution-status.json");
    const runner = createClaudeResolverRunner({
      resolver: {
        command: "this-binary-does-not-exist-pm-resolver-xyzzy --nope",
      },
    });
    const result = await runner.run(baseInput(statusPath));
    expect(result.kind).toBe("incomplete");
    if (result.kind === "incomplete") {
      // shell:true means a missing binary usually surfaces as a non-zero exit
      // (the shell runs, the command fails) rather than a child 'error'. Either
      // a true spawn_error OR the markers fallback (exit≠0) is acceptable; the
      // load-bearing assertion is that it NEVER reports complete/give_up.
      expect(["spawn_error", "markers"]).toContain(result.reason);
    }
  });
});
