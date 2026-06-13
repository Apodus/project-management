import { test, expect } from "@playwright/test";
import {
  login,
  createProjectViaAPI,
  createUserViaAPI,
  raiseEscalationViaAPI,
} from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

/**
 * Campaign C1 seal: the full escalation lifecycle driven over real HTTP against
 * the built prod server. The single admin (a human) is legal at every step
 * (raise = any authed; acknowledge/answer/resolve all permit a human), so one
 * session drives raise → acknowledge → answer → reply → resolve, then the
 * activity feed is asserted to carry the per-transition audit verbs.
 *
 * Everything goes through `page.request`, which inherits the pm_session cookie
 * from `login` — no Bearer token. Spec 01 ran the setup wizard already (specs
 * run serially), so we only log in here.
 */
test.describe("Escalation round-trip", () => {
  let projectId: string;

  test("create project via API for escalation tests", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);
    const project = await createProjectViaAPI(
      page,
      "Escalation Round-trip Test Project",
    );
    projectId = project.id;
  });

  test("full lifecycle: raise → acknowledge → answer → reply → resolve", async ({
    page,
  }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    // 1. Raise (open). originRepo/originWorkerKey are required and echoed back.
    const esc = await raiseEscalationViaAPI(page, projectId, {
      kind: "bug_report",
      title: "E2E: merge train wedged on my repo",
      originRepo: "game_one",
      originWorkerKey: "worker-e2e-08",
      severity: "high",
    });
    expect(esc.status).toBe("open");
    expect(esc.originRepo).toBe("game_one");
    expect(esc.originWorkerKey).toBe("worker-e2e-08");
    const escId = esc.id;

    // 2. Acknowledge (open → acknowledged) — the PM-side pickup.
    const ackResp = await page.request.post(
      `/api/v1/escalations/${escId}/acknowledge`,
    );
    expect(ackResp.status()).toBe(200);
    expect((await ackResp.json()).data.status).toBe("acknowledged");

    // 3. Answer (acknowledged → answered) — body appended as a `diagnosis` message.
    const answerBody = "diagnosis: the lane lock was stale; force-released it";
    const answerResp = await page.request.post(
      `/api/v1/escalations/${escId}/answer`,
      { data: { body: answerBody } },
    );
    expect(answerResp.status()).toBe(200);
    expect((await answerResp.json()).data.status).toBe("answered");

    // 4. Reply on the thread (a plain `reply` message). 201.
    const replyBody = "thanks, confirmed — my next submit landed";
    const replyResp = await page.request.post(
      `/api/v1/escalations/${escId}/messages`,
      { data: { body: replyBody } },
    );
    expect(replyResp.status()).toBe(201);

    // 5. GET the full thread: messages present, monotonic seq, the diagnosis
    //    + reply bodies present.
    const getResp = await page.request.get(`/api/v1/escalations/${escId}`);
    expect(getResp.ok()).toBeTruthy();
    const thread = (await getResp.json()).data;
    expect(Array.isArray(thread.messages)).toBeTruthy();
    expect(thread.messages.length).toBeGreaterThanOrEqual(2);

    // Monotonic 1-based seq (1, 2, ...).
    const seqs = thread.messages.map((m: { seq: number }) => m.seq);
    for (let i = 0; i < seqs.length; i++) {
      expect(seqs[i]).toBe(i + 1);
    }

    const diagnosis = thread.messages.find(
      (m: { messageType: string | null }) => m.messageType === "diagnosis",
    );
    expect(diagnosis).toBeTruthy();
    expect(diagnosis.body).toBe(answerBody);

    expect(
      thread.messages.some((m: { body: string }) => m.body === replyBody),
    ).toBeTruthy();

    // 6. Resolve (→ resolved, terminal). reason → a `system` message;
    //    resolvedBy/resolvedAt set.
    const resolveResp = await page.request.post(
      `/api/v1/escalations/${escId}/resolve`,
      { data: { reason: "fixed — lane unwedged, worker unblocked" } },
    );
    expect(resolveResp.status()).toBe(200);
    const resolved = (await resolveResp.json()).data;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedBy).toBeTruthy();
    expect(resolved.resolvedAt).toBeTruthy();

    const finalResp = await page.request.get(`/api/v1/escalations/${escId}`);
    const finalThread = (await finalResp.json()).data;
    expect(
      finalThread.messages.some(
        (m: { messageType: string | null }) => m.messageType === "system",
      ),
    ).toBeTruthy();

    // 7. The activity feed carries the per-transition audit verbs (one
    //    activity_log row per transition IS the durable audit trail).
    const activityResp = await page.request.get(
      `/api/v1/projects/${projectId}/activity?entity_type=escalation`,
    );
    expect(activityResp.ok()).toBeTruthy();
    const rows = (await activityResp.json()).data as Array<{
      action: string;
      entityId: string;
    }>;
    const actions = rows
      .filter((r) => r.entityId === escId)
      .map((r) => r.action);
    expect(actions).toContain("opened");
    expect(
      actions.some((a) =>
        ["acknowledged", "answered", "resolved"].includes(a),
      ),
    ).toBeTruthy();
  });

  /**
   * C2 §P5 delivery round-trip seal (API-level, via page.request). The reply
   * must be authored by a DIFFERENT user than the raiser (the undelivered
   * filter excludes the origin author's own messages — only a directed reply
   * counts). So: admin raises; a SECOND ai_agent user (driven by a Bearer
   * token, which the auth middleware honors ahead of the admin cookie)
   * acknowledges + answers; then the origin worker's undelivered list returns
   * the unread answer; mark-delivered advances the cursor; the next undelivered
   * read no longer carries it.
   */
  test("delivery: second-user answer → undelivered returns it → mark-delivered → empty", async ({
    page,
  }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    const project = await createProjectViaAPI(
      page,
      "Escalation Delivery Seal Project",
    );

    // A SECOND ai_agent user (the PM/holder) — its create response reveals the
    // minted apiToken (one-time). Bearer-authed below.
    const answerer = await createUserViaAPI(page, {
      username: `pm-holder-${Date.now()}`,
      displayName: "PM Holder",
    });
    expect(answerer.apiToken).toBeTruthy();
    const answererToken = answerer.apiToken!;
    const bearer = { Authorization: `Bearer ${answererToken}` };

    const WORKER_KEY = "worker-e2e-08-delivery";

    // 1. Raise (admin = author).
    const esc = await raiseEscalationViaAPI(page, project.id, {
      kind: "bug_report",
      title: "E2E delivery: my submit keeps bouncing",
      originRepo: "game_one",
      originWorkerKey: WORKER_KEY,
      severity: "high",
    });
    expect(esc.status).toBe("open");
    const escId = esc.id;

    // 2. Acknowledge as the SECOND user (Bearer overrides the admin cookie).
    const ackResp = await page.request.post(
      `/api/v1/escalations/${escId}/acknowledge`,
      { headers: bearer, data: {} },
    );
    expect(ackResp.status()).toBe(200);
    expect((await ackResp.json()).data.status).toBe("acknowledged");

    // 3. Answer as the SECOND user — its diagnosis message's authorId is the
    //    second user (≠ escalation author), so it's a DIRECTED reply.
    const answerResp = await page.request.post(
      `/api/v1/escalations/${escId}/answer`,
      { headers: bearer, data: { body: "the fix is X" } },
    );
    expect(answerResp.status()).toBe(200);
    expect((await answerResp.json()).data.status).toBe("answered");

    // 4. The origin worker's undelivered list (admin cookie) carries the unread
    //    answer; the OTHER test's worker key does NOT see this escalation.
    const undelivResp = await page.request.get(
      `/api/v1/escalations/undelivered?worker_key=${WORKER_KEY}`,
    );
    expect(undelivResp.ok()).toBeTruthy();
    const undeliv = (await undelivResp.json()).data as Array<{
      escalation: { id: string };
      unreadCount: number;
      unreadMessages: Array<{ seq: number; body: string }>;
    }>;
    const entry = undeliv.find((u) => u.escalation.id === escId);
    expect(entry).toBeTruthy();
    expect(entry!.unreadCount).toBeGreaterThanOrEqual(1);
    expect(
      entry!.unreadMessages.some((m) => m.body === "the fix is X"),
    ).toBeTruthy();

    // Isolation: the FIRST test's worker key must NOT carry this escalation.
    const otherResp = await page.request.get(
      `/api/v1/escalations/undelivered?worker_key=worker-e2e-08`,
    );
    const other = (await otherResp.json()).data as Array<{
      escalation: { id: string };
    }>;
    expect(other.some((u) => u.escalation.id === escId)).toBeFalsy();

    // 5. Advance the delivery cursor to the max unread seq.
    const uptoSeq = Math.max(...entry!.unreadMessages.map((m) => m.seq));
    const markResp = await page.request.post(
      `/api/v1/escalations/${escId}/mark-delivered`,
      { data: { workerKey: WORKER_KEY, uptoSeq } },
    );
    expect(markResp.status()).toBe(200);

    // 6. Undelivered for this worker no longer carries the escalation (cursor
    //    advanced past the answer).
    const afterResp = await page.request.get(
      `/api/v1/escalations/undelivered?worker_key=${WORKER_KEY}`,
    );
    const after = (await afterResp.json()).data as Array<{
      escalation: { id: string };
    }>;
    expect(after.some((u) => u.escalation.id === escId)).toBeFalsy();
  });
});
