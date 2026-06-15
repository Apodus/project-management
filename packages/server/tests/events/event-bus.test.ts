import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  TypedEventBus,
  getEventBus,
  resetEventBus,
  EVENT_NAMES,
  type EventPayload,
  type EventName,
} from "../../src/events/event-bus.js";
import { eq, and } from "drizzle-orm";
import { activityLog, auditLog, epics } from "../../src/db/index.js";
import * as claimLeaseSvc from "../../src/services/claim-lease.service.js";
import {
  createTestApp,
  createTestAiAgent,
  createTestEpic,
  createTestProject,
  createTestUser,
  authRequest,
  type TestApp,
} from "../utils.js";

// ─── Event bus unit tests ────────────────────────────────────────

describe("Event Bus", () => {
  beforeEach(() => {
    resetEventBus();
  });

  afterEach(() => {
    resetEventBus();
  });

  describe("TypedEventBus", () => {
    it("should emit and receive events", () => {
      const bus = new TypedEventBus();
      const received: EventPayload[] = [];

      bus.on(EVENT_NAMES.TASK_CREATED, (payload) => {
        received.push(payload);
      });

      const payload: EventPayload = {
        entity: { id: "task-1", title: "Test" },
        entityType: "task",
        entityId: "task-1",
        projectId: "proj-1",
        actorId: "user-1",
        timestamp: new Date().toISOString(),
      };

      bus.emit(EVENT_NAMES.TASK_CREATED, payload);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(payload);
    });

    it("should support multiple listeners on the same event", () => {
      const bus = new TypedEventBus();
      const received1: EventPayload[] = [];
      const received2: EventPayload[] = [];

      bus.on(EVENT_NAMES.PROJECT_CREATED, (payload) => {
        received1.push(payload);
      });

      bus.on(EVENT_NAMES.PROJECT_CREATED, (payload) => {
        received2.push(payload);
      });

      const payload: EventPayload = {
        entity: { id: "proj-1" },
        entityType: "project",
        entityId: "proj-1",
        projectId: "proj-1",
        actorId: "user-1",
        timestamp: new Date().toISOString(),
      };

      bus.emit(EVENT_NAMES.PROJECT_CREATED, payload);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received1[0]).toEqual(payload);
      expect(received2[0]).toEqual(payload);
    });

    it("should not call listeners for different events", () => {
      const bus = new TypedEventBus();
      const received: EventPayload[] = [];

      bus.on(EVENT_NAMES.TASK_CREATED, (payload) => {
        received.push(payload);
      });

      const payload: EventPayload = {
        entity: { id: "proj-1" },
        entityType: "project",
        entityId: "proj-1",
        projectId: "proj-1",
        actorId: "user-1",
        timestamp: new Date().toISOString(),
      };

      bus.emit(EVENT_NAMES.PROJECT_CREATED, payload);

      expect(received).toHaveLength(0);
    });

    it("should support onAll to listen to every event", () => {
      const bus = new TypedEventBus();
      const received: Array<{ event: EventName; payload: EventPayload }> = [];

      bus.onAll((event, payload) => {
        received.push({ event, payload });
      });

      const payload1: EventPayload = {
        entity: { id: "proj-1" },
        entityType: "project",
        entityId: "proj-1",
        projectId: "proj-1",
        actorId: "user-1",
        timestamp: new Date().toISOString(),
      };

      const payload2: EventPayload = {
        entity: { id: "task-1" },
        entityType: "task",
        entityId: "task-1",
        projectId: "proj-1",
        actorId: "user-1",
        timestamp: new Date().toISOString(),
      };

      bus.emit(EVENT_NAMES.PROJECT_CREATED, payload1);
      bus.emit(EVENT_NAMES.TASK_CREATED, payload2);

      expect(received).toHaveLength(2);
      expect(received[0].event).toBe(EVENT_NAMES.PROJECT_CREATED);
      expect(received[0].payload).toEqual(payload1);
      expect(received[1].event).toBe(EVENT_NAMES.TASK_CREATED);
      expect(received[1].payload).toEqual(payload2);
    });

    it("should carry changes in the payload", () => {
      const bus = new TypedEventBus();
      const received: EventPayload[] = [];

      bus.on(EVENT_NAMES.TASK_STATUS_CHANGED, (payload) => {
        received.push(payload);
      });

      const payload: EventPayload = {
        entity: { id: "task-1", status: "in_progress" },
        entityType: "task",
        entityId: "task-1",
        projectId: "proj-1",
        actorId: "user-1",
        timestamp: new Date().toISOString(),
        changes: { status: { from: "ready", to: "in_progress" } },
        previousStatus: "ready",
      };

      bus.emit(EVENT_NAMES.TASK_STATUS_CHANGED, payload);

      expect(received).toHaveLength(1);
      expect(received[0].changes).toEqual({
        status: { from: "ready", to: "in_progress" },
      });
      expect(received[0].previousStatus).toBe("ready");
    });

    it("should remove all listeners on removeAllListeners()", () => {
      const bus = new TypedEventBus();
      const received: EventPayload[] = [];

      bus.on(EVENT_NAMES.TASK_CREATED, (payload) => {
        received.push(payload);
      });

      bus.removeAllListeners();

      const payload: EventPayload = {
        entity: { id: "task-1" },
        entityType: "task",
        entityId: "task-1",
        projectId: "proj-1",
        actorId: "user-1",
        timestamp: new Date().toISOString(),
      };

      bus.emit(EVENT_NAMES.TASK_CREATED, payload);

      expect(received).toHaveLength(0);
    });

    it("should report listener count", () => {
      const bus = new TypedEventBus();

      expect(bus.listenerCount(EVENT_NAMES.TASK_CREATED)).toBe(0);

      bus.on(EVENT_NAMES.TASK_CREATED, () => {});
      expect(bus.listenerCount(EVENT_NAMES.TASK_CREATED)).toBe(1);

      bus.on(EVENT_NAMES.TASK_CREATED, () => {});
      expect(bus.listenerCount(EVENT_NAMES.TASK_CREATED)).toBe(2);
    });
  });

  describe("Singleton", () => {
    it("should return the same instance from getEventBus()", () => {
      const bus1 = getEventBus();
      const bus2 = getEventBus();
      expect(bus1).toBe(bus2);
    });

    it("should return a new instance after resetEventBus()", () => {
      const bus1 = getEventBus();
      resetEventBus();
      const bus2 = getEventBus();
      expect(bus1).not.toBe(bus2);
    });

    it("should clear all listeners on reset", () => {
      const bus = getEventBus();
      const received: EventPayload[] = [];

      bus.on(EVENT_NAMES.TASK_CREATED, (payload) => {
        received.push(payload);
      });

      resetEventBus();

      // Get a new bus - listener should not be registered
      const newBus = getEventBus();
      newBus.emit(EVENT_NAMES.TASK_CREATED, {
        entity: {},
        entityType: "task",
        entityId: "task-1",
        projectId: "proj-1",
        actorId: "user-1",
        timestamp: new Date().toISOString(),
      });

      expect(received).toHaveLength(0);
    });
  });

  // ─── Activity log listener integration test ───────────────────

  describe("Activity log listener", () => {
    let testApp: TestApp;

    beforeEach(() => {
      testApp = createTestApp();
    });

    afterEach(() => {
      testApp.cleanup();
    });

    it("should write activity log entry when event is emitted", async () => {
      // Create a project via the API (which emits project.created)
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Event Bus Test Project" },
      });
      expect(res.status).toBe(201);
      const project = (await res.json()).data;

      // Check activity was logged
      const activityRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/activity`,
      );
      expect(activityRes.status).toBe(200);
      const body = await activityRes.json();

      const createActivity = body.data.find(
        (a: any) => a.action === "created" && a.entityType === "project",
      );
      expect(createActivity).toBeDefined();
      expect(createActivity.entityId).toBe(project.id);
    });

    it("should write activity for task status change event", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create a task
      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "Event status task", reporterId: user.id, status: "ready" } },
      );
      const task = (await createRes.json()).data;

      // Transition status
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/transitions`, {
        body: { to_status: "in_progress" },
      });

      // Check activity
      const activityRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/tasks/${task.id}/activity`,
      );
      const body = await activityRes.json();

      const statusActivity = body.data.find((a: any) => a.action === "status_changed");
      expect(statusActivity).toBeDefined();

      const changes =
        typeof statusActivity.changes === "string"
          ? JSON.parse(statusActivity.changes)
          : statusActivity.changes;
      expect(changes.status.from).toBe("ready");
      expect(changes.status.to).toBe("in_progress");
    });

    it("should support multiple listeners on the event bus", async () => {
      const customReceived: EventPayload[] = [];

      // Add a second listener alongside the activity log listener
      const bus = getEventBus();
      bus.on(EVENT_NAMES.PROJECT_CREATED, (payload) => {
        customReceived.push(payload);
      });

      // Create a real project via the API to emit a real event
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Multi Listener Project" },
      });
      expect(res.status).toBe(201);
      const project = (await res.json()).data;

      // Both the activity log listener AND our custom listener should have received the event
      expect(customReceived).toHaveLength(1);
      expect(customReceived[0].entityId).toBe(project.id);

      // Verify activity was also logged by the other listener
      const activityRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/activity`,
      );
      const body = await activityRes.json();
      const createActivity = body.data.find(
        (a: any) => a.action === "created" && a.entityType === "project",
      );
      expect(createActivity).toBeDefined();
    });
  });

  // ─── Phase 7.1 EVENT_NAMES additions ──────────────────────────

  describe("Phase 7.1 EVENT_NAMES additions", () => {
    it("MERGE_REQUEST_QUEUED = 'merge.request.queued'", () => {
      expect(EVENT_NAMES.MERGE_REQUEST_QUEUED).toBe("merge.request.queued");
    });

    it("MERGE_REQUEST_INTEGRATING = 'merge.request.integrating'", () => {
      expect(EVENT_NAMES.MERGE_REQUEST_INTEGRATING).toBe("merge.request.integrating");
    });

    it("MERGE_REQUEST_REQUEUED = 'merge.request.requeued' (distinct from initial enqueue)", () => {
      expect(EVENT_NAMES.MERGE_REQUEST_REQUEUED).toBe("merge.request.requeued");
      expect(EVENT_NAMES.MERGE_REQUEST_REQUEUED).not.toBe(EVENT_NAMES.MERGE_REQUEST_QUEUED);
    });

    it("MERGE_REQUEST_LANDED = 'merge.request.landed'", () => {
      expect(EVENT_NAMES.MERGE_REQUEST_LANDED).toBe("merge.request.landed");
    });

    it("MERGE_REQUEST_REJECTED = 'merge.request.rejected'", () => {
      expect(EVENT_NAMES.MERGE_REQUEST_REJECTED).toBe("merge.request.rejected");
    });

    it("MERGE_REQUEST_ABANDONED = 'merge.request.abandoned'", () => {
      expect(EVENT_NAMES.MERGE_REQUEST_ABANDONED).toBe("merge.request.abandoned");
    });

    it("MERGE_ATTEMPT_STARTED = 'merge.attempt.started'", () => {
      expect(EVENT_NAMES.MERGE_ATTEMPT_STARTED).toBe("merge.attempt.started");
    });

    it("MERGE_ATTEMPT_COMPLETED = 'merge.attempt.completed'", () => {
      expect(EVENT_NAMES.MERGE_ATTEMPT_COMPLETED).toBe("merge.attempt.completed");
    });

    it("all 7 Phase 7.1 event names are present in EVENT_NAMES values", () => {
      const values = Object.values(EVENT_NAMES) as string[];
      const expected = [
        "merge.request.queued",
        "merge.request.integrating",
        "merge.request.landed",
        "merge.request.rejected",
        "merge.request.abandoned",
        "merge.attempt.started",
        "merge.attempt.completed",
      ];
      for (const name of expected) {
        expect(values).toContain(name);
      }
    });
  });

  // ─── Campaign C2: claim.lease.reclaimed registration + record model ───
  //
  // P4 registers the claim-lease reclaim event so onAll auto-forwards it to
  // the SSE stream and the activity_log listener maps it to "assigned". These
  // tests pin the name/value, prove the onAll forward end-to-end through the
  // real claim-lease.service emit site, and confirm the established two-table
  // record model (one activity_log "assigned" feed row + one audit_log
  // claim_reclaimed ledger row per reclaim).

  describe("Campaign C2 claim.lease.reclaimed registration", () => {
    it("CLAIM_LEASE_RECLAIMED = 'claim.lease.reclaimed'", () => {
      expect(EVENT_NAMES.CLAIM_LEASE_RECLAIMED).toBe("claim.lease.reclaimed");
    });

    it("'claim.lease.reclaimed' is present in EVENT_NAMES values", () => {
      const values = Object.values(EVENT_NAMES) as string[];
      expect(values).toContain("claim.lease.reclaimed");
    });
  });

  describe("Campaign C2 claim.lease.reclaimed onAll + record model", () => {
    let testApp: TestApp;

    beforeEach(() => {
      testApp = createTestApp();
    });

    afterEach(() => {
      testApp.cleanup();
    });

    it("onAll forwards a mode-on reclaim as one 'claim.lease.reclaimed' event with the expected payload", () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      testApp.db.update(epics).set({ assigneeId: a.user.id }).where(eq(epics.id, epic.id)).run();

      const t0 = new Date("2026-06-06T10:00:00.000Z");
      claimLeaseSvc.acquireLease(
        "epic",
        epic.id,
        { id: a.user.id },
        {
          now: t0,
          ttlMs: 1000,
        },
      );

      // Capture every event the onAll fan-out delivers.
      const captured: Array<{ event: EventName; payload: EventPayload }> = [];
      const unsubscribe = getEventBus().onAll((event, payload) => {
        captured.push({ event, payload });
      });

      claimLeaseSvc.sweepStaleClaims({
        entityType: "epic",
        entityId: epic.id,
        graceMs: 0,
        now: new Date(t0.getTime() + 1_000_000),
      });
      unsubscribe();

      const reclaimEvents = captured.filter((c) => c.event === EVENT_NAMES.CLAIM_LEASE_RECLAIMED);
      expect(reclaimEvents).toHaveLength(1);
      const { payload } = reclaimEvents[0];
      expect(payload.entityType).toBe("epic");
      expect(payload.entityId).toBe(epic.id);
      expect(payload.projectId).toBe(project.id);
      expect(payload.changes).toEqual({
        assignee_id: { from: a.user.id, to: null },
      });
    });

    it("a mode-on reclaim writes one activity_log 'assigned' row AND one audit_log claim_reclaimed row for the same target", () => {
      // createTestApp() → createApp() already wires the activity_log listener
      // via initializeEventListeners(), so onAll fan-out reaches it (calling
      // registerActivityLogListener() again here would double-register → 2 rows).

      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      testApp.db.update(epics).set({ assigneeId: a.user.id }).where(eq(epics.id, epic.id)).run();

      const t0 = new Date("2026-06-06T10:00:00.000Z");
      claimLeaseSvc.acquireLease(
        "epic",
        epic.id,
        { id: a.user.id },
        {
          now: t0,
          ttlMs: 1000,
        },
      );

      const result = claimLeaseSvc.sweepStaleClaims({
        entityType: "epic",
        entityId: epic.id,
        graceMs: 0,
        now: new Date(t0.getTime() + 1_000_000),
      });
      expect(result.reclaimed).toHaveLength(1);

      // Feed row: exactly one activity_log "assigned" entry for the epic.
      const activityRows = testApp.db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityType, "epic"), eq(activityLog.entityId, epic.id)))
        .all();
      expect(activityRows).toHaveLength(1);
      expect(activityRows[0].action).toBe("assigned");

      // Ledger row: exactly one audit_log claim_reclaimed entry for the epic.
      const auditRows = testApp.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, epic.id))
        .all();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].action).toBe("claim_reclaimed");
      expect(auditRows[0].targetType).toBe("epic");
    });
  });
});
