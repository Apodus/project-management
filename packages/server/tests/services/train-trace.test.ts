import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  AUDIT_ACTIONS,
  createId,
  MERGE_GROUP_STATES,
  TRAIN_TRACE_KINDS,
  type AuditAction,
  type TrainTraceEntry,
  type TrainTraceKind,
} from "@pm/shared";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
} from "../utils.js";
import {
  auditLog,
  mergeIncidents,
  mergePhaseTimings,
  mergeRequestGroups,
  mergeRequests,
  tasks,
} from "../../src/db/index.js";
import * as svc from "../../src/services/train-trace.service.js";

// ══════════════════════════════════════════════════════════════════
// train-trace.service — the merged recent-event feed.
//
// The through-line: a reader must never be able to misread a number or lose an
// event. So the assertions cluster around three failure modes —
//   1. an event counted TWICE (a group land is two audit rows plus a group row),
//   2. an event silently LOST (a lane filter that cannot see a lane-level row),
//   3. a number rendered with the WRONG SENTENCE (a since-pickup age printed as
//      a duration, a re-queued wait printed as the whole wait, a missing
//      duration printed as zero).
// ══════════════════════════════════════════════════════════════════

const MIN = 60_000;

let T0 = Date.now();
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

describe("train-trace service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    T0 = Date.now();
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ─── Seeding ────────────────────────────────────────────────────

  function lane(): { projectId: string; actorId: string; integratorId: string } {
    const project = createTestProject(testApp.db);
    const submitter = createTestUser(testApp.db);
    const integrator = createTestAiAgent(testApp.db);
    return {
      projectId: project.id,
      actorId: submitter.id,
      integratorId: integrator.user.id,
    };
  }

  function seedRequest(
    projectId: string,
    submittedBy: string,
    over: Partial<{
      enqueuedAt: string;
      pickedUpAt: string | null;
      groupId: string | null;
      resource: string;
      branch: string | null;
      taskId: string | null;
      synthetic: boolean;
      status: string;
    }> = {},
  ): string {
    const id = createId();
    const ts = iso(-120 * MIN);
    testApp.db
      .insert(mergeRequests)
      .values({
        id,
        projectId,
        resource: over.resource ?? "main",
        submittedBy,
        groupId: over.groupId ?? null,
        branch: over.branch === undefined ? "feat/x" : over.branch,
        taskId: over.taskId ?? null,
        synthetic: over.synthetic ?? false,
        status: over.status ?? "queued",
        enqueuedAt: over.enqueuedAt ?? ts,
        pickedUpAt: over.pickedUpAt ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return id;
  }

  function seedGroup(
    projectId: string,
    submittedBy: string,
    over: Partial<{
      state: string;
      createdAt: string;
      resolvedAt: string | null;
      resolutionReason: string | null;
      resource: string;
    }> = {},
  ): string {
    const id = createId();
    const createdAt = over.createdAt ?? iso(-90 * MIN);
    testApp.db
      .insert(mergeRequestGroups)
      .values({
        id,
        projectId,
        resource: over.resource ?? "main",
        submittedBy,
        state: over.state ?? "forming",
        resolvedAt: over.resolvedAt ?? null,
        resolutionReason: over.resolutionReason ?? null,
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    return id;
  }

  function seedAudit(
    projectId: string,
    actorId: string,
    over: Partial<{
      action: AuditAction;
      targetType: string;
      targetId: string;
      reason: string | null;
      after: Record<string, unknown> | null;
      createdAt: string;
    }> = {},
  ): string {
    const id = createId();
    testApp.db
      .insert(auditLog)
      .values({
        id,
        projectId,
        actorId,
        action: over.action ?? "land",
        targetType: over.targetType ?? "merge_request",
        targetId: over.targetId ?? "unknown",
        reason: over.reason ?? null,
        metadataAfter: over.after ?? null,
        createdAt: over.createdAt ?? iso(-10 * MIN),
      })
      .run();
    return id;
  }

  function seedPhase(
    projectId: string,
    over: Partial<{
      requestId: string | null;
      groupId: string | null;
      phase: string;
      startedAt: string;
      durationMs: number;
      label: string | null;
      resource: string;
    }> = {},
  ): string {
    const id = createId();
    testApp.db
      .insert(mergePhaseTimings)
      .values({
        id,
        projectId,
        resource: over.resource ?? "main",
        requestId: over.requestId ?? null,
        groupId: over.groupId ?? null,
        phase: over.phase ?? "verify",
        label: over.label ?? null,
        startedAt: over.startedAt ?? iso(-30 * MIN),
        durationMs: over.durationMs ?? 5 * MIN,
        createdAt: iso(-30 * MIN),
      })
      .run();
    return id;
  }

  const read = (projectId: string, resource = "main", limit = 50): TrainTraceEntry[] =>
    svc.list(projectId, { resource, limit }).entries;

  const kinds = (entries: TrainTraceEntry[]): TrainTraceKind[] => entries.map((e) => e.kind);

  // ─── The partition ──────────────────────────────────────────────

  describe("kind partition", () => {
    // A `Record<AuditAction, …>` already forces every action to be DECIDED at
    // compile time. What it cannot check is the other direction: that every
    // declared kind is actually produced, and by exactly one producer.
    it("covers every audit action and every group state", () => {
      expect(Object.keys(svc.AUDIT_ACTION_KIND).sort()).toEqual([...AUDIT_ACTIONS].sort());
      expect(Object.keys(svc.GROUP_STATE_KIND).sort()).toEqual([...MERGE_GROUP_STATES].sort());
    });

    it("is TOTAL — every declared kind has a producer", () => {
      const produced = new Set<TrainTraceKind>([
        ...Object.values(svc.AUDIT_ACTION_KIND).filter((k): k is TrainTraceKind => k !== null),
        ...Object.values(svc.GROUP_STATE_KIND).filter((k): k is TrainTraceKind => k !== null),
        ...svc.ENTITY_ARM_KINDS,
      ]);
      expect([...produced].sort()).toEqual([...TRAIN_TRACE_KINDS].sort());
    });

    it("is DISJOINT — no kind is produced by two sources", () => {
      const all = [
        ...Object.values(svc.AUDIT_ACTION_KIND).filter((k): k is TrainTraceKind => k !== null),
        ...Object.values(svc.GROUP_STATE_KIND).filter((k): k is TrainTraceKind => k !== null),
        ...svc.ENTITY_ARM_KINDS,
      ];
      expect(all.length).toBe(new Set(all).size);
    });
  });

  // ─── Outcomes: counted exactly once ─────────────────────────────

  describe("outcomes are counted once", () => {
    it("a single-repo land yields exactly ONE landed entry", () => {
      const { projectId, actorId, integratorId } = lane();
      const requestId = seedRequest(projectId, actorId, { pickedUpAt: iso(-40 * MIN) });
      seedAudit(projectId, integratorId, {
        action: "land",
        targetId: requestId,
        after: { landedSha: "abcdef1234567890" },
      });

      const landed = read(projectId).filter((e) => e.kind === "landed");
      expect(landed).toHaveLength(1);
      expect(landed[0]!.subject).toMatchObject({ type: "request", id: requestId });
      // The short sha rides `detail`, so the row says WHICH commit landed.
      expect(landed[0]!.detail).toBe("abcdef12");
    });

    it("a 2-member group land collapses its two member audit rows into the group entry", () => {
      const { projectId, actorId, integratorId } = lane();
      const groupId = seedGroup(projectId, actorId, {
        state: "landed",
        resolvedAt: iso(-5 * MIN),
      });
      const inner = seedRequest(projectId, actorId, {
        groupId,
        branch: "inner/fix",
        pickedUpAt: iso(-35 * MIN),
      });
      const outer = seedRequest(projectId, actorId, {
        groupId,
        branch: "outer/bump",
        pickedUpAt: iso(-30 * MIN),
      });
      // landGroup writes ONE audit row per member.
      seedAudit(projectId, integratorId, { action: "land", targetId: inner });
      seedAudit(projectId, integratorId, { action: "land", targetId: outer });

      const entries = read(projectId);
      expect(kinds(entries).filter((k) => k === "landed")).toEqual([]);
      const group = entries.filter((e) => e.kind === "group_landed");
      expect(group).toHaveLength(1);
      expect(group[0]!.subject.name).toBe("inner/fix + outer/bump");
      // The group's clock runs from its OLDEST member pickup (-35m → -5m).
      expect(group[0]!.elapsed).toEqual({ basis: "since_pickup", ms: 30 * MIN });
    });

    it("never collapses a break-glass force_land on a grouped member", () => {
      const { projectId, actorId, integratorId } = lane();
      const groupId = seedGroup(projectId, actorId, {
        state: "partially_landed",
        resolvedAt: iso(-20 * MIN),
      });
      const outer = seedRequest(projectId, actorId, { groupId, pickedUpAt: iso(-40 * MIN) });
      seedAudit(projectId, integratorId, {
        action: "force_land",
        targetId: outer,
        reason: "outer push raced; landing by hand",
        createdAt: iso(-2 * MIN),
      });

      const forced = read(projectId).filter((e) => e.kind === "force_landed");
      expect(forced).toHaveLength(1);
      expect(forced[0]!.overridden).toBe(true);
      // Carried verbatim — the per-request timeline already returns it.
      expect(forced[0]!.reason).toBe("outer push raced; landing by hand");
    });

    it("labels a partially-landed group as such, not as a plain reject", () => {
      const { projectId, actorId } = lane();
      const groupId = seedGroup(projectId, actorId, {
        state: "partially_landed",
        resolvedAt: iso(-3 * MIN),
        resolutionReason: "inner landed, outer push failed",
      });
      seedRequest(projectId, actorId, { groupId, pickedUpAt: iso(-33 * MIN) });

      const entries = read(projectId);
      expect(kinds(entries)).toContain("group_partially_landed");
      expect(kinds(entries)).not.toContain("group_rejected");
      expect(entries.find((e) => e.kind === "group_partially_landed")!.reason).toBe(
        "inner landed, outer push failed",
      );
    });

    it("announces a grouped member's pickup once, via the group", () => {
      const { projectId, actorId } = lane();
      const groupId = seedGroup(projectId, actorId, { createdAt: iso(-60 * MIN) });
      seedRequest(projectId, actorId, { groupId, pickedUpAt: iso(-45 * MIN) });
      seedRequest(projectId, actorId, { groupId, pickedUpAt: iso(-44 * MIN) });

      const entries = read(projectId);
      expect(kinds(entries).filter((k) => k === "picked_up")).toEqual([]);
      const started = entries.filter((e) => e.kind === "group_started");
      expect(started).toHaveLength(1);
      // forming = group creation (-60m) → OLDEST member pickup (-45m).
      expect(started[0]!.elapsed).toMatchObject({ basis: "forming", ms: 15 * MIN });
      expect(started[0]!.at).toBe(iso(-45 * MIN));
    });
  });

  // ─── Durations that say what they are ───────────────────────────

  describe("elapsed", () => {
    it("orders phase entries by their END, not their start", () => {
      const { projectId } = lane();
      // A starts first but runs an hour; B starts later and finishes in a
      // minute. Newest-first must put A on top — ordering by start would file a
      // long verify above everything that happened DURING it.
      seedPhase(projectId, { phase: "verify", startedAt: iso(-70 * MIN), durationMs: 60 * MIN });
      seedPhase(projectId, { phase: "rebase", startedAt: iso(-60 * MIN), durationMs: 1 * MIN });

      const phases = read(projectId).filter((e) => e.kind === "phase");
      expect(phases.map((e) => e.phase)).toEqual(["verify", "rebase"]);
      expect(phases[0]!.at).toBe(iso(-10 * MIN));
      expect(phases[0]!.elapsed).toEqual({ basis: "phase", ms: 60 * MIN });
    });

    it("re-anchors a re-queued pickup and still reports the full span", () => {
      const { projectId, actorId, integratorId } = lane();
      const requestId = seedRequest(projectId, actorId, {
        enqueuedAt: iso(-60 * MIN),
        pickedUpAt: iso(-10 * MIN),
      });
      // The prior integration ENDED here — the anchor deriveQueueWait uses.
      seedAudit(projectId, integratorId, {
        action: "requeue",
        targetId: requestId,
        createdAt: iso(-20 * MIN),
        reason: "main drifted at land time",
      });

      const pickup = read(projectId).find((e) => e.kind === "picked_up")!;
      expect(pickup.elapsed).toEqual({
        basis: "queue_wait",
        // Only the LAST queue segment is charged to queue time...
        ms: 10 * MIN,
        // ...but the total since submit is stated, never hidden.
        sinceSubmitMs: 50 * MIN,
        requeued: true,
      });
    });

    it("gives an instant the explicit `none` basis — never a zero, never a bare number", () => {
      const { projectId, actorId, integratorId } = lane();
      const requestId = seedRequest(projectId, actorId, { pickedUpAt: iso(-40 * MIN) });
      seedAudit(projectId, integratorId, {
        action: "requeue",
        targetId: requestId,
        createdAt: iso(-15 * MIN),
      });
      seedAudit(projectId, integratorId, {
        action: "pause",
        targetType: "train",
        targetId: "main",
        createdAt: iso(-12 * MIN),
      });
      seedAudit(projectId, integratorId, {
        action: "outer_gitlink_normalized",
        targetId: requestId,
        createdAt: iso(-11 * MIN),
      });
      testApp.db
        .insert(mergeIncidents)
        .values({
          id: createId(),
          projectId,
          groupId: null,
          type: "orphaned_inner",
          innerRepo: "rynx",
          orphanedSha: "0123456789abcdef",
          outerRepo: "game_one",
          state: "open",
          openedAt: iso(-9 * MIN),
          createdAt: iso(-9 * MIN),
          updatedAt: iso(-9 * MIN),
        })
        .run();

      const entries = read(projectId);
      for (const kind of [
        "requeued",
        "paused",
        "outer_gitlink_normalized",
        "incident_opened",
      ] as const) {
        const entry = entries.find((e) => e.kind === kind);
        expect(entry, `expected a ${kind} entry`).toBeDefined();
        // `{ basis: "none" }` carries no `ms` AT ALL, so "no duration" cannot
        // be read as "zero duration" by any renderer.
        expect(entry!.elapsed).toEqual({ basis: "none" });
      }
      // Nothing in the feed may carry a fabricated zero.
      expect(entries.some((e) => "ms" in e.elapsed && e.elapsed.ms === 0)).toBe(false);
    });

    it("anchors an outcome on pickup, and reports none when there was no pickup", () => {
      const { projectId, actorId, integratorId } = lane();
      const picked = seedRequest(projectId, actorId, { pickedUpAt: iso(-50 * MIN) });
      const queued = seedRequest(projectId, actorId, { pickedUpAt: null });
      seedAudit(projectId, integratorId, {
        action: "reject",
        targetId: picked,
        after: { rejectCategory: "verify_failed" },
        createdAt: iso(-8 * MIN),
      });
      seedAudit(projectId, integratorId, {
        action: "cancel",
        targetId: queued,
        createdAt: iso(-7 * MIN),
      });

      const entries = read(projectId);
      const rejected = entries.find((e) => e.kind === "rejected")!;
      expect(rejected.elapsed).toEqual({ basis: "since_pickup", ms: 42 * MIN });
      expect(rejected.detail).toBe("verify_failed");
      // Cancelled before the train ever touched it: no anchor, so no number.
      expect(entries.find((e) => e.kind === "cancelled")!.elapsed).toEqual({ basis: "none" });
    });
  });

  // ─── What the feed does and does not contain ────────────────────

  describe("membership", () => {
    it("a phase ingest contributes phase entries and nothing else", () => {
      const { projectId, actorId } = lane();
      const requestId = seedRequest(projectId, actorId);
      seedPhase(projectId, { requestId, phase: "assemble", startedAt: iso(-25 * MIN) });
      seedPhase(projectId, { requestId, phase: "rebase", startedAt: iso(-24 * MIN) });
      seedPhase(projectId, { requestId, phase: "verify", startedAt: iso(-23 * MIN) });

      const entries = read(projectId);
      expect(entries).toHaveLength(3);
      expect(new Set(kinds(entries))).toEqual(new Set(["phase"]));
      expect(entries.every((e) => e.source === "phase")).toBe(true);
      expect(entries.every((e) => e.subject.id === requestId)).toBe(true);
    });

    it("never surfaces a force_claim on a work item", () => {
      const { projectId, actorId } = lane();
      const task = createTestTask(testApp.db, { projectId, reporterId: actorId });
      seedAudit(projectId, actorId, {
        action: "force_claim",
        targetType: "task",
        targetId: task.id,
        reason: "holder went dark",
      });

      expect(read(projectId)).toEqual([]);
    });

    it("carries a phase's step label through", () => {
      const { projectId, actorId } = lane();
      const requestId = seedRequest(projectId, actorId);
      seedPhase(projectId, { requestId, phase: "verify", label: "build" });

      const entry = read(projectId)[0]!;
      expect(entry.label).toBe("build");
      expect(entry.phase).toBe("verify");
    });
  });

  // ─── Lane scoping ───────────────────────────────────────────────

  describe("resource scoping", () => {
    it("returns only the asked lane, including rows whose lane IS the target id", () => {
      const { projectId, actorId, integratorId } = lane();
      // Lane-level audit rows: target_id IS the resource (a lane has no row).
      seedAudit(projectId, integratorId, {
        action: "pause",
        targetType: "train",
        targetId: "main",
        createdAt: iso(-20 * MIN),
      });
      seedAudit(projectId, integratorId, {
        action: "pause",
        targetType: "train",
        targetId: "release",
        createdAt: iso(-19 * MIN),
      });
      seedAudit(projectId, integratorId, {
        action: "force_release_lock",
        targetType: "merge_lock",
        targetId: "main",
        createdAt: iso(-18 * MIN),
      });
      seedAudit(projectId, integratorId, {
        action: "force_release_lock",
        targetType: "merge_lock",
        targetId: "release",
        createdAt: iso(-17 * MIN),
      });
      // Subject-scoped rows: the lane comes from the merge_request row.
      const onMain = seedRequest(projectId, actorId, { pickedUpAt: iso(-16 * MIN) });
      const onRelease = seedRequest(projectId, actorId, {
        resource: "release",
        pickedUpAt: iso(-15 * MIN),
      });
      seedAudit(projectId, integratorId, { action: "land", targetId: onMain });
      seedAudit(projectId, integratorId, { action: "land", targetId: onRelease });
      seedPhase(projectId, { requestId: onMain, resource: "main" });
      seedPhase(projectId, { requestId: onRelease, resource: "release" });

      const main = read(projectId, "main");
      expect(main.every((e) => e.resource === "main")).toBe(true);
      expect(kinds(main).sort()).toEqual(
        ["landed", "lock_force_released", "paused", "phase", "picked_up"].sort(),
      );

      const release = read(projectId, "release");
      expect(release.every((e) => e.resource === "release")).toBe(true);
      expect(kinds(release).sort()).toEqual(
        ["landed", "lock_force_released", "paused", "phase", "picked_up"].sort(),
      );
    });
  });

  // ─── Degradation + limits ───────────────────────────────────────

  describe("degradation", () => {
    it("degrades a deleted task to the branch, then to (removed), without throwing", () => {
      const { projectId, actorId } = lane();
      const task = createTestTask(testApp.db, {
        projectId,
        reporterId: actorId,
        title: "Fix drift",
      });
      const named = seedRequest(projectId, actorId, {
        taskId: task.id,
        branch: "feat/drift",
        pickedUpAt: iso(-20 * MIN),
      });
      const branchOnly = seedRequest(projectId, actorId, {
        branch: "feat/orphan",
        pickedUpAt: iso(-19 * MIN),
      });
      const nameless = seedRequest(projectId, actorId, {
        branch: null,
        pickedUpAt: iso(-18 * MIN),
      });

      expect(read(projectId).find((e) => e.subject.id === named)!.subject.name).toBe("Fix drift");

      // The task goes away mid-flight (task_id is ON DELETE SET NULL).
      testApp.db.delete(tasks).where(eq(tasks.id, task.id)).run();
      const after = read(projectId);
      expect(after.find((e) => e.subject.id === named)!.subject.name).toBe("feat/drift");
      expect(after.find((e) => e.subject.id === branchOnly)!.subject.name).toBe("feat/orphan");
      expect(after.find((e) => e.subject.id === nameless)!.subject.name).toBe("(removed)");
    });

    it("names a synthetic member for what it is", () => {
      const { projectId, actorId } = lane();
      const groupId = seedGroup(projectId, actorId, {
        state: "landed",
        resolvedAt: iso(-4 * MIN),
      });
      seedRequest(projectId, actorId, {
        groupId,
        branch: "inner/real",
        pickedUpAt: iso(-30 * MIN),
      });
      seedRequest(projectId, actorId, {
        groupId,
        branch: null,
        synthetic: true,
        pickedUpAt: iso(-30 * MIN),
      });

      // A group is named by its REAL members, so the synthetic one is silent...
      const group = read(projectId).find((e) => e.kind === "group_landed")!;
      expect(group.subject.name).toBe("inner/real");
    });

    it("truncates at the limit and says so", () => {
      const { projectId } = lane();
      for (let i = 0; i < 5; i++) {
        seedPhase(projectId, { startedAt: iso(-(30 + i) * MIN) });
      }

      const page = svc.list(projectId, { resource: "main", limit: 2 });
      expect(page.entries).toHaveLength(2);
      expect(page.truncated).toBe(true);

      const all = svc.list(projectId, { resource: "main", limit: 50 });
      expect(all.entries).toHaveLength(5);
      expect(all.truncated).toBe(false);
    });

    it("reports truncation when a single arm hits its row cap", () => {
      const { projectId } = lane();
      // ARM_CAP is 500; 500 rows is the smallest input that trips it.
      testApp.db.transaction((tx) => {
        for (let i = 0; i < 500; i++) {
          tx.insert(mergePhaseTimings)
            .values({
              id: createId(),
              projectId,
              resource: "main",
              phase: "verify",
              startedAt: iso(-(i + 1) * 1000),
              durationMs: 500,
              createdAt: iso(-(i + 1) * 1000),
            })
            .run();
        }
      });

      const page = svc.list(projectId, { resource: "main", limit: 50 });
      expect(page.entries).toHaveLength(50);
      expect(page.truncated).toBe(true);
    });

    it("honours the since window and reports it back", () => {
      const { projectId } = lane();
      seedPhase(projectId, { startedAt: iso(-30 * MIN) });
      seedPhase(projectId, { startedAt: iso(-5 * MIN) });

      const recent = svc.list(projectId, { resource: "main", since: iso(-10 * MIN), limit: 50 });
      expect(recent.entries).toHaveLength(1);
      expect(recent.from).toBe(iso(-10 * MIN));
      expect(Date.parse(recent.to)).toBeGreaterThanOrEqual(T0 - 1000);
    });

    it("404s on an unknown project", () => {
      expect(() => svc.list(createId(), { resource: "main", limit: 50 })).toThrow(/not found/i);
    });
  });

  // ─── Identity ───────────────────────────────────────────────────

  it("gives entries from different sources at the same instant distinct ids", () => {
    const { projectId, actorId, integratorId } = lane();
    const at = iso(-10 * MIN);
    const requestId = seedRequest(projectId, actorId, { pickedUpAt: at });
    // A phase ENDING at the same instant the pickup happened.
    seedPhase(projectId, { requestId, startedAt: iso(-15 * MIN), durationMs: 5 * MIN });
    seedAudit(projectId, integratorId, { action: "land", targetId: requestId, createdAt: at });

    const entries = read(projectId);
    const sameInstant = entries.filter((e) => e.at === at);
    expect(sameInstant.length).toBe(3);
    expect(new Set(sameInstant.map((e) => e.id)).size).toBe(3);
    // Deterministic cross-source order (phase → audit → entity).
    expect(sameInstant.map((e) => e.source)).toEqual(["phase", "audit", "entity"]);
  });
});
