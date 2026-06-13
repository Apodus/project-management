import { test, expect } from "@playwright/test";
import { login, createProjectViaAPI, raiseEscalationViaAPI } from "./helpers";

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
});
