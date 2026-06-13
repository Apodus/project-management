import { describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import {
  createTestApp,
  createTestProject,
  createTestAiAgent,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";
import { users, type AppDatabase } from "../../src/db/index.js";

// A token-bearing HUMAN distinct from the default admin (for non-author
// human resolve/ack cases). createTestUser yields no token; createTestAiAgent
// is ai_agent-typed — so mint a human with an apiTokenHash directly, mirroring
// createTestAiAgent's token convention.
function createTestHuman(db: AppDatabase): { id: string; token: string } {
  const id = createId();
  const token = `human-token-${id}`;
  const ts = new Date().toISOString();
  db.insert(users)
    .values({
      id,
      username: `human-${id.slice(-6)}`,
      displayName: `Human ${id.slice(-6)}`,
      email: null,
      role: "admin",
      type: "human",
      apiTokenHash: bcrypt.hashSync(token, 10),
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return { id, token };
}

// Minimal valid create body (originRepo + originWorkerKey are REQUIRED).
function escBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "bug_report",
    title: "Something broke",
    originRepo: "game_one",
    originWorkerKey: "worker-1",
    ...overrides,
  };
}

async function raise(
  app: TestApp,
  projectId: string,
  opts: { token?: string; body?: Record<string, unknown> } = {},
) {
  const res = await authRequest(app.app, "POST", `/api/v1/projects/${projectId}/escalations`, {
    token: opts.token,
    body: escBody(opts.body),
  });
  return (await res.json()).data as { id: string; [k: string]: unknown };
}

describe("Escalations API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── POST /api/v1/projects/:projectId/escalations ─────────────────
  describe("POST /api/v1/projects/:projectId/escalations", () => {
    it("raises an escalation (201, status open, author=caller, origin echoed)", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/escalations`,
        { body: escBody({ severity: "high", authorId: "bogus-spoofed-id" }) },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBeTruthy();
      expect(body.data.status).toBe("open");
      expect(body.data.kind).toBe("bug_report");
      expect(body.data.severity).toBe("high");
      expect(body.data.originRepo).toBe("game_one");
      expect(body.data.originWorkerKey).toBe("worker-1");
      // Author is the caller, never accepted from the body.
      expect(body.data.authorId).toBe(testApp.testUser.id);
      expect(body.data.authorId).not.toBe("bogus-spoofed-id");
    });

    it("C4 P4: the 201 body carries similar/merged/mergedInto/rateLimited", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/escalations`,
        { body: escBody() },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(Array.isArray(body.similar)).toBe(true);
      expect(body.merged).toBe(false);
      expect(body.mergedInto).toBeNull();
      expect(body.rateLimited).toBe(false);
    });

    it("C4 P4: a duplicate POST folds into the existing thread (merged:true, thread grows, no new row)", async () => {
      const project = createTestProject(testApp.db);
      const first = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/escalations`,
        { body: escBody({ title: "duplicate title here" }) },
      );
      const firstBody = await first.json();
      expect(firstBody.merged).toBe(false);

      const second = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/escalations`,
        { body: escBody({ title: "  DUPLICATE   title here " }) },
      );
      expect(second.status).toBe(201);
      const secondBody = await second.json();
      expect(secondBody.merged).toBe(true);
      expect(secondBody.mergedInto).toBe(firstBody.data.id);
      expect(secondBody.data.id).toBe(firstBody.data.id);

      // No new escalation row.
      const listRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/escalations`,
      );
      const listBody = await listRes.json();
      expect(listBody.data).toHaveLength(1);

      // The thread grew (the folded raise appended as a reply).
      const getRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/escalations/${firstBody.data.id}`,
      );
      const getBody = await getRes.json();
      expect(getBody.data.messages).toHaveLength(1);
      expect(getBody.data.messages[0].messageType).toBe("reply");
    });

    it("returns 404 when the project does not exist", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${createId()}/escalations`,
        { body: escBody() },
      );
      expect(res.status).toBe(404);
    });

    it("returns 400 when originRepo is missing", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/escalations`,
        { body: { kind: "bug_report", title: "x", originWorkerKey: "w" } },
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when title is empty", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/escalations`,
        { body: escBody({ title: "" }) },
      );
      expect(res.status).toBe(400);
    });

    it("returns 401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(`/api/v1/projects/${project.id}/escalations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(escBody()),
      });
      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/v1/projects/:projectId/escalations ──────────────────
  describe("GET /api/v1/projects/:projectId/escalations", () => {
    it("returns a {data, pagination:{total}} envelope, project-scoped", async () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      await raise(testApp, projectA.id, { body: { kind: "bug_report", title: "a1" } });
      await raise(testApp, projectA.id, { body: { kind: "question", title: "a2" } });
      await raise(testApp, projectB.id, { body: { kind: "bug_report", title: "b1" } });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${projectA.id}/escalations`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination).toEqual({ total: 2 });
    });

    it("filters by status and by kind", async () => {
      const project = createTestProject(testApp.db);
      const bug = await raise(testApp, project.id, { body: { kind: "bug_report", title: "bug" } });
      await raise(testApp, project.id, { body: { kind: "question", title: "q" } });
      // Acknowledge one so a status filter has a non-open row.
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${bug.id}/acknowledge`);

      const byKind = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/escalations?kind=bug_report`,
      );
      const byKindBody = await byKind.json();
      expect(byKindBody.data).toHaveLength(1);
      expect(byKindBody.data[0].kind).toBe("bug_report");

      const byStatus = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/escalations?status=acknowledged`,
      );
      const byStatusBody = await byStatus.json();
      expect(byStatusBody.data).toHaveLength(1);
      expect(byStatusBody.data[0].status).toBe("acknowledged");
    });

    it("returns an empty list for a project with no escalations", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/escalations`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({ total: 0 });
    });
  });

  // ── GET /api/v1/escalations/:id ──────────────────────────────────
  describe("GET /api/v1/escalations/:id", () => {
    it("returns the escalation with a monotonic-seq messages thread", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/messages`, {
        body: { body: "first reply" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/messages`, {
        body: { body: "second reply" },
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/escalations/${esc.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(esc.id);
      expect(Array.isArray(body.data.messages)).toBe(true);
      expect(body.data.messages).toHaveLength(2);
      expect(body.data.messages[0].seq).toBe(1);
      expect(body.data.messages[1].seq).toBe(2);
      expect(body.data.messages[0].body).toBe("first reply");
    });

    it("returns 404 for a missing escalation", async () => {
      const res = await authRequest(testApp.app, "GET", `/api/v1/escalations/${createId()}`);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/escalations/:id/messages ────────────────────────
  describe("POST /api/v1/escalations/:id/messages", () => {
    it("appends a reply by the author (201, returns the escalation)", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/messages`, {
        body: { body: "a note" },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBe(esc.id);
    });

    it("returns 403 when a different ai_agent (not author/holder/human) replies", async () => {
      const project = createTestProject(testApp.db);
      const author = createTestAiAgent(testApp.db);
      const other = createTestAiAgent(testApp.db);
      const esc = await raise(testApp, project.id, { token: author.token });

      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/messages`, {
        token: other.token,
        body: { body: "intruder" },
      });
      expect(res.status).toBe(403);
    });

    it("returns 409 when replying to a resolved escalation", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      // Author withdrawal from open → resolved (Amendment B).
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/resolve`, {
        body: { reason: "withdrawn" },
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/messages`, {
        body: { body: "too late" },
      });
      expect(res.status).toBe(409);
    });

    it("returns 400 for an empty body", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/messages`, {
        body: { body: "" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for a missing escalation", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${createId()}/messages`,
        { body: { body: "x" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/escalations/:id/acknowledge ─────────────────────
  describe("POST /api/v1/escalations/:id/acknowledge", () => {
    it("a human acks an open escalation (200 acknowledged)", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("acknowledged");
    });

    it("returns 409 when acking an already-acknowledged escalation", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`);
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`);
      expect(res.status).toBe(409);
    });

    it("an ai_agent acking an unheld open escalation auto-claims it (200, holderId=agent)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const esc = await raise(testApp, project.id, { token: agent.token });
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`, {
        token: agent.token,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("acknowledged");
      expect(body.data.holderId).toBe(agent.user.id);
    });

    it("a SECOND ai_agent acking a held escalation gets 403", async () => {
      const project = createTestProject(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const other = createTestAiAgent(testApp.db);
      const esc = await raise(testApp, project.id, { token: holder.token });
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`, {
        token: holder.token,
      });
      // Held + already acknowledged; a different agent is gated at authz (403)
      // before the transition check.
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`, {
        token: other.token,
      });
      expect(res.status).toBe(403);
    });

    it("returns 404 for a missing escalation", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${createId()}/acknowledge`,
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/escalations/:id/answer ──────────────────────────
  describe("POST /api/v1/escalations/:id/answer", () => {
    it("drives open→acknowledge→answer (200 answered)", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`);
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/answer`, {
        body: {},
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("answered");
    });

    it("appends the optional body as a diagnosis message", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`);
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/answer`, {
        body: { body: "here is the diagnosis" },
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/escalations/${esc.id}`);
      const body = await res.json();
      const diag = body.data.messages.find(
        (m: { messageType: string }) => m.messageType === "diagnosis",
      );
      expect(diag).toBeDefined();
      expect(diag.body).toBe("here is the diagnosis");
    });

    it("returns 409 when answering from open (not acknowledged)", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/answer`, {
        body: {},
      });
      expect(res.status).toBe(409);
    });

    it("returns 404 for a missing escalation", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${createId()}/answer`,
        { body: {} },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/escalations/:id/resolve ─────────────────────────
  describe("POST /api/v1/escalations/:id/resolve", () => {
    it("resolves an answered escalation (200 resolved, resolvedBy set, system message)", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`);
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/answer`, { body: {} });

      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/resolve`, {
        body: { reason: "fixed it" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("resolved");
      expect(body.data.resolvedBy).toBe(testApp.testUser.id);
      expect(body.data.resolvedAt).toBeTruthy();

      const get = await (
        await authRequest(testApp.app, "GET", `/api/v1/escalations/${esc.id}`)
      ).json();
      const sys = get.data.messages.find((m: { messageType: string }) => m.messageType === "system");
      expect(sys).toBeDefined();
      expect(sys.body).toContain("fixed it");
    });

    it("allows author withdrawal from open (200, Amendment B)", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/resolve`, {
        body: { reason: "never mind" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("resolved");
    });

    it("returns 403 for a non-author/non-holder ai_agent", async () => {
      const project = createTestProject(testApp.db);
      const author = createTestAiAgent(testApp.db);
      const other = createTestAiAgent(testApp.db);
      const esc = await raise(testApp, project.id, { token: author.token });

      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/resolve`, {
        token: other.token,
        body: { reason: "not mine" },
      });
      expect(res.status).toBe(403);
    });

    it("returns 409 for a non-author human resolving from open", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const esc = await raise(testApp, project.id, { token: agent.token });
      const human = createTestHuman(testApp.db);

      // Human is allowed (authz), but open is not a legal non-author source state.
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/resolve`, {
        token: human.token,
        body: { reason: "from open" },
      });
      expect(res.status).toBe(409);
    });

    it("returns 400 for an empty reason", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      const res = await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/resolve`, {
        body: { reason: "" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for a missing escalation", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${createId()}/resolve`,
        { body: { reason: "x" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/escalations/:id/escalate-to-human ───────────────
  describe("POST /api/v1/escalations/:id/escalate-to-human", () => {
    it("marks a non-terminal escalation needs_human (200, system message)", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${esc.id}/escalate-to-human`,
        { body: { reason: "need a human" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("needs_human");

      const get = await (
        await authRequest(testApp.app, "GET", `/api/v1/escalations/${esc.id}`)
      ).json();
      const sys = get.data.messages.find((m: { messageType: string }) => m.messageType === "system");
      expect(sys).toBeDefined();
      expect(sys.body).toContain("need a human");
    });

    it("returns 403 for a non-author/non-holder ai_agent", async () => {
      const project = createTestProject(testApp.db);
      const author = createTestAiAgent(testApp.db);
      const other = createTestAiAgent(testApp.db);
      const esc = await raise(testApp, project.id, { token: author.token });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${esc.id}/escalate-to-human`,
        { token: other.token, body: { reason: "not mine" } },
      );
      expect(res.status).toBe(403);
    });

    it("returns 409 from a terminal (resolved) escalation", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/resolve`, {
        body: { reason: "withdrawn" },
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${esc.id}/escalate-to-human`,
        { body: { reason: "too late" } },
      );
      expect(res.status).toBe(409);
    });

    it("returns 400 for an empty reason", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raise(testApp, project.id);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${esc.id}/escalate-to-human`,
        { body: { reason: "" } },
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 for a missing escalation", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${createId()}/escalate-to-human`,
        { body: { reason: "x" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── C2 §P1: delivery cursor ──────────────────────────────────────
  // Seed a non-origin directed reply: the origin (default test admin)
  // raises; a SECOND human acks + replies. The reply's authorId differs
  // from the escalation's authorId, so it is "undelivered" to the origin.
  async function raiseWithHolderReply(
    projectId: string,
    workerKey: string,
    replyBody = "here is the fix",
  ) {
    const esc = await raise(testApp, projectId, { body: { originWorkerKey: workerKey } });
    const holder = createTestHuman(testApp.db);
    await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/acknowledge`, {
      token: holder.token,
    });
    await authRequest(testApp.app, "POST", `/api/v1/escalations/${esc.id}/messages`, {
      token: holder.token,
      body: { body: replyBody },
    });
    return esc;
  }

  describe("GET /api/v1/escalations/undelivered", () => {
    it("returns undelivered escalations for the worker (200, shape)", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raiseWithHolderReply(project.id, "worker-1");

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/escalations/undelivered?worker_key=worker-1`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].escalation.id).toBe(esc.id);
      expect(body.data[0].unreadCount).toBe(1);
      expect(body.data[0].unreadMessages).toHaveLength(1);
      expect(body.data[0].unreadMessages[0].body).toBe("here is the fix");
    });

    it("returns an empty list for a worker with nothing undelivered", async () => {
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/escalations/undelivered?worker_key=nobody`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data).toHaveLength(0);
    });

    it("scopes by project_id when given", async () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      await raiseWithHolderReply(projectA.id, "worker-9");
      await raiseWithHolderReply(projectB.id, "worker-9");

      const all = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/escalations/undelivered?worker_key=worker-9`,
      );
      expect((await all.json()).data).toHaveLength(2);

      const scoped = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/escalations/undelivered?worker_key=worker-9&project_id=${projectA.id}`,
      );
      const scopedBody = await scoped.json();
      expect(scopedBody.data).toHaveLength(1);
      expect(scopedBody.data[0].escalation.projectId).toBe(projectA.id);
    });

    it("400s when worker_key is missing", async () => {
      const res = await authRequest(testApp.app, "GET", `/api/v1/escalations/undelivered`);
      expect(res.status).toBe(400);
    });

    it("is NOT captured by the /escalations/:id route", async () => {
      // If `undelivered` were routed as an :id, this would 404 (no such
      // escalation). Instead it 200s the undelivered list.
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/escalations/undelivered?worker_key=worker-1`,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/v1/escalations/:id/mark-delivered", () => {
    it("advances the cursor → a subsequent /undelivered is empty (200)", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raiseWithHolderReply(project.id, "worker-1");

      const mark = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${esc.id}/mark-delivered`,
        { body: { workerKey: "worker-1", uptoSeq: 1 } },
      );
      expect(mark.status).toBe(200);
      expect((await mark.json()).data.id).toBe(esc.id);

      const after = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/escalations/undelivered?worker_key=worker-1`,
      );
      expect((await after.json()).data).toHaveLength(0);
    });

    it("400s on a bad body", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raiseWithHolderReply(project.id, "worker-1");
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${esc.id}/mark-delivered`,
        { body: { uptoSeq: -1 } },
      );
      expect(res.status).toBe(400);
    });

    it("403s on a wrong workerKey", async () => {
      const project = createTestProject(testApp.db);
      const esc = await raiseWithHolderReply(project.id, "worker-1");
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${esc.id}/mark-delivered`,
        { body: { workerKey: "not-the-origin", uptoSeq: 1 } },
      );
      expect(res.status).toBe(403);
    });

    it("404s on an unknown id", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${createId()}/mark-delivered`,
        { body: { workerKey: "worker-1", uptoSeq: 1 } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/v1/projects/:projectId/escalations/metrics (C4 §P2) ──
  describe("GET /api/v1/projects/:projectId/escalations/metrics", () => {
    it("returns a snake_case metric bundle (200, any authed user)", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/escalations/metrics`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const d = body.data;
      expect(d.time_to_first_response).toEqual({
        p50_ms: null,
        p95_ms: null,
        sample_size: 0,
      });
      expect(d.time_to_resolve).toHaveProperty("p95_ms");
      expect(d.auto_resolve_rate).toEqual({ rate: null, answered: 0, total: 0 });
      expect(d.human_escalation_rate).toEqual({ rate: null, escalated: 0, total: 0 });
      expect(d.open_backlog).toEqual({ count: 0, oldest_age_ms: null });
      expect(d.by_status).toEqual({
        open: 0,
        acknowledged: 0,
        answered: 0,
        resolved: 0,
        needs_human: 0,
      });
      expect(d.by_kind).toEqual({ bug_report: 0, question: 0, request: 0, blocked: 0 });
      expect(d.total).toBe(0);
      expect(typeof d.computed_at).toBe("string");
    });

    it("reflects seeded escalations (open backlog + by_status/by_kind)", async () => {
      const project = createTestProject(testApp.db);
      await raise(testApp, project.id, { body: { kind: "bug_report", title: "b1" } });
      await raise(testApp, project.id, { body: { kind: "question", title: "q1" } });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/escalations/metrics`,
      );
      expect(res.status).toBe(200);
      const d = (await res.json()).data;
      expect(d.total).toBe(2);
      expect(d.open_backlog.count).toBe(2);
      expect(d.open_backlog.oldest_age_ms).toBeGreaterThanOrEqual(0);
      expect(d.by_status.open).toBe(2);
      expect(d.by_kind.bug_report).toBe(1);
      expect(d.by_kind.question).toBe(1);
    });

    it("returns 401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(
        `/api/v1/projects/${project.id}/escalations/metrics`,
        { method: "GET" },
      );
      expect(res.status).toBe(401);
    });

    it("returns 404 when the project does not exist", async () => {
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${createId()}/escalations/metrics`,
      );
      expect(res.status).toBe(404);
    });
  });
});
