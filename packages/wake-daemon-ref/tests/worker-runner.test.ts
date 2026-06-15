import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeWorkerRunner, type WorkerRunInput } from "../src/worker-runner.js";
import type { Escalation, EscalationMessage } from "@pm/shared";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wake-runner-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const escalation = {
  id: "esc-1",
  projectId: "p",
  kind: "question",
  status: "open",
  severity: null,
  title: "t",
  body: null,
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

const messages: EscalationMessage[] = [];

function baseInput(command: string, timeBudgetSec: number): WorkerRunInput {
  return {
    workerKey: "wk",
    escalation,
    unreadMessages: messages,
    prompt: "PROMPT_MARKER",
    budget: { timeBudgetSec },
    cwd: dir,
    command,
    logPath: path.join(dir, "out.log"),
  };
}

describe("createClaudeWorkerRunner", () => {
  it("pipes prompt to stdin, output to logPath, clean exit → ok", async () => {
    const runner = createClaudeWorkerRunner();
    // Read stdin, echo it, exit 0.
    const cmd = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('GOT:'+d);process.exit(0)})"`;
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("ok");
    const log = readFileSync(path.join(dir, "out.log"), "utf8");
    expect(log).toContain("GOT:PROMPT_MARKER");
  });

  it("a sleep beyond a tiny budget → timeout", async () => {
    const runner = createClaudeWorkerRunner();
    // Sleep 10s; budget 1s → killed.
    const cmd = `node -e "setTimeout(()=>{},10000)"`;
    const result = await runner.run(baseInput(cmd, 1));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("timeout");
  }, 15_000);

  it("a bogus command → spawn_error or nonzero_exit", async () => {
    const runner = createClaudeWorkerRunner();
    const result = await runner.run(baseInput("this-command-definitely-does-not-exist-xyz", 30));
    expect(result.kind).toBe("error");
    // shell:true → a missing binary usually surfaces as a non-zero shell exit,
    // not a Node spawn 'error'. Accept either failure classification.
    if (result.kind === "error") {
      expect(["spawn_error", "nonzero_exit"]).toContain(result.reason);
    }
  });

  it("a non-zero exit → nonzero_exit", async () => {
    const runner = createClaudeWorkerRunner();
    const cmd = `node -e "process.exit(1)"`;
    const result = await runner.run(baseInput(cmd, 30));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.reason).toBe("nonzero_exit");
  });
});
