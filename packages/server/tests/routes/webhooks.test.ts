import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, createTestProject, createTestTask, type TestApp } from "../utils.js";
import { createId } from "@pm/shared";

describe("Webhook API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── POST /api/v1/webhooks/git ────────────────────────────────

  describe("POST /api/v1/webhooks/git", () => {
    it("should be publicly accessible (no auth required)", async () => {
      const project = createTestProject(testApp.db);

      // No Authorization header
      const res = await testApp.app.request("/api/v1/webhooks/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "branch_created",
          ref: "feat/some-random-branch",
          project_id: project.id,
        }),
      });

      // Should not get 401
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(200);
    });

    // ── branch_created events ──────────────────────────────────

    describe("branch_created", () => {
      it("should auto-link a branch matching the naming convention", async () => {
        const project = createTestProject(testApp.db);
        const task = createTestTask(testApp.db, { projectId: project.id });
        const branchName = `feat/${task.id}-add-auth`;

        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "branch_created",
            ref: branchName,
            project_id: project.id,
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.linked).toBe(true);
        expect(body.data.refs).toHaveLength(1);
        expect(body.data.refs[0].taskId).toBe(task.id);
        expect(body.data.refs[0].refType).toBe("branch");
        expect(body.data.refs[0].refValue).toBe(branchName);
      });

      it("should return linked: false for a branch that doesn't match", async () => {
        const project = createTestProject(testApp.db);

        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "branch_created",
            ref: "main",
            project_id: project.id,
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.linked).toBe(false);
        expect(body.data.refs).toEqual([]);
      });

      it("should return linked: false when task doesn't exist", async () => {
        const project = createTestProject(testApp.db);
        const fakeId = createId();

        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "branch_created",
            ref: `feat/${fakeId}-something`,
            project_id: project.id,
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.linked).toBe(false);
      });
    });

    // ── commit_pushed events ───────────────────────────────────

    describe("commit_pushed", () => {
      it("should link a commit to tasks referenced in the message", async () => {
        const project = createTestProject(testApp.db);
        const task = createTestTask(testApp.db, { projectId: project.id });

        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "commit_pushed",
            ref: "abc123def456",
            project_id: project.id,
            title: `feat: add auth [PM-${task.id}]`,
            url: "https://github.com/org/repo/commit/abc123def456",
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.linked).toBe(true);
        expect(body.data.refs).toHaveLength(1);
        expect(body.data.refs[0].taskId).toBe(task.id);
        expect(body.data.refs[0].refType).toBe("commit");
      });

      it("should return linked: false when commit message has no task refs", async () => {
        const project = createTestProject(testApp.db);

        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "commit_pushed",
            ref: "abc123def456",
            project_id: project.id,
            title: "chore: clean up code",
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.linked).toBe(false);
        expect(body.data.refs).toEqual([]);
      });

      it("should link to multiple tasks from a single commit", async () => {
        const project = createTestProject(testApp.db);
        const task1 = createTestTask(testApp.db, { projectId: project.id });
        const task2 = createTestTask(testApp.db, { projectId: project.id });

        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "commit_pushed",
            ref: "def456abc789",
            project_id: project.id,
            title: `feat: updates [PM-${task1.id}] [PM-${task2.id}]`,
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.linked).toBe(true);
        expect(body.data.refs).toHaveLength(2);
      });

      it("should handle refs: pattern in commit message", async () => {
        const project = createTestProject(testApp.db);
        const task = createTestTask(testApp.db, { projectId: project.id });

        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "commit_pushed",
            ref: "sha-789",
            project_id: project.id,
            title: `feat: thing\nrefs: ${task.id}`,
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.linked).toBe(true);
        expect(body.data.refs).toHaveLength(1);
      });
    });

    // ── Validation ─────────────────────────────────────────────

    describe("validation", () => {
      it("should return 400 for missing event field", async () => {
        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ref: "main",
            project_id: "some-id",
          }),
        });

        expect(res.status).toBe(400);
      });

      it("should return 400 for invalid event type", async () => {
        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "invalid_event",
            ref: "main",
            project_id: "some-id",
          }),
        });

        expect(res.status).toBe(400);
      });

      it("should return 400 for missing ref field", async () => {
        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "branch_created",
            project_id: "some-id",
          }),
        });

        expect(res.status).toBe(400);
      });

      it("should return 400 for missing project_id", async () => {
        const res = await testApp.app.request("/api/v1/webhooks/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "branch_created",
            ref: "main",
          }),
        });

        expect(res.status).toBe(400);
      });
    });
  });
});
