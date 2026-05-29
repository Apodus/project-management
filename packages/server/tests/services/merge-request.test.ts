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
import * as svc from "../../src/services/merge-request.service.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";

describe("merge-request service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ─── submit ─────────────────────────────────────────────────────
  describe("submit", () => {
    it("happy path: creates queued row + emits MERGE_REQUEST_QUEUED", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_QUEUED, listener);

      const r = svc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
        branch: "feat/x",
        commitSha: "abc1234",
      });

      expect(r.status).toBe("queued");
      expect(r.resource).toBe("main");
      expect(r.submittedBy).toBe(submitter.id);
      expect(r.enqueuedAt).toBeTruthy();
      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entityType).toBe("merge_request");
      expect(payload.entityId).toBe(r.id);
      expect(payload.actorId).toBe(submitter.id);
    });

    it("submit with cross-project taskId → 400 VALIDATION_ERROR", () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const taskInB = createTestTask(testApp.db, { projectId: projectB.id });

      expect(() =>
        svc.submit({
          projectId: projectA.id,
          submittedBy: submitter.id,
          taskId: taskInB.id,
        }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }),
      );
    });

    it("submit with non-existent taskId → 404 NOT_FOUND", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.submit({
          projectId: project.id,
          submittedBy: submitter.id,
          taskId: "01TASKDOESNOTEXIST0000000000",
        }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }),
      );
    });

    it("submit with non-existent project → 404 NOT_FOUND", () => {
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.submit({
          projectId: "01PROJECTDOESNOTEXIST0000000",
          submittedBy: submitter.id,
        }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }),
      );
    });

    it("submit with non-existent submittedBy → 404 NOT_FOUND", () => {
      const project = createTestProject(testApp.db);
      expect(() =>
        svc.submit({
          projectId: project.id,
          submittedBy: "01USERDOESNOTEXIST0000000000",
        }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }),
      );
    });

    it("submit accepts a valid same-project taskId", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });
      const r = svc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
        taskId: task.id,
      });
      expect(r.taskId).toBe(task.id);
    });
  });

  // ─── list ───────────────────────────────────────────────────────
  describe("list", () => {
    it("filters by status and orders by enqueuedAt asc", () => {
      const project = createTestProject(testApp.db);
      const u = createTestUser(testApp.db);
      const r1 = svc.submit({ projectId: project.id, submittedBy: u.id, branch: "a" });
      const r2 = svc.submit({ projectId: project.id, submittedBy: u.id, branch: "b" });
      const result = svc.list(project.id, { status: "queued" });
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe(r1.id);
      expect(result.data[1].id).toBe(r2.id);
    });

    it("filters by taskId", () => {
      const project = createTestProject(testApp.db);
      const u = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });
      svc.submit({ projectId: project.id, submittedBy: u.id }); // no task
      const r = svc.submit({ projectId: project.id, submittedBy: u.id, taskId: task.id });
      const result = svc.list(project.id, { taskId: task.id });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(r.id);
    });
  });

  // ─── getById ────────────────────────────────────────────────────
  describe("getById", () => {
    it("returns the row with attempts: [] when none exist", () => {
      const project = createTestProject(testApp.db);
      const u = createTestUser(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: u.id });
      const got = svc.getById(r.id);
      expect(got.id).toBe(r.id);
      expect(got.attempts).toEqual([]);
    });

    it("throws 404 for unknown id", () => {
      expect(() => svc.getById("01UNKNOWN000000000000000000")).toThrowError(
        expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }),
      );
    });
  });

  // ─── cancel (queued → abandoned) ────────────────────────────────
  describe("cancel", () => {
    it("submitter cancel-while-queued → abandoned + emits MERGE_REQUEST_ABANDONED", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db, { role: "member" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_ABANDONED, listener);

      const result = svc.cancel(r.id, {
        id: submitter.id,
        role: "member",
        type: "human",
      });
      expect(result.status).toBe("abandoned");
      expect(result.resolvedAt).toBeTruthy();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("admin (non-submitter) cancel-while-queued → abandoned", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db, { role: "member" });
      const admin = createTestUser(testApp.db, { role: "admin" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      const result = svc.cancel(r.id, { id: admin.id, role: "admin", type: "human" });
      expect(result.status).toBe("abandoned");
    });

    it("cancel by stranger → 403 NOT_REQUEST_OWNER", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db, { role: "member" });
      const stranger = createTestUser(testApp.db, { role: "member" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      expect(() =>
        svc.cancel(r.id, { id: stranger.id, role: "member", type: "human" }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "NOT_REQUEST_OWNER" }),
      );
    });

    it("cancel from integrating → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db, { role: "member" });
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      svc.transitionToIntegrating(r.id, {
        id: integrator.user.id,
        role: "member",
        type: "ai_agent",
      });
      expect(() =>
        svc.cancel(r.id, { id: submitter.id, role: "member", type: "human" }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("cancel from landed → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db, { role: "member" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      testApp.db
        .update(mergeRequests)
        .set({ status: "landed", resolvedAt: new Date().toISOString() })
        .where(eq(mergeRequests.id, r.id))
        .run();
      expect(() =>
        svc.cancel(r.id, { id: submitter.id, role: "member", type: "human" }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("cancel from rejected → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db, { role: "member" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      testApp.db
        .update(mergeRequests)
        .set({ status: "rejected", resolvedAt: new Date().toISOString() })
        .where(eq(mergeRequests.id, r.id))
        .run();
      expect(() =>
        svc.cancel(r.id, { id: submitter.id, role: "member", type: "human" }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("cancel on abandoned → 200 idempotent (returns existing row, no new event)", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db, { role: "member" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      svc.cancel(r.id, { id: submitter.id, role: "member", type: "human" });
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_ABANDONED, listener);
      const second = svc.cancel(r.id, {
        id: submitter.id,
        role: "member",
        type: "human",
      });
      expect(second.status).toBe("abandoned");
      expect(listener).not.toHaveBeenCalled();
    });

    it("cancel on unknown id → 404 NOT_FOUND", () => {
      const u = createTestUser(testApp.db);
      expect(() =>
        svc.cancel("01UNKNOWN000000000000000000", {
          id: u.id,
          role: "admin",
          type: "human",
        }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }),
      );
    });
  });

  // ─── forceCancel ────────────────────────────────────────────────
  describe("forceCancel", () => {
    it("admin forceCancel from queued → abandoned", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      const out = svc.forceCancel(
        r.id,
        { id: admin.id, role: "admin", type: "human" },
        "broken intent",
      );
      expect(out.status).toBe("abandoned");
    });

    it("admin forceCancel from integrating → abandoned + emits MERGE_REQUEST_ABANDONED", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      svc.transitionToIntegrating(r.id, {
        id: integrator.user.id,
        role: "member",
        type: "ai_agent",
      });
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_ABANDONED, listener);
      const out = svc.forceCancel(
        r.id,
        { id: admin.id, role: "admin", type: "human" },
        "stuck",
      );
      expect(out.status).toBe("abandoned");
      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entity.reason).toBe("stuck");
    });

    it("non-admin forceCancel → 403 FORBIDDEN", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      expect(() =>
        svc.forceCancel(
          r.id,
          { id: submitter.id, role: "member", type: "human" },
          null,
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });

    it("forceCancel from landed → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      testApp.db
        .update(mergeRequests)
        .set({ status: "landed", resolvedAt: new Date().toISOString() })
        .where(eq(mergeRequests.id, r.id))
        .run();
      expect(() =>
        svc.forceCancel(r.id, { id: admin.id, role: "admin", type: "human" }, null),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("forceCancel from rejected → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      testApp.db
        .update(mergeRequests)
        .set({ status: "rejected", resolvedAt: new Date().toISOString() })
        .where(eq(mergeRequests.id, r.id))
        .run();
      expect(() =>
        svc.forceCancel(r.id, { id: admin.id, role: "admin", type: "human" }, null),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("forceCancel on abandoned → 200 idempotent", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      svc.cancel(r.id, { id: submitter.id, role: "member", type: "human" });
      const out = svc.forceCancel(
        r.id,
        { id: admin.id, role: "admin", type: "human" },
        null,
      );
      expect(out.status).toBe("abandoned");
    });
  });

  // ─── transitionToIntegrating ────────────────────────────────────
  describe("transitionToIntegrating", () => {
    it("queued → integrating, sets pickedUpAt, emits MERGE_REQUEST_INTEGRATING", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_INTEGRATING, listener);

      const out = svc.transitionToIntegrating(r.id, {
        id: integrator.user.id,
        role: "member",
        type: "ai_agent",
      });
      expect(out.status).toBe("integrating");
      expect(out.pickedUpAt).toBeTruthy();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].actorId).toBe(integrator.user.id);
    });

    it("integrating → 409 INVALID_TRANSITION (no idempotent case)", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      const actor = {
        id: integrator.user.id,
        role: "member",
        type: "ai_agent",
      };
      svc.transitionToIntegrating(r.id, actor);
      expect(() => svc.transitionToIntegrating(r.id, actor)).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("from landed → 409", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      testApp.db
        .update(mergeRequests)
        .set({ status: "landed" })
        .where(eq(mergeRequests.id, r.id))
        .run();
      expect(() =>
        svc.transitionToIntegrating(r.id, {
          id: integrator.user.id,
          role: "member",
          type: "ai_agent",
        }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("from rejected → 409", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      testApp.db
        .update(mergeRequests)
        .set({ status: "rejected" })
        .where(eq(mergeRequests.id, r.id))
        .run();
      expect(() =>
        svc.transitionToIntegrating(r.id, {
          id: integrator.user.id,
          role: "member",
          type: "ai_agent",
        }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("from abandoned → 409", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      svc.cancel(r.id, { id: submitter.id, role: "member", type: "human" });
      expect(() =>
        svc.transitionToIntegrating(r.id, {
          id: integrator.user.id,
          role: "member",
          type: "ai_agent",
        }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("non-integrator (human) → 403 FORBIDDEN", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      expect(() =>
        svc.transitionToIntegrating(r.id, {
          id: submitter.id,
          role: "admin",
          type: "human",
        }),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });

  // ─── resetToQueued ──────────────────────────────────────────────
  describe("resetToQueued", () => {
    it("integrating → queued, clears pickedUpAt, re-emits MERGE_REQUEST_QUEUED with reason", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      const actor = {
        id: integrator.user.id,
        role: "member",
        type: "ai_agent",
      };
      svc.transitionToIntegrating(r.id, actor);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_QUEUED, listener);

      const out = svc.resetToQueued(r.id, actor, "push race");
      expect(out.status).toBe("queued");
      expect(out.pickedUpAt).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].entity.reason).toBe("push race");
    });

    it("queued → 409 INVALID_TRANSITION (no idempotent case)", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      expect(() =>
        svc.resetToQueued(
          r.id,
          { id: integrator.user.id, role: "member", type: "ai_agent" },
          "x",
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("from landed → 409", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      testApp.db
        .update(mergeRequests)
        .set({ status: "landed" })
        .where(eq(mergeRequests.id, r.id))
        .run();
      expect(() =>
        svc.resetToQueued(
          r.id,
          { id: integrator.user.id, role: "member", type: "ai_agent" },
          "x",
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("from rejected → 409", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      testApp.db
        .update(mergeRequests)
        .set({ status: "rejected" })
        .where(eq(mergeRequests.id, r.id))
        .run();
      expect(() =>
        svc.resetToQueued(
          r.id,
          { id: integrator.user.id, role: "member", type: "ai_agent" },
          "x",
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("from abandoned → 409", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      svc.cancel(r.id, { id: submitter.id, role: "member", type: "human" });
      expect(() =>
        svc.resetToQueued(
          r.id,
          { id: integrator.user.id, role: "member", type: "ai_agent" },
          "x",
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("non-integrator → 403 FORBIDDEN", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      svc.transitionToIntegrating(r.id, {
        id: integrator.user.id,
        role: "member",
        type: "ai_agent",
      });
      expect(() =>
        svc.resetToQueued(
          r.id,
          { id: submitter.id, role: "admin", type: "human" },
          "x",
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });

  // ─── land ───────────────────────────────────────────────────────
  describe("land", () => {
    function setupIntegrating(testApp: TestApp, opts?: { withTask?: boolean }) {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const actor = { id: agent.user.id, role: "member", type: "ai_agent" };
      const task = opts?.withTask
        ? createTestTask(testApp.db, { projectId: project.id })
        : null;
      const r = svc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
        taskId: task?.id ?? null,
      });
      svc.transitionToIntegrating(r.id, actor);
      return { project, submitter, agent, actor, task, r };
    }

    it("integrating → landed; emits MERGE_REQUEST_LANDED AFTER commit", () => {
      const { r, actor } = setupIntegrating(testApp);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_LANDED, listener);

      const out = svc.land(r.id, { landedSha: "ff1122" }, actor);

      expect(out.status).toBe("landed");
      expect(out.landedSha).toBe("ff1122");
      expect(out.resolvedAt).toBeTruthy();
      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entity.landedSha).toBe("ff1122");
      expect(payload.entity.gitRefId).toBeNull();
    });

    it("with taskId: inserts git_refs row of type landed_sha", () => {
      const { r, actor, task } = setupIntegrating(testApp, { withTask: true });
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_LANDED, listener);

      svc.land(r.id, { landedSha: "deadbeef" }, actor);

      const refs = testApp.db
        .select()
        .from(gitRefs)
        .where(eq(gitRefs.taskId, task!.id))
        .all();
      expect(refs).toHaveLength(1);
      expect(refs[0].refType).toBe("landed_sha");
      expect(refs[0].refValue).toBe("deadbeef");
      const payload = listener.mock.calls[0][0];
      expect(payload.entity.gitRefId).toBe(refs[0].id);
    });

    it("idempotent: second land on landed returns existing row, no second event, no duplicate git_ref", () => {
      const { r, actor, task } = setupIntegrating(testApp, { withTask: true });
      svc.land(r.id, { landedSha: "sha1" }, actor);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_LANDED, listener);

      const out = svc.land(r.id, { landedSha: "sha1" }, actor);
      expect(out.status).toBe("landed");
      expect(listener).not.toHaveBeenCalled();

      const refs = testApp.db
        .select()
        .from(gitRefs)
        .where(eq(gitRefs.taskId, task!.id))
        .all();
      expect(refs).toHaveLength(1);
    });

    it("from queued → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const r = svc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
      });
      expect(() =>
        svc.land(
          r.id,
          { landedSha: "x" },
          { id: agent.user.id, role: "member", type: "ai_agent" },
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("from rejected → 409 INVALID_TRANSITION", () => {
      const { r, actor } = setupIntegrating(testApp);
      testApp.db
        .update(mergeRequests)
        .set({ status: "rejected", resolvedAt: new Date().toISOString() })
        .where(eq(mergeRequests.id, r.id))
        .run();
      expect(() => svc.land(r.id, { landedSha: "x" }, actor)).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("non-integrator → 403 FORBIDDEN", () => {
      const { r } = setupIntegrating(testApp);
      expect(() =>
        svc.land(
          r.id,
          { landedSha: "x" },
          { id: "u", role: "admin", type: "human" },
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });

  // ─── reject ─────────────────────────────────────────────────────
  describe("reject", () => {
    function setupIntegrating(testApp: TestApp, opts?: { withTask?: boolean }) {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const actor = { id: agent.user.id, role: "member", type: "ai_agent" };
      const task = opts?.withTask
        ? createTestTask(testApp.db, { projectId: project.id })
        : null;
      const r = svc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
        taskId: task?.id ?? null,
      });
      svc.transitionToIntegrating(r.id, actor);
      return { project, submitter, agent, actor, task, r };
    }

    it("integrating → rejected; emits MERGE_REQUEST_REJECTED AFTER commit", () => {
      const { r, actor } = setupIntegrating(testApp);
      const attempt = attemptSvc.startAttempt(r.id, { baseSha: "b1" }, actor);
      attemptSvc.completeAttempt(
        attempt.id,
        {
          status: "failed",
          failureCategory: "build_failed",
          failureReason: "boom",
        },
        actor,
      );

      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_REJECTED, listener);

      const out = svc.reject(
        r.id,
        {
          category: "build_failed",
          reason: "cargo failed",
          failedFiles: ["a.rs"],
          logExcerpt: "error",
          logUrl: "file:///tmp/log",
        },
        actor,
      );

      expect(out.status).toBe("rejected");
      expect(out.rejectCategory).toBe("build_failed");
      expect(out.failedFiles).toEqual(["a.rs"]);
      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entity.category).toBe("build_failed");
      expect(payload.entity.attemptId).toBe(attempt.id);
    });

    it("with taskId: inserts merge_rejection comment with structured metadata", () => {
      const { r, actor, task } = setupIntegrating(testApp, { withTask: true });
      const attempt = attemptSvc.startAttempt(r.id, { baseSha: "B" }, actor);
      attemptSvc.completeAttempt(
        attempt.id,
        {
          status: "failed",
          failureCategory: "test_failed",
          failureReason: "tests",
        },
        actor,
      );

      svc.reject(
        r.id,
        {
          category: "test_failed",
          reason: "8 tests failed",
          failedFiles: ["t.rs"],
          logUrl: "file:///tmp/log",
        },
        actor,
      );

      const list = testApp.db
        .select()
        .from(comments)
        .where(eq(comments.taskId, task!.id))
        .all();
      expect(list).toHaveLength(1);
      expect(list[0].commentType).toBe("merge_rejection");
      const meta = list[0].metadata as Record<string, unknown>;
      expect(meta.mergeRequestId).toBe(r.id);
      expect(meta.attemptId).toBe(attempt.id);
      expect(meta.category).toBe("test_failed");
      expect(meta.baseSha).toBe("B");
    });

    it("without taskId: no comment, structured payload still in payload + row", () => {
      const { r, actor } = setupIntegrating(testApp);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_REJECTED, listener);
      const out = svc.reject(
        r.id,
        { category: "other", reason: "x" },
        actor,
      );
      expect(out.rejectCategory).toBe("other");
      expect(listener.mock.calls[0][0].entity.commentId).toBeNull();
    });

    it("idempotent: second reject on rejected returns row, no new event, no duplicate comment", () => {
      const { r, actor, task } = setupIntegrating(testApp, { withTask: true });
      svc.reject(r.id, { category: "other", reason: "1" }, actor);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_REJECTED, listener);

      const out = svc.reject(r.id, { category: "other", reason: "2" }, actor);
      expect(out.status).toBe("rejected");
      expect(listener).not.toHaveBeenCalled();
      const list = testApp.db
        .select()
        .from(comments)
        .where(eq(comments.taskId, task!.id))
        .all();
      expect(list).toHaveLength(1);
    });

    it("from queued → 409", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      expect(() =>
        svc.reject(
          r.id,
          { category: "other", reason: "x" },
          { id: agent.user.id, role: "member", type: "ai_agent" },
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("from landed → 409", () => {
      const { r, actor } = setupIntegrating(testApp);
      svc.land(r.id, { landedSha: "x" }, actor);
      expect(() =>
        svc.reject(r.id, { category: "other", reason: "x" }, actor),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("non-integrator → 403", () => {
      const { r } = setupIntegrating(testApp);
      expect(() =>
        svc.reject(
          r.id,
          { category: "other", reason: "x" },
          { id: "u", role: "admin", type: "human" },
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });

  // ─── resetToQueued cancels open attempts ────────────────────────
  describe("resetToQueued cancels open attempts", () => {
    it("cancels running attempts and emits per-attempt MERGE_ATTEMPT_COMPLETED AFTER commit", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const actor = { id: agent.user.id, role: "member", type: "ai_agent" };
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      svc.transitionToIntegrating(r.id, actor);
      const a = attemptSvc.startAttempt(r.id, { baseSha: "b" }, actor);

      const attemptListener = vi.fn();
      const queuedListener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_ATTEMPT_COMPLETED, attemptListener);
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_QUEUED, queuedListener);

      const out = svc.resetToQueued(r.id, actor, "push race");

      expect(out.status).toBe("queued");
      expect(out.pickedUpAt).toBeNull();

      const row = testApp.db
        .select()
        .from(mergeAttempts)
        .where(eq(mergeAttempts.id, a.id))
        .get();
      expect(row?.status).toBe("cancelled");

      expect(attemptListener).toHaveBeenCalledTimes(1);
      expect(queuedListener).toHaveBeenCalledTimes(1);
      expect(attemptListener.mock.calls[0][0].entity.reason).toBe("push race");
      expect(queuedListener.mock.calls[0][0].entity.reason).toBe("push race");
    });

    it("no open attempts: still re-emits MERGE_REQUEST_QUEUED, no attempt events", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const actor = { id: agent.user.id, role: "member", type: "ai_agent" };
      const r = svc.submit({ projectId: project.id, submittedBy: submitter.id });
      svc.transitionToIntegrating(r.id, actor);

      const attemptListener = vi.fn();
      const queuedListener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_ATTEMPT_COMPLETED, attemptListener);
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_QUEUED, queuedListener);

      svc.resetToQueued(r.id, actor, "no attempt yet");
      expect(attemptListener).not.toHaveBeenCalled();
      expect(queuedListener).toHaveBeenCalledTimes(1);
    });
  });
});
