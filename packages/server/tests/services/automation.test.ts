import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTestApp,
  createTestProject,
  createTestUser,
  createTestTask,
  createTestEpic,
  createTestProposal,
  authRequest,
  type TestApp,
} from "../utils.js";
import * as automationService from "../../src/services/automation.service.js";
import { getEventBus, EVENT_NAMES, resetEventBus } from "../../src/events/event-bus.js";
import { registerProposalAutoTransitionListener } from "../../src/events/automation-listener.js";
import { getDb, tasks, epics, proposals, automationRules } from "../../src/db/index.js";
import { eq } from "drizzle-orm";

// ─── Automation service unit tests ──────────────────────────────

describe("Automation Service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── CRUD ────────────────────────────────────────────────────────

  describe("CRUD", () => {
    it("should create an automation rule", () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const rule = automationService.create({
        projectId: project.id,
        name: "Test Rule",
        description: "A test automation rule",
        triggerEvent: "task.status_changed",
        conditions: [{ field: "changes.status.to", operator: "eq", value: "done" }],
        actionType: "transition_task",
        actionConfig: { to_status: "in_review" },
        createdBy: user.id,
      });

      expect(rule.id).toBeDefined();
      expect(rule.name).toBe("Test Rule");
      expect(rule.triggerEvent).toBe("task.status_changed");
      expect(rule.actionType).toBe("transition_task");
      expect(rule.isActive).toBe(true);
    });

    it("should list rules for a project", () => {
      const project = createTestProject(testApp.db);

      automationService.create({
        projectId: project.id,
        name: "Rule 1",
        triggerEvent: "task.created",
        actionType: "notify",
      });
      automationService.create({
        projectId: project.id,
        name: "Rule 2",
        triggerEvent: "task.status_changed",
        actionType: "notify",
      });

      const rules = automationService.list(project.id);
      expect(rules).toHaveLength(2);
    });

    it("should get a rule by ID", () => {
      const project = createTestProject(testApp.db);
      const created = automationService.create({
        projectId: project.id,
        name: "Get Test",
        triggerEvent: "task.created",
        actionType: "notify",
      });

      const fetched = automationService.getById(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.name).toBe("Get Test");
    });

    it("should throw 404 for non-existent rule", () => {
      expect(() => automationService.getById("nonexistent")).toThrow();
    });

    it("should update a rule", () => {
      const project = createTestProject(testApp.db);
      const created = automationService.create({
        projectId: project.id,
        name: "Before Update",
        triggerEvent: "task.created",
        actionType: "notify",
      });

      const updated = automationService.update(created.id, {
        name: "After Update",
        triggerEvent: "task.status_changed",
      });

      expect(updated.name).toBe("After Update");
      expect(updated.triggerEvent).toBe("task.status_changed");
    });

    it("should delete a rule", () => {
      const project = createTestProject(testApp.db);
      const created = automationService.create({
        projectId: project.id,
        name: "To Delete",
        triggerEvent: "task.created",
        actionType: "notify",
      });

      automationService.deleteRule(created.id);
      expect(() => automationService.getById(created.id)).toThrow();
    });

    it("should toggle a rule active/inactive", () => {
      const project = createTestProject(testApp.db);
      const created = automationService.create({
        projectId: project.id,
        name: "Toggle Test",
        triggerEvent: "task.created",
        actionType: "notify",
      });

      expect(created.isActive).toBe(true);

      const disabled = automationService.toggle(created.id, false);
      expect(disabled.isActive).toBe(false);

      const enabled = automationService.toggle(created.id, true);
      expect(enabled.isActive).toBe(true);
    });

    it("should reject invalid action types", () => {
      const project = createTestProject(testApp.db);
      expect(() =>
        automationService.create({
          projectId: project.id,
          name: "Invalid",
          triggerEvent: "task.created",
          actionType: "invalid_action",
        }),
      ).toThrow("Invalid action_type");
    });
  });

  // ── Condition evaluation ─────────────────────────────────────────

  describe("evaluateConditions", () => {
    it("should return true for null/empty conditions", () => {
      expect(automationService.evaluateConditions(null, {})).toBe(true);
      expect(automationService.evaluateConditions([], {})).toBe(true);
      expect(automationService.evaluateConditions(undefined, {})).toBe(true);
    });

    it("should evaluate 'eq' operator", () => {
      const conditions = [{ field: "status", operator: "eq" as const, value: "done" }];
      expect(automationService.evaluateConditions(conditions, { status: "done" })).toBe(true);
      expect(automationService.evaluateConditions(conditions, { status: "open" })).toBe(false);
    });

    it("should evaluate 'neq' operator", () => {
      const conditions = [{ field: "status", operator: "neq" as const, value: "done" }];
      expect(automationService.evaluateConditions(conditions, { status: "open" })).toBe(true);
      expect(automationService.evaluateConditions(conditions, { status: "done" })).toBe(false);
    });

    it("should evaluate 'in' operator", () => {
      const conditions = [
        { field: "status", operator: "in" as const, value: ["done", "cancelled"] },
      ];
      expect(automationService.evaluateConditions(conditions, { status: "done" })).toBe(true);
      expect(automationService.evaluateConditions(conditions, { status: "cancelled" })).toBe(true);
      expect(automationService.evaluateConditions(conditions, { status: "open" })).toBe(false);
    });

    it("should evaluate 'not_in' operator", () => {
      const conditions = [
        { field: "status", operator: "not_in" as const, value: ["done", "cancelled"] },
      ];
      expect(automationService.evaluateConditions(conditions, { status: "open" })).toBe(true);
      expect(automationService.evaluateConditions(conditions, { status: "done" })).toBe(false);
    });

    it("should evaluate 'contains' operator on strings", () => {
      const conditions = [
        { field: "title", operator: "contains" as const, value: "bug" },
      ];
      expect(automationService.evaluateConditions(conditions, { title: "Fix bug #123" })).toBe(true);
      expect(automationService.evaluateConditions(conditions, { title: "Add feature" })).toBe(false);
    });

    it("should evaluate 'contains' operator on arrays", () => {
      const conditions = [
        { field: "tags", operator: "contains" as const, value: "urgent" },
      ];
      expect(
        automationService.evaluateConditions(conditions, { tags: ["urgent", "bug"] }),
      ).toBe(true);
      expect(
        automationService.evaluateConditions(conditions, { tags: ["feature"] }),
      ).toBe(false);
    });

    it("should support nested field access via dot notation", () => {
      const conditions = [
        { field: "changes.status.to", operator: "eq" as const, value: "done" },
      ];
      const payload = {
        changes: { status: { from: "in_progress", to: "done" } },
      };
      expect(automationService.evaluateConditions(conditions, payload)).toBe(true);
    });

    it("should handle deep nested field access", () => {
      const conditions = [
        { field: "a.b.c.d", operator: "eq" as const, value: 42 },
      ];
      expect(
        automationService.evaluateConditions(conditions, { a: { b: { c: { d: 42 } } } }),
      ).toBe(true);
      expect(
        automationService.evaluateConditions(conditions, { a: { b: { c: { d: 99 } } } }),
      ).toBe(false);
    });

    it("should handle missing nested fields gracefully", () => {
      const conditions = [
        { field: "changes.status.to", operator: "eq" as const, value: "done" },
      ];
      expect(automationService.evaluateConditions(conditions, {})).toBe(false);
      expect(automationService.evaluateConditions(conditions, { changes: null })).toBe(false);
      expect(
        automationService.evaluateConditions(conditions, { changes: { priority: {} } }),
      ).toBe(false);
    });

    it("should AND multiple conditions", () => {
      const conditions = [
        { field: "changes.status.to", operator: "eq" as const, value: "done" },
        { field: "priority", operator: "eq" as const, value: "high" },
      ];
      expect(
        automationService.evaluateConditions(conditions, {
          changes: { status: { from: "open", to: "done" } },
          priority: "high",
        }),
      ).toBe(true);
      expect(
        automationService.evaluateConditions(conditions, {
          changes: { status: { from: "open", to: "done" } },
          priority: "low",
        }),
      ).toBe(false);
    });

    it("should handle 'in' with non-array value gracefully", () => {
      const conditions = [
        { field: "status", operator: "in" as const, value: "not-an-array" },
      ];
      expect(automationService.evaluateConditions(conditions, { status: "done" })).toBe(false);
    });

    it("should handle 'contains' on non-string/non-array gracefully", () => {
      const conditions = [
        { field: "count", operator: "contains" as const, value: "5" },
      ];
      expect(automationService.evaluateConditions(conditions, { count: 5 })).toBe(false);
    });
  });

  // ── Action execution ─────────────────────────────────────────────

  describe("executeAction", () => {
    it("should execute transition_task action", () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "in_progress",
      });

      automationService.executeAction(
        "transition_task",
        { to_status: "done", task_id: task.id },
        {
          entity: task,
          entityType: "task",
          entityId: task.id,
          projectId: project.id,
          actorId: user.id,
          timestamp: new Date().toISOString(),
        },
      );

      const db = getDb();
      const updated = db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      expect(updated!.status).toBe("done");
      expect(updated!.completedAt).toBeDefined();
    });

    it("should execute transition_epic action", () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "active",
      });

      automationService.executeAction(
        "transition_epic",
        { to_status: "completed", epic_id: epic.id },
        {
          entity: epic,
          entityType: "epic",
          entityId: epic.id,
          projectId: project.id,
          actorId: user.id,
          timestamp: new Date().toISOString(),
        },
      );

      const db = getDb();
      const updated = db.select().from(epics).where(eq(epics.id, epic.id)).get();
      expect(updated!.status).toBe("completed");
    });

    it("should execute notify action (creates activity log entry)", () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      // Should not throw
      automationService.executeAction(
        "notify",
        { message: "Test notification" },
        {
          entity: task,
          entityType: "task",
          entityId: task.id,
          projectId: project.id,
          actorId: user.id,
          timestamp: new Date().toISOString(),
        },
      );
    });

    it("should not transition a task already in target status", () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "done",
      });

      // Should be a no-op
      automationService.executeAction(
        "transition_task",
        { to_status: "done", task_id: task.id },
        {
          entity: task,
          entityType: "task",
          entityId: task.id,
          projectId: project.id,
          actorId: user.id,
          timestamp: new Date().toISOString(),
        },
      );

      const db = getDb();
      const updated = db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      expect(updated!.status).toBe("done");
    });
  });

  // ── Built-in rules ──────────────────────────────────────────────

  describe("Built-in rules", () => {
    it("should create built-in rules for a new project", () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Initially clean (createTestProject uses raw insert, not the service)
      const db = getDb();
      db.delete(automationRules).where(eq(automationRules.projectId, project.id)).run();

      automationService.createBuiltInRules(project.id, user.id);

      const rules = automationService.list(project.id);
      expect(rules).toHaveLength(2);

      const names = rules.map((r) => r.name);
      expect(names).toContain("Auto-complete epic");
      expect(names).toContain("Auto-advance parent");
    });

    it("should not create built-in rules if rules already exist", () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      automationService.create({
        projectId: project.id,
        name: "Existing Rule",
        triggerEvent: "task.created",
        actionType: "notify",
        createdBy: user.id,
      });

      automationService.createBuiltInRules(project.id, user.id);

      const rules = automationService.list(project.id);
      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe("Existing Rule");
    });
  });

  // ── Loop prevention ───────────────────────────────────────────────

  describe("Loop prevention", () => {
    it("should report depth exceeded at max depth", () => {
      expect(automationService.isDepthExceeded(3)).toBe(true);
      expect(automationService.isDepthExceeded(2)).toBe(false);
      expect(automationService.isDepthExceeded(0)).toBe(false);
    });

    it("should have max depth of 3", () => {
      expect(automationService.getMaxDepth()).toBe(3);
    });
  });

  // ── Rule matching ──────────────────────────────────────────────────

  describe("findMatchingRules", () => {
    it("should find active rules matching event and project", () => {
      const project = createTestProject(testApp.db);
      automationService.create({
        projectId: project.id,
        name: "Matching Rule",
        triggerEvent: "task.status_changed",
        actionType: "notify",
        isActive: true,
      });
      automationService.create({
        projectId: project.id,
        name: "Different Event",
        triggerEvent: "task.created",
        actionType: "notify",
        isActive: true,
      });
      automationService.create({
        projectId: project.id,
        name: "Inactive Rule",
        triggerEvent: "task.status_changed",
        actionType: "notify",
        isActive: false,
      });

      const matches = automationService.findMatchingRules("task.status_changed", project.id);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe("Matching Rule");
    });

    it("should return empty for null projectId", () => {
      const matches = automationService.findMatchingRules("task.status_changed", null);
      expect(matches).toHaveLength(0);
    });
  });
});

// ─── Route tests ────────────────────────────────────────────────

describe("Automation API Routes", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  describe("GET /api/v1/projects/:projectId/automation-rules", () => {
    it("should list automation rules for a project", async () => {
      const project = createTestProject(testApp.db);

      // Create a rule directly
      automationService.create({
        projectId: project.id,
        name: "Test Rule",
        triggerEvent: "task.created",
        actionType: "notify",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/automation-rules`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe("Test Rule");
    });
  });

  describe("POST /api/v1/projects/:projectId/automation-rules", () => {
    it("should create an automation rule", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/automation-rules`,
        {
          body: {
            name: "New Rule",
            triggerEvent: "task.status_changed",
            conditions: [{ field: "changes.status.to", operator: "eq", value: "done" }],
            actionType: "transition_task",
            actionConfig: { to_status: "in_review" },
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("New Rule");
      expect(body.data.triggerEvent).toBe("task.status_changed");
      expect(body.data.actionType).toBe("transition_task");
      expect(body.data.isActive).toBe(true);
    });

    it("should reject invalid action types", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/automation-rules`,
        {
          body: {
            name: "Bad Rule",
            triggerEvent: "task.created",
            actionType: "invalid_action",
          },
        },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/v1/automation-rules/:id", () => {
    it("should update an automation rule", async () => {
      const project = createTestProject(testApp.db);
      const rule = automationService.create({
        projectId: project.id,
        name: "Before",
        triggerEvent: "task.created",
        actionType: "notify",
      });

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/automation-rules/${rule.id}`,
        {
          body: { name: "After" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.name).toBe("After");
    });

    it("should return 404 for non-existent rule", async () => {
      const res = await authRequest(
        testApp.app,
        "PATCH",
        "/api/v1/automation-rules/nonexistent",
        {
          body: { name: "Test" },
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/automation-rules/:id", () => {
    it("should delete an automation rule", async () => {
      const project = createTestProject(testApp.db);
      const rule = automationService.create({
        projectId: project.id,
        name: "To Delete",
        triggerEvent: "task.created",
        actionType: "notify",
      });

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/automation-rules/${rule.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.deleted).toBe(true);
    });
  });

  describe("POST /api/v1/automation-rules/:id/toggle", () => {
    it("should toggle a rule's active state", async () => {
      const project = createTestProject(testApp.db);
      const rule = automationService.create({
        projectId: project.id,
        name: "Toggle",
        triggerEvent: "task.created",
        actionType: "notify",
        isActive: true,
      });

      // Disable
      const res1 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/automation-rules/${rule.id}/toggle`,
        { body: { active: false } },
      );
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.data.isActive).toBe(false);

      // Enable
      const res2 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/automation-rules/${rule.id}/toggle`,
        { body: { active: true } },
      );
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.data.isActive).toBe(true);
    });
  });
});

// ─── End-to-end automation triggering tests ─────────────────────

describe("Automation Event Triggering", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("should trigger automation rule when matching event fires", async () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const epic = createTestEpic(testApp.db, {
      projectId: project.id,
      createdBy: user.id,
      status: "active",
    });

    // Create tasks in the epic
    const task1 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      epicId: epic.id,
      status: "done",
    });
    const task2 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      epicId: epic.id,
      status: "in_progress",
    });

    // Create the auto-complete epic rule
    automationService.create({
      projectId: project.id,
      name: "Auto-complete epic",
      triggerEvent: "task.status_changed",
      conditions: [
        { field: "changes.status.to", operator: "eq", value: "done" },
      ],
      actionType: "transition_epic",
      actionConfig: { to_status: "completed" },
    });

    // Now transition task2 to done via the event bus
    const db = getDb();
    db.update(tasks)
      .set({ status: "done", updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, task2.id))
      .run();

    // Emit the event (simulating what task.transition() does)
    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: { ...task2, status: "done", epicId: epic.id },
      entityType: "task",
      entityId: task2.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "in_progress", to: "done" } },
      previousStatus: "in_progress",
    });

    // Check that the epic was transitioned
    const updatedEpic = db.select().from(epics).where(eq(epics.id, epic.id)).get();
    expect(updatedEpic!.status).toBe("completed");
  });

  it("should trigger auto-advance parent when all subtasks are done", async () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    // Create parent task
    const parent = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      status: "in_progress",
    });

    // Create subtasks
    const sub1 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      parentTaskId: parent.id,
      status: "done",
    });
    const sub2 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      parentTaskId: parent.id,
      status: "in_progress",
    });

    // Create auto-advance parent rule
    automationService.create({
      projectId: project.id,
      name: "Auto-advance parent",
      triggerEvent: "task.status_changed",
      conditions: [
        { field: "changes.status.to", operator: "eq", value: "done" },
      ],
      actionType: "transition_task",
      actionConfig: { to_status: "in_review" },
    });

    // Transition sub2 to done
    const db = getDb();
    db.update(tasks)
      .set({ status: "done", updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, sub2.id))
      .run();

    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: { ...sub2, status: "done", parentTaskId: parent.id },
      entityType: "task",
      entityId: sub2.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "in_progress", to: "done" } },
      previousStatus: "in_progress",
    });

    // Check that parent was advanced to in_review
    const updatedParent = db.select().from(tasks).where(eq(tasks.id, parent.id)).get();
    expect(updatedParent!.status).toBe("in_review");
  });

  it("should not trigger when conditions do not match", async () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const epic = createTestEpic(testApp.db, {
      projectId: project.id,
      createdBy: user.id,
      status: "active",
    });
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      epicId: epic.id,
      status: "in_progress",
    });

    automationService.create({
      projectId: project.id,
      name: "Only on done",
      triggerEvent: "task.status_changed",
      conditions: [
        { field: "changes.status.to", operator: "eq", value: "done" },
      ],
      actionType: "transition_epic",
      actionConfig: { to_status: "completed" },
    });

    // Emit event with status change to in_review (not done)
    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: { ...task, status: "in_review", epicId: epic.id },
      entityType: "task",
      entityId: task.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "in_progress", to: "in_review" } },
      previousStatus: "in_progress",
    });

    // Epic should NOT have been changed
    const db = getDb();
    const unchangedEpic = db.select().from(epics).where(eq(epics.id, epic.id)).get();
    expect(unchangedEpic!.status).toBe("active");
  });

  it("should prevent loops at depth 3", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      status: "ready",
    });

    // Create a rule that would create an infinite loop:
    // on task.status_changed -> transition_task (same task to different status)
    automationService.create({
      projectId: project.id,
      name: "Loop Rule",
      triggerEvent: "task.status_changed",
      conditions: [],
      actionType: "notify",
      actionConfig: { message: "triggered" },
    });

    // Emit at depth 3 - should NOT trigger the rule
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: task,
      entityType: "task",
      entityId: task.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "ready", to: "in_progress" } },
      previousStatus: "ready",
      _automationDepth: 3,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Loop prevention"),
    );
    warnSpy.mockRestore();
  });

  it("should not trigger inactive rules", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const epic = createTestEpic(testApp.db, {
      projectId: project.id,
      createdBy: user.id,
      status: "active",
    });
    const task1 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      epicId: epic.id,
      status: "done",
    });

    // Create an inactive auto-complete rule
    automationService.create({
      projectId: project.id,
      name: "Auto-complete epic",
      triggerEvent: "task.status_changed",
      conditions: [
        { field: "changes.status.to", operator: "eq", value: "done" },
      ],
      actionType: "transition_epic",
      actionConfig: { to_status: "completed" },
      isActive: false,
    });

    // Emit the event - should not trigger since rule is inactive
    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: { ...task1, status: "done", epicId: epic.id },
      entityType: "task",
      entityId: task1.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "in_progress", to: "done" } },
      previousStatus: "in_progress",
    });

    const db = getDb();
    const unchangedEpic = db.select().from(epics).where(eq(epics.id, epic.id)).get();
    expect(unchangedEpic!.status).toBe("active");
  });
});

// ─── Proposal auto-transition tests ───────────────────────────────

describe("Proposal Auto-Transition", () => {
  let testApp: TestApp;
  let cleanupListener: () => void;

  beforeEach(() => {
    testApp = createTestApp();
    cleanupListener = registerProposalAutoTransitionListener();
  });

  afterEach(() => {
    cleanupListener();
    testApp.cleanup();
  });

  it("should transition proposal from in_progress to completed when all tasks are done", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const proposal = createTestProposal(testApp.db, {
      projectId: project.id,
      createdBy: user.id,
      status: "in_progress",
    });
    const task1 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      proposalId: proposal.id,
      status: "done",
    });
    const task2 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      proposalId: proposal.id,
      status: "in_progress",
    });

    // Transition task2 to done
    const db = getDb();
    db.update(tasks)
      .set({ status: "done", updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, task2.id))
      .run();

    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: { ...task2, status: "done", proposalId: proposal.id },
      entityType: "task",
      entityId: task2.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "in_progress", to: "done" } },
      previousStatus: "in_progress",
    });

    // Proposal should now be completed
    const updatedProposal = db.select().from(proposals).where(eq(proposals.id, proposal.id)).get();
    expect(updatedProposal!.status).toBe("completed");
  });

  it("should NOT auto-complete proposal when there are non-done tasks remaining", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const proposal = createTestProposal(testApp.db, {
      projectId: project.id,
      createdBy: user.id,
      status: "in_progress",
    });
    createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      proposalId: proposal.id,
      status: "ready",
    });
    const task2 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      proposalId: proposal.id,
      status: "in_progress",
    });

    // Transition task2 to done
    const db = getDb();
    db.update(tasks)
      .set({ status: "done", updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, task2.id))
      .run();

    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: { ...task2, status: "done", proposalId: proposal.id },
      entityType: "task",
      entityId: task2.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "in_progress", to: "done" } },
      previousStatus: "in_progress",
    });

    // Proposal should still be in_progress (task1 is still "ready")
    const updatedProposal = db.select().from(proposals).where(eq(proposals.id, proposal.id)).get();
    expect(updatedProposal!.status).toBe("in_progress");
  });

  it("should auto-complete when cancelled tasks exist but all non-cancelled are done", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const proposal = createTestProposal(testApp.db, {
      projectId: project.id,
      createdBy: user.id,
      status: "in_progress",
    });
    createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      proposalId: proposal.id,
      status: "done",
    });
    createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      proposalId: proposal.id,
      status: "cancelled",
    });
    const task3 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      proposalId: proposal.id,
      status: "in_progress",
    });

    // Transition task3 to done
    const db = getDb();
    db.update(tasks)
      .set({ status: "done", updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, task3.id))
      .run();

    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: { ...task3, status: "done", proposalId: proposal.id },
      entityType: "task",
      entityId: task3.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "in_progress", to: "done" } },
      previousStatus: "in_progress",
    });

    // Proposal should be completed (only cancelled + done tasks)
    const updatedProposal = db.select().from(proposals).where(eq(proposals.id, proposal.id)).get();
    expect(updatedProposal!.status).toBe("completed");
  });

  it("should NOT auto-complete when only cancelled tasks exist", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const proposal = createTestProposal(testApp.db, {
      projectId: project.id,
      createdBy: user.id,
      status: "in_progress",
    });
    const task1 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      proposalId: proposal.id,
      status: "in_progress",
    });

    // Cancel the task (simulating that all tasks become cancelled)
    const db = getDb();
    db.update(tasks)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, task1.id))
      .run();

    // Emit status_changed but the change is to "cancelled" not "done"
    // so the auto-complete check won't trigger (it only triggers on "done")
    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: { ...task1, status: "cancelled", proposalId: proposal.id },
      entityType: "task",
      entityId: task1.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "in_progress", to: "cancelled" } },
      previousStatus: "in_progress",
    });

    // Proposal should still be in_progress
    const updatedProposal = db.select().from(proposals).where(eq(proposals.id, proposal.id)).get();
    expect(updatedProposal!.status).toBe("in_progress");
  });

  it("should NOT transition proposal if it is not in planned status when task starts", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const proposal = createTestProposal(testApp.db, {
      projectId: project.id,
      createdBy: user.id,
      status: "open",
    });
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: user.id,
      proposalId: proposal.id,
      status: "ready",
    });

    const db = getDb();
    db.update(tasks)
      .set({ status: "in_progress", updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, task.id))
      .run();

    getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
      entity: { ...task, status: "in_progress", proposalId: proposal.id },
      entityType: "task",
      entityId: task.id,
      projectId: project.id,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      changes: { status: { from: "ready", to: "in_progress" } },
      previousStatus: "ready",
    });

    // Proposal should stay "open"
    const updatedProposal = db.select().from(proposals).where(eq(proposals.id, proposal.id)).get();
    expect(updatedProposal!.status).toBe("open");
  });
});

// ─── Built-in rules on project creation (via project service) ───

describe("Built-in rules on project creation", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("should create built-in rules when a project is created via API", async () => {
    const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
      body: { name: "Automation Test Project" },
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    const projectId = body.data.id;

    // Check that built-in rules were created
    const rules = automationService.list(projectId);
    expect(rules).toHaveLength(2);

    const names = rules.map((r) => r.name).sort();
    expect(names).toEqual(["Auto-advance parent", "Auto-complete epic"]);
  });
});
