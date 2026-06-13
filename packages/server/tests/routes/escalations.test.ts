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
});
