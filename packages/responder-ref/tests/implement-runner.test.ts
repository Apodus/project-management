import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createClaudeImplementRunner, type ImplementRunInput } from "../src/implement-runner.js";
import { buildImplementPrompt, DEFAULT_IMPLEMENT_PROMPT } from "../src/implement-prompt.js";
import { DEFAULT_RESPONDER_PROMPT } from "../src/prompt.js";
import type { Escalation, EscalationMessage } from "@pm/shared";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

const escalation = {
  id: "esc-1",
  projectId: "p",
  kind: "bug",
  status: "open",
  severity: null,
  title: "Fix the off-by-one",
  body: "the loop runs one too many times",
  codeLocator: null,
  anchorType: null,
  anchorId: null,
  originRepo: "repo",
  originWorkerKey: "wk",
  holderId: null,
  authorId: "a",
  createdAt: "2026-06-13T00:00:00.000Z",
  updatedAt: "2026-06-13T00:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
} satisfies Escalation;

const thread: EscalationMessage[] = [
  {
    id: "m1",
    escalationId: "esc-1",
    seq: 1,
    authorId: "a",
    body: "first thread body here",
    messageType: "reply",
    metadata: null,
    createdAt: "2026-06-13T00:00:00.000Z",
  },
];

const PROMPT_MARKER = "IMPL_PROMPT_MARKER_XYZ";

// ── createClaudeImplementRunner (real git: a bare repo + a clone we run in) ──
//
// Unlike the responder-runner suite (plain temp dirs suffice for a read-only
// session), the implement runner's commit cross-check needs a REAL git worktree:
// the agent stub commits into the clone, and the runner confirms a commit exists
// beyond the base before trusting branch_ready.
describe.skipIf(!GIT_AVAILABLE)("createClaudeImplementRunner (real git)", () => {
  let tmpRoot: string;
  let bareRepo: string;
  let worktreePath: string;
  let outsideDir: string;

  async function configIdentity(g: SimpleGit): Promise<void> {
    await g.addConfig("user.email", "impl@test.local");
    await g.addConfig("user.name", "Implement Test");
    await g.addConfig("commit.gpgsign", "false");
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "impl-runner-"));
    bareRepo = path.join(tmpRoot, "bare.git");
    worktreePath = path.join(tmpRoot, "wt");
    outsideDir = path.join(tmpRoot, "outside"); // sentinel + log live OUTSIDE the worktree
    mkdirSync(outsideDir, { recursive: true });

    await simpleGit().init(["--bare", "--initial-branch=main", bareRepo]);
    const seedClone = path.join(tmpRoot, "seed");
    await simpleGit().clone(bareRepo, seedClone);
    const seed = simpleGit(seedClone);
    await configIdentity(seed);
    writeFileSync(path.join(seedClone, "base.txt"), "base\n");
    await seed.add(["base.txt"]);
    await seed.commit("initial");
    await seed.branch(["-M", "main"]);
    await seed.push(["-u", "origin", "main"]);

    // The worktree the session runs in: a fresh clone of the bare repo.
    await simpleGit().clone(bareRepo, worktreePath);
    const wt = simpleGit(worktreePath);
    await configIdentity(wt);
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.PM_IMPLEMENT_SENTINEL;
    delete process.env.PM_IMPLEMENT_WRITE_FILE;
  });

  function baseInput(command: string, timeBudgetSec: number): ImplementRunInput {
    return {
      escalation,
      thread,
      branch: "pm/impl-esc-1",
      worktreePath,
      budget: { timeBudgetSec },
      command,
      prompt: PROMPT_MARKER,
      logPath: path.join(outsideDir, "out.log"),
      statusPath: path.join(outsideDir, "status.json"),
    };
  }

  /**
   * An agent stub: a `node <script>.cjs` command that reads stdin (echoing it to
   * stdout so the test can assert prompt → stdin → log), optionally writes+commits
   * a file in cwd (the worktree), and writes its sentinel payload (from the
   * PM_IMPLEMENT_SENTINEL env var) to PM_IMPLEMENT_STATUS_PATH. The payload travels
   * via env (NOT the command string — nested-quoted JSON does not survive the
   * Windows cmd.exe shell quoting under shell:true).
   *
   * `commit`: when true the stub creates + commits a file in cwd (a REAL commit
   * the cross-check should see); when false it writes only the sentinel.
   */
  function agentCmd(opts: { sentinel: string; commit: boolean }): string {
    process.env.PM_IMPLEMENT_SENTINEL = opts.sentinel;
    process.env.PM_IMPLEMENT_WRITE_FILE = opts.commit ? "1" : "";
    const script = path.join(outsideDir, `agent-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(
      script,
      `const fs=require('fs');const cp=require('child_process');let d='';` +
        `process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{` +
        `process.stdout.write('GOT:'+d);` +
        `if(process.env.PM_IMPLEMENT_WRITE_FILE){` +
        `fs.writeFileSync('fix.txt','the fix\\n');` +
        `cp.execSync('git -c user.email=a@b.c -c user.name=A -c commit.gpgsign=false add fix.txt',{cwd:process.cwd()});` +
        `cp.execSync('git -c user.email=a@b.c -c user.name=A -c commit.gpgsign=false commit -m fix',{cwd:process.cwd()});` +
        `}` +
        `fs.writeFileSync(process.env.PM_IMPLEMENT_STATUS_PATH, process.env.PM_IMPLEMENT_SENTINEL);` +
        `process.exit(0)});`,
    );
    return `node "${script}"`;
  }

  it("branch_ready with a REAL commit → branch_ready, commitSha populated, live repo untouched", async () => {
    const runner = createClaudeImplementRunner({});
    const cmd = agentCmd({
      sentinel: JSON.stringify({
        status: "branch_ready",
        branch: "pm/impl-esc-1",
        commitSha: "deadbeef-claimed",
      }),
      commit: true,
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("branch_ready");
    if (result.kind === "branch_ready") {
      expect(result.branch).toBe("pm/impl-esc-1");
      // commitSha is the ACTUAL HEAD, never the sentinel's self-asserted value.
      expect(result.commitSha).toBeTruthy();
      expect(result.commitSha).not.toBe("deadbeef-claimed");
    }
    // Worktree isolation: fix.txt lives in the worktree clone, never in the seed/origin.
    expect(existsSync(path.join(worktreePath, "fix.txt"))).toBe(true);
    expect(existsSync(path.join(tmpRoot, "seed", "fix.txt"))).toBe(false);
    // The prompt reached the agent via stdin and was logged.
    const log = readFileSync(path.join(outsideDir, "out.log"), "utf8");
    expect(log).toContain(`GOT:${PROMPT_MARKER}`);
  });

  it("branch_ready declared but NO commit → error (the cross-check fires)", async () => {
    const runner = createClaudeImplementRunner({});
    const cmd = agentCmd({
      sentinel: JSON.stringify({ status: "branch_ready", branch: "pm/impl-esc-1" }),
      commit: false,
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("spawn_error");
      expect(result.detail).toContain("no commit");
    }
  });

  it("give_up{reason} → give_up", async () => {
    const runner = createClaudeImplementRunner({});
    const cmd = agentCmd({
      sentinel: JSON.stringify({ status: "give_up", reason: "too hard" }),
      commit: false,
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("give_up");
    if (result.kind === "give_up") expect(result.reason).toBe("too hard");
  });

  it("a sleep beyond a tiny budget → error(timeout)", async () => {
    const runner = createClaudeImplementRunner({});
    const cmd = `node -e "setTimeout(()=>{},10000)"`;
    const result = await runner.run(baseInput(cmd, 1));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("timeout");
  }, 15_000);

  it("a bogus command → error(spawn_error)", async () => {
    const runner = createClaudeImplementRunner({});
    const result = await runner.run(baseInput("this-command-definitely-does-not-exist-xyz", 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("absent sentinel on a clean exit-0 → error(spawn_error), NOT branch_ready", async () => {
    const runner = createClaudeImplementRunner({});
    const cmd = `node -e "process.exit(0)"`;
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("garbage (non-JSON) sentinel → error(spawn_error)", async () => {
    const runner = createClaudeImplementRunner({});
    const cmd = agentCmd({ sentinel: "not json", commit: false });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("an unrecognized status falls back to error", async () => {
    const runner = createClaudeImplementRunner({});
    const cmd = agentCmd({ sentinel: JSON.stringify({ status: "whatever" }), commit: false });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("a stale branch_ready sentinel is removed before spawn (no false branch_ready:STALE)", async () => {
    const runner = createClaudeImplementRunner({});
    const input = baseInput(`node -e "process.exit(0)"`, 30);
    // Pre-write a stale branch_ready sentinel. The runner must rm it before spawn,
    // so a command that exits 0 WITHOUT writing yields the fallback error — never
    // the stale branch_ready.
    writeFileSync(
      input.statusPath,
      JSON.stringify({ status: "branch_ready", branch: "STALE", commitSha: "x" }),
    );
    const result = await runner.run(input);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });
});

// ── buildImplementPrompt (pure — no git) ──
describe("buildImplementPrompt", () => {
  it("substitutes {escalation}, {thread}, AND {branch} into the default", () => {
    const out = buildImplementPrompt(escalation, thread, "pm/impl-esc-1", "");
    expect(out).toContain("esc-1");
    expect(out).toContain("Fix the off-by-one");
    expect(out).toContain("first thread body here");
    expect(out).toContain("pm/impl-esc-1");
    // No raw placeholders survive.
    expect(out).not.toContain("{escalation}");
    expect(out).not.toContain("{thread}");
    expect(out).not.toContain("{branch}");
  });

  it("mandates the implement sentinel + permits editing (no do-not-edit constraint)", () => {
    const out = buildImplementPrompt(escalation, thread, "pm/impl-esc-1", "");
    expect(out).toContain("PM_IMPLEMENT_STATUS_PATH");
    expect(out).toContain("branch_ready");
    expect(out).toContain("give_up");
    expect(out).toContain("permitted to edit code");
    // The write prompt carries NO read-only constraint.
    expect(out).not.toContain("MUST NOT edit");
    expect(DEFAULT_IMPLEMENT_PROMPT).not.toContain("MUST NOT edit");
  });

  it("a custom template is preserved (replace-if-present)", () => {
    const out = buildImplementPrompt(escalation, thread, "br", "", "ON {branch}: {escalation}");
    expect(out.startsWith("ON br: ")).toBe(true);
    expect(out).toContain("esc-1");
    expect(out).not.toContain("{thread}");
  });
});

// ── ANSWER-MODE BYTE-IDENTITY SEAL ──
// The read-only responder prompt MUST remain untouched: its mutation prohibition
// and four-state sentinel contract are intact. (prompt.ts is never edited/exported.)
describe("answer-mode byte-identity", () => {
  it("DEFAULT_RESPONDER_PROMPT still forbids mutation (read-only seal intact)", () => {
    expect(DEFAULT_RESPONDER_PROMPT).toContain("MUST NOT edit, commit, push, or branch");
    expect(DEFAULT_RESPONDER_PROMPT).toContain("PM_RESPONDER_STATUS_PATH");
    expect(DEFAULT_RESPONDER_PROMPT).toContain("answered");
  });
});
