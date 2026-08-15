/**
 * Campaign 2026-08-15 §R3 — a rejected merge reaches the AUTHOR'S SESSION.
 *
 * Before this, a merge outcome reached Discord and the web UI and stopped. The
 * author's agent learned nothing, so either it polled its own merge request on
 * a babysitting timer or a human read Discord and pasted the news in. The
 * delivery channel already existed — the wake daemon — and was simply scoped to
 * escalations, so a reject now raises one addressed to the submitting worker.
 *
 * The sharp assertion in this file is the WAKE-DAEMON CONTRACT: the daemon
 * delivers "messages NOT authored by the origin author". If the escalation were
 * authored by the integrator (the natural thing to write), its own notice would
 * read as self-authored, count as nothing, and wake nobody — silently. So the
 * escalation must belong to the WORKER and the notice must come from the train.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  type TestApp,
} from "../utils.js";
import { agentClaims, escalations, escalationMessages, projects } from "../../src/db/index.js";

describe("merge reject → author notification (§R3)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  /** Turn the notification on for a project (it ships OFF). */
  function enableNotify(projectId: string, on = true): void {
    testApp.db
      .update(projects)
      .set({ settings: { integrator: { notify_author_on_reject: on } } })
      .where(eq(projects.id, projectId))
      .run();
  }

  /** Give a user the KEYED claim the wake daemon polls on. */
  function bindWorkerKey(userId: string, workerKey: string): void {
    const now = new Date().toISOString();
    testApp.db
      .insert(agentClaims)
      .values({
        id: `claim-${workerKey}`,
        userId,
        claimedAt: now,
        expiresAt: now,
        heartbeatAt: now,
        workerKey,
      })
      .run();
  }

  async function submitAndReject(
    projectId: string,
    submitterToken: string,
    integratorToken: string,
    taskId?: string,
  ): Promise<string> {
    const submitted = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${projectId}/merge-requests`,
      {
        token: submitterToken,
        body: { resource: "main", branch: "feat-r3", ...(taskId ? { taskId } : {}) },
      },
    );
    expect(submitted.status).toBe(201);
    const id = (await submitted.json()).data.id as string;

    const pickup = await authRequest(testApp.app, "POST", `/api/v1/merge-requests/${id}/pickup`, {
      token: integratorToken,
    });
    expect(pickup.status).toBe(200);

    const rejected = await authRequest(testApp.app, "POST", `/api/v1/merge-requests/${id}/reject`, {
      token: integratorToken,
      body: { category: "test_failed", reason: "two tests failed in the widget suite" },
    });
    expect(rejected.status).toBe(200);
    return id;
  }

  it("raises an escalation the wake daemon can actually deliver", async () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestAiAgent(testApp.db);
    const integrator = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });
    enableNotify(project.id);
    bindWorkerKey(submitter.user.id, "worker-alpha");

    const requestId = await submitAndReject(project.id, submitter.token, integrator.token, task.id);

    const esc = testApp.db
      .select()
      .from(escalations)
      .where(eq(escalations.projectId, project.id))
      .get();
    expect(esc).toBeDefined();

    // Addressed to the worker: this is what the daemon polls on.
    expect(esc!.originWorkerKey).toBe("worker-alpha");
    // THE contract. Author = the worker, so the train's notice counts as an
    // unread directed reply. Author = the integrator would deliver NOTHING,
    // and would do it silently.
    expect(esc!.authorId).toBe(submitter.user.id);

    const messages = testApp.db
      .select()
      .from(escalationMessages)
      .where(eq(escalationMessages.escalationId, esc!.id))
      .all();
    expect(messages).toHaveLength(1);
    expect(messages[0].authorId).toBe(integrator.user.id);
    expect(messages[0].authorId).not.toBe(esc!.authorId);

    // The body has to be actionable on its own: the category, the reason, and
    // the "a resolver may already own this" caveat that stops duplicated work.
    expect(messages[0].body).toContain("test_failed");
    expect(messages[0].body).toContain("two tests failed in the widget suite");
    expect(messages[0].body).toMatch(/merge_resolution/);
    expect((messages[0].metadata as { mergeRequestId: string }).mergeRequestId).toBe(requestId);

    // Anchored to the task so it lands where the work lives.
    expect(esc!.anchorType).toBe("task");
    expect(esc!.anchorId).toBe(task.id);
  });

  it("ships OFF: no setting, no escalation", async () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestAiAgent(testApp.db);
    const integrator = createTestAiAgent(testApp.db);
    bindWorkerKey(submitter.user.id, "worker-beta");
    // deliberately NOT enabling it

    await submitAndReject(project.id, submitter.token, integrator.token);

    const escs = testApp.db.select().from(escalations).all();
    expect(escs).toHaveLength(0);
  });

  it("a submitter with no keyed claim is skipped, not half-notified", async () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestAiAgent(testApp.db);
    const integrator = createTestAiAgent(testApp.db);
    enableNotify(project.id);
    // No bindWorkerKey: nothing the daemon could poll on.

    await submitAndReject(project.id, submitter.token, integrator.token);

    // An escalation with no reachable recipient is worse than none — it would
    // sit open forever looking like unanswered work.
    const escs = testApp.db.select().from(escalations).all();
    expect(escs).toHaveLength(0);
  });

  it("the reject itself is unaffected when notification cannot run", async () => {
    const project = createTestProject(testApp.db);
    const submitter = createTestAiAgent(testApp.db);
    const integrator = createTestAiAgent(testApp.db);
    enableNotify(project.id);
    // A keyed claim pointing at a user that does not exist cannot produce a
    // deliverable escalation; the reject must still succeed.
    bindWorkerKey(submitter.user.id, "worker-gamma");

    const id = await submitAndReject(project.id, submitter.token, integrator.token);

    const got = await authRequest(testApp.app, "GET", `/api/v1/merge-requests/${id}`, {
      token: integrator.token,
    });
    expect(got.status).toBe(200);
    expect((await got.json()).data.status).toBe("rejected");
  });

  it("does not notify when the integrator is also the submitter", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    enableNotify(project.id);
    bindWorkerKey(agent.user.id, "worker-self");

    // Same actor on both ends: an escalation authored by and replied to by the
    // same user can never satisfy the unread rule, so raising one would create
    // a thread nobody is ever woken for.
    await submitAndReject(project.id, agent.token, agent.token);

    const escs = testApp.db
      .select()
      .from(escalations)
      .where(and(eq(escalations.projectId, project.id)))
      .all();
    expect(escs).toHaveLength(0);
  });
});
