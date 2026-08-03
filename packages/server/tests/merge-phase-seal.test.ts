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

  it("metrics.service is the ONLY service allowed to import it (P3 aggregates these rows)", () => {
    // Scans every service, not just the merge path: the allowance is a
    // WHITELIST, so a new consumer has to come here and justify itself.
    const dir = path.join(SRC, "services");
    const importers = readdirSync(dir)
      .filter((f) => f.endsWith(".service.ts") || f.endsWith(".ts"))
      .filter((f) => f !== "merge-phase.service.ts")
      .filter((f) => read(path.join(dir, f)).includes("merge-phase.service.js"));
    expect(importers.filter((f) => f !== "metrics.service.ts")).toEqual([]);
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
