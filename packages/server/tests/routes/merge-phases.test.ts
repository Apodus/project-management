import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import {
  createId,
  MERGE_PHASES_DERIVED,
  mergePhaseIngestSchema,
  mergePhaseRowSchema,
  phaseTraceEntrySchema,
} from "@pm/shared";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { activityLog, mergeRequestGroups, mergeRequests, users } from "../../src/db/index.js";

// ══════════════════════════════════════════════════════════════════
// The phase-timing REST surface. Beyond the usual authz/validation matrix this
// file pins two things the campaign depends on:
//   - a DERIVED phase name is refused at the WIRE (the anti-double-count guard
//     has to hold at the boundary, not just in the service), and
//   - the Zod-3 (@pm/shared) and Zod-4 (route-local mirror) schemas stay in
//     lockstep: the body is BUILT from the shared schema and the response is
//     PARSED with the shared view schemas, so a drift between the two fails here.
// ══════════════════════════════════════════════════════════════════

const MIN = 60_000;

describe("merge-phases routes", () => {
  let testApp: TestApp;
  let projectId: string;
  let integratorToken: string;
  let memberToken: string;
  let submitterId: string;

  beforeEach(() => {
    testApp = createTestApp();
    const project = createTestProject(testApp.db);
    projectId = project.id;
    integratorToken = createTestAiAgent(testApp.db).token;

    // A HUMAN member (non-admin) — the read tier. utils.ts has no
    // human-with-token factory, so the token is attached here the same way
    // createTestAiAgent does it.
    const member = createTestUser(testApp.db, { role: "member" });
    memberToken = `member-token-${member.id}`;
    testApp.db
      .update(users)
      .set({ apiTokenHash: bcrypt.hashSync(memberToken, 10) })
      .where(eq(users.id, member.id))
      .run();
    submitterId = member.id;
  });

  afterEach(() => {
    testApp.cleanup();
  });

  function ingestBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    // BUILT from the shared Zod-3 schema — the lockstep half of the contract.
    return mergePhaseIngestSchema.parse({
      phases: [
        {
          phase: "verify",
          startedAt: new Date().toISOString(),
          durationMs: 1000,
          ...over,
        },
      ],
    }) as unknown as Record<string, unknown>;
  }

  function seedRequest(over: Partial<{ enqueuedAt: string; pickedUpAt: string }> = {}): string {
    const id = createId();
    const ts = new Date().toISOString();
    testApp.db
      .insert(mergeRequests)
      .values({
        id,
        projectId,
        submittedBy: submitterId,
        enqueuedAt: over.enqueuedAt ?? ts,
        pickedUpAt: over.pickedUpAt ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return id;
  }

  // ─── Authz matrix ───────────────────────────────────────────────

  describe("authz", () => {
    it("POST: anon 401 / human admin 403 / human member 403 / ai_agent 202", async () => {
      const path = `/api/v1/projects/${projectId}/merge-phases`;

      const anon = await testApp.app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ingestBody()),
      });
      expect(anon.status).toBe(401);

      // The default test token is a human ADMIN — break-glass power does not
      // grant the ability to fabricate telemetry.
      const admin = await authRequest(testApp.app, "POST", path, { body: ingestBody() });
      expect(admin.status).toBe(403);

      const member = await authRequest(testApp.app, "POST", path, {
        token: memberToken,
        body: ingestBody(),
      });
      expect(member.status).toBe(403);

      const integrator = await authRequest(testApp.app, "POST", path, {
        token: integratorToken,
        body: ingestBody(),
      });
      expect(integrator.status).toBe(202);
    });

    it("GETs: anon 401, any authenticated member 200", async () => {
      const requestId = seedRequest({ pickedUpAt: new Date().toISOString() });
      const groupId = createId();
      const ts = new Date().toISOString();
      testApp.db
        .insert(mergeRequestGroups)
        .values({ id: groupId, projectId, submittedBy: submitterId, createdAt: ts, updatedAt: ts })
        .run();

      for (const path of [
        `/api/v1/projects/${projectId}/merge-phases`,
        `/api/v1/merge-requests/${requestId}/phases`,
        `/api/v1/merge-groups/${groupId}/phases`,
      ]) {
        expect((await testApp.app.request(path)).status).toBe(401);
        expect((await authRequest(testApp.app, "GET", path, { token: memberToken })).status).toBe(
          200,
        );
      }
    });
  });

  // ─── Validation ─────────────────────────────────────────────────

  describe("ingest validation", () => {
    it("400s on a DERIVED phase name — the anti-double-count guard at the wire", async () => {
      for (const phase of MERGE_PHASES_DERIVED) {
        const res = await authRequest(
          testApp.app,
          "POST",
          `/api/v1/projects/${projectId}/merge-phases`,
          {
            token: integratorToken,
            body: {
              phases: [{ phase, startedAt: new Date().toISOString(), durationMs: 1 }],
            },
          },
        );
        expect(res.status).toBe(400);
      }
    });

    it("accepts exactly 100 entries, 400s on 101 and on an empty batch", async () => {
      const path = `/api/v1/projects/${projectId}/merge-phases`;
      const one = { phase: "land", startedAt: new Date().toISOString(), durationMs: 1 };

      const at100 = await authRequest(testApp.app, "POST", path, {
        token: integratorToken,
        body: { phases: Array.from({ length: 100 }, () => one) },
      });
      expect(at100.status).toBe(202);
      expect((await at100.json()).data.recorded).toBe(100);

      const at101 = await authRequest(testApp.app, "POST", path, {
        token: integratorToken,
        body: { phases: Array.from({ length: 101 }, () => one) },
      });
      expect(at101.status).toBe(400);

      const empty = await authRequest(testApp.app, "POST", path, {
        token: integratorToken,
        body: { phases: [] },
      });
      expect(empty.status).toBe(400);
    });

    it("404s on an unknown project", async () => {
      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/nope/merge-phases`, {
        token: integratorToken,
        body: ingestBody(),
      });
      expect(res.status).toBe(404);
    });

    it("takes recordedBy from the session even when the body supplies one", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${projectId}/merge-phases`,
        {
          token: integratorToken,
          body: {
            phases: [
              {
                phase: "verify",
                startedAt: new Date().toISOString(),
                durationMs: 1,
                recordedBy: "someone-else",
              },
            ],
          },
        },
      );
      expect(res.status).toBe(202);

      const list = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${projectId}/merge-phases`,
      );
      const row = (await list.json()).data[0];
      expect(row.recordedBy).not.toBe("someone-else");
      expect(row.recordedBy).toBeTruthy();
    });

    it("reports `adjusted` for a normalized row rather than failing the POST", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${projectId}/merge-phases`,
        {
          token: integratorToken,
          body: {
            phases: [
              {
                phase: "verify",
                startedAt: new Date().toISOString(),
                durationMs: -100,
                requestId: "dangling",
              },
            ],
          },
        },
      );
      expect(res.status).toBe(202);
      expect((await res.json()).data).toEqual({ recorded: 1, adjusted: 1 });
    });
  });

  // ─── Reads ──────────────────────────────────────────────────────

  describe("list + traces", () => {
    it("filters and paginates, newest-first, stored rows only", async () => {
      const requestId = seedRequest({
        enqueuedAt: new Date(Date.now() - 30 * MIN).toISOString(),
        pickedUpAt: new Date(Date.now() - 20 * MIN).toISOString(),
      });
      await authRequest(testApp.app, "POST", `/api/v1/projects/${projectId}/merge-phases`, {
        token: integratorToken,
        body: {
          phases: [
            {
              phase: "rebase",
              startedAt: new Date(Date.now() - 19 * MIN).toISOString(),
              durationMs: 1,
              requestId,
            },
            {
              phase: "verify",
              startedAt: new Date(Date.now() - 15 * MIN).toISOString(),
              durationMs: 2,
              requestId,
            },
          ],
        },
      });

      const all = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${projectId}/merge-phases`,
      );
      const body = await all.json();
      expect(body.pagination).toEqual({ total: 2, page: 1, perPage: 50 });
      expect(body.data.map((r: { phase: string }) => r.phase)).toEqual(["verify", "rebase"]);
      // Stored rows only — no derived queue_wait leaks into the page.
      expect(body.data.every((r: { derived: boolean }) => r.derived === false)).toBe(true);

      const filtered = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${projectId}/merge-phases?phase=verify&perPage=1&page=1`,
      );
      const filteredBody = await filtered.json();
      expect(filteredBody.pagination.total).toBe(1);
      expect(filteredBody.data).toHaveLength(1);

      // LOCKSTEP: the response parses against the shared Zod-3 view schema.
      for (const row of body.data) {
        expect(mergePhaseRowSchema.safeParse(row).success).toBe(true);
      }
    });

    it("the request trace is ASC and leads with the derived queue_wait", async () => {
      const requestId = seedRequest({
        enqueuedAt: new Date(Date.now() - 30 * MIN).toISOString(),
        pickedUpAt: new Date(Date.now() - 20 * MIN).toISOString(),
      });
      await authRequest(testApp.app, "POST", `/api/v1/projects/${projectId}/merge-phases`, {
        token: integratorToken,
        body: {
          phases: [
            {
              phase: "verify",
              startedAt: new Date(Date.now() - 15 * MIN).toISOString(),
              durationMs: 1,
              requestId,
            },
            {
              phase: "rebase",
              startedAt: new Date(Date.now() - 19 * MIN).toISOString(),
              durationMs: 1,
              requestId,
            },
          ],
        },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-requests/${requestId}/phases`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()).data;
      expect(data.map((e: { phase: string }) => e.phase)).toEqual([
        "queue_wait",
        "rebase",
        "verify",
      ]);
      expect(data[0].derived).toBe(true);
      expect(data[0].basis).toBe("exact");
      // LOCKSTEP on the discriminated union.
      for (const entry of data) {
        expect(phaseTraceEntrySchema.safeParse(entry).success).toBe(true);
      }
    });

    it("the group trace is ASC and leads with the derived forming", async () => {
      const ts = new Date().toISOString();
      const groupId = createId();
      testApp.db
        .insert(mergeRequestGroups)
        .values({
          id: groupId,
          projectId,
          submittedBy: submitterId,
          createdAt: new Date(Date.now() - 30 * MIN).toISOString(),
          updatedAt: ts,
        })
        .run();
      const memberId = createId();
      testApp.db
        .insert(mergeRequests)
        .values({
          id: memberId,
          projectId,
          submittedBy: submitterId,
          groupId,
          enqueuedAt: new Date(Date.now() - 30 * MIN).toISOString(),
          pickedUpAt: new Date(Date.now() - 25 * MIN).toISOString(),
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      await authRequest(testApp.app, "POST", `/api/v1/projects/${projectId}/merge-phases`, {
        token: integratorToken,
        body: {
          phases: [
            {
              phase: "assemble",
              startedAt: new Date(Date.now() - 24 * MIN).toISOString(),
              durationMs: 1,
              groupId,
            },
            {
              phase: "materialize",
              startedAt: new Date(Date.now() - 23 * MIN).toISOString(),
              durationMs: 1,
              requestId: memberId,
            },
          ],
        },
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/merge-groups/${groupId}/phases`);
      const data = (await res.json()).data;
      expect(data.map((e: { phase: string }) => e.phase)).toEqual([
        "forming",
        "assemble",
        "materialize",
      ]);
      expect(data[0].derived).toBe(true);
      for (const entry of data) {
        expect(phaseTraceEntrySchema.safeParse(entry).success).toBe(true);
      }
    });

    it("404s on unknown request / group ids", async () => {
      expect(
        (await authRequest(testApp.app, "GET", `/api/v1/merge-requests/nope/phases`)).status,
      ).toBe(404);
      expect(
        (await authRequest(testApp.app, "GET", `/api/v1/merge-groups/nope/phases`)).status,
      ).toBe(404);
    });
  });

  // ─── The activity-feed suppression ──────────────────────────────

  it("a successful ingest adds ZERO activity_log rows (telemetry is not narrative)", async () => {
    const before = testApp.db.select().from(activityLog).all().length;

    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${projectId}/merge-phases`,
      { token: integratorToken, body: ingestBody() },
    );
    expect(res.status).toBe(202);

    expect(testApp.db.select().from(activityLog).all().length).toBe(before);
  });
});
