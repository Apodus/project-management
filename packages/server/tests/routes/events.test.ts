import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestProject,
  createTestUser,
  createTestTask,
  createTestAiAgent,
  authRequest,
  type TestApp,
} from "../utils.js";
import { getEventBus, EVENT_NAMES, type EventPayload } from "../../src/events/event-bus.js";
import * as mergeRequestSvc from "../../src/services/merge-request.service.js";
import * as mergeAttemptSvc from "../../src/services/merge-attempt.service.js";

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Parse SSE text into individual events.
 * Each event is delimited by a blank line (\n\n).
 */
function parseSSEEvents(text: string): Array<{ event?: string; data?: string }> {
  const events: Array<{ event?: string; data?: string }> = [];
  // Split on double newline (handles \r\n and \n)
  const blocks = text.split(/\r?\n\r?\n/).filter((b) => b.trim());

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const entry: { event?: string; data?: string } = {};

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        entry.event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        entry.data = line.slice(6);
      } else if (line.startsWith("data:")) {
        entry.data = line.slice(5);
      }
    }

    if (entry.event || entry.data) {
      events.push(entry);
    }
  }

  return events;
}

/**
 * Read SSE stream with a timeout, collecting text until we have enough
 * events or the timeout expires. Cancels the stream reader on completion.
 */
async function readSSEStream(
  response: Response,
  opts: { maxEvents?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { maxEvents = 5, timeoutMs = 2000 } = opts;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";

  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => resolve(), timeoutMs),
  );

  const read = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        // Check if we have enough events
        const eventCount = parseSSEEvents(text).length;
        if (eventCount >= maxEvents) break;
      }
    } catch {
      // reader may be cancelled
    }
  };

  await Promise.race([read(), timeout]);

  try {
    reader.cancel();
  } catch {
    // already closed
  }

  return text;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("SSE Events API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Auth ─────────────────────────────────────────────────────

  describe("Authentication", () => {
    it("should return 401 without auth token", async () => {
      const res = await testApp.app.request("/api/v1/events", {
        method: "GET",
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("should accept valid Bearer token", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/events");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });
  });

  // ── Content type ─────────────────────────────────────────────

  describe("SSE headers", () => {
    it("should return text/event-stream content type", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/events");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });
  });

  // ── Connected event ──────────────────────────────────────────

  describe("Connected event", () => {
    it("should send connected event on connection", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/events");
      expect(res.status).toBe(200);

      const text = await readSSEStream(res, { maxEvents: 1, timeoutMs: 1000 });
      const events = parseSSEEvents(text);

      expect(events.length).toBeGreaterThanOrEqual(1);
      const connected = events.find((e) => e.event === "connected");
      expect(connected).toBeDefined();
      expect(JSON.parse(connected!.data!)).toEqual({ status: "connected" });
    });
  });

  // ── Event streaming ──────────────────────────────────────────

  describe("Event streaming", () => {
    it("should stream events when mutations happen via event bus", async () => {
      // Create real entities so activity log FK constraints pass
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "GET", "/api/v1/events");
      expect(res.status).toBe(200);

      const bus = getEventBus();

      setTimeout(() => {
        const payload: EventPayload = {
          entity: { id: project.id, name: project.name },
          entityType: "project",
          entityId: project.id,
          projectId: project.id,
          actorId: testApp.testUser.id,
          timestamp: new Date().toISOString(),
        };
        bus.emit(EVENT_NAMES.PROJECT_UPDATED, payload);
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 2, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      // Should have connected + project.updated
      expect(events.length).toBeGreaterThanOrEqual(2);

      const projectEvent = events.find((e) => e.event === "project.updated");
      expect(projectEvent).toBeDefined();

      const data = JSON.parse(projectEvent!.data!);
      expect(data.entity_type).toBe("project");
      expect(data.entity_id).toBe(project.id);
      expect(data.action).toBe("updated");
      expect(data.actor.id).toBe(testApp.testUser.id);
      expect(data.actor.name).toBe(testApp.testUser.displayName);
      expect(data.timestamp).toBeDefined();
    });

    it("should include changes in update events", async () => {
      const project = createTestProject(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });

      const res = await authRequest(testApp.app, "GET", "/api/v1/events");
      const bus = getEventBus();

      setTimeout(() => {
        const payload: EventPayload = {
          entity: { id: task.id, title: "Updated Task" },
          entityType: "task",
          entityId: task.id,
          projectId: project.id,
          actorId: testApp.testUser.id,
          timestamp: new Date().toISOString(),
          changes: {
            title: { from: "Original", to: "Updated Task" },
          },
        };
        bus.emit(EVENT_NAMES.TASK_UPDATED, payload);
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 2, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      const taskEvent = events.find((e) => e.event === "task.updated");
      expect(taskEvent).toBeDefined();

      const data = JSON.parse(taskEvent!.data!);
      expect(data.changes).toBeDefined();
      expect(data.changes.title.from).toBe("Original");
      expect(data.changes.title.to).toBe("Updated Task");
    });
  });

  // ── Project filter ───────────────────────────────────────────

  describe("Project filter", () => {
    it("should only stream events matching project_id filter", async () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const taskA = createTestTask(testApp.db, { projectId: projectA.id });
      const taskB = createTestTask(testApp.db, { projectId: projectB.id });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${projectA.id}`,
      );
      const bus = getEventBus();

      setTimeout(() => {
        // Emit event for projectB (should be filtered out)
        bus.emit(EVENT_NAMES.TASK_UPDATED, {
          entity: { id: taskB.id },
          entityType: "task",
          entityId: taskB.id,
          projectId: projectB.id,
          actorId: testApp.testUser.id,
          timestamp: new Date().toISOString(),
        });

        // Emit event for projectA (should pass through)
        bus.emit(EVENT_NAMES.TASK_UPDATED, {
          entity: { id: taskA.id },
          entityType: "task",
          entityId: taskA.id,
          projectId: projectA.id,
          actorId: testApp.testUser.id,
          timestamp: new Date().toISOString(),
        });
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 2, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      // Should have connected + task.updated for projectA only
      const taskEvents = events.filter((e) => e.event === "task.updated");
      expect(taskEvents.length).toBe(1);

      const data = JSON.parse(taskEvents[0].data!);
      expect(data.entity_id).toBe(taskA.id);
    });

    it("should stream all events when no project_id is specified", async () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const taskA = createTestTask(testApp.db, { projectId: projectA.id });
      const taskB = createTestTask(testApp.db, { projectId: projectB.id });

      const res = await authRequest(testApp.app, "GET", "/api/v1/events");
      const bus = getEventBus();

      setTimeout(() => {
        bus.emit(EVENT_NAMES.TASK_UPDATED, {
          entity: { id: taskA.id },
          entityType: "task",
          entityId: taskA.id,
          projectId: projectA.id,
          actorId: testApp.testUser.id,
          timestamp: new Date().toISOString(),
        });

        bus.emit(EVENT_NAMES.TASK_UPDATED, {
          entity: { id: taskB.id },
          entityType: "task",
          entityId: taskB.id,
          projectId: projectB.id,
          actorId: testApp.testUser.id,
          timestamp: new Date().toISOString(),
        });
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 3, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      const taskEvents = events.filter((e) => e.event === "task.updated");
      expect(taskEvents.length).toBe(2);
    });
  });

  // ── Integration: API mutation triggers SSE ───────────────────

  describe("Integration with API mutations", () => {
    it("should stream events when a project is created via API", async () => {
      // Start SSE stream
      const sseRes = await authRequest(testApp.app, "GET", "/api/v1/events");
      expect(sseRes.status).toBe(200);

      // Create a project via API (this should trigger event bus emission)
      setTimeout(async () => {
        await authRequest(testApp.app, "POST", "/api/v1/projects", {
          body: { name: "SSE Integration Test Project" },
        });
      }, 50);

      const text = await readSSEStream(sseRes, { maxEvents: 2, timeoutMs: 3000 });
      const events = parseSSEEvents(text);

      // Should have connected + project.created
      const projectEvent = events.find((e) => e.event === "project.created");
      expect(projectEvent).toBeDefined();

      if (projectEvent) {
        const data = JSON.parse(projectEvent.data!);
        expect(data.entity_type).toBe("project");
        expect(data.action).toBe("created");
      }
    });
  });

  // ── Phase 7.1: merge train events over SSE ───────────────────

  describe("Phase 7.1 merge train events over SSE", () => {
    it("streams merge.request.queued when a request is submitted via service", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${project.id}`,
      );
      expect(res.status).toBe(200);

      let submittedId = "";
      setTimeout(() => {
        const r = mergeRequestSvc.submit({
          projectId: project.id,
          submittedBy: submitter.id,
          branch: "feat/sse-stream",
          commitSha: "deadbeef",
        });
        submittedId = r.id;
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 2, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      const queued = events.find((e) => e.event === "merge.request.queued");
      expect(queued).toBeDefined();
      const data = JSON.parse(queued!.data!);
      expect(data.entity_type).toBe("merge_request");
      expect(data.entity_id).toBe(submittedId);
      expect(data.action).toBe("request.queued");
      expect(data.actor.id).toBe(submitter.id);
      expect(data.timestamp).toBeDefined();
    });

    it("streams the full integrating → attempt-started → landed sequence in order", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db).user;
      const actor = { id: integrator.id, role: "member", type: "ai_agent" };

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${project.id}`,
      );
      expect(res.status).toBe(200);

      setTimeout(() => {
        const r = mergeRequestSvc.submit({
          projectId: project.id,
          submittedBy: submitter.id,
          branch: "feat/full-cycle",
        });
        mergeRequestSvc.transitionToIntegrating(r.id, actor);
        const att = mergeAttemptSvc.startAttempt(r.id, { baseSha: "base000" }, actor);
        mergeAttemptSvc.completeAttempt(
          att.id,
          { status: "passed", treeSha: "tree111" },
          actor,
        );
        mergeRequestSvc.land(r.id, { landedSha: "tree111" }, actor);
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 6, timeoutMs: 3000 });
      const events = parseSSEEvents(text);

      const mergeEvents = events
        .filter((e) => e.event && e.event.startsWith("merge."))
        .map((e) => e.event);

      expect(mergeEvents).toEqual([
        "merge.request.queued",
        "merge.request.integrating",
        "merge.attempt.started",
        "merge.attempt.completed",
        "merge.request.landed",
      ]);

      const landed = events.find((e) => e.event === "merge.request.landed")!;
      const landedData = JSON.parse(landed.data!);
      expect(landedData.entity_type).toBe("merge_request");
    });
  });

  // ── Phase 7.2: batch-tagged merge.request / merge.attempt frames ──

  describe("Phase 7.2 batch-tagged frames over SSE", () => {
    it("tags merge.request.integrating and merge.attempt.started with batch_id/speculative_position", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db).user;
      const actor = { id: integrator.id, role: "member", type: "ai_agent" };

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${project.id}`,
      );
      expect(res.status).toBe(200);

      setTimeout(() => {
        const r = mergeRequestSvc.submit({
          projectId: project.id,
          submittedBy: submitter.id,
          branch: "feat/tagged",
        });
        mergeRequestSvc.transitionToIntegrating(r.id, actor, {
          batchId: "batch-X",
          speculativePosition: 2,
        });
        mergeAttemptSvc.startAttempt(r.id, { baseSha: "base000" }, actor, {
          batchId: "batch-X",
          speculativePosition: 2,
        });
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 4, timeoutMs: 3000 });
      const events = parseSSEEvents(text);

      const integrating = events.find((e) => e.event === "merge.request.integrating");
      expect(integrating).toBeDefined();
      const intData = JSON.parse(integrating!.data!);
      expect(intData.batch_id).toBe("batch-X");
      expect(intData.speculative_position).toBe(2);

      const started = events.find((e) => e.event === "merge.attempt.started");
      expect(started).toBeDefined();
      const startData = JSON.parse(started!.data!);
      expect(startData.batch_id).toBe("batch-X");
      expect(startData.speculative_position).toBe(2);
    });

    it("backward-compat: an untagged 7.1-style integrating frame has no batch_id", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db).user;
      const actor = { id: integrator.id, role: "member", type: "ai_agent" };

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${project.id}`,
      );
      expect(res.status).toBe(200);

      setTimeout(() => {
        const r = mergeRequestSvc.submit({
          projectId: project.id,
          submittedBy: submitter.id,
          branch: "feat/untagged",
        });
        // No extra → 7.1 behavior.
        mergeRequestSvc.transitionToIntegrating(r.id, actor);
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 3, timeoutMs: 3000 });
      const events = parseSSEEvents(text);

      const integrating = events.find((e) => e.event === "merge.request.integrating");
      expect(integrating).toBeDefined();
      const data = JSON.parse(integrating!.data!);
      expect("batch_id" in data).toBe(false);
      expect("speculative_position" in data).toBe(false);
    });
  });
});
