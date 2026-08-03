import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createId } from "@pm/shared";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "./utils.js";
import { mergeAttempts, mergeLocks, mergeRequests } from "../src/db/index.js";
import * as svc from "../src/services/merge-phase.service.js";

// ══════════════════════════════════════════════════════════════════
// DESIGN LOCK 1, sealed at the source: "telemetry is never load-bearing."
//
// The lock is not a discipline the callers must remember — it is a shape. This
// file pins that shape two ways:
//   1. STRUCTURAL — merge-phase.service writes exactly one table and shares no
//      import edge with any merge-path service, so no telemetry code path can
//      reach into a merge and no merge can reach into telemetry.
//   2. BEHAVIOURAL — a full 100-row ingest leaves the merge tables byte-identical.
//
// The naming precedent is responder-seal.test.ts.
// ══════════════════════════════════════════════════════════════════

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PHASE_SERVICE = path.join(SRC, "services/merge-phase.service.ts");
const TRACE_SERVICE = path.join(SRC, "services/train-trace.service.ts");

/** The merge-path services the telemetry store must stay disjoint from. */
const MERGE_PATH_SERVICES = [
  "merge-request",
  "merge-group",
  "merge-attempt",
  "merge-lock",
  "merge-resolution",
] as const;

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("merge-phase seal — the only write", () => {
  it("every insert/update/delete in the service targets merge_phase_timings", () => {
    const source = read(PHASE_SERVICE);
    const targets = [...source.matchAll(/\.(insert|update|delete)\(\s*([A-Za-z0-9_]+)/g)].map(
      (m) => ({ op: m[1]!, table: m[2]! }),
    );

    // The write exists (a vacuous pass would be worse than a failure)...
    expect(targets.some((t) => t.op === "insert")).toBe(true);
    // ...and nothing else is ever written.
    expect(targets.filter((t) => t.table !== "mergePhaseTimings")).toEqual([]);
    expect(targets.filter((t) => t.op !== "insert")).toEqual([]);
  });

  it("the service exports no mutator beyond `record`", () => {
    const exported = Object.entries(svc)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);
    expect(exported).toContain("record");
    expect(exported.filter((k) => /update|delete|remove|purge|prune|land|reject/i.test(k))).toEqual(
      [],
    );
  });
});

describe("merge-phase seal — no import edge with the merge path", () => {
  it("merge-phase.service imports NO merge-path service", () => {
    const source = read(PHASE_SERVICE);
    for (const name of MERGE_PATH_SERVICES) {
      expect(source).not.toContain(`${name}.service.js`);
    }
  });

  it("no merge-path service imports merge-phase.service", () => {
    for (const name of MERGE_PATH_SERVICES) {
      const source = read(path.join(SRC, `services/${name}.service.ts`));
      expect(source, `${name}.service.ts must not import merge-phase.service`).not.toContain(
        "merge-phase.service.js",
      );
    }
  });

  it("only metrics.service + train-trace.service may import it (the request-path whitelist)", () => {
    // Scans every service, not just the merge path: the allowance is a
    // WHITELIST, so a new consumer has to come here and justify itself.
    //
    // metrics.service.ts — P3 aggregates these rows.
    // train-trace.service.ts — P5 merges them into the lane's event feed. It is
    // admitted because its edge is REQUEST-PATH: it runs inside a GET handler,
    // where a throw costs one 500 on an observability read. That is the whole
    // distinction this whitelist encodes, and it is why the events-layer scans
    // below are separate and stricter — a listener runs synchronously inside
    // the emitting service's COMMIT path, where a throw breaks a land.
    const dir = path.join(SRC, "services");
    const importers = readdirSync(dir)
      .filter((f) => f.endsWith(".service.ts") || f.endsWith(".ts"))
      .filter((f) => f !== "merge-phase.service.ts")
      .filter((f) => read(path.join(dir, f)).includes("merge-phase.service.js"));
    expect(importers.sort()).toEqual(["metrics.service.ts", "train-trace.service.ts"]);
  });

  it("phase-line.ts is the ONLY events-layer importer (P6 renders these rows to Discord)", () => {
    // The scan above walks src/services ONLY, so an events-layer import would
    // have escaped it silently — and the events layer is where the risk is: its
    // listeners run SYNCHRONOUSLY inside the emitting service's commit path, so
    // a read that throws there is a read that can break a land.
    //
    // phase-line.ts is allowed because its edge is read-only, guarded (it returns
    // "" on any throw, so a formatter fault costs a stopwatch line and never the
    // narration), and confined to one formatter — design lock 1 survives. A
    // SECOND events importer must come to this seal and justify itself, exactly
    // as metrics.service.ts did.
    //
    // Scoped to src/events on purpose: src/routes/merge-phases.ts legitimately
    // imports the service (it IS the ingest/read surface) and is not scanned.
    const dir = path.join(SRC, "events");
    const importers = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => read(path.join(dir, f)).includes("merge-phase.service.js"));
    expect(importers).toEqual(["phase-line.ts"]);
  });
});

// ══════════════════════════════════════════════════════════════════
// The TRANSITIVE seal (§P5). train-trace.service imports merge-phase.service,
// so from the moment it exists the whitelists above are reachable through it:
// an events-layer listener that imported train-trace.service would touch the
// telemetry store while passing BOTH prior seals, because neither of them names
// the new file. These assertions close that laundering path — the reachability
// rule is "no commit-path code reaches telemetry", not "no commit-path code
// imports one particular filename".
// ══════════════════════════════════════════════════════════════════

describe("train-trace seal — a read that can never write, and can never run in a commit path", () => {
  it("the trace service performs NO write of any kind", () => {
    const source = read(TRACE_SERVICE);
    // Orthogonal to the import seals and deliberately blunter: those constrain
    // WHO may reach the store, this constrains what this file may do to any
    // table at all. A merged read feed has no business owning a write.
    expect(source).not.toContain(".insert(");
    expect(source).not.toContain(".update(");
    expect(source).not.toContain(".delete(");
  });

  it("no events-layer file imports the trace service", () => {
    const dir = path.join(SRC, "events");
    const importers = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => read(path.join(dir, f)).includes("train-trace.service.js"));
    expect(importers).toEqual([]);
  });

  it("no merge-path service imports the trace service", () => {
    for (const name of MERGE_PATH_SERVICES) {
      const source = read(path.join(SRC, `services/${name}.service.ts`));
      expect(source, `${name}.service.ts must not import train-trace.service`).not.toContain(
        "train-trace.service.js",
      );
    }
  });
});

describe("merge-phase seal — a full ingest touches nothing else", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("100 recorded phases leave merge_requests / merge_attempts / merge_locks byte-identical", () => {
    const project = createTestProject(testApp.db);
    const integrator = createTestAiAgent(testApp.db);
    const submitter = createTestUser(testApp.db);
    const ts = new Date().toISOString();

    const requestId = createId();
    testApp.db
      .insert(mergeRequests)
      .values({
        id: requestId,
        projectId: project.id,
        submittedBy: submitter.id,
        status: "integrating",
        enqueuedAt: ts,
        pickedUpAt: ts,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const attemptId = createId();
    testApp.db
      .insert(mergeAttempts)
      .values({
        id: attemptId,
        requestId,
        attemptNumber: 1,
        baseSha: "base1",
        status: "running",
        startedAt: ts,
        createdAt: ts,
      })
      .run();

    testApp.db
      .insert(mergeLocks)
      .values({
        id: createId(),
        projectId: project.id,
        resource: "main",
        holderId: integrator.user.id,
        acquiredAt: ts,
        heartbeatAt: ts,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const snapshot = (): string =>
      JSON.stringify([
        testApp.db.select().from(mergeRequests).all(),
        testApp.db.select().from(mergeAttempts).all(),
        testApp.db.select().from(mergeLocks).all(),
      ]);

    const before = snapshot();

    const result = svc.record(
      project.id,
      {
        resource: "main",
        phases: Array.from({ length: 100 }, (_, i) => ({
          phase: "verify" as const,
          startedAt: new Date(Date.now() - i * 1000).toISOString(),
          durationMs: 1000,
          requestId,
          attemptId,
        })),
      },
      { id: integrator.user.id },
      ts,
    );

    expect(result).toEqual({ recorded: 100, adjusted: 0 });
    expect(snapshot()).toBe(before);
  });
});
