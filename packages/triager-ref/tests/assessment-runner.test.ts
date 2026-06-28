import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeAssessmentRunner, type AssessmentRunInput } from "../src/assessment-runner.js";
import { parseAssessmentSentinel, MAX_FAST_TRACK_TASKS } from "../src/decision.js";
import type { Note } from "@pm/shared";

function mkNote(over: Partial<Note> = {}): Note {
  return {
    id: "n-1",
    projectId: "p",
    kind: "bug",
    status: "open",
    title: "the build fails",
    body: null,
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

const PROMPT_MARKER = "PROMPT_MARKER_XYZ";

/**
 * A per-test harness with its OWN temp dir (see injection-sniffer.test.ts) — no
 * shared module-level state, so the spawn tests are concurrency-safe. The child's
 * cwd is a STABLE dir; cleanup retries to ride out transient Windows handle holds.
 * The sentinel payload is BAKED into the script file (no shared payload env var).
 */
function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "triager-assess-"));
  return {
    dir,
    input(command: string, timeBudgetSec: number): AssessmentRunInput {
      return {
        note: mkNote(),
        prompt: PROMPT_MARKER,
        budget: { timeBudgetSec },
        cwd: tmpdir(),
        command,
        logPath: path.join(dir, "out.log"),
        statusPath: path.join(dir, "status.json"),
      };
    },
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

describe("createClaudeAssessmentRunner", () => {
  it.each(["promote_standard", "dismiss", "needs_human", "give_up"] as const)(
    "status %s ⇒ matching TriageAssessment",
    (status) =>
      withHarness(async (h) => {
        const runner = createClaudeAssessmentRunner({});
        const cmd = h.sentinelCmd(JSON.stringify({ status, rationale: "R", confidence: 0.5 }));
        const result = await runner.run(h.input(cmd, 30));
        expect(result.kind).toBe(status);
        if (result.kind === status) {
          expect(result.rationale).toBe("R");
          expect(result.confidence).toBe(0.5);
        }
      }),
  );

  it("promote_fast_track WITH breakdown.tasks ⇒ parsed (capped at 3)", () =>
    withHarness(async (h) => {
      const runner = createClaudeAssessmentRunner({});
      const cmd = h.sentinelCmd(
        JSON.stringify({
          status: "promote_fast_track",
          rationale: "small",
          confidence: 0.9,
          breakdown: {
            tasks: [{ title: "t1" }, { title: "t2" }, { title: "t3" }, { title: "t4" }],
          },
        }),
      );
      const result = await runner.run(h.input(cmd, 30));
      expect(result.kind).toBe("promote_fast_track");
      if (result.kind === "promote_fast_track") {
        expect(result.breakdown?.tasks).toHaveLength(MAX_FAST_TRACK_TASKS);
      }
    }));

  it("promote_fast_track with NO breakdown ⇒ downgraded to promote_standard", () =>
    withHarness(async (h) => {
      const runner = createClaudeAssessmentRunner({});
      const cmd = h.sentinelCmd(
        JSON.stringify({ status: "promote_fast_track", rationale: "r", confidence: 0.5 }),
      );
      const result = await runner.run(h.input(cmd, 30));
      expect(result.kind).toBe("promote_standard");
      if (result.kind === "promote_standard") expect(result.breakdown).toBeUndefined();
    }));

  it(
    "sleep beyond a tiny budget ⇒ error(timeout)",
    () =>
      withHarness(async (h) => {
        const runner = createClaudeAssessmentRunner({});
        const cmd = `node -e "setTimeout(()=>{},10000)"`;
        const result = await runner.run(h.input(cmd, 1));
        expect(result.kind).toBe("error");
        if (result.kind === "error") expect(result.reason).toBe("timeout");
      }),
    30_000,
  );

  it("a bogus command ⇒ error(spawn_error)", () =>
    withHarness(async (h) => {
      const runner = createClaudeAssessmentRunner({});
      const result = await runner.run(h.input("this-command-definitely-does-not-exist-xyz", 30));
      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.reason).toBe("spawn_error");
    }));

  it("garbage (non-JSON) sentinel ⇒ error(spawn_error), never fabricated", () =>
    withHarness(async (h) => {
      const runner = createClaudeAssessmentRunner({});
      const cmd = h.sentinelCmd("not json");
      const result = await runner.run(h.input(cmd, 30));
      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.reason).toBe("spawn_error");
    }));

  it("absent sentinel on a clean exit-0 ⇒ error(spawn_error)", () =>
    withHarness(async (h) => {
      const runner = createClaudeAssessmentRunner({});
      const cmd = `node -e "process.exit(0)"`;
      const result = await runner.run(h.input(cmd, 30));
      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.reason).toBe("spawn_error");
    }));

  it("a stale sentinel is removed before spawn", () =>
    withHarness(async (h) => {
      const runner = createClaudeAssessmentRunner({});
      const input = h.input(`node -e "process.exit(0)"`, 30);
      writeFileSync(
        input.statusPath,
        JSON.stringify({ status: "dismiss", rationale: "STALE", confidence: 1 }),
      );
      const result = await runner.run(input);
      expect(result.kind).toBe("error");
    }));
});

describe("parseAssessmentSentinel", () => {
  it("parses each of the five decision kinds", () => {
    for (const kind of ["promote_standard", "dismiss", "needs_human", "give_up"] as const) {
      const a = parseAssessmentSentinel(
        JSON.stringify({ status: kind, rationale: "x", confidence: 0.3 }),
      );
      expect(a?.kind).toBe(kind);
      expect(a?.rationale).toBe("x");
      expect(a?.confidence).toBe(0.3);
    }
  });

  it("promote_fast_track with tasks keeps the breakdown (capped, epics optional)", () => {
    const a = parseAssessmentSentinel(
      JSON.stringify({
        status: "promote_fast_track",
        rationale: "r",
        confidence: 1,
        breakdown: {
          epics: [{ title: "e1" }],
          tasks: [
            { title: "t1", description: "d1" },
            { title: "t2" },
            { title: "t3" },
            { title: "t4" },
          ],
        },
      }),
    );
    expect(a?.kind).toBe("promote_fast_track");
    expect(a?.breakdown?.tasks).toHaveLength(MAX_FAST_TRACK_TASKS);
    expect(a?.breakdown?.tasks[0]).toEqual({ title: "t1", description: "d1" });
    expect(a?.breakdown?.epics).toHaveLength(1);
  });

  it("promote_fast_track with missing/empty tasks ⇒ downgrade to promote_standard (no breakdown)", () => {
    const missing = parseAssessmentSentinel(
      JSON.stringify({ status: "promote_fast_track", rationale: "r", confidence: 0.5 }),
    );
    expect(missing?.kind).toBe("promote_standard");
    expect(missing?.breakdown).toBeUndefined();

    const empty = parseAssessmentSentinel(
      JSON.stringify({ status: "promote_fast_track", breakdown: { tasks: [] } }),
    );
    expect(empty?.kind).toBe("promote_standard");
  });

  it.each([null, [1, 2, 3], "abc", NaN] as const)("malformed confidence %p ⇒ 0", (bad) => {
    const a = parseAssessmentSentinel(
      JSON.stringify({ status: "dismiss", rationale: "r", confidence: bad }),
    );
    expect(a?.confidence).toBe(0);
  });

  it("out-of-range confidence is clamped to [0,1]", () => {
    expect(
      parseAssessmentSentinel(JSON.stringify({ status: "dismiss", confidence: 5 }))?.confidence,
    ).toBe(1);
    expect(
      parseAssessmentSentinel(JSON.stringify({ status: "dismiss", confidence: -3 }))?.confidence,
    ).toBe(0);
  });

  it("an unrecognized / absent status ⇒ undefined", () => {
    expect(parseAssessmentSentinel(JSON.stringify({ status: "implement" }))).toBeUndefined();
    expect(parseAssessmentSentinel(JSON.stringify({ rationale: "no status" }))).toBeUndefined();
  });

  it("never throws on malformed JSON / non-object ⇒ undefined", () => {
    expect(parseAssessmentSentinel("not json")).toBeUndefined();
    expect(parseAssessmentSentinel("42")).toBeUndefined();
    expect(parseAssessmentSentinel("null")).toBeUndefined();
    expect(parseAssessmentSentinel("[1,2]")).toBeUndefined();
  });
});
