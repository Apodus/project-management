import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
} from "../utils.js";
import {
  comments,
  gitRefs,
  mergeAttempts,
  mergeRequests,
} from "../../src/db/index.js";
import * as attemptSvc from "../../src/services/merge-attempt.service.js";
import * as requestSvc from "../../src/services/merge-request.service.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";

describe("merge-attempt service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  function pickUp(testApp: TestApp) {
    const project = createTestProject(testApp.db);
    const submitter = createTestUser(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const actor = { id: agent.user.id, role: "member", type: "ai_agent" };
    const req = requestSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
      branch: "feat/x",
      commitSha: "abc1234",
    });
    requestSvc.transitionToIntegrating(req.id, actor);
    return { project, submitter, agent, actor, req };
  }

  describe("startAttempt", () => {
    it("inserts running attempt, numbered 1, emits MERGE_ATTEMPT_STARTED", () => {
      const { req, actor } = pickUp(testApp);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_ATTEMPT_STARTED, listener);

      const a = attemptSvc.startAttempt(req.id, { baseSha: "base1" }, actor);

      expect(a.status).toBe("running");
      expect(a.attemptNumber).toBe(1);
      expect(a.baseSha).toBe("base1");
      expect(a.startedAt).toBeTruthy();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].actorId).toBe(actor.id);
    });

    it("monotonic numbering: second attempt is attemptNumber=2", () => {
      const { req, actor } = pickUp(testApp);
      const a1 = attemptSvc.startAttempt(req.id, { baseSha: "b1" }, actor);
      attemptSvc.completeAttempt(a1.id, { status: "cancelled" }, actor);
      const a2 = attemptSvc.startAttempt(req.id, { baseSha: "b2" }, actor);
      expect(a2.attemptNumber).toBe(2);
    });

    it("from non-integrating request → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const actor = { id: agent.user.id, role: "member", type: "ai_agent" };
      const req = requestSvc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
      });
      expect(() =>
        attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("non-integrator (human) → 403 FORBIDDEN", () => {
      const { req } = pickUp(testApp);
      expect(() =>
        attemptSvc.startAttempt(
          req.id,
          { baseSha: "b" },
          { id: "u", role: "admin", type: "human" },
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });

  describe("completeAttempt", () => {
    it("passed: sets treeSha, verifyDurationMs, emits MERGE_ATTEMPT_COMPLETED", () => {
      const { req, actor } = pickUp(testApp);
      const a = attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_ATTEMPT_COMPLETED, listener);

      const done = attemptSvc.completeAttempt(
        a.id,
        { status: "passed", treeSha: "tree1" },
        actor,
      );

      expect(done.status).toBe("passed");
      expect(done.treeSha).toBe("tree1");
      expect(done.completedAt).toBeTruthy();
      expect(done.verifyDurationMs).not.toBeNull();
      expect(done.verifyDurationMs).toBeGreaterThanOrEqual(0);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("passed WITH steps: persists steps[] on the view (Phase 7.5)", () => {
      const { req, actor } = pickUp(testApp);
      const a = attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor);
      const steps = [
        {
          stepId: "lint",
          outcome: "pass" as const,
          cached: true,
          durationMs: 0,
          treeSha: "tree1",
          stepConfigSha: "cfg-lint",
        },
        {
          stepId: "unit",
          outcome: "pass" as const,
          cached: false,
          durationMs: 4200,
          treeSha: "tree1",
          stepConfigSha: "cfg-unit",
          logUrl: "file:///tmp/unit.log",
        },
      ];
      const done = attemptSvc.completeAttempt(
        a.id,
        { status: "passed", treeSha: "tree1", steps },
        actor,
      );
      expect(done.steps).toEqual(steps);
    });

    it("passed WITHOUT steps: steps column is null (7.1-7.4 compat)", () => {
      const { req, actor } = pickUp(testApp);
      const a = attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor);
      const done = attemptSvc.completeAttempt(
        a.id,
        { status: "passed", treeSha: "tree1" },
        actor,
      );
      expect(done.steps).toBeNull();
    });

    it("failed WITH steps: persists the failing pipeline pass (Phase 7.5)", () => {
      const { req, actor } = pickUp(testApp);
      const a = attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor);
      const steps = [
        {
          stepId: "lint",
          outcome: "fail" as const,
          cached: false,
          durationMs: 1200,
          treeSha: "tree2",
          stepConfigSha: "cfg-lint",
        },
      ];
      const done = attemptSvc.completeAttempt(
        a.id,
        {
          status: "failed",
          failureCategory: "lint_failed",
          failureReason: "eslint",
          steps,
        },
        actor,
      );
      expect(done.steps).toEqual(steps);
    });

    it("failed: records failureCategory + payload", () => {
      const { req, actor } = pickUp(testApp);
      const a = attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor);
      const done = attemptSvc.completeAttempt(
        a.id,
        {
          status: "failed",
          failureCategory: "build_failed",
          failureReason: "cargo failed",
          failedFiles: ["src/a.rs"],
          logExcerpt: "error[E0599]",
          logUrl: "file:///tmp/log",
        },
        actor,
      );
      expect(done.failureCategory).toBe("build_failed");
      expect(done.failedFiles).toEqual(["src/a.rs"]);
    });

    it("from non-running attempt → 409 INVALID_TRANSITION", () => {
      const { req, actor } = pickUp(testApp);
      const a = attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor);
      attemptSvc.completeAttempt(a.id, { status: "cancelled" }, actor);
      expect(() =>
        attemptSvc.completeAttempt(a.id, { status: "cancelled" }, actor),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("non-integrator → 403 FORBIDDEN", () => {
      const { req, actor } = pickUp(testApp);
      const a = attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor);
      expect(() =>
        attemptSvc.completeAttempt(
          a.id,
          { status: "cancelled" },
          { id: "u", role: "admin", type: "human" },
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });

  describe("cancelOpenAttempts", () => {
    it("write-only: cancels running attempts, does NOT emit", () => {
      const { req, actor } = pickUp(testApp);
      const a = attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_ATTEMPT_COMPLETED, listener);

      const { cancelledAttempts } = attemptSvc.cancelOpenAttempts(req.id);

      expect(cancelledAttempts).toHaveLength(1);
      expect(cancelledAttempts[0].id).toBe(a.id);
      expect(cancelledAttempts[0].status).toBe("cancelled");
      expect(listener).not.toHaveBeenCalled();

      const row = testApp.db
        .select()
        .from(mergeAttempts)
        .where(eq(mergeAttempts.id, a.id))
        .get();
      expect(row?.status).toBe("cancelled");
      expect(row?.completedAt).toBeTruthy();
    });

    it("skips already-terminal attempts", () => {
      const { req, actor } = pickUp(testApp);
      const a1 = attemptSvc.startAttempt(req.id, { baseSha: "b" }, actor);
      attemptSvc.completeAttempt(
        a1.id,
        { status: "passed", treeSha: "t" },
        actor,
      );

      const { cancelledAttempts } = attemptSvc.cancelOpenAttempts(req.id);
      expect(cancelledAttempts).toHaveLength(0);
    });

    it("returns empty array when no attempts exist", () => {
      const { req } = pickUp(testApp);
      const { cancelledAttempts } = attemptSvc.cancelOpenAttempts(req.id);
      expect(cancelledAttempts).toEqual([]);
    });
  });
});
