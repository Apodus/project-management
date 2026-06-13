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
import { eq } from "drizzle-orm";
import { createTestApp, createTestProject, createTestAiAgent, authRequest } from "./utils.js";
import type { TestApp } from "./utils.js";
import { escalations, escalationMessages, mergeRequests } from "../src/db/schema.js";
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
import type {
  ImplementRunner,
  ImplementRunResult,
  ImplementRunInput,
} from "../../responder-ref/src/implement-runner.js";
import type { Worktree } from "../../responder-ref/src/worktree.js";
import type { InjectionSniffer, InjectionSniffResult } from "../../responder-ref/src/injection-sniffer.js";

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

// ─── A2 auto-implement land seal (Campaign A1+A2, FINAL) ──────────────
//
// The full-stack close of the auto-implement loop, driving the REAL responder
// loop's `runImplementSession` against an in-memory @pm/server over HTTP, then
// driving the REAL merge train (land/reject) over HTTP as the integrator. Only
// the LLM session + git are injected (BY DESIGN — the implement runner +
// worktree are the injectable seams; a real conflict-server test is NOT the
// contract here — the resolver propagation is covered by the integrator-ref
// unit + the server resubmission test).
//
// Chain proven:
//   - a client agent raises an OPEN escalation (severity null),
//   - the responder acknowledges + the answering session returns implement{bounded},
//   - runImplementSession submits the real escalationId-linked, task-less MR over
//     HTTP + leaves the escalation acknowledged + pendingLand,
//   - the train LANDS the MR over HTTP (integrator ai_agent) → the P2 post-back
//     fires: escalation resolved + landed_sha summary + the origin auto-notices
//     via C2 (undelivered surfaces, mark-delivered drains),
//   - the reject path (2nd it): same to submit, then reject → needs_human + the
//     reject reason + the branch (MR row) preserved.
describe("A2 auto-implement land seal", () => {
  let testApp: TestApp;
  afterEach(() => {
    testApp?.cleanup();
  });

  /** A fake isolated worktree — no real git. Scripts checkoutLocalBranch/diff/push. */
  class FakeWorktree implements Worktree {
    readonly path = "/wt/pm-implement-0";
    readonly logsDir = "/wt/logs";
    pushCalls: { remote: string; branch: string }[] = [];
    push = async (remote: string, branch: string): Promise<void> => {
      this.pushCalls.push({ remote, branch });
    };
    // Empty diff so the (empty) allowlist always passes; advisory --stat is benign.
    diff = async (args: string[]): Promise<string> => {
      if (args[0] === "--name-only") return "";
      return " src/x.ts | 2 +-\n 1 file changed";
    };
    checkoutLocalBranch = async (): Promise<void> => {};
    readonly git = {
      push: this.push,
      diff: this.diff,
      checkoutLocalBranch: this.checkoutLocalBranch,
    } as unknown as Worktree["git"];
    ensureExists = async (): Promise<void> => {};
    resetForAttempt = async (): Promise<void> => {};
    detectCorruption = async (): Promise<boolean> => false;
    repair = async (): Promise<void> => {};
  }

  /** The answering session always declares implement{bounded}. */
  class ImplementDeclaringRunner implements ResponderRunner {
    async run(_input: ResponderRunInput): Promise<ResponderRunResult> {
      return { kind: "implement", size: "bounded", rationale: "fix the foo widget", durationMs: 1 };
    }
  }

  /** The write session returns branch_ready on the pre-created branch. */
  class BranchReadyRunner implements ImplementRunner {
    async run(input: ImplementRunInput): Promise<ImplementRunResult> {
      return { kind: "branch_ready", branch: input.branch, commitSha: "implcommit", durationMs: 1 };
    }
  }

  const cleanSniffer: InjectionSniffer = {
    sniff: async (): Promise<InjectionSniffResult> => ({ kind: "clean" }),
  };

  function implementDeps(
    client: ResponderClient,
    projectId: string,
    selfId: string,
  ): ResponderDeps {
    return {
      client,
      logger: silentLogger,
      projectIds: [projectId],
      selfId,
      enabled: true,
      mode: "on",
      maxConcurrent: 10,
      runner: new ImplementDeclaringRunner(),
      autoImplementEnabled: true,
      sniffer: cleanSniffer,
      implementRunner: new BranchReadyRunner(),
      acquireWorktree: () => new FakeWorktree(),
      worktreeGit: { remote: "origin", mainBranch: "main", allowedPaths: [] },
      verifyCmd: "",
      repoCwd: "/unused",
      command: "unused",
      budget: { timeBudgetSec: 900 },
      excludeOriginRepos: [],
      reclaimGraceSec: 120,
      maxReclaimAttempts: 2,
      spawnBudget: { maxSpawns: 1000, windowSec: 3600 },
      now: () => Date.now(),
    };
  }

  /** Raise an OPEN escalation under the client author; return its id. */
  async function raiseOpen(
    app: TestApp["app"],
    projectId: string,
    clientToken: string,
    originWorkerKey: string,
  ): Promise<string> {
    const res = await authRequest(app, "POST", `/api/v1/projects/${projectId}/escalations`, {
      token: clientToken,
      body: {
        kind: "bug_report",
        title: "foo widget shows stale data",
        originRepo: "client-repo",
        originWorkerKey,
        severity: null,
      },
    });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  }

  /** Find the MR the responder submitted for this escalation (the only one). */
  function findEscalationMr(db: TestApp["db"], escId: string): { id: string; branch: string | null } {
    const row = db.select().from(mergeRequests).where(eq(mergeRequests.escalationId, escId)).get();
    expect(row).toBeTruthy();
    return { id: row!.id, branch: row!.branch };
  }

  it("client raises → assess → implement → submit MR → (train) LAND → escalation resolved + origin auto-notices via C2", async () => {
    testApp = createTestApp();
    const { app, db } = testApp;
    const project = createTestProject(db);
    const responder = createTestAiAgent(db); // the responder (holder)
    const integrator = createTestAiAgent(db); // the train lander
    const client = createTestAiAgent(db); // the origin author (DISTINCT)

    const responderClient = new ResponderClient({
      baseUrl: "http://seal.test",
      token: responder.token,
      fetchImpl: (url, init) => app.request(url as string, init as RequestInit),
    });

    const escId = await raiseOpen(app, project.id, client.token, "client-impl");

    // ── Drive ONE responder tick: assess → implement{bounded} → submit MR. ──
    await responderTick(
      implementDeps(responderClient, project.id, responder.user.id),
      createResponderState(),
    );

    // The escalation is acknowledged (held by the responder) with a pendingLand handoff.
    const afterImpl = (await (await authRequest(app, "GET", `/api/v1/escalations/${escId}`)).json()).data;
    expect(afterImpl.status).toBe("acknowledged");
    expect(afterImpl.holderId).toBe(responder.user.id);
    const handoff = afterImpl.messages.find(
      (m: { metadata?: { pendingLand?: boolean } }) => m.metadata?.pendingLand === true,
    );
    expect(handoff).toBeTruthy();

    // The real escalationId-linked, task-less MR exists.
    const mr = findEscalationMr(db, escId);
    expect(mr.branch).toBe(`pm/escalation-${escId}`);

    // ── Drive the REAL train land over HTTP (integrator ai_agent). ──
    db.update(mergeRequests)
      .set({ status: "integrating", pickedUpAt: new Date().toISOString() })
      .where(eq(mergeRequests.id, mr.id))
      .run();
    const landRes = await authRequest(app, "POST", `/api/v1/merge-requests/${mr.id}/land`, {
      token: integrator.token,
      body: { landedSha: "implLANDED" },
    });
    expect(landRes.status).toBe(200);
    expect((await landRes.json()).data.status).toBe("landed");

    // ── P2 post-back: escalation resolved by the holder + landed_sha summary. ──
    const escRow = db.select().from(escalations).where(eq(escalations.id, escId)).get();
    expect(escRow?.status).toBe("resolved");
    expect(escRow?.resolvedBy).toBe(responder.user.id);
    const msgs = db
      .select()
      .from(escalationMessages)
      .where(eq(escalationMessages.escalationId, escId))
      .all();
    expect(msgs.some((m) => m.body.includes("implLANDED") && m.body.includes(mr.id))).toBe(true);

    // ── C2: the origin auto-notices the holder-authored landed summary. ──
    const undel = (
      await (
        await authRequest(app, "GET", `/api/v1/escalations/undelivered?worker_key=client-impl`)
      ).json()
    ).data;
    const entry = undel.find((u: { escalation: { id: string } }) => u.escalation.id === escId);
    expect(entry).toBeTruthy();
    const landedMsg = entry.unreadMessages.find((m: { body: string; seq: number }) =>
      m.body.includes("implLANDED"),
    );
    expect(landedMsg).toBeTruthy();

    // mark-delivered up to the HIGHEST unread seq drains the thread (the land
    // post-back authors BOTH a holder summary AND a system resolution message;
    // draining requires advancing the watermark past the last of them).
    const maxUnreadSeq = Math.max(
      ...entry.unreadMessages.map((m: { seq: number }) => m.seq),
    );
    const markRes = await authRequest(app, "POST", `/api/v1/escalations/${escId}/mark-delivered`, {
      body: { workerKey: "client-impl", uptoSeq: maxUnreadSeq },
    });
    expect(markRes.status).toBe(200);
    const after = (
      await (
        await authRequest(app, "GET", `/api/v1/escalations/undelivered?worker_key=client-impl`)
      ).json()
    ).data;
    expect(after.find((u: { escalation: { id: string } }) => u.escalation.id === escId)).toBeFalsy();
  });

  it("reject path: client raises → implement → submit MR → (train) REJECT → escalation needs_human + branch preserved", async () => {
    testApp = createTestApp();
    const { app, db } = testApp;
    const project = createTestProject(db);
    const responder = createTestAiAgent(db);
    const integrator = createTestAiAgent(db);
    const client = createTestAiAgent(db);

    const responderClient = new ResponderClient({
      baseUrl: "http://seal.test",
      token: responder.token,
      fetchImpl: (url, init) => app.request(url as string, init as RequestInit),
    });

    const escId = await raiseOpen(app, project.id, client.token, "client-rej");

    await responderTick(
      implementDeps(responderClient, project.id, responder.user.id),
      createResponderState(),
    );

    const mr = findEscalationMr(db, escId);
    expect(mr.branch).toBe(`pm/escalation-${escId}`);

    // ── Drive the REAL train REJECT over HTTP (verify-fail category). ──
    db.update(mergeRequests)
      .set({ status: "integrating", pickedUpAt: new Date().toISOString() })
      .where(eq(mergeRequests.id, mr.id))
      .run();
    const rejRes = await authRequest(app, "POST", `/api/v1/merge-requests/${mr.id}/reject`, {
      token: integrator.token,
      body: { category: "test_failed", reason: "verify red: 2 failing", logUrl: "https://ex/log" },
    });
    expect(rejRes.status).toBe(200);
    expect((await rejRes.json()).data.status).toBe("rejected");

    // ── P3 post-back: escalation → needs_human with the reject reason. ──
    const escRow = db.select().from(escalations).where(eq(escalations.id, escId)).get();
    expect(escRow?.status).toBe("needs_human");
    const msgs = db
      .select()
      .from(escalationMessages)
      .where(eq(escalationMessages.escalationId, escId))
      .all();
    expect(msgs.some((m) => m.messageType === "system" && m.body.includes("verify red"))).toBe(true);

    // The MR row + its branch ref are untouched (no proven work discarded).
    const mrRow = db.select().from(mergeRequests).where(eq(mergeRequests.id, mr.id)).get();
    expect(mrRow?.branch).toBe(`pm/escalation-${escId}`);
  });
});

// ─── A2 no-recursion lock (responder seed gate) ──────────────────────
//
// The seed gate seeds ONLY status==="open" escalations not authored by self
// (loop.ts:863). A resolved (client-authored) escalation, a needs_human one,
// and a pendingLand acknowledged self-held STALE one are all NOT re-spawned —
// the structural no-recursion seal (no new guard). These lock that the
// responder never re-engages a terminal/handed-off escalation.
describe("A2 no-recursion lock", () => {
  let testApp: TestApp;
  afterEach(() => {
    testApp?.cleanup();
  });

  function noopImplementDeps(
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
      mode: "on",
      maxConcurrent: 10,
      runner: { run: async () => ({ kind: "give_up", reason: "noop", durationMs: 0 }) },
      autoImplementEnabled: true,
      sniffer: { sniff: async () => ({ kind: "clean" }) },
      implementRunner: { run: async () => ({ kind: "give_up", reason: "noop", durationMs: 0 }) },
      acquireWorktree: () => {
        throw new Error("acquireWorktree must NOT be called (no implement spawn expected)");
      },
      worktreeGit: { remote: "origin", mainBranch: "main", allowedPaths: [] },
      verifyCmd: "",
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

  /** Seed an escalation in a given terminal/non-open status authored by `authorId`. */
  function seedEscalation(
    db: TestApp["db"],
    projectId: string,
    status: "resolved" | "needs_human" | "acknowledged",
    authorId: string,
    holderId: string | null,
    updatedAt: string,
    withPendingLand = false,
  ): string {
    const id = `esc-${Math.random().toString(36).slice(2, 10)}`;
    const ts = new Date().toISOString();
    db.insert(escalations)
      .values({
        id,
        projectId,
        kind: "bug_report",
        status,
        title: "lock me",
        originRepo: "client-repo",
        originWorkerKey: "client-lock",
        holderId,
        authorId,
        resolvedBy: status === "resolved" ? holderId : null,
        resolvedAt: status === "resolved" ? ts : null,
        createdAt: ts,
        updatedAt,
      })
      .run();
    if (withPendingLand) {
      db.insert(escalationMessages)
        .values({
          id: `msg-${Math.random().toString(36).slice(2, 10)}`,
          escalationId: id,
          seq: 1,
          authorId: holderId,
          messageType: "diagnosis",
          body: "Submitted MR; pending land (A2).",
          metadata: { pendingLand: true, mergeRequestId: "mr-x" },
          createdAt: ts,
        })
        .run();
    }
    return id;
  }

  it("a resolved (client-authored) escalation is NOT seeded — responderTick does not claim/spawn", async () => {
    testApp = createTestApp();
    const { app, db } = testApp;
    const project = createTestProject(db);
    const responder = createTestAiAgent(db);
    const client = createTestAiAgent(db);

    const escId = seedEscalation(
      db,
      project.id,
      "resolved",
      client.user.id,
      responder.user.id,
      new Date().toISOString(),
    );

    const responderClient = new ResponderClient({
      baseUrl: "http://seal.test",
      token: responder.token,
      fetchImpl: (url, init) => app.request(url as string, init as RequestInit),
    });

    // acquireWorktree throws if reached — a tick that stays inert proves no spawn.
    await responderTick(
      noopImplementDeps(responderClient, project.id, responder.user.id),
      createResponderState(),
    );

    // Unchanged: still resolved, no new messages beyond what was seeded (none).
    const escRow = db.select().from(escalations).where(eq(escalations.id, escId)).get();
    expect(escRow?.status).toBe("resolved");
  });

  it("a needs_human escalation is NOT seeded (seed gate is status==='open' only)", async () => {
    testApp = createTestApp();
    const { app, db } = testApp;
    const project = createTestProject(db);
    const responder = createTestAiAgent(db);
    const client = createTestAiAgent(db);

    const escId = seedEscalation(
      db,
      project.id,
      "needs_human",
      client.user.id,
      null,
      new Date().toISOString(),
    );

    const responderClient = new ResponderClient({
      baseUrl: "http://seal.test",
      token: responder.token,
      fetchImpl: (url, init) => app.request(url as string, init as RequestInit),
    });

    await responderTick(
      noopImplementDeps(responderClient, project.id, responder.user.id),
      createResponderState(),
    );

    const escRow = db.select().from(escalations).where(eq(escalations.id, escId)).get();
    expect(escRow?.status).toBe("needs_human");
  });

  it("a pendingLand acknowledged self-held STALE escalation is reclaim-skipped (no re-spawn)", async () => {
    testApp = createTestApp();
    const { app, db } = testApp;
    const project = createTestProject(db);
    const responder = createTestAiAgent(db);
    const client = createTestAiAgent(db);

    // updatedAt far in the past so it is STALE past timeBudgetSec + grace.
    const stale = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
    const escId = seedEscalation(
      db,
      project.id,
      "acknowledged",
      client.user.id,
      responder.user.id,
      stale,
      true, // pendingLand marker
    );

    const responderClient = new ResponderClient({
      baseUrl: "http://seal.test",
      token: responder.token,
      fetchImpl: (url, init) => app.request(url as string, init as RequestInit),
    });

    // acquireWorktree throws if a respawn occurs; the reclaim pending-land probe
    // must SKIP it. A clean tick proves the skip.
    await responderTick(
      noopImplementDeps(responderClient, project.id, responder.user.id),
      createResponderState(),
    );

    // Still acknowledged; only the seeded handoff message exists (no re-spawn output).
    const escRow = db.select().from(escalations).where(eq(escalations.id, escId)).get();
    expect(escRow?.status).toBe("acknowledged");
    const msgs = db
      .select()
      .from(escalationMessages)
      .where(eq(escalationMessages.escalationId, escId))
      .all();
    expect(msgs.length).toBe(1);
  });
});
