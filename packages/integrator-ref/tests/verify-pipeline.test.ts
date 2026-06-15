/**
 * Phase 7.5 Step 5 — unit tests for the pure verify-pipeline DAG executor.
 *
 * `runPipeline` is exercised against a FAKE GitOps whose `runVerify` records
 * { stepCommand, logPath, startMs, endMs, signal } and returns a CONFIGURABLE
 * VerifyResult (per-command). Timing-based overlap assertions reuse the
 * batch.test.ts pattern: two CONCURRENT steps have latest-start < earliest-end.
 *
 * Win32 idioms are unnecessary here (no real shell — the fake never spawns), but
 * the result shapes mirror git-ops VerifyResult exactly.
 *
 * fileParallelism:false is already configured for this package.
 */
import { describe, expect, it } from "vitest";
import type { GitOps, VerifyResult, RunVerifyOptions } from "../src/git-ops.js";
import { runPipeline, type PipelineCtx } from "../src/verify-pipeline.js";
import { classifyVerifyFailure } from "../src/categorize.js";
import type { VerifyStep } from "@pm/shared";

// ── A recorded runVerify invocation. ──
interface VerifyCall {
  command: string;
  logPath: string;
  startMs: number;
  endMs: number;
  aborted: boolean; // was the passed signal aborted by the time it resolved?
}

// Per-command behavior the fake honors.
interface StepBehavior {
  /** ms the step "runs" before resolving (simulated work). Default 5. */
  durationMs?: number;
  /** the result the step resolves to (when NOT aborted first). */
  result: VerifyResult;
}

function okResult(logPath: string): VerifyResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    logPath,
  };
}

function realFailResult(logPath: string): VerifyResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "boom",
    durationMs: 1,
    timedOut: false,
    logPath,
  };
}

// A SIGTERM/abort-casualty shape (what a child killed by the per-pass controller
// reports): exitCode:null + signal:SIGTERM, NOT timedOut.
function sigtermResult(logPath: string): VerifyResult {
  return {
    exitCode: null as unknown as number,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    logPath,
  };
}

/**
 * Build a fake GitOps whose runVerify:
 *  - records the call (command, logPath, timing, whether its signal aborted),
 *  - waits `durationMs`, but RESOLVES EARLY (via the abort-casualty result) the
 *    moment its passed signal aborts — mirroring how a real killed child settles
 *    quickly after SIGTERM.
 * `behaviors` maps command → StepBehavior. `onAbortResult(command, logPath)`
 * supplies what an aborted step resolves to (default sigtermResult).
 */
function makeFakeGitOps(
  behaviors: Record<string, StepBehavior>,
  calls: VerifyCall[],
  onAbortResult: (command: string, logPath: string) => VerifyResult = (_c, lp) => sigtermResult(lp),
): GitOps {
  const runVerify = (
    command: string,
    _timeoutMs: number,
    opts: RunVerifyOptions,
  ): Promise<VerifyResult> => {
    const startMs = performance.now();
    const behavior = behaviors[command];
    const durationMs = behavior?.durationMs ?? 5;
    const signal = opts.signal;

    return new Promise<VerifyResult>((resolve) => {
      let settled = false;
      const finish = (result: VerifyResult, aborted: boolean): void => {
        if (settled) return;
        settled = true;
        const endMs = performance.now();
        calls.push({
          command,
          logPath: opts.logPath,
          startMs,
          endMs,
          aborted,
        });
        resolve(result);
      };

      if (signal?.aborted) {
        finish(onAbortResult(command, opts.logPath), true);
        return;
      }
      const timer = setTimeout(() => {
        finish(behavior?.result ?? okResult(opts.logPath), signal?.aborted ?? false);
      }, durationMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          finish(onAbortResult(command, opts.logPath), true);
        },
        { once: true },
      );
    });
  };

  // Only runVerify is exercised; the rest throw if touched (they must not be).
  return new Proxy({ runVerify } as Partial<GitOps>, {
    get(target, prop) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      return () => {
        throw new Error(`unexpected GitOps.${String(prop)} call`);
      };
    },
  }) as GitOps;
}

function ctxFor(gitOps: GitOps, overrides: Partial<PipelineCtx> = {}): PipelineCtx {
  return {
    gitOps,
    cwd: "/wt",
    verifyTimeoutSec: 600,
    logsDir: "/logs",
    attemptId: "att-1",
    ...overrides,
  };
}

const step = (id: string, command: string, depends_on: string[] = []): VerifyStep => ({
  id,
  command,
  depends_on,
  cache_key_inputs: [],
});

describe("runPipeline (Phase 7.5 Step 5)", () => {
  it("1. topo order: format → {lint,typecheck} → unit (waves; middle pair concurrent)", async () => {
    const calls: VerifyCall[] = [];
    const behaviors: Record<string, StepBehavior> = {
      "cmd-format": { durationMs: 15, result: okResult("") },
      "cmd-lint": { durationMs: 20, result: okResult("") },
      "cmd-typecheck": { durationMs: 20, result: okResult("") },
      "cmd-unit": { durationMs: 15, result: okResult("") },
    };
    const gitOps = makeFakeGitOps(behaviors, calls);
    const steps: VerifyStep[] = [
      step("format", "cmd-format"),
      step("lint", "cmd-lint", ["format"]),
      step("typecheck", "cmd-typecheck", ["format"]),
      step("unit", "cmd-unit", ["lint", "typecheck"]),
    ];

    const res = await runPipeline(steps, ctxFor(gitOps));
    expect(res.outcome).toBe("pass");
    expect(res.steps.map((s) => s.stepId).sort()).toEqual(["format", "lint", "typecheck", "unit"]);

    const byCmd = (c: string) => calls.find((k) => k.command === c)!;
    const format = byCmd("cmd-format");
    const lint = byCmd("cmd-lint");
    const tc = byCmd("cmd-typecheck");
    const unit = byCmd("cmd-unit");

    // format completes before lint/typecheck start (wave boundary).
    expect(format.endMs).toBeLessThanOrEqual(lint.startMs);
    expect(format.endMs).toBeLessThanOrEqual(tc.startMs);
    // lint + typecheck OVERLAP: latest-start < earliest-end.
    expect(Math.max(lint.startMs, tc.startMs)).toBeLessThan(Math.min(lint.endMs, tc.endMs));
    // unit starts after both lint and typecheck finished.
    expect(unit.startMs).toBeGreaterThanOrEqual(lint.endMs);
    expect(unit.startMs).toBeGreaterThanOrEqual(tc.endMs);
  });

  it("2. parallel overlap: two independent steps run concurrently", async () => {
    const calls: VerifyCall[] = [];
    const behaviors: Record<string, StepBehavior> = {
      "cmd-a": { durationMs: 25, result: okResult("") },
      "cmd-b": { durationMs: 25, result: okResult("") },
    };
    const gitOps = makeFakeGitOps(behaviors, calls);
    const steps = [step("a", "cmd-a"), step("b", "cmd-b")];

    const res = await runPipeline(steps, ctxFor(gitOps));
    expect(res.outcome).toBe("pass");
    const a = calls.find((k) => k.command === "cmd-a")!;
    const b = calls.find((k) => k.command === "cmd-b")!;
    expect(Math.max(a.startMs, b.startMs)).toBeLessThan(Math.min(a.endMs, b.endMs));
  });

  it("3. fail-fast short-circuit: a wave-1 fail means the downstream step never runs", async () => {
    const calls: VerifyCall[] = [];
    const behaviors: Record<string, StepBehavior> = {
      "cmd-cheap": { durationMs: 2, result: realFailResult("") },
      "cmd-expensive": { durationMs: 5000, result: okResult("") },
    };
    const gitOps = makeFakeGitOps(behaviors, calls);
    // expensive depends on cheap → cheap fails in wave 1 → expensive never starts.
    const steps = [step("cheap", "cmd-cheap"), step("expensive", "cmd-expensive", ["cheap"])];

    const res = await runPipeline(steps, ctxFor(gitOps));
    expect(res.outcome).toBe("fail");
    expect(res.failingStep!.stepId).toBe("cheap");
    expect(calls.some((k) => k.command === "cmd-expensive")).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("4. failingStep is the real-exit-1 TRIGGER, not the SIGTERM abort-casualty", async () => {
    const calls: VerifyCall[] = [];
    // Step A resolves FAST with a clean exit:1 (the real fail / trigger).
    // Step B is slow; when A aborts the pass, B resolves as a SIGTERM casualty.
    const behaviors: Record<string, StepBehavior> = {
      "cmd-A": { durationMs: 2, result: realFailResult("") },
      "cmd-B": { durationMs: 5000, result: okResult("") },
    };
    const gitOps = makeFakeGitOps(behaviors, calls);
    const steps = [step("A", "cmd-A"), step("B", "cmd-B")];

    const res = await runPipeline(steps, ctxFor(gitOps));
    expect(res.outcome).toBe("fail");
    // The TRIGGER must be A (exitCode 1), NOT B (the abort-casualty SIGTERM).
    expect(res.failingStep!.stepId).toBe("A");
    expect(res.failingStep!.verify.exitCode).toBe(1);
    expect(res.failingStep!.verify.signal).toBe(null);
    // B did run (concurrently) and was aborted — present in steps but NOT the trigger.
    const bResult = res.steps.find((s) => s.stepId === "B");
    expect(bResult).toBeDefined();
    expect(bResult!.verify.signal).toBe("SIGTERM");
  });

  it("5a. multi-step pipeline: each step gets a DISTINCT suffixed logPath", async () => {
    const calls: VerifyCall[] = [];
    const behaviors: Record<string, StepBehavior> = {
      "cmd-x": { durationMs: 10, result: okResult("") },
      "cmd-y": { durationMs: 10, result: okResult("") },
    };
    const gitOps = makeFakeGitOps(behaviors, calls);
    const steps = [step("x", "cmd-x"), step("y", "cmd-y")];

    await runPipeline(steps, ctxFor(gitOps));
    const logPaths = calls.map((c) => c.logPath);
    expect(new Set(logPaths).size).toBe(2); // no two concurrent steps share a path
    expect(logPaths.some((p) => p.includes("att-1-x"))).toBe(true);
    expect(logPaths.some((p) => p.includes("att-1-y"))).toBe(true);
  });

  it("5b. single synthetic 'verify' step: EXACT bare logPathFor path (no suffix)", async () => {
    const calls: VerifyCall[] = [];
    const behaviors: Record<string, StepBehavior> = {
      "cmd-v": { durationMs: 5, result: okResult("") },
    };
    const gitOps = makeFakeGitOps(behaviors, calls);
    const steps = [step("verify", "cmd-v")];

    await runPipeline(steps, ctxFor(gitOps));
    expect(calls.length).toBe(1);
    // path.join("/logs", "att-1.log") — bare today path, NO stepId suffix.
    expect(calls[0].logPath.replace(/\\/g, "/")).toBe("/logs/att-1.log");
  });

  it("8. member-signal abort propagates to the in-flight step's child signal", async () => {
    const calls: VerifyCall[] = [];
    const behaviors: Record<string, StepBehavior> = {
      "cmd-slow": { durationMs: 5000, result: okResult("") },
    };
    const gitOps = makeFakeGitOps(behaviors, calls);
    const parent = new AbortController();
    const steps = [step("slow", "cmd-slow")];

    const p = runPipeline(steps, ctxFor(gitOps, { signal: parent.signal }));
    // Abort the PARENT (member signal) mid-flight; the per-pass child must abort
    // → the in-flight step resolves via the abort path.
    setTimeout(() => parent.abort(), 10);
    const res = await p;
    expect(calls[0].aborted).toBe(true);
    // The step resolved as a fail (SIGTERM casualty); runPipeline reports fail.
    expect(res.outcome).toBe("fail");
  });

  it("9. cycle defense: a cyclic steps array returns a real-fail failingStep, no hang", async () => {
    const calls: VerifyCall[] = [];
    const gitOps = makeFakeGitOps({}, calls);
    // a → b → a (cycle): neither has indegree 0 → wave is empty on entry.
    const steps = [step("a", "cmd-a", ["b"]), step("b", "cmd-b", ["a"])];

    const res = await runPipeline(steps, ctxFor(gitOps));
    expect(res.outcome).toBe("fail");
    expect(res.failingStep).not.toBe(null);
    expect(res.failingStep!.verify.exitCode).toBe(1);
    expect(res.failingStep!.verify.timedOut).toBe(false);
    expect(res.failingStep!.verify.stderr).toMatch(/dependency cycle/);
    // No step ever ran.
    expect(calls.length).toBe(0);
  });

  it("backward-compat: single passing synthetic step → outcome pass, one call", async () => {
    const calls: VerifyCall[] = [];
    const behaviors: Record<string, StepBehavior> = {
      "echo ok": { durationMs: 3, result: okResult("") },
    };
    const gitOps = makeFakeGitOps(behaviors, calls);
    const res = await runPipeline([step("verify", "echo ok")], ctxFor(gitOps));
    expect(res.outcome).toBe("pass");
    expect(res.failingStep).toBe(null);
    expect(calls.length).toBe(1);
    expect(calls[0].command).toBe("echo ok");
  });
});

// ════════════════════════════════════════════════════════════════════
// Phase 7.5 Step 6 — cache-aware runStep + shadow mode.
// ════════════════════════════════════════════════════════════════════
import type { VerifyCacheRowView, CacheMode } from "@pm/shared";
import type { PipelineCacheCtx } from "../src/verify-pipeline.js";
import { stepConfigSha } from "../src/step-config-sha.js";

type LookupKey = {
  resource: string;
  treeSha: string;
  stepId: string;
  stepConfigSha: string;
};
type RecordEntry = LookupKey & {
  result: "pass" | "fail";
  durationMs?: number | null;
  logExcerpt?: string | null;
  logUrl?: string | null;
};
type MismatchBody = LookupKey & {
  cachedResult: "pass" | "fail";
  realResult: "pass" | "fail";
  requestId?: string;
  attemptId?: string;
};

const keyOf = (k: LookupKey): string => [k.resource, k.treeSha, k.stepId, k.stepConfigSha].join(" ");

interface CacheCalls {
  lookups: LookupKey[];
  records: RecordEntry[];
  mismatches: MismatchBody[];
}

/**
 * An in-memory fake of the 3 cache pmClient methods keyed by the 5-tuple. `record`
 * is a write-or-update that PRESERVES created_at + hit_count on a re-record (the
 * self-heal semantics). `lookup` returns the row and bumps hit_count/last_hit_at.
 * `throwOn` makes a given method throw (best-effort I/O test). Spies via CacheCalls.
 */
function makeFakeCacheClient(
  seed: RecordEntry[] = [],
  throwOn: Partial<Record<"lookup" | "record" | "mismatch", boolean>> = {},
): {
  client: PipelineCacheCtx["pmClient"];
  calls: CacheCalls;
  rows: Map<string, VerifyCacheRowView>;
} {
  const rows = new Map<string, VerifyCacheRowView>();
  const calls: CacheCalls = { lookups: [], records: [], mismatches: [] };

  const upsert = (e: RecordEntry): VerifyCacheRowView => {
    const id = keyOf(e);
    const existing = rows.get(id);
    const row: VerifyCacheRowView = {
      id,
      projectId: "proj-1",
      resource: e.resource,
      treeSha: e.treeSha,
      stepId: e.stepId,
      stepConfigSha: e.stepConfigSha,
      result: e.result,
      durationMs: e.durationMs ?? null,
      logExcerpt: e.logExcerpt ?? null,
      logUrl: e.logUrl ?? null,
      // PRESERVE created_at + hit_count on a re-record (the self-heal).
      createdAt: existing?.createdAt ?? "2026-05-30T00:00:00.000Z",
      lastHitAt: existing?.lastHitAt ?? null,
      hitCount: existing?.hitCount ?? 0,
      updatedAt: "2026-05-30T00:00:01.000Z",
    };
    rows.set(id, row);
    return row;
  };
  for (const s of seed) upsert(s);

  const client: PipelineCacheCtx["pmClient"] = {
    async lookupVerifyCache(_projectId, key) {
      calls.lookups.push(key);
      if (throwOn.lookup) throw new Error("lookup boom");
      const row = rows.get(keyOf(key));
      if (!row) return null;
      // Server-side hit bump.
      row.hitCount += 1;
      row.lastHitAt = "2026-05-30T00:00:02.000Z";
      return row;
    },
    async recordVerifyCache(_projectId, entry) {
      calls.records.push(entry);
      if (throwOn.record) throw new Error("record boom");
      return upsert(entry);
    },
    async emitVerifyCacheMismatch(_projectId, mismatch) {
      calls.mismatches.push(mismatch);
      if (throwOn.mismatch) throw new Error("mismatch boom");
    },
  };
  return { client, calls, rows };
}

const TREE = "tree-aaa";
function cacheCtx(
  client: PipelineCacheCtx["pmClient"],
  mode: CacheMode,
  overrides: Partial<PipelineCacheCtx> = {},
): PipelineCacheCtx {
  return {
    enabled: true,
    mode,
    pmClient: client,
    projectId: "proj-1",
    resource: "main",
    treeSha: TREE,
    requestId: "req-1",
    ...overrides,
  };
}

// A seed row helper for a given step id (uses the REAL stepConfigSha so the
// strict-key probe matches).
function seedRow(
  stepId: string,
  command: string,
  result: "pass" | "fail",
  extra: Partial<RecordEntry> = {},
): RecordEntry {
  return {
    resource: "main",
    treeSha: TREE,
    stepId,
    stepConfigSha: stepConfigSha({ command, cache_key_inputs: [] }),
    result,
    durationMs: 1234,
    ...extra,
  };
}

describe("runPipeline cache-aware (Phase 7.5 Step 6)", () => {
  it("1. off-mode no-op: cache undefined → never looks up, runs every step", async () => {
    const calls: VerifyCall[] = [];
    const gitOps = makeFakeGitOps(
      { "cmd-a": { result: okResult("") }, "cmd-b": { result: okResult("") } },
      calls,
    );
    const { client, calls: cc } = makeFakeCacheClient();
    // cache: undefined
    const res1 = await runPipeline([step("a", "cmd-a"), step("b", "cmd-b", ["a"])], ctxFor(gitOps));
    expect(res1.outcome).toBe("pass");
    expect(calls.length).toBe(2);
    expect(cc.lookups.length).toBe(0);

    // cache: { enabled:true, mode:"off" } — STILL a true no-op.
    const calls2: VerifyCall[] = [];
    const gitOps2 = makeFakeGitOps(
      { "cmd-a": { result: okResult("") }, "cmd-b": { result: okResult("") } },
      calls2,
    );
    const res2 = await runPipeline(
      [step("a", "cmd-a"), step("b", "cmd-b", ["a"])],
      ctxFor(gitOps2, { cache: cacheCtx(client, "off") }),
    );
    expect(res2.outcome).toBe("pass");
    expect(calls2.length).toBe(2);
    expect(cc.lookups.length).toBe(0);
    expect(cc.records.length).toBe(0);
  });

  it("2. on-mode HIT skips the real run, outcome from the row, no record", async () => {
    const calls: VerifyCall[] = [];
    const gitOps = makeFakeGitOps({ "cmd-a": { result: okResult("") } }, calls);
    const { client, calls: cc } = makeFakeCacheClient([
      seedRow("a", "cmd-a", "pass", { durationMs: 777 }),
    ]);
    const res = await runPipeline(
      [step("a", "cmd-a")],
      ctxFor(gitOps, { cache: cacheCtx(client, "on") }),
    );
    expect(res.outcome).toBe("pass");
    // The hit step NEVER ran.
    expect(calls.length).toBe(0);
    const sr = res.steps[0];
    expect(sr.cached).toBe(true);
    expect(sr.outcome).toBe("pass");
    expect(sr.durationMs).toBe(777);
    expect(sr.treeSha).toBe(TREE);
    // NO record on a HIT.
    expect(cc.records.length).toBe(0);
    expect(cc.lookups.length).toBe(1);
  });

  it("3. on-mode MISS runs + records the EXACT verdict body", async () => {
    const calls: VerifyCall[] = [];
    const gitOps = makeFakeGitOps(
      { "cmd-a": { result: { ...okResult("/l/a.log"), durationMs: 42 } } },
      calls,
    );
    const { client, calls: cc } = makeFakeCacheClient(); // empty → MISS
    const res = await runPipeline(
      [step("a", "cmd-a")],
      ctxFor(gitOps, { cache: cacheCtx(client, "on") }),
    );
    expect(res.outcome).toBe("pass");
    expect(calls.length).toBe(1); // the MISS ran.
    expect(cc.records.length).toBe(1);
    const rec = cc.records[0];
    expect(rec.resource).toBe("main");
    expect(rec.treeSha).toBe(TREE);
    expect(rec.stepId).toBe("a");
    expect(rec.stepConfigSha).toBe(stepConfigSha({ command: "cmd-a", cache_key_inputs: [] }));
    expect(rec.result).toBe("pass");
    expect(rec.durationMs).toBe(42);
  });

  it("4. SHADOW always runs + mismatch + uses the REAL verdict (false-pass detector)", async () => {
    const calls: VerifyCall[] = [];
    // The cached row says PASS, but the REAL run FAILS.
    const gitOps = makeFakeGitOps({ "cmd-a": { result: realFailResult("") } }, calls);
    const { client, calls: cc } = makeFakeCacheClient([seedRow("a", "cmd-a", "pass")]);
    const res = await runPipeline(
      [step("a", "cmd-a")],
      ctxFor(gitOps, { cache: cacheCtx(client, "shadow") }),
    );
    // (a) the real run DID execute.
    expect(calls.length).toBe(1);
    // (b) a mismatch fired with the disagreement.
    expect(cc.mismatches.length).toBe(1);
    expect(cc.mismatches[0].cachedResult).toBe("pass");
    expect(cc.mismatches[0].realResult).toBe("fail");
    // (c) the pipeline outcome is the REAL verdict (fail), NOT the cached pass.
    expect(res.outcome).toBe("fail");
    // (d) the REAL verdict was recorded (the self-heal).
    expect(cc.records.length).toBe(1);
    expect(cc.records[0].result).toBe("fail");
  });

  it("5. shadow MATCH → uses real, NO emit, still records", async () => {
    const calls: VerifyCall[] = [];
    const gitOps = makeFakeGitOps({ "cmd-a": { result: okResult("") } }, calls);
    const { client, calls: cc } = makeFakeCacheClient([seedRow("a", "cmd-a", "pass")]);
    const res = await runPipeline(
      [step("a", "cmd-a")],
      ctxFor(gitOps, { cache: cacheCtx(client, "shadow") }),
    );
    expect(calls.length).toBe(1);
    expect(res.outcome).toBe("pass");
    // hit && agree → NO mismatch.
    expect(cc.mismatches.length).toBe(0);
    // still records the real verdict.
    expect(cc.records.length).toBe(1);
    expect(cc.records[0].result).toBe("pass");
  });

  it("6. strict key: a planted row under a different treeSha/stepConfigSha/stepId → MISS → re-run", async () => {
    const calls: VerifyCall[] = [];
    const gitOps = makeFakeGitOps({ "cmd-a": { result: okResult("") } }, calls);
    // Seed rows that DON'T match the probe: wrong treeSha, wrong stepId, wrong config.
    const { client, calls: cc } = makeFakeCacheClient([
      { ...seedRow("a", "cmd-a", "pass"), treeSha: "OTHER-TREE" },
      seedRow("different-step", "cmd-a", "pass"),
      seedRow("a", "cmd-a-DIFFERENT-COMMAND", "pass"),
    ]);
    const res = await runPipeline(
      [step("a", "cmd-a")],
      ctxFor(gitOps, { cache: cacheCtx(client, "on") }),
    );
    expect(res.outcome).toBe("pass");
    // None of the planted rows matched → MISS → the step RAN.
    expect(calls.length).toBe(1);
    // And the exact probe key was used.
    expect(cc.lookups.length).toBe(1);
    expect(cc.lookups[0]).toEqual({
      resource: "main",
      treeSha: TREE,
      stepId: "a",
      stepConfigSha: stepConfigSha({ command: "cmd-a", cache_key_inputs: [] }),
    });
  });

  it("9. best-effort I/O: lookup throw → MISS (runs); record throw → ignored", async () => {
    // lookup throws → treated as MISS → step runs.
    const calls1: VerifyCall[] = [];
    const gitOps1 = makeFakeGitOps({ "cmd-a": { result: okResult("") } }, calls1);
    const { client: c1 } = makeFakeCacheClient([], { lookup: true });
    const res1 = await runPipeline(
      [step("a", "cmd-a")],
      ctxFor(gitOps1, { cache: cacheCtx(c1, "on") }),
    );
    expect(res1.outcome).toBe("pass");
    expect(calls1.length).toBe(1); // ran (no false hit).

    // record throws → swallowed; the verdict still stands.
    const calls2: VerifyCall[] = [];
    const gitOps2 = makeFakeGitOps({ "cmd-a": { result: okResult("") } }, calls2);
    const { client: c2 } = makeFakeCacheClient([], { record: true });
    const res2 = await runPipeline(
      [step("a", "cmd-a")],
      ctxFor(gitOps2, { cache: cacheCtx(c2, "on") }),
    );
    expect(res2.outcome).toBe("pass");
  });

  it("10. transient (spawnError) on a MISS is NOT recorded", async () => {
    const calls: VerifyCall[] = [];
    const transient: VerifyResult = {
      exitCode: 127,
      signal: null,
      stdout: "",
      stderr: "ENOENT",
      durationMs: 1,
      timedOut: false,
      logPath: "",
      spawnError: "spawn cmd-a ENOENT",
    };
    const gitOps = makeFakeGitOps({ "cmd-a": { result: transient } }, calls);
    const { client, calls: cc } = makeFakeCacheClient(); // MISS
    const res = await runPipeline(
      [step("a", "cmd-a")],
      ctxFor(gitOps, { cache: cacheCtx(client, "on") }),
    );
    // A transient surfaces as a failing step (the pipeline doesn't pass)...
    expect(res.outcome).toBe("fail");
    expect(calls.length).toBe(1);
    // ...but it is NOT a verdict → NOT recorded.
    expect(cc.records.length).toBe(0);
  });

  it("synthesized cached-fail HIT → classifyVerifyFailure 'real' (exitCode 1, !timedOut)", async () => {
    const calls: VerifyCall[] = [];
    const gitOps = makeFakeGitOps({ "cmd-a": { result: okResult("") } }, calls);
    const { client } = makeFakeCacheClient([
      seedRow("a", "cmd-a", "fail", { logExcerpt: "cached boom" }),
    ]);
    const res = await runPipeline(
      [step("a", "cmd-a")],
      ctxFor(gitOps, { cache: cacheCtx(client, "on") }),
    );
    expect(res.outcome).toBe("fail");
    expect(calls.length).toBe(0); // HIT skipped the run.
    const v = res.failingStep!.verify;
    expect(v.exitCode).toBe(1);
    expect(v.timedOut).toBe(false);
    expect(v.signal).toBe(null);
    expect(v.stderr).toBe("cached boom");
    // classifyVerifyFailure → "real" (proven by exitCode:1 + !timedOut + no spawnError).
    expect(classifyVerifyFailure(v)).toBe("real");
  });
});
