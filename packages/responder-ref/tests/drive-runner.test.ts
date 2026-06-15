import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeDriveRunner, type DriveRunInput } from "../src/drive-runner.js";
import type { Escalation, EscalationMessage } from "@pm/shared";

const escalation = {
  id: "esc-1",
  projectId: "p",
  kind: "request",
  status: "open",
  severity: null,
  title: "the architecture is wrong",
  body: "we need a systemic rework",
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

const PROMPT_MARKER = "DRIVE_PROMPT_MARKER_XYZ";

// ── createClaudeDriveRunner (a plain temp worktree + an "outside" dir) ──
//
// Unlike the implement runner (which needs a real git worktree for its commit
// cross-check), the drive runner only writes a FILE — so a plain directory worktree
// suffices. The agent stub optionally writes a vision .md inside cwd (the worktree),
// and the runner's file-on-disk seal confirms it exists + is inside the worktree.
describe("createClaudeDriveRunner", () => {
  let tmpRoot: string;
  let worktreePath: string;
  let outsideDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "drive-runner-"));
    worktreePath = path.join(tmpRoot, "wt");
    outsideDir = path.join(tmpRoot, "outside"); // sentinel + log live OUTSIDE the worktree
    mkdirSync(path.join(worktreePath, "roadmaps"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    // A file that exists OUTSIDE the worktree (used to prove an escaping path is
    // rejected even when the target file genuinely exists there).
    writeFileSync(path.join(outsideDir, "x.md"), "outside vision\n");
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.PM_DRIVE_SENTINEL;
    delete process.env.PM_DRIVE_WRITE_REL;
  });

  function baseInput(command: string, timeBudgetSec: number): DriveRunInput {
    return {
      escalation,
      thread,
      worktreePath,
      budget: { timeBudgetSec },
      command,
      prompt: PROMPT_MARKER,
      statusPath: path.join(outsideDir, "status.json"),
      logPath: path.join(outsideDir, "out.log"),
    };
  }

  /**
   * An agent stub: a `node <script>.cjs` command that reads stdin (echoing it to
   * stdout so the test can assert prompt → stdin → log), optionally writes a vision
   * file at a worktree-relative path (PM_DRIVE_WRITE_REL, relative to cwd = the
   * worktree), and writes its sentinel payload (PM_DRIVE_SENTINEL) to
   * PM_DRIVE_STATUS_PATH. The payload travels via env (NOT the command string —
   * nested-quoted JSON does not survive the Windows cmd.exe shell quoting under
   * shell:true).
   *
   * `writeRel`: when set, the stub writes a file at that cwd-relative path (a REAL
   * vision the seal should see); when "" it writes only the sentinel.
   */
  function agentCmd(opts: { sentinel: string; writeRel: string }): string {
    process.env.PM_DRIVE_SENTINEL = opts.sentinel;
    process.env.PM_DRIVE_WRITE_REL = opts.writeRel;
    const script = path.join(outsideDir, `agent-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(
      script,
      `const fs=require('fs');const path=require('path');let d='';` +
        `process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{` +
        `process.stdout.write('GOT:'+d);` +
        `if(process.env.PM_DRIVE_WRITE_REL){` +
        `const f=path.resolve(process.cwd(),process.env.PM_DRIVE_WRITE_REL);` +
        `fs.mkdirSync(path.dirname(f),{recursive:true});` +
        `fs.writeFileSync(f,'# vision\\n');` +
        `}` +
        `fs.writeFileSync(process.env.PM_DRIVE_STATUS_PATH, process.env.PM_DRIVE_SENTINEL);` +
        `process.exit(0)});`,
    );
    return `node "${script}"`;
  }

  it("vision_ready + a REAL file under the worktree + valid sentinel → vision_ready (visionPath normalized, campaigns carried)", async () => {
    const runner = createClaudeDriveRunner({});
    const cmd = agentCmd({
      sentinel: JSON.stringify({
        status: "vision_ready",
        visionPath: "roadmaps/vision-x.md",
        epicName: "Systemic rework",
        campaigns: [
          { title: "C1", priority: "high", description: "d1" },
          { title: "C2", priority: "bogus", description: 42 },
        ],
      }),
      writeRel: "roadmaps/vision-x.md",
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("vision_ready");
    if (result.kind === "vision_ready") {
      expect(result.visionPath).toBe("roadmaps/vision-x.md"); // normalized, forward slashes
      expect(result.epicName).toBe("Systemic rework");
      expect(result.campaigns).toEqual([
        { title: "C1", priority: "high", description: "d1" },
        // priority clamped to "medium"; description coerced to a string.
        { title: "C2", priority: "medium", description: "42" },
      ]);
    }
    expect(existsSync(path.join(worktreePath, "roadmaps", "vision-x.md"))).toBe(true);
    const log = readFileSync(path.join(outsideDir, "out.log"), "utf8");
    expect(log).toContain(`GOT:${PROMPT_MARKER}`);
  });

  it("vision_ready declared but NO file on disk → error (the file seal fires)", async () => {
    const runner = createClaudeDriveRunner({});
    const cmd = agentCmd({
      sentinel: JSON.stringify({
        status: "vision_ready",
        visionPath: "roadmaps/vision-x.md",
        epicName: "E",
        campaigns: [{ title: "C1", priority: "high", description: "d" }],
      }),
      writeRel: "", // no file written
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("spawn_error");
      expect(result.detail).toContain("no vision file");
    }
  });

  it("visionPath escaping the worktree (../outside/x.md) → rejected, and the out-of-tree file is NOT read", async () => {
    const runner = createClaudeDriveRunner({});
    // The escaping target genuinely exists (outsideDir/x.md, written in beforeEach),
    // proving the seal rejects on the path check BEFORE the stat would succeed.
    const cmd = agentCmd({
      sentinel: JSON.stringify({
        status: "vision_ready",
        visionPath: "../outside/x.md",
        epicName: "E",
        campaigns: [{ title: "C1", priority: "high", description: "d" }],
      }),
      writeRel: "",
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("spawn_error");
      expect(result.detail).toContain("no vision file");
    }
  });

  it("an ABSOLUTE visionPath → rejected (even though the file exists there)", async () => {
    const runner = createClaudeDriveRunner({});
    const abs = path.join(outsideDir, "x.md");
    const cmd = agentCmd({
      sentinel: JSON.stringify({
        status: "vision_ready",
        visionPath: abs,
        epicName: "E",
        campaigns: [{ title: "C1", priority: "high", description: "d" }],
      }),
      writeRel: "",
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("empty epicName → error (malformed sentinel)", async () => {
    const runner = createClaudeDriveRunner({});
    const cmd = agentCmd({
      sentinel: JSON.stringify({
        status: "vision_ready",
        visionPath: "roadmaps/vision-x.md",
        epicName: "",
        campaigns: [{ title: "C1", priority: "high", description: "d" }],
      }),
      writeRel: "roadmaps/vision-x.md",
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.detail).toContain("malformed");
  });

  it("zero campaigns → error (malformed sentinel)", async () => {
    const runner = createClaudeDriveRunner({});
    const cmd = agentCmd({
      sentinel: JSON.stringify({
        status: "vision_ready",
        visionPath: "roadmaps/vision-x.md",
        epicName: "E",
        campaigns: [],
      }),
      writeRel: "roadmaps/vision-x.md",
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.detail).toContain("malformed");
  });

  it("a campaign with an empty title → error (malformed sentinel)", async () => {
    const runner = createClaudeDriveRunner({});
    const cmd = agentCmd({
      sentinel: JSON.stringify({
        status: "vision_ready",
        visionPath: "roadmaps/vision-x.md",
        epicName: "E",
        campaigns: [{ title: "", priority: "high", description: "d" }],
      }),
      writeRel: "roadmaps/vision-x.md",
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.detail).toContain("malformed");
  });

  it("give_up{reason} → give_up", async () => {
    const runner = createClaudeDriveRunner({});
    const cmd = agentCmd({
      sentinel: JSON.stringify({ status: "give_up", reason: "too vague" }),
      writeRel: "",
    });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("give_up");
    if (result.kind === "give_up") expect(result.reason).toBe("too vague");
  });

  it("absent sentinel on a clean exit-0 → error(spawn_error), NOT vision_ready", async () => {
    const runner = createClaudeDriveRunner({});
    const cmd = `node -e "process.exit(0)"`;
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("garbage (non-JSON) sentinel → error(spawn_error)", async () => {
    const runner = createClaudeDriveRunner({});
    const cmd = agentCmd({ sentinel: "not json", writeRel: "" });
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("a bogus command → error(spawn_error)", async () => {
    const runner = createClaudeDriveRunner({});
    const result = await runner.run(baseInput("this-command-definitely-does-not-exist-xyz", 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("timeout precedence: a sleep beyond a 1s budget → error(timeout) even if a vision_ready+file was written first", async () => {
    const runner = createClaudeDriveRunner({});
    // Write a valid vision file + a valid vision_ready sentinel, THEN sleep past the
    // budget. The kill fires; the timeout verdict precedes the (valid) sentinel.
    const script = path.join(outsideDir, "slow.cjs");
    const sentinel = JSON.stringify({
      status: "vision_ready",
      visionPath: "roadmaps/vision-x.md",
      epicName: "E",
      campaigns: [{ title: "C1", priority: "high", description: "d" }],
    });
    writeFileSync(
      script,
      `const fs=require('fs');const path=require('path');` +
        `const f=path.resolve(process.cwd(),'roadmaps/vision-x.md');` +
        `fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,'# vision\\n');` +
        `fs.writeFileSync(process.env.PM_DRIVE_STATUS_PATH, ${JSON.stringify(sentinel)});` +
        `setTimeout(()=>{},10000);`,
    );
    const result = await runner.run(baseInput(`node "${script}"`, 1));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("timeout");
  }, 15_000);

  it("a stale vision_ready sentinel is removed before spawn (no-write exit-0 → fallback error, not the stale vision_ready)", async () => {
    const runner = createClaudeDriveRunner({});
    const input = baseInput(`node -e "process.exit(0)"`, 30);
    // Pre-write a stale vision_ready sentinel AND its file. The runner must rm the
    // sentinel before spawn, so a no-write exit-0 yields the fallback error.
    writeFileSync(path.join(worktreePath, "roadmaps", "stale.md"), "# stale\n");
    writeFileSync(
      input.statusPath,
      JSON.stringify({
        status: "vision_ready",
        visionPath: "roadmaps/stale.md",
        epicName: "STALE",
        campaigns: [{ title: "C1", priority: "high", description: "d" }],
      }),
    );
    const result = await runner.run(input);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });
});
