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
import * as mergeGroupSvc from "../../src/services/merge-group.service.js";
import * as mergeIncidentSvc from "../../src/services/merge-incident.service.js";

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

  // ── Notes events over SSE (Campaign C1) ──────────────────────

  describe("Notes events over SSE", () => {
    it("projects the note title onto the note.created frame", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", "/api/v1/events");
      const bus = getEventBus();

      setTimeout(() => {
        const payload: EventPayload = {
          entity: { id: "note_001", title: "DB connection leaks on retry" },
          entityType: "note",
          entityId: "note_001",
          projectId: project.id,
          actorId: testApp.testUser.id,
          timestamp: new Date().toISOString(),
        };
        bus.emit(EVENT_NAMES.NOTE_CREATED, payload);
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 2, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      const noteEvent = events.find((e) => e.event === "note.created");
      expect(noteEvent).toBeDefined();

      const data = JSON.parse(noteEvent!.data!);
      expect(data.entity_type).toBe("note");
      expect(data.entity_title).toBe("DB connection leaks on retry");
    });
  });

  // ── Escalation events over SSE (Campaign C1 §P5) ─────────────

  describe("Escalation events over SSE", () => {
    it("projects escalation_id/origin_worker_key/entity_title onto the escalation.opened frame", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", "/api/v1/events");
      const bus = getEventBus();

      setTimeout(() => {
        const payload: EventPayload = {
          entity: {
            id: "esc_001",
            title: "Auth bug in shared lib",
            originRepo: "client-app",
            originWorkerKey: "client-app/worker-7",
            status: "open",
            kind: "bug_report",
          },
          entityType: "escalation",
          entityId: "esc_001",
          projectId: project.id,
          actorId: testApp.testUser.id,
          timestamp: new Date().toISOString(),
        };
        bus.emit(EVENT_NAMES.ESCALATION_OPENED, payload);
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 2, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      const escEvent = events.find((e) => e.event === "escalation.opened");
      expect(escEvent).toBeDefined();

      const data = JSON.parse(escEvent!.data!);
      expect(data.entity_type).toBe("escalation");
      expect(data.entity_id).toBe("esc_001");
      expect(data.action).toBe("opened");
      expect(data.entity_title).toBe("Auth bug in shared lib");
      expect(data.escalation_id).toBe("esc_001");
      expect(data.origin_worker_key).toBe("client-app/worker-7");
    });

    it("byte-identical: a non-escalation frame carries no escalation_id/origin_worker_key", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", "/api/v1/events");
      const bus = getEventBus();

      setTimeout(() => {
        const payload: EventPayload = {
          entity: { id: "note_002", title: "Stray TODO in parser" },
          entityType: "note",
          entityId: "note_002",
          projectId: project.id,
          actorId: testApp.testUser.id,
          timestamp: new Date().toISOString(),
        };
        bus.emit(EVENT_NAMES.NOTE_CREATED, payload);
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 2, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      const noteEvent = events.find((e) => e.event === "note.created");
      expect(noteEvent).toBeDefined();

      const data = JSON.parse(noteEvent!.data!);
      expect("escalation_id" in data).toBe(false);
      expect("origin_worker_key" in data).toBe(false);
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

  // ── Phase 7.3: group/incident frames over SSE ────────────────────

  describe("Phase 7.3 group/incident events over SSE", () => {
    /** Create a real, FK-valid forming group from 2 queued members. */
    function makeGroup(
      project: { id: string },
      submitter: { id: string },
      resource = "main",
    ) {
      const m1 = mergeRequestSvc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
        resource,
      });
      const m2 = mergeRequestSvc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
        resource,
      });
      const g = mergeGroupSvc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: [m1.id, m2.id],
          resource,
        },
        { id: submitter.id, role: "member", type: "human" },
      );
      return { group: g, m1, m2 };
    }

    it("streams group started → member_landed → landed all tagged with group_id", async () => {
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

      let groupId = "";
      setTimeout(() => {
        const { group, m1, m2 } = makeGroup(project, submitter);
        groupId = group.id;
        mergeGroupSvc.markIntegrating(group.id, actor);
        mergeGroupSvc.landGroup(
          group.id,
          {
            members: [
              { requestId: m1.id, landedSha: "inner1", role: "inner" },
              { requestId: m2.id, landedSha: "outer1", role: "outer" },
            ],
          },
          actor,
        );
      }, 50);

      // Phase 7.4: landGroup now also emits one audit.recorded per landed
      // member (additive). Widen the capture window so the targeted group
      // lifecycle events still fall inside it.
      const text = await readSSEStream(res, { maxEvents: 12, timeoutMs: 3000 });
      const events = parseSSEEvents(text);

      const started = events.find((e) => e.event === "merge.group.started");
      expect(started).toBeDefined();
      const startedData = JSON.parse(started!.data!);
      expect(startedData.entity_type).toBe("merge_group");
      expect(startedData.entity_id).toBe(groupId);
      expect(startedData.action).toBe("group.started");
      expect(startedData.group_id).toBe(groupId);

      const memberLanded = events.find(
        (e) => e.event === "merge.group.member_landed",
      );
      expect(memberLanded).toBeDefined();
      const memberLandedData = JSON.parse(memberLanded!.data!);
      expect(memberLandedData.group_id).toBe(groupId);

      const landed = events.find((e) => e.event === "merge.group.landed");
      expect(landed).toBeDefined();
      const landedData = JSON.parse(landed!.data!);
      expect(landedData.entity_type).toBe("merge_group");
      expect(landedData.action).toBe("group.landed");
      expect(landedData.group_id).toBe(groupId);
    });

    it("streams merge.group.rejected tagged with group_id", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${project.id}`,
      );
      expect(res.status).toBe(200);

      let groupId = "";
      setTimeout(() => {
        const { group } = makeGroup(project, submitter);
        groupId = group.id;
        mergeGroupSvc.rejectGroup(
          group.id,
          { reason: "killed" },
          { id: submitter.id, role: "admin", type: "human" },
        );
      }, 50);

      // Phase 7.4: rejectGroup now also emits one audit.recorded per rejected
      // member (additive). Widen the capture window.
      const text = await readSSEStream(res, { maxEvents: 8, timeoutMs: 3000 });
      const events = parseSSEEvents(text);

      const rejected = events.find((e) => e.event === "merge.group.rejected");
      expect(rejected).toBeDefined();
      const data = JSON.parse(rejected!.data!);
      expect(data.entity_type).toBe("merge_group");
      expect(data.action).toBe("group.rejected");
      expect(data.group_id).toBe(groupId);
    });

    it("streams merge.incident.opened tagged with incident_id, orphaned_sha, group_id", async () => {
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

      let incidentId = "";
      let groupId = "";
      setTimeout(() => {
        const { group, m1 } = makeGroup(project, submitter);
        groupId = group.id;
        const inc = mergeIncidentSvc.openIncident(
          {
            projectId: project.id,
            groupId: group.id,
            type: "orphaned_inner",
            innerRepo: "core",
            orphanedSha: "Ri999",
            outerRepo: "shell",
            innerRequestId: m1.id,
          },
          actor,
        );
        incidentId = inc.id;
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 4, timeoutMs: 3000 });
      const events = parseSSEEvents(text);

      const opened = events.find((e) => e.event === "merge.incident.opened");
      expect(opened).toBeDefined();
      const data = JSON.parse(opened!.data!);
      expect(data.entity_type).toBe("merge_incident");
      expect(data.entity_id).toBe(incidentId);
      expect(data.action).toBe("incident.opened");
      expect(data.incident_id).toBe(incidentId);
      expect(data.orphaned_sha).toBe("Ri999");
      expect(data.group_id).toBe(groupId);
    });

    it("streams incident auto_resolved (ai) and human_resolved (admin) with incident_id/orphaned_sha/group_id", async () => {
      // ── auto_rollforward (integrator) ──
      const projectA = createTestProject(testApp.db);
      const submitterA = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db).user;
      const aiActor = { id: integrator.id, role: "member", type: "ai_agent" };

      const resA = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${projectA.id}`,
      );
      expect(resA.status).toBe(200);

      let incidentIdA = "";
      let groupIdA = "";
      setTimeout(() => {
        const { group, m1 } = makeGroup(projectA, submitterA);
        groupIdA = group.id;
        const inc = mergeIncidentSvc.openIncident(
          {
            projectId: projectA.id,
            groupId: group.id,
            type: "orphaned_inner",
            innerRepo: "core",
            orphanedSha: "RiAUTO",
            outerRepo: "shell",
            innerRequestId: m1.id,
          },
          aiActor,
        );
        incidentIdA = inc.id;
        mergeIncidentSvc.resolve(
          inc.id,
          {
            mode: "auto_rollforward",
            outerLandedSha: "OUTER_AUTO",
            resolvedByGroupId: group.id,
          },
          aiActor,
        );
      }, 50);

      const textA = await readSSEStream(resA, { maxEvents: 5, timeoutMs: 3000 });
      const eventsA = parseSSEEvents(textA);

      const autoResolved = eventsA.find(
        (e) => e.event === "merge.incident.auto_resolved",
      );
      expect(autoResolved).toBeDefined();
      const autoData = JSON.parse(autoResolved!.data!);
      expect(autoData.entity_type).toBe("merge_incident");
      expect(autoData.action).toBe("incident.auto_resolved");
      expect(autoData.incident_id).toBe(incidentIdA);
      expect(autoData.orphaned_sha).toBe("RiAUTO");
      expect(autoData.group_id).toBe(groupIdA);

      // ── human (admin) ──
      const projectB = createTestProject(testApp.db);
      const submitterB = createTestUser(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const adminActor = { id: admin.id, role: "admin", type: "human" };

      const resB = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${projectB.id}`,
      );
      expect(resB.status).toBe(200);

      let incidentIdB = "";
      let groupIdB = "";
      setTimeout(() => {
        const { group, m1 } = makeGroup(projectB, submitterB);
        groupIdB = group.id;
        const inc = mergeIncidentSvc.openIncident(
          {
            projectId: projectB.id,
            groupId: group.id,
            type: "orphaned_inner",
            innerRepo: "core",
            orphanedSha: "RiHUMAN",
            outerRepo: "shell",
            innerRequestId: m1.id,
          },
          aiActor,
        );
        incidentIdB = inc.id;
        mergeIncidentSvc.resolve(
          inc.id,
          { mode: "human", outerLandedSha: "OUTER_HUMAN", note: "fixed by hand" },
          adminActor,
        );
      }, 50);

      const textB = await readSSEStream(resB, { maxEvents: 5, timeoutMs: 3000 });
      const eventsB = parseSSEEvents(textB);

      const humanResolved = eventsB.find(
        (e) => e.event === "merge.incident.human_resolved",
      );
      expect(humanResolved).toBeDefined();
      const humanData = JSON.parse(humanResolved!.data!);
      expect(humanData.entity_type).toBe("merge_incident");
      expect(humanData.action).toBe("incident.human_resolved");
      expect(humanData.incident_id).toBe(incidentIdB);
      expect(humanData.orphaned_sha).toBe("RiHUMAN");
      expect(humanData.group_id).toBe(groupIdB);
    });

    it("backward-compat: a plain merge.request.queued frame carries no group_id/incident_id/orphaned_sha", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${project.id}`,
      );
      expect(res.status).toBe(200);

      setTimeout(() => {
        mergeRequestSvc.submit({
          projectId: project.id,
          submittedBy: submitter.id,
          branch: "feat/plain",
        });
      }, 50);

      const text = await readSSEStream(res, { maxEvents: 2, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      const queued = events.find((e) => e.event === "merge.request.queued");
      expect(queued).toBeDefined();
      const data = JSON.parse(queued!.data!);
      expect("group_id" in data).toBe(false);
      expect("incident_id" in data).toBe(false);
      expect("orphaned_sha" in data).toBe(false);
    });
  });
});
