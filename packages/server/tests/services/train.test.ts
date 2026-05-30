import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
  type TestProject,
} from "../utils.js";
import {
  auditLog,
  comments,
  gitRefs,
  mergeAttempts,
  mergeLocks,
  mergeRequests,
  mergeRequestGroups,
  trainState,
} from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import { createId } from "@pm/shared";
import * as svc from "../../src/services/train.service.js";
import * as requestSvc from "../../src/services/merge-request.service.js";
import * as attemptSvc from "../../src/services/merge-attempt.service.js";
import * as mergeLockService from "../../src/services/merge-lock.service.js";
import type { Actor } from "../../src/services/merge-request.service.js";

// ─── Helpers ──────────────────────────────────────────────────────

function adminActor(testApp: TestApp): Actor {
  // The default test user is a human admin.
  return {
    id: testApp.testUser.id,
    role: testApp.testUser.role,
    type: testApp.testUser.type,
  };
}

function aiActor(testApp: TestApp): Actor {
  const agent = createTestAiAgent(testApp.db);
  return { id: agent.user.id, role: agent.user.role, type: agent.user.type };
}

function memberActor(testApp: TestApp): Actor {
  const member = createTestUser(testApp.db, { role: "member" });
  return { id: member.id, role: member.role, type: member.type };
}

/** Submit a request and drive it to `integrating` via the integrator path. */
function integratingRequest(
  testApp: TestApp,
  project: TestProject,
  opts: { withTask?: boolean; withAttempt?: boolean } = {},
): { requestId: string; taskId: string | null; integrator: Actor } {
  const submitter = createTestUser(testApp.db);
  let taskId: string | null = null;
  if (opts.withTask) {
    taskId = createTestTask(testApp.db, { projectId: project.id }).id;
  }
  const r = requestSvc.submit({
    projectId: project.id,
    submittedBy: submitter.id,
    taskId,
    branch: "feat/x",
    commitSha: "deadbeef",
  });
  const integrator = aiActor(testApp);
  requestSvc.transitionToIntegrating(r.id, integrator);
  if (opts.withAttempt) {
    // Start an open attempt via the ai_agent-gated service (legitimately).
    attemptSvc.startAttempt(r.id, { baseSha: "base000" }, integrator);
  }
  return { requestId: r.id, taskId, integrator };
}

function auditCount(testApp: TestApp): number {
  return testApp.db.select().from(auditLog).all().length;
}

describe("train service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── pause / resume ───────────────────────────────────────────────

  describe("pause / resume", () => {
    it("pause flips state, writes exactly ONE pause audit row, emits TRAIN_PAUSED", () => {
      const project = createTestProject(testApp.db);
      const paused = vi.fn();
      getEventBus().on(EVENT_NAMES.TRAIN_PAUSED, paused);

      const view = svc.pause(project.id, "main", adminActor(testApp), "draining");
      expect(view.state).toBe("paused");
      expect(view.changedBy).toBe(testApp.testUser.id);
      expect(view.reason).toBe("draining");

      const rows = testApp.db.select().from(auditLog).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("pause");
      expect(rows[0].targetType).toBe("train");
      expect(rows[0].targetId).toBe("main");
      expect(rows[0].reason).toBe("draining");
      expect(rows[0].metadataBefore).toEqual({ state: "running" });
      expect(rows[0].metadataAfter).toEqual({ state: "paused" });

      expect(paused).toHaveBeenCalledTimes(1);
      const payload = paused.mock.calls[0][0];
      expect(payload.entityType).toBe("train");
    });

    it("re-pausing an already-paused lane is a 200 no-op with NO new audit + no duplicate emit", () => {
      const project = createTestProject(testApp.db);
      svc.pause(project.id, "main", adminActor(testApp));
      expect(auditCount(testApp)).toBe(1);

      const paused = vi.fn();
      getEventBus().on(EVENT_NAMES.TRAIN_PAUSED, paused);
      const view = svc.pause(project.id, "main", adminActor(testApp));
      expect(view.state).toBe("paused");
      // No new audit row, no new emit.
      expect(auditCount(testApp)).toBe(1);
      expect(paused).not.toHaveBeenCalled();
    });

    it("resume flips back, writes ONE resume audit, emits TRAIN_RESUMED", () => {
      const project = createTestProject(testApp.db);
      svc.pause(project.id, "main", adminActor(testApp));
      const resumed = vi.fn();
      getEventBus().on(EVENT_NAMES.TRAIN_RESUMED, resumed);

      const view = svc.resume(project.id, "main", adminActor(testApp), "ready");
      expect(view.state).toBe("running");
      const rows = testApp.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "resume"))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0].metadataBefore).toEqual({ state: "paused" });
      expect(rows[0].metadataAfter).toEqual({ state: "running" });
      expect(resumed).toHaveBeenCalledTimes(1);
    });

    it("resuming an already-running lane is a clean no-op (no audit)", () => {
      const project = createTestProject(testApp.db);
      const resumed = vi.fn();
      getEventBus().on(EVENT_NAMES.TRAIN_RESUMED, resumed);
      const view = svc.resume(project.id, "main", adminActor(testApp));
      expect(view.state).toBe("running");
      expect(auditCount(testApp)).toBe(0);
      expect(resumed).not.toHaveBeenCalled();
    });

    it("pause/resume by a non-admin → 403 FORBIDDEN", () => {
      const project = createTestProject(testApp.db);
      expect(() => svc.pause(project.id, "main", memberActor(testApp))).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
      expect(() => svc.resume(project.id, "main", memberActor(testApp))).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });

    it("getTrainState lazy-creates a running lane with no audit/emit", () => {
      const project = createTestProject(testApp.db);
      const view = svc.getTrainState(project.id, "main");
      expect(view.state).toBe("running");
      expect(auditCount(testApp)).toBe(0);
      expect(testApp.db.select().from(trainState).all()).toHaveLength(1);
    });
  });

  // ── forceReleaseLock ─────────────────────────────────────────────

  describe("forceReleaseLock", () => {
    function acquireLock(testApp: TestApp, project: TestProject): Actor {
      const holder = aiActor(testApp);
      mergeLockService.acquire(project.id, "main", { id: holder.id });
      return holder;
    }

    it("HARD-clears the holder + all intent fields, writes ONE audit, emits MERGE_LOCK_RELEASED", () => {
      const project = createTestProject(testApp.db);
      const holder = acquireLock(testApp, project);

      const released = vi.fn();
      const granted = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_LOCK_RELEASED, released);
      getEventBus().on(EVENT_NAMES.MERGE_LOCK_GRANTED, granted);

      const result = svc.forceReleaseLock(
        project.id,
        "main",
        adminActor(testApp),
        "integrator died",
      );
      expect(result.ok).toBe(true);
      expect(result.priorHolderId).toBe(holder.id);

      const lock = testApp.db
        .select()
        .from(mergeLocks)
        .where(
          and(eq(mergeLocks.projectId, project.id), eq(mergeLocks.resource, "main")),
        )
        .get();
      expect(lock!.holderId).toBeNull();
      expect(lock!.acquiredAt).toBeNull();
      expect(lock!.heartbeatAt).toBeNull();
      expect(lock!.expiresAt).toBeNull();
      expect(lock!.taskId).toBeNull();
      expect(lock!.branch).toBeNull();
      expect(lock!.commitSha).toBeNull();
      expect(lock!.verifyCmd).toBeNull();
      expect(lock!.worktreePath).toBeNull();
      expect(lock!.abandonReason).toBeNull();

      const rows = testApp.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "force_release_lock"))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0].targetType).toBe("merge_lock");
      expect(rows[0].metadataBefore).toEqual({ holderId: holder.id });
      expect(rows[0].metadataAfter).toEqual({ holderId: null });

      expect(released).toHaveBeenCalledTimes(1);
      // NO queue promotion — no merge.lock.granted.
      expect(granted).not.toHaveBeenCalled();
    });

    it("does NOT promote a waiting queue head (no merge.lock.granted)", () => {
      const project = createTestProject(testApp.db);
      const holder = aiActor(testApp);
      const waiter = aiActor(testApp);
      mergeLockService.acquire(project.id, "main", { id: holder.id });
      mergeLockService.acquire(project.id, "main", { id: waiter.id }); // queued

      const granted = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_LOCK_GRANTED, granted);

      svc.forceReleaseLock(project.id, "main", adminActor(testApp), "force");

      const lock = testApp.db
        .select()
        .from(mergeLocks)
        .where(
          and(eq(mergeLocks.projectId, project.id), eq(mergeLocks.resource, "main")),
        )
        .get();
      // Holder cleared, NOT replaced by the waiter.
      expect(lock!.holderId).toBeNull();
      expect(granted).not.toHaveBeenCalled();
    });

    it("does NOT touch in-flight merge_requests", () => {
      const project = createTestProject(testApp.db);
      acquireLock(testApp, project);
      const { requestId } = integratingRequest(testApp, project);

      svc.forceReleaseLock(project.id, "main", adminActor(testApp), "force");

      const req = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, requestId))
        .get();
      expect(req!.status).toBe("integrating");
    });

    it("non-admin → 403 FORBIDDEN", () => {
      const project = createTestProject(testApp.db);
      expect(() =>
        svc.forceReleaseLock(project.id, "main", memberActor(testApp), "x"),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });
  });

  // ── forceLand (THE R1 OVERRIDE) ──────────────────────────────────

  describe("forceLand", () => {
    it("lands integrating + open attempt as a HUMAN admin: request landed, git_ref attached, attempt passed/overridden, ONE force_land audit, MERGE_REQUEST_LANDED overridden:true", () => {
      const project = createTestProject(testApp.db);
      const { requestId, taskId } = integratingRequest(testApp, project, {
        withTask: true,
        withAttempt: true,
      });

      const landed = vi.fn();
      const auditEmit = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_LANDED, landed);
      getEventBus().on(EVENT_NAMES.AUDIT_RECORDED, auditEmit);

      const admin = adminActor(testApp);
      expect(admin.type).toBe("human"); // The override lands with a HUMAN actor.

      const view = svc.forceLand(
        requestId,
        { landedSha: "ff00ba5", reason: "prod outage hotfix; verify infra down" },
        admin,
      );
      expect(view.status).toBe("landed");
      expect(view.landedSha).toBe("ff00ba5");
      expect(view.resolvedAt).toBeTruthy();

      // git_ref attached on the task.
      const refs = testApp.db
        .select()
        .from(gitRefs)
        .where(eq(gitRefs.taskId, taskId!))
        .all();
      expect(refs).toHaveLength(1);
      expect(refs[0].refType).toBe("landed_sha");
      expect(refs[0].refValue).toBe("ff00ba5");

      // The attempt is passed + overridden marker.
      const att = testApp.db
        .select()
        .from(mergeAttempts)
        .where(eq(mergeAttempts.requestId, requestId))
        .all();
      expect(att).toHaveLength(1);
      expect(att[0].status).toBe("passed");
      expect(att[0].treeSha).toBe("ff00ba5");
      expect(att[0].failureReason).toContain("force_land override");

      // Exactly ONE force_land audit row, with reason + before/after.
      const audits = testApp.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "force_land"))
        .all();
      expect(audits).toHaveLength(1);
      expect(audits[0].reason).toBe("prod outage hotfix; verify infra down");
      expect(audits[0].metadataBefore).toEqual({ status: "integrating", landedSha: null });
      expect((audits[0].metadataAfter as Record<string, unknown>).overridden).toBe(true);
      expect((audits[0].metadataAfter as Record<string, unknown>).status).toBe("landed");

      // MERGE_REQUEST_LANDED with overridden:true; audit.recorded emitted.
      expect(landed).toHaveBeenCalledTimes(1);
      expect(landed.mock.calls[0][0].entity.overridden).toBe(true);
      expect(auditEmit).toHaveBeenCalledTimes(1);
    });

    it("CONTRAST: the public land() 403s the same human admin (proving the gate-bypass is the point)", () => {
      const project = createTestProject(testApp.db);
      const { requestId } = integratingRequest(testApp, project, {
        withTask: true,
        withAttempt: true,
      });
      const admin = adminActor(testApp);
      // The public, ai_agent-gated land() rejects the human admin...
      expect(() =>
        requestSvc.land(requestId, { landedSha: "ff00ba5" }, admin),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
      // ...but forceLand lands it.
      const view = svc.forceLand(
        requestId,
        { landedSha: "ff00ba5", reason: "bypass" },
        admin,
      );
      expect(view.status).toBe("landed");
    });

    it("synthesizes a passed/overridden attempt (baseSha = landedSha, non-null) when NO open attempt exists", () => {
      const project = createTestProject(testApp.db);
      const { requestId } = integratingRequest(testApp, project, {
        withTask: true,
        withAttempt: false, // no attempt started
      });
      svc.forceLand(
        requestId,
        { landedSha: "abc9999", reason: "no attempt path" },
        adminActor(testApp),
      );
      const att = testApp.db
        .select()
        .from(mergeAttempts)
        .where(eq(mergeAttempts.requestId, requestId))
        .all();
      expect(att).toHaveLength(1);
      expect(att[0].status).toBe("passed");
      expect(att[0].baseSha).toBe("abc9999"); // NON-null PIN 1.
      expect(att[0].treeSha).toBe("abc9999");

      const req = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, requestId))
        .get();
      expect(req!.status).toBe("landed");
    });

    it("does NOT run git (records only the operator-asserted landedSha)", () => {
      const project = createTestProject(testApp.db);
      const { requestId } = integratingRequest(testApp, project, { withTask: true });
      const view = svc.forceLand(
        requestId,
        { landedSha: "operator-asserted-sha", reason: "x" },
        adminActor(testApp),
      );
      // The landedSha is whatever the operator asserted; PM never verified it.
      expect(view.landedSha).toBe("operator-asserted-sha");
    });

    it("grouped member → 409 GROUPED_MEMBER", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const ts = new Date().toISOString();
      const groupId = createId();
      testApp.db
        .insert(mergeRequestGroups)
        .values({
          id: groupId,
          projectId: project.id,
          submittedBy: submitter.id,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      const reqId = createId();
      testApp.db
        .insert(mergeRequests)
        .values({
          id: reqId,
          projectId: project.id,
          submittedBy: submitter.id,
          groupId,
          status: "integrating",
          enqueuedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      expect(() =>
        svc.forceLand(reqId, { landedSha: "x", reason: "y" }, adminActor(testApp)),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "GROUPED_MEMBER" }),
      );
    });

    it("non-admin → 403", () => {
      const project = createTestProject(testApp.db);
      const { requestId } = integratingRequest(testApp, project);
      expect(() =>
        svc.forceLand(requestId, { landedSha: "x", reason: "y" }, memberActor(testApp)),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });

    it("empty reason → 400 VALIDATION_ERROR (no state change)", () => {
      const project = createTestProject(testApp.db);
      const { requestId } = integratingRequest(testApp, project);
      expect(() =>
        svc.forceLand(requestId, { landedSha: "x", reason: "  " }, adminActor(testApp)),
      ).toThrowError(
        expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }),
      );
      const req = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, requestId))
        .get();
      expect(req!.status).toBe("integrating");
    });

    it("queued (not integrating) → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const r = requestSvc.submit({ projectId: project.id, submittedBy: submitter.id });
      expect(() =>
        svc.forceLand(r.id, { landedSha: "x", reason: "y" }, adminActor(testApp)),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("already landed → idempotent 200 no-op, NO new audit", () => {
      const project = createTestProject(testApp.db);
      const { requestId } = integratingRequest(testApp, project, { withTask: true });
      svc.forceLand(requestId, { landedSha: "s1", reason: "first" }, adminActor(testApp));
      const before = auditCount(testApp);
      const view = svc.forceLand(
        requestId,
        { landedSha: "s2", reason: "second" },
        adminActor(testApp),
      );
      expect(view.status).toBe("landed");
      expect(view.landedSha).toBe("s1"); // unchanged
      expect(auditCount(testApp)).toBe(before); // no new audit
    });
  });

  // ── forceReject ──────────────────────────────────────────────────

  describe("forceReject", () => {
    it("rejects integrating: attempt failed/policy + request rejected + reject comment + ONE force_reject audit", () => {
      const project = createTestProject(testApp.db);
      const { requestId, taskId } = integratingRequest(testApp, project, {
        withTask: true,
        withAttempt: true,
      });

      const rejected = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_REJECTED, rejected);

      const view = svc.forceReject(
        requestId,
        { reason: "obsoleted; clearing lane" },
        adminActor(testApp),
      );
      expect(view.status).toBe("rejected");
      expect(view.rejectCategory).toBe("policy");
      expect(view.rejectReason).toBe("obsoleted; clearing lane");

      const att = testApp.db
        .select()
        .from(mergeAttempts)
        .where(eq(mergeAttempts.requestId, requestId))
        .all();
      expect(att).toHaveLength(1);
      expect(att[0].status).toBe("failed");
      expect(att[0].failureCategory).toBe("policy");

      const cmts = testApp.db
        .select()
        .from(comments)
        .where(eq(comments.taskId, taskId!))
        .all();
      const rejComment = cmts.find((c) => c.commentType === "merge_rejection");
      expect(rejComment).toBeDefined();

      const audits = testApp.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "force_reject"))
        .all();
      expect(audits).toHaveLength(1);
      expect(audits[0].reason).toBe("obsoleted; clearing lane");
      expect((audits[0].metadataAfter as Record<string, unknown>).overridden).toBe(true);

      expect(rejected).toHaveBeenCalledTimes(1);
      expect(rejected.mock.calls[0][0].entity.overridden).toBe(true);
    });

    it("synthesizes a failed/policy attempt (baseSha empty) when none open", () => {
      const project = createTestProject(testApp.db);
      const { requestId } = integratingRequest(testApp, project, { withAttempt: false });
      svc.forceReject(requestId, { reason: "policy" }, adminActor(testApp));
      const att = testApp.db
        .select()
        .from(mergeAttempts)
        .where(eq(mergeAttempts.requestId, requestId))
        .all();
      expect(att).toHaveLength(1);
      expect(att[0].status).toBe("failed");
      expect(att[0].baseSha).toBe("");
    });

    it("non-admin → 403; empty reason → 400", () => {
      const project = createTestProject(testApp.db);
      const { requestId } = integratingRequest(testApp, project);
      expect(() =>
        svc.forceReject(requestId, { reason: "x" }, memberActor(testApp)),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
      expect(() =>
        svc.forceReject(requestId, { reason: "" }, adminActor(testApp)),
      ).toThrowError(
        expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }),
      );
    });

    it("already rejected → idempotent 200 no-op, no new audit", () => {
      const project = createTestProject(testApp.db);
      const { requestId } = integratingRequest(testApp, project, { withTask: true });
      svc.forceReject(requestId, { reason: "first" }, adminActor(testApp));
      const before = auditCount(testApp);
      const view = svc.forceReject(requestId, { reason: "second" }, adminActor(testApp));
      expect(view.status).toBe("rejected");
      expect(auditCount(testApp)).toBe(before);
    });
  });
});
