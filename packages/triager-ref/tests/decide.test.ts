import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { createTriageDecide } from "../src/decide.js";
import type { InjectionSniffer, InjectionSniffResult } from "../src/injection-sniffer.js";
import type { AssessmentRunner, AssessmentResult } from "../src/assessment-runner.js";
import type { TriageAssessment } from "../src/decision.js";
import type { Note } from "@pm/shared";
import type { Logger } from "../src/logger.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const LOGS_DIR = path.join(os.tmpdir(), "triager-logs");

function mkNote(over: Partial<Note> = {}): Note {
  return {
    id: "n-1",
    projectId: "p",
    kind: "bug",
    status: "open",
    title: "t",
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

function sniffer(verdict: InjectionSniffResult): {
  sniffer: InjectionSniffer;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async () => verdict);
  return { sniffer: { sniff: spy }, spy };
}

function runner(result: AssessmentResult): {
  runner: AssessmentRunner;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async () => result);
  return { runner: { run: spy }, spy };
}

function deps(s: InjectionSniffer, r: AssessmentRunner) {
  return {
    sniffer: s,
    runner: r,
    logsDir: LOGS_DIR,
    command: "claude -p",
    budget: { timeBudgetSec: 60 },
    logger: silentLogger,
  };
}

const ctx = { projectId: "p", resolved: { enabled: true, mode: "on" as const } };

describe("createTriageDecide", () => {
  it("sniff suspicious ⇒ needs_human; runner NEVER called", async () => {
    const s = sniffer({ kind: "suspicious", reason: "coercion" });
    const r = runner({ kind: "give_up", rationale: "", confidence: 0 });
    const decide = createTriageDecide(deps(s.sniffer, r.runner));
    const out = await decide({ note: mkNote(), ...ctx });
    expect(out.kind).toBe("needs_human");
    expect(out.rationale).toContain("injection-suspected");
    expect(out.rationale).toContain("coercion");
    expect(out.confidence).toBe(0);
    expect(r.spy).not.toHaveBeenCalled();
  });

  it("sniff error/timeout ⇒ needs_human; runner NEVER called", async () => {
    const s = sniffer({ kind: "error", reason: "timeout" });
    const r = runner({ kind: "give_up", rationale: "", confidence: 0 });
    const decide = createTriageDecide(deps(s.sniffer, r.runner));
    const out = await decide({ note: mkNote(), ...ctx });
    expect(out.kind).toBe("needs_human");
    expect(r.spy).not.toHaveBeenCalled();
  });

  it("sniff clean ⇒ runner is invoked", async () => {
    const s = sniffer({ kind: "clean" });
    const r = runner({ kind: "dismiss", rationale: "no merit", confidence: 0.9 });
    const decide = createTriageDecide(deps(s.sniffer, r.runner));
    await decide({ note: mkNote(), ...ctx });
    expect(r.spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: "promote_standard", rationale: "r", confidence: 0.5 },
    { kind: "dismiss", rationale: "r", confidence: 0.5 },
    { kind: "needs_human", rationale: "r", confidence: 0.5 },
    { kind: "give_up", rationale: "r", confidence: 0.5 },
    {
      kind: "promote_fast_track",
      rationale: "r",
      confidence: 0.5,
      breakdown: { tasks: [{ title: "t1" }] },
    },
  ] as TriageAssessment[])(
    "a clean run passes the agent's %s through unchanged",
    async (assessment) => {
      const s = sniffer({ kind: "clean" });
      const r = runner(assessment);
      const decide = createTriageDecide(deps(s.sniffer, r.runner));
      const out = await decide({ note: mkNote(), ...ctx });
      expect(out).toEqual(assessment);
    },
  );

  it("runner error ⇒ fail-safe needs_human (confidence 0)", async () => {
    const s = sniffer({ kind: "clean" });
    const r = runner({ kind: "error", reason: "spawn_error" });
    const decide = createTriageDecide(deps(s.sniffer, r.runner));
    const out = await decide({ note: mkNote(), ...ctx });
    expect(out.kind).toBe("needs_human");
    expect(out.rationale).toContain("assessment-session-failed");
    expect(out.confidence).toBe(0);
  });

  it("the sniff + assess paths land under logsDir (sentinels OUTSIDE git)", async () => {
    const sniffSpy = vi.fn(async () => ({ kind: "clean" }) as InjectionSniffResult);
    const runSpy = vi.fn(
      async () => ({ kind: "give_up", rationale: "", confidence: 0 }) as AssessmentResult,
    );
    const decide = createTriageDecide(deps({ sniff: sniffSpy }, { run: runSpy }));
    await decide({ note: mkNote({ id: "weird/id:1" }), ...ctx });
    const sniffArg = sniffSpy.mock.calls[0][0];
    const runArg = runSpy.mock.calls[0][0];
    expect(path.dirname(sniffArg.statusPath)).toBe(LOGS_DIR);
    expect(path.dirname(sniffArg.logPath)).toBe(LOGS_DIR);
    expect(path.dirname(runArg.statusPath)).toBe(LOGS_DIR);
    expect(path.dirname(runArg.logPath)).toBe(LOGS_DIR);
    // id sanitized into the filename (no path separators / colons leak through).
    expect(sniffArg.statusPath).not.toContain("weird/id:1");
  });

  it("is side-effect-free: no record/promote/dismiss/flag on any dependency", () => {
    // The deps surface is sniffer + runner ONLY — there is no client/record seam
    // wired into decide in P3 (execution is P4). Structurally there is nothing to
    // call.
    const d = deps(
      sniffer({ kind: "clean" }).sniffer,
      runner({ kind: "give_up", rationale: "", confidence: 0 }).runner,
    );
    expect(d).not.toHaveProperty("client");
    expect(d).not.toHaveProperty("recordTriageDecision");
  });
});
