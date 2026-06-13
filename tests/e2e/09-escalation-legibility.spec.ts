import { test, expect } from "@playwright/test";
import { login, createProjectViaAPI, raiseEscalationViaAPI } from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

/**
 * Campaign C4 seal — escalation legibility, safety rails & SLAs — driven over
 * real HTTP against the built prod server. This is the legibility/safety seal
 * that closes the 4-campaign arc (C1 channel → C2 delivery → C3 responder →
 * C4 legibility): the web dashboard renders escalations, the per-escalation
 * timeline renders the thread + lifecycle, an exact-duplicate raise FOLDS
 * (merged, auto-linked — no 2nd thread / no 2nd responder), and the metrics
 * panel renders the PM-side observable responder-outcome signals.
 *
 * SLA-FIRING IS DEFERRED to the P3 unit tests: the
 * ESCALATION_SLA_BREACH_THRESHOLD_MS=1h threshold is hardcoded (non-env-tunable),
 * so the alert cannot be made to fire inside an e2e budget. The unit suite
 * covers the edge-triggered + latched alert directly.
 *
 * Everything goes through `page.request` (inherits the pm_session cookie from
 * `login`; for the full create envelope we POST directly), with DOM assertions
 * only where a render proof is needed. Spec 01 ran the setup wizard (specs run
 * serially), so we only log in here. Each test uses a UNIQUE originWorkerKey +
 * a unique title so cross-test dedup/rate-limit folding can never collide.
 *
 * Positive load-gating: heading → project badge → content, on
 * `domcontentloaded` (NOT networkidle — the SSE stream never idles), 15s for
 * first paint.
 */
test.describe("Escalation legibility (C4)", () => {
  // Unique per run so repeated local runs never fold across runs on title.
  const RUN_TAG = Date.now().toString(36);

  test("A — dashboard renders an escalation (DOM)", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN_USER, ADMIN_PASS);

    const project = await createProjectViaAPI(
      page,
      "C4 Dashboard Render Project",
    );
    const title = `E2E C4 dashboard render seal ${RUN_TAG}`;
    await raiseEscalationViaAPI(page, project.id, {
      kind: "bug_report",
      title,
      originRepo: "game_one",
      originWorkerKey: `worker-e2e-09a-${RUN_TAG}`,
      severity: "high",
    });

    await page.goto(`/projects/${project.id}/escalations`);

    // Positive load-gating: heading first, then the project badge, then content.
    // The project-name BADGE is data-slot-scoped: the name ALSO renders in the
    // header breadcrumb + the sidebar project-selector (strict-mode multi-match
    // otherwise) — the spec-06 idiom. The badge only paints once the project
    // query resolves, so it is the "page loaded" gate.
    await expect(
      page.getByRole("heading", { name: "Escalations" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-slot="badge"]', {
        hasText: "C4 Dashboard Render Project",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(title)).toBeVisible({ timeout: 30_000 });
  });

  test("B — timeline renders the thread (DOM, API-seeded)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN_USER, ADMIN_PASS);

    const project = await createProjectViaAPI(page, "C4 Timeline Render Project");
    const title = `E2E C4 timeline render seal ${RUN_TAG}`;
    const esc = await raiseEscalationViaAPI(page, project.id, {
      kind: "bug_report",
      title,
      originRepo: "game_one",
      originWorkerKey: `worker-e2e-09b-${RUN_TAG}`,
      severity: "high",
    });
    const escId = esc.id;

    // Seed the thread via the API: acknowledge (open → acknowledged) then answer
    // (acknowledged → answered; the body becomes a `diagnosis` message).
    const ackResp = await page.request.post(
      `/api/v1/escalations/${escId}/acknowledge`,
    );
    expect(ackResp.status()).toBe(200);

    const diagnosis = `diagnosis: seal ${RUN_TAG}`;
    const answerResp = await page.request.post(
      `/api/v1/escalations/${escId}/answer`,
      { data: { body: diagnosis } },
    );
    expect(answerResp.status()).toBe(200);

    await page.goto(`/projects/${project.id}/escalations/${escId}`);

    // Positive load-gating: the page <h1> is "Escalation".
    await expect(
      page.getByRole("heading", { name: "Escalation" }),
    ).toBeVisible({ timeout: 15_000 });

    // "Thread" and "Lifecycle" are CardTitle DIVS (data-slot=card-title), NOT
    // heading-role — match them with getByText (NOTE 1). Generous budgets: this
    // box runs concurrent agent sessions, so a loaded SPA can paint async-query
    // content past 10s.
    await expect(page.getByText("Thread")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Lifecycle")).toBeVisible();

    // The diagnosis body renders in the thread.
    await expect(page.getByText(diagnosis)).toBeVisible({ timeout: 30_000 });

    // The Lifecycle strip's "Answered" stage. "Answered" ALSO appears as a
    // status badge, so scope to the Lifecycle card (NOTE 2). The Lifecycle
    // CardTitle and the strip share the same Card ancestor.
    const lifecycleCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Lifecycle" });
    await expect(
      lifecycleCard.getByText("Answered", { exact: true }),
    ).toBeVisible();
  });

  test("C — FTS dedup auto-link folds a duplicate (API-level)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN_USER, ADMIN_PASS);

    const project = await createProjectViaAPI(page, "C4 Dedup Fold Project");
    const title = `E2E C4 dedup ${RUN_TAG}`;
    const body = "same body";
    const data = {
      kind: "bug_report",
      title,
      body,
      originRepo: "game_one",
      originWorkerKey: `worker-e2e-09c-${RUN_TAG}`,
    };

    // First raise → a NEW thread (merged:false).
    const firstResp = await page.request.post(
      `/api/v1/projects/${project.id}/escalations`,
      { data },
    );
    expect(firstResp.status()).toBe(201);
    const first = await firstResp.json();
    expect(first.merged).toBe(false);
    const escId1: string = first.data.id;

    // Second raise — EXACT same title + body + originRepo, both open → FOLDS
    // into the first (merged:true; mergedInto + data.id === the existing id).
    const secondResp = await page.request.post(
      `/api/v1/projects/${project.id}/escalations`,
      { data },
    );
    expect(secondResp.status()).toBe(201);
    const second = await secondResp.json();
    expect(second.merged).toBe(true);
    expect(second.mergedInto).toBe(escId1);
    expect(second.data.id).toBe(escId1);

    // No 2nd row exists: exactly ONE open escalation matches that title.
    const listResp = await page.request.get(
      `/api/v1/projects/${project.id}/escalations?status=open`,
    );
    expect(listResp.ok()).toBeTruthy();
    const list = (await listResp.json()).data as Array<{
      id: string;
      title: string;
    }>;
    const matching = list.filter((e) => e.title === title);
    expect(matching.length).toBe(1);
    expect(matching[0].id).toBe(escId1);
  });

  test("D — metrics panel renders (DOM)", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN_USER, ADMIN_PASS);

    const project = await createProjectViaAPI(page, "C4 Metrics Panel Project");
    await raiseEscalationViaAPI(page, project.id, {
      kind: "question",
      title: `E2E C4 metrics seal ${RUN_TAG}`,
      originRepo: "game_one",
      originWorkerKey: `worker-e2e-09d-${RUN_TAG}`,
      severity: "low",
    });

    await page.goto(`/projects/${project.id}/escalations`);

    // Positive load-gating: heading first, then the metric labels directly. The
    // metrics panel (useEscalationMetrics) is an async query independent of the
    // project-details query, so we gate on the metric label itself with a
    // generous first-paint budget (this box runs concurrent agent sessions, so
    // a loaded SPA can paint async-query content well past 10s) rather than on
    // the project badge, whose separate useProject query can lag further.
    await expect(
      page.getByRole("heading", { name: "Escalations" }),
    ).toBeVisible({ timeout: 15_000 });

    // The P2 metrics panel surfaces the PM-side observable responder-outcome
    // signals. We confirm the panel renders — NOT SLA-firing (deferred to P3).
    await expect(page.getByText("Open backlog")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Auto-resolve rate")).toBeVisible();
    await expect(page.getByText("Human-escalation rate")).toBeVisible();
  });
});
