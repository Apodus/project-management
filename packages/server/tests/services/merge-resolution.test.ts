import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import { mergeResolutions } from "../../src/db/index.js";
import * as svc from "../../src/services/merge-resolution.service.js";
import * as mrSvc from "../../src/services/merge-request.service.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";

const HUMAN = (id: string, role = "admin") => ({ id, role, type: "human" });
const AGENT = (id: string) => ({ id, role: "member", type: "ai_agent" });

describe("merge-resolution service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  /** Submit a merge request → returns its id (FK-valid for originRequestId). */
  function makeRequest(projectId: string, submitterId: string): string {
    return mrSvc.submit({ projectId, submittedBy: submitterId }).id;
  }

  /** Open a pending resolution and return its id. */
  function openPending(project: { id: string }, integratorId: string, submitterId: string): string {
    const originRequestId = makeRequest(project.id, submitterId);
    return svc.open(
      { projectId: project.id, originRequestId, conflictingFiles: ["a.ts"] },
      AGENT(integratorId),
    ).id;
  }

  // ─── open ─────────────────────────────────────────────────────────
  describe("open", () => {
    it("inserts a pending row and emits MERGE_RESOLUTION_PENDING after commit", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const originRequestId = makeRequest(project.id, submitter.id);

      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_RESOLUTION_PENDING, listener);

      const out = svc.open(
        { projectId: project.id, originRequestId, conflictingFiles: ["x.ts"] },
        AGENT(integrator.id),
      );

      expect(out.state).toBe("pending");
      expect(out.originRequestId).toBe(originRequestId);
      expect(out.conflictingFiles).toEqual(["x.ts"]);

      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entityType).toBe("merge_resolution");
      expect(payload.entity.resolutionId).toBe(out.id);
      expect(payload.entity.originRequestId).toBe(originRequestId);
      // emit-after-commit: the listener sees the persisted state.
      expect(payload.entity.state).toBe("pending");
      const row = testApp.db
        .select()
        .from(mergeResolutions)
        .where(eq(mergeResolutions.id, out.id))
        .get();
      expect(row?.state).toBe("pending");
    });

    it("throws 403 for a human actor", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const originRequestId = makeRequest(project.id, submitter.id);
      expect(() =>
        svc.open({ projectId: project.id, originRequestId }, HUMAN(submitter.id)),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });
  });

  // ─── start ────────────────────────────────────────────────────────
  describe("start", () => {
    it("pending → resolving emits STARTED (after commit) and sets attemptStartedAt", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id = openPending(project, integrator.id, submitter.id);

      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_RESOLUTION_STARTED, listener);

      const out = svc.start(id, AGENT(integrator.id));
      expect(out.state).toBe("resolving");
      expect(out.attemptStartedAt).toBeTruthy();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].entity.state).toBe("resolving");
    });

    it("throws 409 from a non-pending state", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id = openPending(project, integrator.id, submitter.id);
      svc.start(id, AGENT(integrator.id));
      expect(() => svc.start(id, AGENT(integrator.id))).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("throws 403 for a human actor", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id = openPending(project, integrator.id, submitter.id);
      expect(() => svc.start(id, HUMAN(submitter.id))).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });

  // ─── resolved ─────────────────────────────────────────────────────
  describe("resolved", () => {
    it("resolving → resolved emits SUCCEEDED with resolvedRequestId", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id = openPending(project, integrator.id, submitter.id);
      svc.start(id, AGENT(integrator.id));
      const resolvedRequestId = makeRequest(project.id, submitter.id);

      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_RESOLUTION_SUCCEEDED, listener);

      const out = svc.resolved(
        id,
        { resolvedRequestId, detail: { verifyVerdict: "pass" } },
        AGENT(integrator.id),
      );
      expect(out.state).toBe("resolved");
      expect(out.resolvedRequestId).toBe(resolvedRequestId);
      expect(out.attemptEndedAt).toBeTruthy();

      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entity.state).toBe("resolved");
      expect(payload.entity.resolvedRequestId).toBe(resolvedRequestId);
    });

    it("throws 409 from pending (not resolving)", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id = openPending(project, integrator.id, submitter.id);
      const resolvedRequestId = makeRequest(project.id, submitter.id);
      expect(() => svc.resolved(id, { resolvedRequestId }, AGENT(integrator.id))).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });
  });

  // ─── escalate — the right event fires, the other does not ─────────
  describe("escalate", () => {
    it("state 'escalated' emits ESCALATED and NOT FAILED", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id = openPending(project, integrator.id, submitter.id);
      svc.start(id, AGENT(integrator.id));

      const escalated = vi.fn();
      const failed = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_RESOLUTION_ESCALATED, escalated);
      getEventBus().on(EVENT_NAMES.MERGE_RESOLUTION_FAILED, failed);

      const out = svc.escalate(
        id,
        { target: "author", reason: "verify failed" },
        AGENT(integrator.id),
      );
      expect(out.state).toBe("escalated");
      expect(out.escalationTarget).toBe("author");
      expect(out.detail?.escalationReason).toBe("verify failed");
      expect(out.attemptEndedAt).toBeTruthy();

      expect(escalated).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
    });

    it("state 'failed' emits FAILED and NOT ESCALATED", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id = openPending(project, integrator.id, submitter.id);
      svc.start(id, AGENT(integrator.id));

      const escalated = vi.fn();
      const failed = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_RESOLUTION_ESCALATED, escalated);
      getEventBus().on(EVENT_NAMES.MERGE_RESOLUTION_FAILED, failed);

      const out = svc.escalate(
        id,
        { state: "failed", target: "human", reason: "worktree build failed" },
        AGENT(integrator.id),
      );
      expect(out.state).toBe("failed");

      expect(failed).toHaveBeenCalledTimes(1);
      expect(escalated).not.toHaveBeenCalled();
    });

    it("throws 409 from pending (not resolving)", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id = openPending(project, integrator.id, submitter.id);
      expect(() =>
        svc.escalate(id, { target: "author", reason: "x" }, AGENT(integrator.id)),
      ).toThrowError(expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }));
    });

    it("throws 403 for a human actor", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id = openPending(project, integrator.id, submitter.id);
      svc.start(id, AGENT(integrator.id));
      expect(() =>
        svc.escalate(id, { target: "author", reason: "x" }, HUMAN(submitter.id)),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });
  });

  // ─── getById / list ───────────────────────────────────────────────
  describe("getById / list", () => {
    it("getById throws 404 for an unknown id", () => {
      expect(() => svc.getById("01HNONEXISTENTRES00000")).toThrowError(
        expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }),
      );
    });

    it("list filters by state, ordered by createdAt asc", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestUser(testApp.db, { type: "ai_agent" });
      const id1 = openPending(project, integrator.id, submitter.id);
      const id2 = openPending(project, integrator.id, submitter.id);
      svc.start(id2, AGENT(integrator.id));

      const all = svc.list(project.id);
      expect(all.map((r) => r.id)).toEqual([id1, id2]);

      const pending = svc.list(project.id, { state: "pending" });
      expect(pending.map((r) => r.id)).toEqual([id1]);

      const resolving = svc.list(project.id, { state: "resolving" });
      expect(resolving.map((r) => r.id)).toEqual([id2]);
    });
  });
});
