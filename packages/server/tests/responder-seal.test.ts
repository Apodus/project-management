/**
 * C3 P6b — full-stack responder seal (FINAL).
 *
 * Drives the REAL `responderTick` (from @urtela/pm-responder, imported by
 * relative path — Vitest transpiles the sibling TS on demand; loop.ts's
 * logger/pino/responder-runner/@pm/shared imports are type-only and erase, so
 * there is no unresolvable runtime dep) against an in-memory @pm/server: the
 * `ResponderClient`'s `fetchImpl` is `app.request`, so every HTTP call the loop
 * makes lands on the real route stack + real SQLite.
 *
 * Only the LLM session is stubbed (the runner is injectable BY DESIGN). This
 * proves the autonomous loop closes the C1→C3→C2 chain end-to-end:
 *   - a client agent raises an OPEN escalation (C1),
 *   - the responder acknowledges (auto-claim, the C1 one-active gate) then
 *     answers — the diagnosis message is authored by the responder, NOT the
 *     origin author, so it is a directed reply the origin has not seen (C3),
 *   - that reply surfaces via GET /escalations/undelivered for the origin
 *     worker_key, and mark-delivered drains it (the C2 delivery layer).
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp, createTestProject, createTestAiAgent, authRequest } from "./utils.js";
import type { TestApp } from "./utils.js";
// REVISE FIX #1 — correct relative path: responder-ref is `packages/responder-ref`,
// so from `packages/server/tests/` it is `../../responder-ref/...`.
import {
  responderTick,
  createResponderState,
  type ResponderDeps,
} from "../../responder-ref/src/loop.js";
import { ResponderClient } from "../../responder-ref/src/api-client.js";
import type { Logger } from "../../responder-ref/src/logger.js";
import type {
  ResponderRunner,
  ResponderRunResult,
  ResponderRunInput,
} from "../../responder-ref/src/responder-runner.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const DIAGNOSIS = "Root cause: the foo widget reads a stale cache; flush it on write.";

/** A scripted answering session — always `answered` with the diagnosis text. */
class AnsweredRunner implements ResponderRunner {
  result: ResponderRunResult;
  constructor(result?: ResponderRunResult) {
    this.result = result ?? { kind: "answered", answer: DIAGNOSIS, durationMs: 1 };
  }
  async run(_input: ResponderRunInput): Promise<ResponderRunResult> {
    return this.result;
  }
}

function baseDeps(
  client: ResponderClient,
  projectId: string,
  selfId: string,
  over: Partial<ResponderDeps> = {},
): ResponderDeps {
  return {
    client,
    logger: silentLogger,
    projectIds: [projectId],
    selfId,
    enabled: true,
    // REVISE FIX #2: mode "on" so a routine (non-high) answer auto-sends and
    // the chain lands on `answered`.
    mode: "on",
    maxConcurrent: 10,
    runner: new AnsweredRunner(),
    repoCwd: "/unused",
    command: "unused",
    budget: { timeBudgetSec: 900 },
    excludeOriginRepos: [],
    reclaimGraceSec: 120,
    maxReclaimAttempts: 2,
    spawnBudget: { maxSpawns: 1000, windowSec: 3600 },
    now: () => Date.now(),
    ...over,
  };
}

describe("C3 responder full-stack seal", () => {
  let testApp: TestApp;

  afterEach(() => {
    testApp?.cleanup();
  });

  it("closes the C1→C3→C2 chain: client raises → responder acknowledges+answers → undelivered surfaces → mark-delivered drains", async () => {
    testApp = createTestApp();
    const { app, db } = testApp;
    const project = createTestProject(db);

    // The RESPONDER (the autonomous answerer) and a DISTINCT client-origin
    // author, so the diagnosis authorId != the responder selfId.
    const responder = createTestAiAgent(db);
    const client = createTestAiAgent(db);

    const responderClient = new ResponderClient({
      baseUrl: "http://seal.test",
      token: responder.token,
      // Hono's app.request(input, requestInit) — exactly the fetchImpl shape.
      fetchImpl: (url, init) => app.request(url as string, init as RequestInit),
    });

    // ── Seed: an OPEN escalation under the CLIENT author (severity null →
    // the chain lands on answer; REVISE FIX #2). ──
    const raiseRes = await authRequest(
      app,
      "POST",
      `/api/v1/projects/${project.id}/escalations`,
      {
        token: client.token,
        body: {
          kind: "question",
          title: "Why does the foo widget show stale data?",
          originRepo: "client-repo",
          originWorkerKey: "client-x",
          severity: null,
        },
      },
    );
    expect(raiseRes.status).toBe(201);
    const escId = (await raiseRes.json()).data.id as string;

    // ── Drive ONE real tick. ──
    await responderTick(
      baseDeps(responderClient, project.id, responder.user.id),
      createResponderState(),
    );

    // ── Assertion 1: the escalation is answered + held by the responder. ──
    const getRes = await authRequest(app, "GET", `/api/v1/escalations/${escId}`);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()).data;
    expect(detail.status).toBe("answered");
    expect(detail.holderId).toBe(responder.user.id);

    // ── Assertion 2: the diagnosis message exists, body matches, authored by
    // the responder (≠ the origin client author). ──
    const diag = detail.messages.find(
      (m: { body: string }) => m.body === DIAGNOSIS,
    );
    expect(diag).toBeDefined();
    expect(diag.authorId).toBe(responder.user.id);
    expect(diag.authorId).not.toBe(client.user.id);

    // ── Assertion 3: it surfaces as an undelivered directed reply for the
    // origin worker_key (the C2 delivery layer auto-notices it). ──
    const undelRes = await authRequest(
      app,
      "GET",
      `/api/v1/escalations/undelivered?worker_key=client-x`,
    );
    expect(undelRes.status).toBe(200);
    const undel = (await undelRes.json()).data;
    expect(undel).toHaveLength(1);
    expect(undel[0].escalation.id).toBe(escId);
    expect(undel[0].unreadCount).toBeGreaterThanOrEqual(1);
    const unreadBodies = undel[0].unreadMessages.map((m: { body: string }) => m.body);
    expect(unreadBodies).toContain(DIAGNOSIS);

    // ── Assertion 4: mark-delivered up to the diagnosis seq drains it. ──
    const diagSeq = diag.seq as number;
    const markRes = await authRequest(
      app,
      "POST",
      `/api/v1/escalations/${escId}/mark-delivered`,
      { body: { workerKey: "client-x", uptoSeq: diagSeq } },
    );
    expect(markRes.status).toBe(200);

    const afterRes = await authRequest(
      app,
      "GET",
      `/api/v1/escalations/undelivered?worker_key=client-x`,
    );
    expect((await afterRes.json()).data).toHaveLength(0);
  });

  it("shadow mode routes the drafted answer to a human (needs_human) — NOT answered", async () => {
    testApp = createTestApp();
    const { app, db } = testApp;
    const project = createTestProject(db);
    const responder = createTestAiAgent(db);
    const client = createTestAiAgent(db);

    const responderClient = new ResponderClient({
      baseUrl: "http://seal.test",
      token: responder.token,
      fetchImpl: (url, init) => app.request(url as string, init as RequestInit),
    });

    const raiseRes = await authRequest(
      app,
      "POST",
      `/api/v1/projects/${project.id}/escalations`,
      {
        token: client.token,
        body: {
          kind: "question",
          title: "Shadow boundary check",
          originRepo: "client-repo",
          originWorkerKey: "client-y",
          severity: null,
        },
      },
    );
    const escId = (await raiseRes.json()).data.id as string;

    await responderTick(
      baseDeps(responderClient, project.id, responder.user.id, { mode: "shadow" }),
      createResponderState(),
    );

    const getRes = await authRequest(app, "GET", `/api/v1/escalations/${escId}`);
    const detail = (await getRes.json()).data;
    // Shadow drafts → human approval: the escalation goes to needs_human, never
    // answered, and the client never receives an auto-sent diagnosis.
    expect(detail.status).toBe("needs_human");
    expect(detail.holderId).toBe(responder.user.id);
  });
});
