import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  createTestProposal,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";

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

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/proposals`,
      );
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

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/proposals`,
      );
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
      expect(body.data.description).toBe(
        "We need login/logout functionality",
      );
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

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${fakeId}/proposals`,
        {
          body: { title: "Test", createdBy: user.id },
        },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/v1/proposals/:id ────────────────────────────────────
  describe("GET /api/v1/proposals/:id", () => {
    it("should return a proposal by ID with comments and work items", async () => {
      const proposal = createTestProposal(testApp.db, {
        title: "Found Me",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(proposal.id);
      expect(body.data.title).toBe("Found Me");
      expect(body.data.comments).toEqual([]);
      expect(body.data.workItems).toEqual({ epics: [], tasks: [] });
    });

    it("should return 404 for non-existent proposal", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${fakeId}`,
      );
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

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/proposals/${proposal.id}`,
        { body: { title: "Updated Title" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("Updated Title");
    });

    it("should update proposal description", async () => {
      const proposal = createTestProposal(testApp.db);

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/proposals/${proposal.id}`,
        { body: { description: "New description" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.description).toBe("New description");
    });

    it("should return 404 for non-existent proposal", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/proposals/${fakeId}`,
        { body: { title: "Nope" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/proposals/:id/transitions ───────────────────────
  describe("POST /api/v1/proposals/:id/transitions", () => {
    // ── Valid transitions ────────────────────────────────────────
    it("should transition open → discussing (human)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "discussing", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("discussing");
    });

    it("should transition open → discussing (AI agent)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "discussing", actorId: aiUser.id },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("discussing");
    });

    it("should transition discussing → accepted (human only)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "accepted", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("accepted");
      expect(body.data.resolvedBy).toBe(humanUser.id);
      expect(body.data.resolvedAt).toBeDefined();
    });

    it("should transition discussing → rejected (human only)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "rejected", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("rejected");
      expect(body.data.resolvedBy).toBe(humanUser.id);
      expect(body.data.resolvedAt).toBeDefined();
    });

    it("should transition open → rejected (human only)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "rejected", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("rejected");
      expect(body.data.resolvedBy).toBe(humanUser.id);
      expect(body.data.resolvedAt).toBeDefined();
    });

    // ── Invalid transitions ─────────────────────────────────────
    it("should reject open → accepted (invalid transition)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "accepted", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    it("should reject open → implemented (invalid transition)", async () => {
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "implemented", actorId: aiUser.id },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    it("should reject discussing → implemented (invalid transition)", async () => {
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "implemented", actorId: aiUser.id },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    it("should reject rejected → open (invalid transition)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "rejected",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "open", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    it("should reject implemented → open (invalid transition)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "implemented",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "open", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    it("should reject accepted → open (invalid transition)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "open", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    // ── Role enforcement ────────────────────────────────────────
    it("should reject AI trying to accept a proposal (403)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "accepted", actorId: aiUser.id },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should reject AI trying to reject a proposal (403)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "rejected", actorId: aiUser.id },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should reject human trying to implement a proposal (403)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "implemented", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should reject AI trying to reject from open (403)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "rejected", actorId: aiUser.id },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should return 404 for non-existent proposal", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const fakeId = createId();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${fakeId}/transitions`,
        {
          body: { toStatus: "discussing", actorId: humanUser.id },
        },
      );
      expect(res.status).toBe(404);
    });

    it("should return 404 for non-existent actor", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });
      const fakeActorId = createId();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        {
          body: { toStatus: "discussing", actorId: fakeActorId },
        },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/proposals/:id/comments ──────────────────────────
  describe("POST /api/v1/proposals/:id/comments", () => {
    it("should add a comment to a proposal", async () => {
      const user = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        createdBy: user.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: {
            authorId: user.id,
            body: "This is a great idea!",
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.body).toBe("This is a great idea!");
      expect(body.data.authorId).toBe(user.id);
      expect(body.data.proposalId).toBe(proposal.id);
      expect(body.data.commentType).toBe("comment");
    });

    it("should auto-transition open → discussing when AI agent comments", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });

      // AI agent comments
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: {
            authorId: aiUser.id,
            body: "I have some questions about this...",
          },
        },
      );

      // Verify the proposal status changed
      const proposalRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}`,
      );
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.status).toBe("discussing");
    });

    it("should NOT auto-transition when human comments on open proposal", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });

      // Human comments
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: {
            authorId: humanUser.id,
            body: "Adding more context...",
          },
        },
      );

      // Verify the proposal status did NOT change
      const proposalRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}`,
      );
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.status).toBe("open");
    });

    it("should NOT auto-transition when AI comments on non-open proposal", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: humanUser.id,
      });

      // AI comments on a proposal already in "discussing"
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: {
            authorId: aiUser.id,
            body: "Here is my analysis...",
          },
        },
      );

      // Verify status stays "discussing"
      const proposalRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}`,
      );
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.status).toBe("discussing");
    });

    it("should return 404 for non-existent proposal", async () => {
      const user = createTestUser(testApp.db);
      const fakeId = createId();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${fakeId}/comments`,
        {
          body: {
            authorId: user.id,
            body: "Comment on nothing",
          },
        },
      );
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
      const user = createTestUser(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        createdBy: user.id,
      });

      // Add comments
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: { authorId: user.id, body: "First comment" },
        },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: { authorId: user.id, body: "Second comment" },
        },
      );

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
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${fakeId}/comments`,
      );
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
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${fakeId}/work-items`,
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/proposals/:id/implement ─────────────────────────
  describe("POST /api/v1/proposals/:id/implement", () => {
    it("should implement an accepted proposal with epics and tasks", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
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
      expect(body.data.status).toBe("implemented");
    });

    it("should create epics with proposalId set", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: humanUser.id,
      });

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [{ name: "Epic A" }],
            tasks: [],
          },
        },
      );

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
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: humanUser.id,
      });

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [],
            tasks: [{ title: "Standalone Task" }],
          },
        },
      );

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

    it("should transition to implemented", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: humanUser.id,
      });

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [],
            tasks: [{ title: "Task 1" }],
          },
        },
      );

      // Verify proposal status
      const proposalRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}`,
      );
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.status).toBe("implemented");
    });

    it("should add a summary comment after implementation", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: humanUser.id,
      });

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [{ name: "Epic 1" }],
            tasks: [{ title: "Task 1" }, { title: "Task 2" }],
          },
        },
      );

      // Verify summary comment appears
      const proposalRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}`,
      );
      const proposalBody = await proposalRes.json();
      expect(proposalBody.data.comments).toHaveLength(1);
      expect(proposalBody.data.comments[0].body).toContain(
        "Proposal implemented",
      );
      expect(proposalBody.data.comments[0].body).toContain("1 epic(s)");
      expect(proposalBody.data.comments[0].body).toContain("2 task(s)");
    });

    it("should fail if proposal is not in accepted status (open)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "open",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [],
            tasks: [{ title: "Task" }],
          },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_STATUS");
    });

    it("should fail if proposal is not in accepted status (discussing)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "discussing",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [],
            tasks: [{ title: "Task" }],
          },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_STATUS");
    });

    it("should fail if proposal is not in accepted status (rejected)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "rejected",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [],
            tasks: [{ title: "Task" }],
          },
        },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_STATUS");
    });

    it("should fail if proposal is not in accepted status (implemented)", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "implemented",
        createdBy: humanUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
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
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const fakeId = createId();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${fakeId}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [],
            tasks: [{ title: "Task" }],
          },
        },
      );
      expect(res.status).toBe(404);
    });

    it("should link tasks to created epics via epicIndex", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: humanUser.id,
      });

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [{ name: "Epic A" }, { name: "Epic B" }],
            tasks: [
              { title: "Task under Epic A", epicIndex: 0 },
              { title: "Task under Epic B", epicIndex: 1 },
              { title: "Standalone task" },
            ],
          },
        },
      );

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
      const epicA = workItemsBody.data.epics.find(
        (e: any) => e.name === "Epic A",
      );
      const taskUnderA = workItemsBody.data.tasks.find(
        (t: any) => t.title === "Task under Epic A",
      );
      expect(taskUnderA.epicId).toBe(epicA.id);

      // Tasks under Epic B should have epicId matching Epic B's id
      const epicB = workItemsBody.data.epics.find(
        (e: any) => e.name === "Epic B",
      );
      const taskUnderB = workItemsBody.data.tasks.find(
        (t: any) => t.title === "Task under Epic B",
      );
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
      const user = createTestUser(testApp.db, { type: "human" });
      const proposal = createTestProposal(testApp.db, {
        createdBy: user.id,
      });

      // Add comments
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: { authorId: user.id, body: "Great idea!" },
        },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/comments`,
        {
          body: { authorId: user.id, body: "Let's proceed" },
        },
      );

      // Get proposal detail
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}`,
      );
      const body = await res.json();

      expect(body.data.comments).toHaveLength(2);
      expect(body.data.comments[0].body).toBe("Great idea!");
      expect(body.data.comments[1].body).toBe("Let's proceed");
    });
  });

  // ── Work items appear after implementation ───────────────────────
  describe("Work items after implementation", () => {
    it("should show work items in proposal detail after implementation", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const proposal = createTestProposal(testApp.db, {
        status: "accepted",
        createdBy: humanUser.id,
      });

      // Implement
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/implement`,
        {
          body: {
            actorId: aiUser.id,
            epics: [{ name: "Auth Epic" }],
            tasks: [
              { title: "JWT Setup", epicIndex: 0 },
              { title: "Login Page" },
            ],
          },
        },
      );

      // Get proposal detail — should include work items
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposal.id}`,
      );
      const body = await res.json();

      expect(body.data.workItems.epics).toHaveLength(1);
      expect(body.data.workItems.epics[0].name).toBe("Auth Epic");
      expect(body.data.workItems.tasks).toHaveLength(2);
    });
  });

  // ── Complete workflow integration test ───────────────────────────
  describe("Full proposal workflow", () => {
    it("should support the complete proposal lifecycle", async () => {
      const humanUser = createTestUser(testApp.db, { type: "human" });
      const aiUser = createTestUser(testApp.db, { type: "ai_agent" });
      const project = createTestProject(testApp.db, {
        createdBy: humanUser.id,
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
            createdBy: humanUser.id,
          },
        },
      );
      expect(createRes.status).toBe(201);
      const proposalId = (await createRes.json()).data.id;

      // 2. AI agent engages (auto-transitions to discussing)
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposalId}/comments`,
        {
          body: {
            authorId: aiUser.id,
            body: "I can implement dark mode using CSS custom properties. Should we support system preference detection?",
          },
        },
      );

      // Verify auto-transition
      let proposalRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposalId}`,
      );
      expect((await proposalRes.json()).data.status).toBe("discussing");

      // 3. Human approves
      const acceptRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposalId}/transitions`,
        {
          body: { toStatus: "accepted", actorId: humanUser.id },
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
          body: {
            actorId: aiUser.id,
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
      expect((await implementRes.json()).data.status).toBe("implemented");

      // 5. Verify final state
      proposalRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/proposals/${proposalId}`,
      );
      const finalProposal = (await proposalRes.json()).data;
      expect(finalProposal.status).toBe("implemented");
      expect(finalProposal.workItems.epics).toHaveLength(1);
      expect(finalProposal.workItems.tasks).toHaveLength(3);
      // Comments: 1 AI discussion + 1 implementation summary
      expect(finalProposal.comments).toHaveLength(2);
    });
  });
});
