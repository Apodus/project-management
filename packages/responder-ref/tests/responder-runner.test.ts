import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeResponderRunner, type ResponderRunInput } from "../src/responder-runner.js";
import { buildResponderPrompt, DEFAULT_RESPONDER_PROMPT } from "../src/prompt.js";
import type { Escalation, EscalationMessage } from "@pm/shared";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "responder-runner-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PM_RESPONDER_SENTINEL;
});

const escalation = {
  id: "esc-1",
  projectId: "p",
  kind: "question",
  status: "open",
  severity: null,
  title: "Why does the build fail",
  body: "build fails on step 2",
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

const PROMPT_MARKER = "PROMPT_MARKER_XYZ";

function baseInput(command: string, timeBudgetSec: number): ResponderRunInput {
  return {
    escalation,
    prompt: PROMPT_MARKER,
    budget: { timeBudgetSec },
    cwd: dir,
    command,
    logPath: path.join(dir, "out.log"),
    statusPath: path.join(dir, "status.json"),
  };
}

/**
 * An agent simulator: a `node <script>` command whose script reads stdin (echoing
 * it to stdout so the test can assert prompt → stdin → log), reads its sentinel
 * payload from the PM_RESPONDER_SENTINEL env var, and writes it to the path in
 * PM_RESPONDER_STATUS_PATH. The payload travels via env (PM_RESPONDER_SENTINEL,
 * set on process.env so the runner's `{...process.env}` copy carries it), NOT
 * embedded in the command string — embedding nested-quoted JSON in `node -e` does
 * not survive the Windows cmd.exe shell quoting (`shell:true`).
 */
function writeSentinelCmd(sentinel: string): string {
  process.env.PM_RESPONDER_SENTINEL = sentinel;
  const script = path.join(dir, `agent-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(
    script,
    `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{` +
      `process.stdout.write('GOT:'+d);` +
      `require('fs').writeFileSync(process.env.PM_RESPONDER_STATUS_PATH, process.env.PM_RESPONDER_SENTINEL);` +
      `process.exit(0)});`,
  );
  return `node "${script}"`;
}

describe("createClaudeResponderRunner", () => {
  it("answered carries the answer text + log got the prompt", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = writeSentinelCmd(JSON.stringify({ status: "answered", answer: "X" }));
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("answered");
    if (result.kind === "answered") expect(result.answer).toBe("X");
    const log = readFileSync(path.join(dir, "out.log"), "utf8");
    expect(log).toContain(`GOT:${PROMPT_MARKER}`);
  });

  it("needs_human carries the reason", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = writeSentinelCmd(JSON.stringify({ status: "needs_human", reason: "R" }));
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("needs_human");
    if (result.kind === "needs_human") expect(result.reason).toBe("R");
  });

  it("give_up carries the reason", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = writeSentinelCmd(JSON.stringify({ status: "give_up", reason: "R" }));
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("give_up");
    if (result.kind === "give_up") expect(result.reason).toBe("R");
  });

  it("implement{bounded} carries size + rationale", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = writeSentinelCmd(
      JSON.stringify({ status: "implement", size: "bounded", rationale: "small fix" }),
    );
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("implement");
    if (result.kind === "implement") {
      expect(result.size).toBe("bounded");
      expect(result.rationale).toBe("small fix");
    }
  });

  it("implement{systemic} carries size", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = writeSentinelCmd(JSON.stringify({ status: "implement", size: "systemic" }));
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("implement");
    if (result.kind === "implement") expect(result.size).toBe("systemic");
  });

  it("implement with an unknown/missing size falls back to error (a code change must be scoped)", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = writeSentinelCmd(JSON.stringify({ status: "implement", size: "huge" }));
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("a sleep beyond a tiny budget → error(timeout)", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = `node -e "setTimeout(()=>{},10000)"`;
    const result = await runner.run(baseInput(cmd, 1));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("timeout");
  }, 15_000);

  it("a bogus command → error(spawn_error)", async () => {
    const runner = createClaudeResponderRunner({});
    const result = await runner.run(baseInput("this-command-definitely-does-not-exist-xyz", 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("absent sentinel on a clean exit-0 → error(spawn_error), NOT answered", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = `node -e "process.exit(0)"`;
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("garbage (non-JSON) sentinel → error(spawn_error)", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = writeSentinelCmd("not json");
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("answered-without-answer falls back to error", async () => {
    const runner = createClaudeResponderRunner({});
    const cmd = writeSentinelCmd(JSON.stringify({ status: "answered" }));
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });

  it("a stale sentinel is removed before spawn (no false answered:STALE)", async () => {
    const runner = createClaudeResponderRunner({});
    const input = baseInput(`node -e "process.exit(0)"`, 30);
    // Pre-write a stale answered sentinel. The runner must rm it before spawn, so
    // a command that exits 0 WITHOUT writing yields the fallback error — never the
    // stale answer.
    writeFileSync(input.statusPath, JSON.stringify({ status: "answered", answer: "STALE" }));
    const result = await runner.run(input);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("spawn_error");
  });
});

describe("buildResponderPrompt", () => {
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

  it("substitutes {escalation} (id/title) and {thread} (body) into the default", () => {
    const out = buildResponderPrompt(escalation, thread);
    expect(out).toContain("esc-1");
    expect(out).toContain("Why does the build fail");
    expect(out).toContain("first thread body here");
    // No raw placeholders survive.
    expect(out).not.toContain("{escalation}");
    expect(out).not.toContain("{thread}");
  });

  it("the default prompt forbids mutation + mandates the status sentinel", () => {
    expect(DEFAULT_RESPONDER_PROMPT).toContain("PM_RESPONDER_STATUS_PATH");
    expect(DEFAULT_RESPONDER_PROMPT).toContain("answered");
    expect(DEFAULT_RESPONDER_PROMPT).toContain("needs_human");
    expect(DEFAULT_RESPONDER_PROMPT).toContain("give_up");
    expect(DEFAULT_RESPONDER_PROMPT).toContain("implement");
  });

  it("a custom template is preserved (replace-if-present)", () => {
    const out = buildResponderPrompt(escalation, thread, "ONLY ESC: {escalation}");
    expect(out.startsWith("ONLY ESC: ")).toBe(true);
    expect(out).toContain("esc-1");
    expect(out).not.toContain("{thread}");
  });
});
