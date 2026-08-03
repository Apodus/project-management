import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import {
  auditLog,
  mergeAttempts,
  mergePhaseTimings,
  mergeRequestGroups,
  mergeRequests,
} from "../../src/db/index.js";
import * as svc from "../../src/services/merge-phase.service.js";
import * as requestSvc from "../../src/services/merge-request.service.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";

// ══════════════════════════════════════════════════════════════════
// merge-phase.service — the append-only phase store + the derived phases.
//
// The through-line of this file is design lock 1: telemetry is never
// load-bearing. Every "wrong but well-formed" input an integrator can send is
// asserted to be RECORDED-AND-COUNTED, never thrown; the only legal throw is a
// 404 for an entity that does not exist.
// ══════════════════════════════════════════════════════════════════

const MIN = 60_000;

// One frozen "now" per test, so seeded offsets are exact rather than drifting by
// the millisecond between helper calls.
let T0 = Date.now();

function iso(offsetMs: number, base = T0): string {
  return new Date(base + offsetMs).toISOString();
}

describe("merge-phase service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    T0 = Date.now();
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  /** A lane with an integrator, a project, and a submitter. */
  function lane(): {
    projectId: string;
    integrator: { id: string };
    submitterId: string;
  } {
    const project = createTestProject(testApp.db);
    const integrator = createTestAiAgent(testApp.db);
    const submitter = createTestUser(testApp.db);
    return {
      projectId: project.id,
      integrator: { id: integrator.user.id },
      submitterId: submitter.id,
    };
  }

  /** A raw merge_requests row with fully controlled queue timestamps. */
  function seedRequest(
    projectId: string,
    submittedBy: string,
    over: Partial<{
      enqueuedAt: string;
      pickedUpAt: string | null;
      groupId: string | null;
      status: string;
      resource: string;
    }> = {},
  ): string {
    const id = createId();
    const ts = new Date().toISOString();
    testApp.db
      .insert(mergeRequests)
      .values({
        id,
        projectId,
        resource: over.resource ?? "main",
        submittedBy,
        groupId: over.groupId ?? null,
        status: over.status ?? "queued",
        enqueuedAt: over.enqueuedAt ?? ts,
        pickedUpAt: over.pickedUpAt ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return id;
  }

  function seedGroup(projectId: string, submittedBy: string, createdAt: string): string {
    const id = createId();
    testApp.db
      .insert(mergeRequestGroups)
      .values({ id, projectId, submittedBy, createdAt, updatedAt: createdAt })
      .run();
    return id;
  }

  function entry(over: Partial<svc.PhaseEntryInput> = {}): svc.PhaseEntryInput {
    return {
      phase: "verify",
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      ...over,
    };
  }

  // ─── record: normalization instead of rejection ──────────────────

  describe("record", () => {
    it("records a clean batch with adjusted 0 and server-assigned recordedBy", () => {
      const { projectId, integrator, submitterId } = lane();
      const requestId = seedRequest(projectId, submitterId);

      const result = svc.record(
        projectId,
        { resource: "main", phases: [entry({ requestId }), entry({ phase: "land", requestId })] },
        integrator,
        new Date().toISOString(),
      );

      expect(result).toEqual({ recorded: 2, adjusted: 0 });
      const rows = testApp.db.select().from(mergePhaseTimings).all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.recordedBy === integrator.id)).toBe(true);
      expect(rows.every((r) => r.requestId === requestId)).toBe(true);
    });

    it("a DANGLING request/group/attempt id is nulled + counted, NEVER thrown", () => {
      const { projectId, integrator } = lane();

      const result = svc.record(
        projectId,
        {
          resource: "main",
          phases: [
            entry({ requestId: "no-such-request" }),
            entry({ groupId: "no-such-group" }),
            entry({ attemptId: "no-such-attempt" }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );

      expect(result).toEqual({ recorded: 3, adjusted: 3 });
      const rows = testApp.db.select().from(mergePhaseTimings).all();
      expect(rows).toHaveLength(3);
      expect(
        rows.every((r) => r.requestId === null && r.groupId === null && r.attemptId === null),
      ).toBe(true);
    });

    it("a CROSS-PROJECT id is nulled + counted (a phase can never be attributed across projects)", () => {
      const { projectId, integrator, submitterId } = lane();
      const other = createTestProject(testApp.db);
      const otherRequestId = seedRequest(other.id, submitterId);
      const otherGroupId = seedGroup(other.id, submitterId, new Date().toISOString());
      const otherAttemptId = createId();
      testApp.db
        .insert(mergeAttempts)
        .values({
          id: otherAttemptId,
          requestId: otherRequestId,
          attemptNumber: 1,
          baseSha: "b",
          status: "passed",
          createdAt: new Date().toISOString(),
        })
        .run();

      const result = svc.record(
        projectId,
        {
          resource: "main",
          phases: [
            entry({
              requestId: otherRequestId,
              groupId: otherGroupId,
              attemptId: otherAttemptId,
            }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );

      expect(result).toEqual({ recorded: 1, adjusted: 1 });
      const row = testApp.db.select().from(mergePhaseTimings).all()[0];
      expect(row.requestId).toBeNull();
      expect(row.groupId).toBeNull();
      expect(row.attemptId).toBeNull();
      expect(row.projectId).toBe(projectId);
    });

    it("clamps a negative/fractional/non-finite duration, truncates a fat label, drops a fat detail", () => {
      const { projectId, integrator } = lane();
      const fatDetail = { blob: "x".repeat(5000) };

      const result = svc.record(
        projectId,
        {
          resource: "main",
          // Keyed by phase, not by insertion order — ULIDs minted in the same
          // millisecond do not sort by insertion.
          phases: [
            entry({ phase: "assemble", durationMs: -42 }),
            entry({ phase: "materialize", durationMs: 10.6 }),
            entry({ phase: "rebase", durationMs: Number.NaN }),
            entry({ phase: "verify", label: "L".repeat(500) }),
            entry({ phase: "land", detail: fatDetail }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );

      expect(result.recorded).toBe(5);
      expect(result.adjusted).toBe(5);
      const byPhase = new Map(
        testApp.db
          .select()
          .from(mergePhaseTimings)
          .all()
          .map((r) => [r.phase, r]),
      );
      expect(byPhase.get("assemble")!.durationMs).toBe(0);
      expect(byPhase.get("materialize")!.durationMs).toBe(11);
      expect(byPhase.get("rebase")!.durationMs).toBe(0);
      expect(byPhase.get("verify")!.label).toHaveLength(120);
      expect(byPhase.get("land")!.detail).toBeNull();
    });

    it("a row tripping TWO normalizations still counts ONCE (adjusted counts rows, not defects)", () => {
      const { projectId, integrator } = lane();

      const result = svc.record(
        projectId,
        {
          resource: "main",
          phases: [
            entry({ durationMs: -1, label: "L".repeat(500), requestId: "nope" }),
            entry({ durationMs: 5 }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );

      expect(result).toEqual({ recorded: 2, adjusted: 1 });
    });

    it("a small detail survives verbatim (the budget only kills the outliers)", () => {
      const { projectId, integrator } = lane();
      const detail = { repo: "outer", stepId: "build", cached: true };
      svc.record(
        projectId,
        { resource: "main", phases: [entry({ detail })] },
        integrator,
        new Date().toISOString(),
      );
      expect(testApp.db.select().from(mergePhaseTimings).all()[0].detail).toEqual(detail);
    });

    it("404 on an unknown project — the ONLY legal throw", () => {
      const { integrator } = lane();
      expect(() =>
        svc.record(
          "no-such-project",
          { resource: "main", phases: [entry()] },
          integrator,
          new Date().toISOString(),
        ),
      ).toThrow(/not found/i);
    });

    it("emits exactly ONE merge.phase.recorded event per batch, carrying the DISTINCT phase names", () => {
      const { projectId, integrator, submitterId } = lane();
      const requestId = seedRequest(projectId, submitterId);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_PHASE_RECORDED, listener);

      svc.record(
        projectId,
        {
          resource: "main",
          phases: [
            entry({ phase: "rebase", requestId }),
            entry({ phase: "verify", requestId }),
            entry({ phase: "verify", requestId }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );

      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entityType).toBe("merge_phase");
      expect(payload.entityId).toBe(requestId);
      expect(payload.actorId).toBe(integrator.id);
      const entity = payload.entity as { recorded: number; adjusted: number; phases: string[] };
      expect(entity.recorded).toBe(3);
      expect(entity.adjusted).toBe(0);
      expect([...entity.phases].sort()).toEqual(["rebase", "verify"]);
    });

    it("a lane-level batch (no single entity) falls back to a project:resource event id", () => {
      const { projectId, integrator } = lane();
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_PHASE_RECORDED, listener);

      svc.record(
        projectId,
        { resource: "main", phases: [entry()] },
        integrator,
        new Date().toISOString(),
      );

      expect(listener.mock.calls[0][0].entityId).toBe(`${projectId}:main`);
    });

    it("exposes NO update/delete surface — the table is append-only", () => {
      const mutators = Object.keys(svc).filter((k) => /update|delete|remove|purge|prune/i.test(k));
      expect(mutators).toEqual([]);
    });
  });

  // ─── Survival: the row outlives what it measured ─────────────────

  describe("survival after the measured entity is deleted", () => {
    it("keeps the row and nulls the link when the request/attempt/group go away", () => {
      const { projectId, integrator, submitterId } = lane();
      const groupId = seedGroup(projectId, submitterId, new Date().toISOString());
      const requestId = seedRequest(projectId, submitterId, { groupId });
      const attemptId = createId();
      testApp.db
        .insert(mergeAttempts)
        .values({
          id: attemptId,
          requestId,
          attemptNumber: 1,
          baseSha: "b",
          status: "passed",
          createdAt: new Date().toISOString(),
        })
        .run();

      svc.record(
        projectId,
        { resource: "main", phases: [entry({ requestId, groupId, attemptId })] },
        integrator,
        new Date().toISOString(),
      );

      testApp.db.delete(mergeAttempts).where(eq(mergeAttempts.id, attemptId)).run();
      testApp.db.delete(mergeRequests).where(eq(mergeRequests.id, requestId)).run();
      testApp.db.delete(mergeRequestGroups).where(eq(mergeRequestGroups.id, groupId)).run();

      const rows = testApp.db.select().from(mergePhaseTimings).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].requestId).toBeNull();
      expect(rows[0].attemptId).toBeNull();
      expect(rows[0].groupId).toBeNull();
      expect(rows[0].durationMs).toBe(1000);
    });
  });

  // ─── listRecent: stored rows only ────────────────────────────────

  describe("listRecent", () => {
    it("returns STORED rows only, even when the request has a derivable queue_wait", () => {
      const { projectId, integrator, submitterId } = lane();
      const requestId = seedRequest(projectId, submitterId, {
        enqueuedAt: iso(-30 * MIN),
        pickedUpAt: iso(-20 * MIN),
      });
      svc.record(
        projectId,
        { resource: "main", phases: [entry({ requestId, phase: "verify" })] },
        integrator,
        new Date().toISOString(),
      );

      // The derived entry EXISTS on the trace read...
      expect(svc.listForRequest(requestId).some((e) => e.derived)).toBe(true);
      // ...but never leaks into the paginated list.
      const page = svc.listRecent(projectId, { page: 1, perPage: 50 });
      expect(page.total).toBe(1);
      expect(page.rows).toHaveLength(1);
      expect(page.rows.every((r) => r.derived === false)).toBe(true);
      expect(page.rows[0].phase).toBe("verify");
    });

    it("paginates with a consistent total and no gaps or duplicates", () => {
      const { projectId, integrator, submitterId } = lane();
      const requestId = seedRequest(projectId, submitterId);
      svc.record(
        projectId,
        {
          resource: "main",
          // Same instant on purpose: the (started_at, id) ordering is what makes
          // paging stable when a batch lands on one timestamp.
          phases: Array.from({ length: 5 }, () => entry({ requestId, startedAt: iso(-5 * MIN) })),
        },
        integrator,
        new Date().toISOString(),
      );

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const result = svc.listRecent(projectId, { page, perPage: 2 });
        expect(result.total).toBe(5);
        seen.push(...result.rows.map((r) => r.id));
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it("filters by resource / phase / request / window", () => {
      const { projectId, integrator, submitterId } = lane();
      const requestId = seedRequest(projectId, submitterId);
      const otherRequestId = seedRequest(projectId, submitterId);
      svc.record(
        projectId,
        {
          resource: "main",
          phases: [
            entry({ requestId, phase: "verify", startedAt: iso(-10 * MIN) }),
            entry({ requestId, phase: "land", startedAt: iso(-1 * MIN) }),
            entry({ requestId: otherRequestId, phase: "verify", startedAt: iso(-1 * MIN) }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );
      svc.record(
        projectId,
        { resource: "release", phases: [entry({ phase: "verify" })] },
        integrator,
        new Date().toISOString(),
      );

      expect(svc.listRecent(projectId, { page: 1, perPage: 50, resource: "release" }).total).toBe(
        1,
      );
      expect(svc.listRecent(projectId, { page: 1, perPage: 50, phase: "land" }).total).toBe(1);
      expect(svc.listRecent(projectId, { page: 1, perPage: 50, requestId }).total).toBe(2);
      expect(svc.listRecent(projectId, { page: 1, perPage: 50, since: iso(-5 * MIN) }).total).toBe(
        3,
      );
    });

    it("404s on an unknown project", () => {
      expect(() => svc.listRecent("nope", { page: 1, perPage: 10 })).toThrow(/not found/i);
    });
  });

  // ─── listForRequest: the derived queue_wait ──────────────────────

  describe("listForRequest", () => {
    it("puts the derived queue_wait at the head, stored rows after it in ASC order", () => {
      const { projectId, integrator, submitterId } = lane();
      const requestId = seedRequest(projectId, submitterId, {
        enqueuedAt: iso(-30 * MIN),
        pickedUpAt: iso(-20 * MIN),
      });
      svc.record(
        projectId,
        {
          resource: "main",
          phases: [
            entry({ requestId, phase: "verify", startedAt: iso(-15 * MIN) }),
            entry({ requestId, phase: "rebase", startedAt: iso(-19 * MIN) }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );

      const trace = svc.listForRequest(requestId);
      expect(trace).toHaveLength(3);
      expect(trace[0].derived).toBe(true);
      expect(trace[0].phase).toBe("queue_wait");
      expect(trace[0].durationMs).toBe(10 * MIN);
      expect(trace.slice(1).map((e) => e.phase)).toEqual(["rebase", "verify"]);
    });

    it("REQUEUE via the real merge-request service: audit evidence re-anchors the wait", () => {
      const { projectId, integrator, submitterId } = lane();

      // The real lifecycle: submit → pickup → resetToQueued (which writes the
      // `requeue` audit row inside its own transaction).
      const submitted = requestSvc.submit({
        projectId,
        submittedBy: submitterId,
        branch: "feat/x",
      });
      requestSvc.transitionToIntegrating(submitted.id, { id: integrator.id, type: "ai_agent" });
      requestSvc.resetToQueued(
        submitted.id,
        { id: integrator.id, type: "ai_agent" },
        "post-verify drift",
      );

      const requeueAt = testApp.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, submitted.id))
        .all()
        .find((r) => r.action === "requeue")!.createdAt;

      // Backdate the submit an hour and re-pick it up 5 minutes after the requeue.
      const requeueMs = Date.parse(requeueAt);
      testApp.db
        .update(mergeRequests)
        .set({
          enqueuedAt: iso(-60 * MIN, requeueMs),
          pickedUpAt: iso(5 * MIN, requeueMs),
          status: "integrating",
        })
        .where(eq(mergeRequests.id, submitted.id))
        .run();

      const head = svc.listForRequest(submitted.id)[0];
      expect(head.derived).toBe(true);
      expect(head.basis).toBe("requeued");
      // The honest LAST segment — not the 65 minutes since submit.
      expect(head.durationMs).toBe(5 * MIN);
      expect(head.originDurationMs).toBe(65 * MIN);
      expect(head.startedAt).toBe(requeueAt);
    });

    it("PHASE-ROW evidence: a group member with no attempt and no audit still re-anchors", () => {
      // A grouped member is reset without an audit row or an attempt of its own;
      // the only trace of the prior integration is the phase row it left behind.
      // The anchor is that row's END (started_at + duration_ms), never its start —
      // anchoring on the start would swallow the whole verify into "queue wait".
      const { projectId, integrator, submitterId } = lane();
      const groupId = seedGroup(projectId, submitterId, iso(-70 * MIN));
      const requestId = seedRequest(projectId, submitterId, {
        groupId,
        enqueuedAt: iso(-60 * MIN),
        pickedUpAt: iso(5 * MIN),
      });
      svc.record(
        projectId,
        {
          resource: "main",
          // A 39-minute verify that ENDED at "now".
          phases: [
            entry({ requestId, phase: "verify", startedAt: iso(-39 * MIN), durationMs: 39 * MIN }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );

      expect(testApp.db.select().from(mergeAttempts).all()).toHaveLength(0);
      expect(testApp.db.select().from(auditLog).all()).toHaveLength(0);

      const head = svc.listForRequest(requestId)[0];
      expect(head.basis).toBe("requeued");
      // The verify ENDED at T0; the re-pickup is 5 minutes later. Anchoring on
      // the row's START instead would have reported 44 minutes of "queue wait".
      expect(head.durationMs).toBe(5 * MIN);
      expect(head.originDurationMs).toBe(65 * MIN);
    });

    it("omits the derived entry entirely for a never-picked-up request", () => {
      const { projectId, submitterId } = lane();
      const requestId = seedRequest(projectId, submitterId, { enqueuedAt: iso(-10 * MIN) });
      expect(svc.listForRequest(requestId)).toEqual([]);
    });

    it("404s on an unknown request", () => {
      expect(() => svc.listForRequest("nope")).toThrow(/not found/i);
    });
  });

  // ─── listForGroup: the derived forming ───────────────────────────

  describe("listForGroup", () => {
    it("derives forming from the EARLIEST member pickup and includes member rows", () => {
      const { projectId, integrator, submitterId } = lane();
      const groupId = seedGroup(projectId, submitterId, iso(-30 * MIN));
      const inner = seedRequest(projectId, submitterId, {
        groupId,
        enqueuedAt: iso(-30 * MIN),
        pickedUpAt: iso(-25 * MIN),
      });
      seedRequest(projectId, submitterId, {
        groupId,
        enqueuedAt: iso(-30 * MIN),
        pickedUpAt: iso(-20 * MIN),
      });

      svc.record(
        projectId,
        {
          resource: "main",
          phases: [
            entry({ groupId, phase: "assemble", startedAt: iso(-24 * MIN) }),
            entry({ requestId: inner, phase: "materialize", startedAt: iso(-23 * MIN) }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );

      const trace = svc.listForGroup(groupId);
      expect(trace[0].derived).toBe(true);
      expect(trace[0].phase).toBe("forming");
      expect(trace[0].durationMs).toBe(5 * MIN); // MIN(pickup), not MAX
      // Both the group's own row and its member's row are in the trace.
      expect(trace.slice(1).map((e) => e.phase)).toEqual(["assemble", "materialize"]);
    });

    it("omits forming when no member has been picked up", () => {
      const { projectId, submitterId } = lane();
      const groupId = seedGroup(projectId, submitterId, iso(-30 * MIN));
      seedRequest(projectId, submitterId, { groupId, enqueuedAt: iso(-30 * MIN) });
      expect(svc.listForGroup(groupId)).toEqual([]);
    });

    it("404s on an unknown group", () => {
      expect(() => svc.listForGroup("nope")).toThrow(/not found/i);
    });
  });

  // ─── samples / derivedSamples ────────────────────────────────────

  describe("samples + derivedSamples", () => {
    it("are DISJOINT by phase — concatenating them cannot double-count", () => {
      const { projectId, integrator, submitterId } = lane();
      const groupId = seedGroup(projectId, submitterId, iso(-30 * MIN));
      const requestId = seedRequest(projectId, submitterId, {
        groupId,
        enqueuedAt: iso(-30 * MIN),
        pickedUpAt: iso(-25 * MIN),
      });
      svc.record(
        projectId,
        {
          resource: "main",
          phases: [
            entry({ requestId, phase: "verify", startedAt: iso(-20 * MIN) }),
            entry({ requestId, phase: "land", startedAt: iso(-10 * MIN) }),
          ],
        },
        integrator,
        new Date().toISOString(),
      );

      const from = iso(-60 * MIN);
      const to = iso(MIN);
      const stored = svc.samples(projectId, "main", from, to);
      const derived = svc.derivedSamples(projectId, "main", from, to);

      expect(stored.map((s) => s.phase).sort()).toEqual(["land", "verify"]);
      expect(derived.map((s) => s.phase).sort()).toEqual(["forming", "queue_wait"]);
      const overlap = stored.filter((s) => derived.some((d) => d.phase === s.phase));
      expect(overlap).toEqual([]);
      expect(derived.find((d) => d.phase === "queue_wait")!.durationMs).toBe(5 * MIN);
      expect(derived.find((d) => d.phase === "forming")!.durationMs).toBe(5 * MIN);
    });

    it("honors the lane and the window on both sides", () => {
      const { projectId, integrator, submitterId } = lane();
      seedRequest(projectId, submitterId, {
        enqueuedAt: iso(-300 * MIN),
        pickedUpAt: iso(-290 * MIN),
      });
      svc.record(
        projectId,
        { resource: "release", phases: [entry({ startedAt: iso(-10 * MIN) })] },
        integrator,
        new Date().toISOString(),
      );

      const from = iso(-60 * MIN);
      const to = iso(MIN);
      // Out of window (started 5h ago) and off-lane respectively.
      expect(svc.derivedSamples(projectId, "main", from, to)).toEqual([]);
      expect(svc.samples(projectId, "main", from, to)).toEqual([]);
      expect(svc.samples(projectId, "release", from, to)).toHaveLength(1);
    });
  });
});
