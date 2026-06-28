import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createClaudeInjectionSniffer,
  buildSnifferPrompt,
  type InjectionSniffInput,
} from "../src/injection-sniffer.js";
import type { Note } from "@pm/shared";

function mkNote(over: Partial<Note> = {}): Note {
  return {
    id: "n-1",
    projectId: "p",
    kind: "bug",
    status: "open",
    title: "the build fails on step 2",
    body: "stack trace attached in the body",
    anchorType: null,
    anchorId: null,
    codeLocator: null,
    severity: null,
    authorId: "human",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    triagedAt: null,
    triagedBy: null,
    triageOutcome: null,
    triageReason: null,
    promotedProposalId: null,
    promotedTaskId: null,
    ...over,
  };
}

/**
 * A per-test harness with its OWN temp dir. Each test owns its dir — there is NO
 * shared module-level state — so the spawn tests are safe even if vitest runs them
 * concurrently (a shared `dir` would let one test's child write into another's
 * statusPath). The spawned child's cwd is a STABLE dir (tmpdir(), never deleted),
 * so a lingering/just-killed child never races cleanup into EPERM; cleanup still
 * retries to ride out any transient Windows file-handle hold on the script file.
 */
function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "triager-sniffer-"));
  return {
    dir,
    input(timeBudgetSec: number): InjectionSniffInput {
      return {
        note: mkNote(),
        budget: { timeBudgetSec },
        cwd: tmpdir(),
        logPath: path.join(dir, "out.log"),
        statusPath: path.join(dir, "status.json"),
      };
    },
    /**
     * An agent simulator: a `node <script>` command whose script reads stdin
     * (echoing it to stdout so the test can assert prompt → stdin → log) and writes
     * its sentinel payload to PM_TRIAGE_STATUS_PATH — the lockstep-renamed env var
     * the sniffer injects (per-spawn, unique). The payload is BAKED into the script
     * file via JSON.stringify (a script FILE, not `node -e`, so no shell-quoting
     * hazard) — no shared payload env var, so no cross-file process.env race.
     */
    sentinelCmd(sentinel: string): string {
      const script = path.join(dir, `agent-${Math.random().toString(36).slice(2)}.cjs`);
      writeFileSync(
        script,
        `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{` +
          `process.stdout.write('GOT:'+d);` +
          `require('fs').writeFileSync(process.env.PM_TRIAGE_STATUS_PATH, ${JSON.stringify(sentinel)});` +
          `process.exit(0)});`,
      );
      return `node "${script}"`;
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

async function withHarness(
  fn: (h: ReturnType<typeof makeHarness>) => Promise<void>,
): Promise<void> {
  const h = makeHarness();
  try {
    await fn(h);
  } finally {
    h.cleanup();
  }
}

describe("createClaudeInjectionSniffer", () => {
  it("clean ⇒ clean (and log got the prompt via stdin)", () =>
    withHarness(async (h) => {
      // The sniffer command is fixed at CONSTRUCTION (cfg.command) — the input
      // carries no command — so the node-script double goes to the constructor.
      const sniffer = createClaudeInjectionSniffer({
        command: h.sentinelCmd(JSON.stringify({ status: "clean" })),
      });
      const result = await sniffer.sniff(h.input(30));
      expect(result.kind).toBe("clean");
      const log = readFileSync(path.join(h.dir, "out.log"), "utf8");
      expect(log).toContain("GOT:");
      expect(log).toContain("PM_TRIAGE_STATUS_PATH");
    }));

  it("suspicious ⇒ suspicious + reason", () =>
    withHarness(async (h) => {
      const sniffer = createClaudeInjectionSniffer({
        command: h.sentinelCmd(
          JSON.stringify({ status: "suspicious", reason: "override attempt" }),
        ),
      });
      const result = await sniffer.sniff(h.input(30));
      expect(result.kind).toBe("suspicious");
      if (result.kind === "suspicious") expect(result.reason).toBe("override attempt");
    }));

  it(
    "sleep beyond a tiny budget ⇒ error(timeout)",
    () =>
      withHarness(async (h) => {
        const sniffer = createClaudeInjectionSniffer({
          command: `node -e "setTimeout(()=>{},10000)"`,
        });
        const result = await sniffer.sniff(h.input(1));
        expect(result.kind).toBe("error");
        if (result.kind === "error") expect(result.reason).toBe("timeout");
      }),
    30_000,
  );

  it("a bogus command ⇒ error(spawn_error)", () =>
    withHarness(async (h) => {
      const sniffer = createClaudeInjectionSniffer({
        command: "this-command-definitely-does-not-exist-xyz",
      });
      const result = await sniffer.sniff(h.input(30));
      expect(result.kind).toBe("error");
    }));

  it("garbage (non-JSON) sentinel ⇒ error", () =>
    withHarness(async (h) => {
      const sniffer = createClaudeInjectionSniffer({ command: h.sentinelCmd("not json") });
      const result = await sniffer.sniff(h.input(30));
      expect(result.kind).toBe("error");
    }));

  it("absent sentinel on a clean exit-0 ⇒ error (NOT clean)", () =>
    withHarness(async (h) => {
      const sniffer = createClaudeInjectionSniffer({ command: `node -e "process.exit(0)"` });
      const result = await sniffer.sniff(h.input(30));
      expect(result.kind).toBe("error");
    }));

  it("a stale sentinel is removed before spawn (no false clean:STALE)", () =>
    withHarness(async (h) => {
      const sniffer = createClaudeInjectionSniffer({ command: `node -e "process.exit(0)"` });
      const input = h.input(30);
      writeFileSync(input.statusPath, JSON.stringify({ status: "clean" }));
      const result = await sniffer.sniff(input);
      expect(result.kind).toBe("error");
    }));
});

describe("buildSnifferPrompt", () => {
  it("includes the note's title/body + 'prefer suspicious' + the PM_TRIAGE_STATUS_PATH sentinel line", () => {
    const note = mkNote({ title: "TITLE_MARKER", body: "BODY_MARKER" });
    const out = buildSnifferPrompt(note);
    expect(out).toContain("TITLE_MARKER");
    expect(out).toContain("BODY_MARKER");
    expect(out).toContain("prefer suspicious");
    expect(out).toContain("PM_TRIAGE_STATUS_PATH");
    expect(out).toContain('"status":"clean"');
    expect(out).toContain('"status":"suspicious"');
  });
});
