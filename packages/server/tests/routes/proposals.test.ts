import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  createTestProposal,
  createTestAiAgent,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";
import { getEventBus, type EventName, type EventPayload } from "../../src/events/event-bus.js";

describe("Proposals API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── GET /api/v1/projects/:projectId/proposals ────────────────────
  describe("GET /api/v1/projects/:projectId/proposals", () => {
    it("should return empty list when no proposals exist", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/proposals`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({ total: 0 });
    });

    it("should return all proposals for a project", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });
      createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/proposals`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });

    it("should filter by status", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "open",
      });
      createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "discussing",
      });
      createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "open",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/proposals?status=open`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data.every((p: any) => p.status === "open")).toBe(true);
    });

    it("should not return proposals from other projects", async () => {
      const project1 = createTestProject(testApp.db);
      const project2 = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      createTestProposal(testApp.db, {
        projectId: project1.id,
        createdBy: user.id,
      });
      createTestProposal(testApp.db, {
        projectId: project2.id,
        createdBy: user.id,
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project1.id}/proposals`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

  // ── POST /api/v1/projects/:projectId/proposals ───────────────────
  describe("POST /api/v1/projects/:projectId/proposals", () => {
    it("should create a proposal with valid data", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/proposals`,
        {
          body: {
            title: "Add user authentication",
            description: "We need login/logout functionality",
            createdBy: user.id,
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.title).toBe("Add user authentication");
      expect(body.data.description).toBe("We need login/logout functionality");
      expect(body.data.status).toBe("open");
      expect(body.data.projectId).toBe(project.id);
      expect(body.data.createdBy).toBe(user.id);
      expect(body.data.id).toBeDefined();
      expect(body.data.createdAt).toBeDefined();
      expect(body.data.updatedAt).toBeDefined();
    });

    it("should create a proposal with minimal fields", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/proposals`,
        {
          body: {
            title: "Quick idea",
            createdBy: user.id,
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.title).toBe("Quick idea");
      expect(body.data.description).toBeNull();
    });

    it("should reject missing title", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/proposals`,
        {
          body: { createdBy: user.id },
        },
      );
      expect(res.status).toBe(400);
    });

    it("should reject empty title", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/proposals`,
        {
          body: { title: "", createdBy: user.id },
        },
      );
      expect(res.status).toBe(400);
    });

    it("should return 404 for non-existent project", async () => {
      const user = createTestUser(testApp.db);
      const fakeId = createId();

      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${fakeId}/proposals`, {
        body: { title: "Test", createdBy: user.id },
      });
      expect(res.status).toBe(404);
    });

    it("should derive createdBy from the authenticated caller when omitted", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/proposals`,
        { body: { title: "Auth-derived" } },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.createdBy).toBe(testApp.testUser.id);
    });

    it("should force createdBy to the AI agent's own ID (ignores body value)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const project = createTestProject(testApp.db);
      const otherUser = createTestUser(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/proposals`,
        {
          token: aiAgent.token,
          body: { title: "Agent proposal", createdBy: otherUser.id },
        },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.createdBy).toBe(aiAgent.user.id);
    });
  });

  // ── GET /api/v1/proposals/:id ────────────────────────────────────
  describe("GET /api/v1/proposals/:id", () => {
    it("should return a proposal by ID with comments and work items", async () => {
      const proposal = createTestProposal(testApp.db, {
        title: "Found Me",
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(proposal.id);
      expect(body.data.title).toBe("Found Me");
      expect(body.data.comments).toEqual([]);
      expect(body.data.workItems).toEqual({ epics: [], tasks: [] });
    });

    it("should return 404 for non-existent proposal", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "GET", `/api/v1/proposals/${fakeId}`);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // ── PATCH /api/v1/proposals/:id ──────────────────────────────────
  describe("PATCH /api/v1/proposals/:id", () => {
    it("should update proposal title", async () => {
      const proposal = createTestProposal(testApp.db, {
        title: "Original Title",
      });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/proposals/${proposal.id}`, {
        body: { title: "Updated Title" },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("Updated Title");
    });

    it("should update proposal description", async () => {
      const proposal = createTestProposal(testApp.db);

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/proposals/${proposal.id}`, {
        body: { description: "New description" },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.description).toBe("New description");
    });

    it("should return 404 for non-existent proposal", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/proposals/${fakeId}`, {
        body: { title: "Nope" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/proposals/:id/transitions ───────────────────────
  describe("POST /api/v1/proposals/:id/transitions", () => {
    // ── Valid transitions ────────────────────────────────────────
    it("should transition open → discussing (human)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "discussing" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("discussing");
    });

    it("should transition open → discussing (AI agent with claim)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          token: aiAgent.token,
          body: { toStatus: "discussing" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("discussing");
    });

    it("should transition discussing → accepted (human only)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "accepted" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("accepted");
      expect(body.data.resolvedBy).toBe(testApp.testUser.id);
      expect(body.data.resolvedAt).toBeDefined();
    });

    it("should transition discussing → rejected (human only)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "rejected" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("rejected");
      expect(body.data.resolvedBy).toBe(testApp.testUser.id);
      expect(body.data.resolvedAt).toBeDefined();
    });

    it("should transition open → rejected (human only)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "rejected" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("rejected");
      expect(body.data.resolvedBy).toBe(testApp.testUser.id);
      expect(body.data.resolvedAt).toBeDefined();
    });

    // ── Invalid transitions ─────────────────────────────────────
    it("should transition open → accepted (human, no discussion round needed)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "accepted" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("accepted");
    });

    it("should forbid open → accepted for an AI agent (acceptance is human-only)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          token: aiAgent.token,
          body: { toStatus: "accepted" },
        },
      );
      expect(res.status).toBe(403);
    });

    it("should transition open → in_progress (AI agent with claim)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      // AI agent must claim before writing
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          token: aiAgent.token,
          body: { toStatus: "in_progress" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("in_progress");
    });

    it("should transition discussing → in_progress (AI agent with claim)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          token: aiAgent.token,
          body: { toStatus: "in_progress" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("in_progress");
    });

    it("should reject rejected → open (invalid transition)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "rejected",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "open" },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    it("should reject in_progress → open (invalid transition)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "in_progress",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "open" },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    it("should reject accepted → open (invalid transition)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "open" },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    // ── Role enforcement ────────────────────────────────────────
    it("should reject AI trying to accept a proposal (403)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          token: aiAgent.token,
          body: { toStatus: "accepted" },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should reject AI trying to reject a proposal (403)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          token: aiAgent.token,
          body: { toStatus: "rejected" },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should allow human to transition accepted → in_progress (no claim required)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "in_progress" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("in_progress");
    });

    it("should reject AI trying to reject from open (403)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          token: aiAgent.token,
          body: { toStatus: "rejected" },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should return 404 for non-existent proposal", async () => {
      const fakeId = createId();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${fakeId}/transitions`,
        {
          body: { toStatus: "discussing" },
        },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/proposals/:id/comments ──────────────────────────
  describe("POST /api/v1/proposals/:id/comments", () => {
    it("should add a comment to a proposal", async () => {
      const proposal = createTestProposal(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: {
            body: "This is a great idea!",
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.body).toBe("This is a great idea!");
      expect(body.data.authorId).toBe(testApp.testUser.id);
      expect(body.data.proposalId).toBe(proposal.id);
      expect(body.data.commentType).toBe("comment");
    });

    it("should auto-transition open → discussing when AI agent comments", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      // AI agent must claim before commenting
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      // Capture bus events emitted by the comment (so idle views update live).
      const events: { event: EventName; payload: EventPayload }[] = [];
      const off = getEventBus().onAll((event, payload) => events.push({ event, payload }));

      // AI agent comments
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/comments`, {
        token: aiAgent.token,
        body: {
          body: "I have some questions about this...",
        },
      });
      off();

      // Verify the proposal status changed
      const proposalRes = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.status).toBe("discussing");

      // The comment must broadcast BOTH a proposal.commented and a
      // proposal.transitioned (open→discussing) event — otherwise an idle
      // proposal view never learns about the auto-transition.
      expect(events.map((e) => e.event)).toContain("proposal.commented");
      const transition = events.find((e) => e.event === "proposal.transitioned");
      expect(transition).toBeDefined();
      expect(transition!.payload.projectId).toBe(proposal.projectId);
      expect(transition!.payload.changes?.status).toEqual({
        from: "open",
        to: "discussing",
      });
    });

    it("should emit proposal.commented when a human comments (no auto-transition)", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      const events: { event: EventName; payload: EventPayload }[] = [];
      const off = getEventBus().onAll((event, payload) => events.push({ event, payload }));
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/comments`, {
        body: { body: "Looks good to me." },
      });
      off();

      expect(events.map((e) => e.event)).toContain("proposal.commented");
      // No status change → no transition event.
      expect(events.map((e) => e.event)).not.toContain("proposal.transitioned");
    });

    it("should auto-transition open → discussing when a human comments", async () => {
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      const events: { event: EventName; payload: EventPayload }[] = [];
      const off = getEventBus().onAll((event, payload) => events.push({ event, payload }));
      // Human comments (default token is human)
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/comments`, {
        body: {
          body: "Adding more context...",
        },
      });
      off();

      // A comment carries an open proposal forward to discussing.
      const proposalRes = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.status).toBe("discussing");

      // And it broadcasts the transition so idle views update live.
      const transition = events.find((e) => e.event === "proposal.transitioned");
      expect(transition).toBeDefined();
      expect(transition!.payload.changes?.status).toEqual({
        from: "open",
        to: "discussing",
      });
    });

    it("should NOT auto-transition when AI comments on non-open proposal", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      // AI agent must claim before commenting
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      // AI comments on a proposal already in "discussing"
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/comments`, {
        token: aiAgent.token,
        body: {
          body: "Here is my analysis...",
        },
      });

      // Verify status stays "discussing"
      const proposalRes = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.status).toBe("discussing");
    });

    it("should return 404 for non-existent proposal", async () => {
      const fakeId = createId();

      const res = await authRequest(testApp.app, "POST", `/api/v1/proposals/${fakeId}/comments`, {
        body: {
          body: "Comment on nothing",
        },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/v1/proposals/:id/comments ───────────────────────────
  describe("GET /api/v1/proposals/:id/comments", () => {
    it("should return empty list when no comments exist", async () => {
      const proposal = createTestProposal(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}/comments`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it("should return comments for a proposal", async () => {
      const proposal = createTestProposal(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      // Add comments
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/comments`, {
        body: { body: "First comment" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/comments`, {
        body: { body: "Second comment" },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}/comments`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });

    it("should return 404 for non-existent proposal", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "GET", `/api/v1/proposals/${fakeId}/comments`);
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/v1/proposals/:id/work-items ─────────────────────────
  describe("GET /api/v1/proposals/:id/work-items", () => {
    it("should return empty work items when none exist", async () => {
      const proposal = createTestProposal(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}/work-items`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.epics).toEqual([]);
      expect(body.data.tasks).toEqual([]);
    });

    it("should return 404 for non-existent proposal", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "GET", `/api/v1/proposals/${fakeId}/work-items`);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/proposals/:id/implement ─────────────────────────
  describe("POST /api/v1/proposals/:id/implement", () => {
    it("should implement an accepted proposal with epics and tasks", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          token: aiAgent.token,
          body: {
            epics: [
              {
                name: "Epic 1: Authentication",
                description: "Implement auth module",
                priority: "high",
              },
            ],
            tasks: [
              {
                title: "Set up JWT library",
                description: "Install and configure JWT",
                priority: "high",
                type: "feature",
                epicIndex: 0,
              },
              {
                title: "Write auth tests",
                priority: "medium",
                type: "chore",
              },
            ],
          },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("in_progress");
    });

    it("should create epics with proposalId set", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/implement`, {
        token: aiAgent.token,
        body: {
          epics: [{ name: "Epic A" }],
          tasks: [],
        },
      });

      // Verify work items
      const workItemsRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}/work-items`,
      );
      const workItemsBody = await workItemsRes.json();
      expect(workItemsBody.data.epics).toHaveLength(1);
      expect(workItemsBody.data.epics[0].name).toBe("Epic A");
      expect(workItemsBody.data.epics[0].proposalId).toBe(proposal.id);
    });

    it("should create tasks with proposalId set", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/implement`, {
        token: aiAgent.token,
        body: {
          epics: [],
          tasks: [{ title: "Standalone Task" }],
        },
      });

      // Verify work items
      const workItemsRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}/work-items`,
      );
      const workItemsBody = await workItemsRes.json();
      expect(workItemsBody.data.tasks).toHaveLength(1);
      expect(workItemsBody.data.tasks[0].title).toBe("Standalone Task");
      expect(workItemsBody.data.tasks[0].proposalId).toBe(proposal.id);
    });

    it("should transition to in_progress", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/implement`, {
        token: aiAgent.token,
        body: {
          epics: [],
          tasks: [{ title: "Task 1" }],
        },
      });

      // Verify proposal status
      const proposalRes = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.status).toBe("in_progress");
    });

    it("should add a summary comment after implementation", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/implement`, {
        token: aiAgent.token,
        body: {
          epics: [{ name: "Epic 1" }],
          tasks: [{ title: "Task 1" }, { title: "Task 2" }],
        },
      });

      // Verify summary comment appears
      const proposalRes = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.comments).toHaveLength(1);
      expect(proposalBody.data.comments[0].body).toContain("Proposal planned");
      expect(proposalBody.data.comments[0].body).toContain("1 epic(s)");
      expect(proposalBody.data.comments[0].body).toContain("2 task(s)");
    });

    it("should succeed when implementing an open proposal", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          token: aiAgent.token,
          body: {
            epics: [],
            tasks: [{ title: "Task" }],
          },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("in_progress");
    });

    it("should succeed when implementing a discussing proposal", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          token: aiAgent.token,
          body: {
            epics: [],
            tasks: [{ title: "Task" }],
          },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("in_progress");
    });

    it("should fail if proposal is not in accepted status (rejected)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "rejected",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          token: aiAgent.token,
          body: {
            epics: [],
            tasks: [{ title: "Task" }],
          },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_STATUS");
    });

    it("should fail if proposal is already in_progress", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "in_progress",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          token: aiAgent.token,
          body: {
            epics: [],
            tasks: [{ title: "Task" }],
          },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_STATUS");
    });

    it("should return 404 for non-existent proposal", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const fakeId = createId();

      const res = await authRequest(testApp.app, "POST", `/api/v1/proposals/${fakeId}/implement`, {
        token: aiAgent.token,
        body: {
          epics: [],
          tasks: [{ title: "Task" }],
        },
      });
      expect(res.status).toBe(404);
    });

    it("should link tasks to created epics via epicIndex", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/implement`, {
        token: aiAgent.token,
        body: {
          epics: [{ name: "Epic A" }, { name: "Epic B" }],
          tasks: [
            { title: "Task under Epic A", epicIndex: 0 },
            { title: "Task under Epic B", epicIndex: 1 },
            { title: "Standalone task" },
          ],
        },
      });

      // Verify work items
      const workItemsRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}/work-items`,
      );
      const workItemsBody = await workItemsRes.json();
      expect(workItemsBody.data.epics).toHaveLength(2);
      expect(workItemsBody.data.tasks).toHaveLength(3);

      // Tasks under Epic A should have epicId matching Epic A's id
      const epicA = workItemsBody.data.epics.find((e: any) => e.name === "Epic A");
      const taskUnderA = workItemsBody.data.tasks.find((t: any) => t.title === "Task under Epic A");
      expect(taskUnderA.epicId).toBe(epicA.id);

      // Tasks under Epic B should have epicId matching Epic B's id
      const epicB = workItemsBody.data.epics.find((e: any) => e.name === "Epic B");
      const taskUnderB = workItemsBody.data.tasks.find((t: any) => t.title === "Task under Epic B");
      expect(taskUnderB.epicId).toBe(epicB.id);

      // Standalone task should have no epicId
      const standaloneTask = workItemsBody.data.tasks.find(
        (t: any) => t.title === "Standalone task",
      );
      expect(standaloneTask.epicId).toBeNull();
    });
  });

  // ── Comments appear on proposal detail ───────────────────────────
  describe("Comments on proposal detail", () => {
    it("should include comments in proposal detail response", async () => {
      const proposal = createTestProposal(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      // Add comments
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/comments`, {
        body: { body: "Great idea!" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/comments`, {
        body: { body: "Let's proceed" },
      });

      // Get proposal detail
      const res = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      const body = await res.json();

      expect(body.data.comments).toHaveLength(2);
      expect(body.data.comments[0].body).toBe("Great idea!");
      expect(body.data.comments[1].body).toBe("Let's proceed");
    });
  });

  // ── Work items appear after implementation ───────────────────────
  describe("Work items after implementation", () => {
    it("should show work items in proposal detail after implementation", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: aiAgent.token,
      });

      // Implement
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/implement`, {
        token: aiAgent.token,
        body: {
          epics: [{ name: "Auth Epic" }],
          tasks: [{ title: "JWT Setup", epicIndex: 0 }, { title: "Login Page" }],
        },
      });

      // Get proposal detail — should include work items
      const res = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      const body = await res.json();

      expect(body.data.workItems.epics).toHaveLength(1);
      expect(body.data.workItems.epics[0].name).toBe("Auth Epic");
      expect(body.data.workItems.tasks).toHaveLength(2);
    });
  });

  // ── Complete workflow integration test ───────────────────────────
  describe("Full proposal workflow", () => {
    it("should support the complete proposal lifecycle", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const project = createTestProject(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      // 1. Human creates a proposal
      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/proposals`,
        {
          body: {
            title: "Add dark mode",
            description: "Users want dark mode support",
            createdBy: testApp.testUser.id,
          },
        },
      );
      expect(createRes.status).toBe(201);
      const proposalId = (await createRes.json()).data.id;

      // 2a. AI agent claims the proposal
      const claimRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposalId}/claim`,
        { token: aiAgent.token },
      );
      expect(claimRes.status).toBe(200);
      expect((await claimRes.json()).data.status).toBe("claimed_by_you");

      // 2b. AI agent engages (auto-transitions to discussing)
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposalId}/comments`, {
        token: aiAgent.token,
        body: {
          body: "I can implement dark mode using CSS custom properties. Should we support system preference detection?",
        },
      });

      // Verify auto-transition
      let proposalRes = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposalId}`);
      expect((await proposalRes.json()).data.status).toBe("discussing");

      // 3. Human approves (default token = human admin)
      const acceptRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposalId}/transitions`,
        {
          body: { toStatus: "accepted" },
        },
      );
      expect(acceptRes.status).toBe(200);
      expect((await acceptRes.json()).data.status).toBe("accepted");

      // 4. AI implements
      const implementRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposalId}/implement`,
        {
          token: aiAgent.token,
          body: {
            epics: [
              {
                name: "Dark Mode Implementation",
                description: "Full dark mode support",
                priority: "high",
              },
            ],
            tasks: [
              {
                title: "Create CSS custom properties for theming",
                epicIndex: 0,
                priority: "high",
                type: "feature",
              },
              {
                title: "Add system preference detection",
                epicIndex: 0,
                priority: "medium",
                type: "feature",
              },
              {
                title: "Write dark mode tests",
                priority: "medium",
                type: "chore",
              },
            ],
          },
        },
      );
      expect(implementRes.status).toBe(200);
      expect((await implementRes.json()).data.status).toBe("in_progress");

      // 5. Verify final state
      proposalRes = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposalId}`);
      const finalProposal = (await proposalRes.json()).data;
      expect(finalProposal.status).toBe("in_progress");
      expect(finalProposal.workItems.epics).toHaveLength(1);
      expect(finalProposal.workItems.tasks).toHaveLength(3);
      // Comments: 1 AI discussion + 1 implementation summary
      expect(finalProposal.comments).toHaveLength(2);
    });
  });

  // ── Claim semantics ──────────────────────────────────────────────
  describe("Proposal claim/release", () => {
    it("returns claim_status=unclaimed on a fresh proposal", async () => {
      const proposal = createTestProposal(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      const body = await res.json();
      expect(body.data.claimedBy).toBeNull();
      expect(body.data.claimStatus).toBe("unclaimed");
    });

    it("agent A claims an unclaimed proposal", async () => {
      const agentA = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agentA.token,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ ok: true, status: "claimed_by_you" });

      // Agent A now sees claim_status=claimed_by_you
      const getRes = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`, {
        token: agentA.token,
      });
      expect((await getRes.json()).data.claimStatus).toBe("claimed_by_you");
    });

    it("agent B sees claimed_by_other when agent A holds the claim", async () => {
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agentA.token,
      });

      const claimRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/claim`,
        { token: agentB.token },
      );
      expect(claimRes.status).toBe(200);
      expect(await claimRes.json()).toEqual({
        data: { ok: false, status: "claimed_by_another_agent" },
      });

      const getRes = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`, {
        token: agentB.token,
      });
      expect((await getRes.json()).data.claimStatus).toBe("claimed_by_other");
    });

    it("idempotent: claiming twice returns already_claimed_by_you", async () => {
      const agent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agent.token,
      });

      const second = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/claim`,
        { token: agent.token },
      );
      expect((await second.json()).data).toEqual({
        ok: true,
        status: "already_claimed_by_you",
      });
    });

    it("releasing your own claim returns released, then proposal is unclaimed", async () => {
      const agent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agent.token,
      });

      const rel = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/release`,
        { token: agent.token },
      );
      expect((await rel.json()).data).toEqual({ ok: true, status: "released" });

      // Another agent can now claim it
      const agentB = createTestAiAgent(testApp.db);
      const reclaim = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/claim`,
        { token: agentB.token },
      );
      expect((await reclaim.json()).data).toEqual({
        ok: true,
        status: "claimed_by_you",
      });
    });

    it("releasing without holding the claim returns claimed_by_another_agent for AI agents", async () => {
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agentA.token,
      });

      const rel = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/release`,
        { token: agentB.token },
      );
      expect((await rel.json()).data).toEqual({
        ok: false,
        status: "claimed_by_another_agent",
      });
    });

    it("AI agent without claim is blocked from commenting (409)", async () => {
      const agent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          token: agent.token,
          body: { body: "Can I comment?" },
        },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("CLAIM_DENIED");
    });

    it("AI agent without claim is blocked from transitioning (409)", async () => {
      const agent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          token: agent.token,
          body: { toStatus: "in_progress" },
        },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("CLAIM_DENIED");
    });

    it("AI agent B blocked from commenting on A-claimed proposal (409)", async () => {
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agentA.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        { token: agentB.token, body: { body: "stealing this" } },
      );
      expect(res.status).toBe(409);
    });

    it("humans bypass claim checks — can comment on AI-claimed proposal", async () => {
      const agent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: { body: "I'm the director — let me weigh in." },
        },
      );
      expect(res.status).toBe(201);
    });

    it("transition to completed clears claimed_by", async () => {
      const agent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "in_progress",
        createdBy: testApp.testUser.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agent.token,
      });

      const tx = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        { token: agent.token, body: { toStatus: "completed" } },
      );
      expect(tx.status).toBe(200);
      const txBody = await tx.json();
      expect(txBody.data.status).toBe("completed");
      expect(txBody.data.claimedBy).toBeNull();
    });

    it("claiming a completed proposal returns closed", async () => {
      const agent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        status: "completed",
        createdBy: testApp.testUser.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agent.token,
      });
      expect((await res.json()).data).toEqual({
        ok: false,
        status: "closed",
      });
    });

    it("?claim=available excludes proposals claimed by other agents", async () => {
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const project = createTestProject(testApp.db, {
        createdBy: testApp.testUser.id,
      });

      const claimedByA = createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: testApp.testUser.id,
        title: "claimed-by-A",
      });
      const unclaimed = createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: testApp.testUser.id,
        title: "unclaimed",
      });
      const claimedByB = createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: testApp.testUser.id,
        title: "claimed-by-B",
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${claimedByA.id}/claim`, {
        token: agentA.token,
      });
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${claimedByB.id}/claim`, {
        token: agentB.token,
      });

      // Agent B asks for available work — should see unclaimed + own claim, NOT A's
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/proposals?claim=available`,
        { token: agentB.token },
      );
      const body = await res.json();
      const titles = body.data.map((p: { title: string }) => p.title).sort();
      expect(titles).toEqual(["claimed-by-B", "unclaimed"]);
    });
  });
});
