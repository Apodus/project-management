import { test, expect, type Locator, type Page } from "@playwright/test";
import { login, createProjectViaAPI, createTaskViaAPI, createUserViaAPI } from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

// Unique per run so repeated local runs never collide on usernames.
const RUN_TAG = Date.now().toString(36);

/**
 * Campaign 2026-08-03 seal — "where the time goes" (§P4) + the lane event
 * trace (§P5).
 *
 * WHAT THIS SPEC IS FOR. The campaign's whole point is that the train stops
 * lying about its own clock: a phase it never measured is ABSENT rather than
 * zero, a share is "of measured phase time" rather than "of elapsed", and the
 * phase a member is running RIGHT NOW is deliberately unnamed. Those are
 * statements the page makes in prose, and prose is exactly what a unit test
 * asserting a payload shape cannot protect. So the two states asserted here are
 * the two an operator actually meets:
 *
 *   1. UN-INSTRUMENTED — the lane has trips but the integrator has not been
 *      redeployed with §P2's emitters. PM still derives `queue_wait` from
 *      timestamps it already owns, so the panel shows exactly that one phase and
 *      NAMES the six it did not observe, and the trace renders its lifecycle
 *      rows under a footer explaining why they carry no durations. This is the
 *      state every existing deployment is in until the bundle ships, so it has
 *      to be correct, not merely non-crashing.
 *
 *   2. INSTRUMENTED — observed rows exist. Bars, percentiles, in-flight phase
 *      chips, and durations in the trace.
 *
 * HOW STATE 2 IS SEEDED, and why not through the UI: there is no UI that mints a
 * phase row, and there must not be — the only writer is the integrator, over the
 * ai_agent-gated ingest. So the spec drives that REAL endpoint with a REAL
 * Bearer token (the spec ACTS AS the daemon; no daemon process, no git). Faking
 * rows any other way would seal a path production never takes.
 *
 * The ingest ack is asserted too: `adjusted: 0` is the contract that nothing in
 * the payload had to be normalized, and a non-zero value means the EMITTER is
 * wrong. Asserting it here keeps this spec honest about seeding clean data.
 *
 * Self-contained like spec 06 — depends only on 01's admin.
 */

/** The lane every merge_requests row defaults to. */
const LANE = "main";

interface SeededTrip {
  projectId: string;
  requestId: string;
}

/**
 * A project with one merge request that the train has PICKED UP.
 *
 * A WORKER submits (any authenticated user may — here the admin session), but
 * only the INTEGRATOR may pick up: `transitionToIntegrating` 403s a non-ai_agent
 * actor, so the pickup goes over the Bearer token. That asymmetry is the real
 * train contract and the spec honours it rather than routing around it.
 *
 * Pickup is what makes the trip observable at all: it sets `picked_up_at`, which
 * ends the derived `queue_wait` and anchors the in-flight "unrecorded" chip.
 */
async function seedPickedUpTrip(
  page: Page,
  projectName: string,
  integratorToken: string,
): Promise<SeededTrip> {
  const project = await createProjectViaAPI(page, projectName);
  const task = await createTaskViaAPI(page, project.id, {
    title: `Phase timing subject ${RUN_TAG}`,
    type: "chore",
  });

  const submit = await page.request.post(`/api/v1/projects/${project.id}/merge-requests`, {
    data: {
      resource: LANE,
      taskId: task.id,
      branch: `feat/phase-timing-${RUN_TAG}`,
      commitSha: "0".repeat(40),
    },
  });
  if (submit.status() !== 201) {
    throw new Error(`submit merge request -> ${submit.status()} ${await submit.text()}`);
  }
  const requestId = (await submit.json()).data.id as string;

  const pickup = await page.request.post(`/api/v1/merge-requests/${requestId}/pickup`, {
    headers: { Authorization: `Bearer ${integratorToken}` },
    data: {},
  });
  if (!pickup.ok()) {
    throw new Error(`pickup ${requestId} -> ${pickup.status()} ${await pickup.text()}`);
  }

  return { projectId: project.id, requestId };
}

/** Mint an ai_agent and return its one-time API token — the integrator identity. */
async function mintIntegratorToken(page: Page, suffix: string): Promise<string> {
  const agent = await createUserViaAPI(page, {
    username: `integrator-${suffix}-${RUN_TAG}`,
    displayName: `Integrator ${suffix}`,
  });
  expect(agent.apiToken).toBeTruthy();
  return agent.apiToken!;
}

/**
 * SERVER TRUTH FIRST, then the UI — the spec-07 idiom.
 *
 * The panel's numbers are an ON-READ aggregate: they exist the instant the rows
 * do, with no job to wait for. So polling the metrics GET until the aggregate
 * reports the expected sample count separates two failures that otherwise look
 * identical at the DOM: "the server never counted this" (a real defect) and
 * "the page has not painted yet" (this box, at the tail of a 14-minute suite,
 * under an already-documented CPU load — see playwright.config.ts's 60s budget).
 *
 * Returns the phase names the window aggregated, so a caller can assert the
 * absence list is derived from real absence rather than from a slow render.
 */
async function waitForPhaseSamples(
  page: Page,
  projectId: string,
  expectedSamples: number,
): Promise<string[]> {
  let phases: string[] = [];
  await expect
    .poll(
      async () => {
        const resp = await page.request.get(`/api/v1/projects/${projectId}/train/metrics`);
        if (!resp.ok()) return -1;
        const timing = (await resp.json()).data.phase_timing as {
          window: { sample_size: number; phases: { phase: string }[] };
        };
        phases = timing.window.phases.map((p) => p.phase);
        return timing.window.sample_size;
      },
      { timeout: 20_000, intervals: [250, 500, 1000] },
    )
    .toBe(expectedSamples);
  return phases;
}

/**
 * The train dashboard fires ~8 parallel queries behind Chrome's per-host socket
 * limit, and this spec runs LAST in the suite. A first paint that takes longer
 * than the 5s default is slowness, not breakage — the assertions below still
 * fail (just later) if the app is actually wrong, which is exactly the trade the
 * repo already made with its 60s per-test budget.
 */
const PAINT = { timeout: 30_000 };

/**
 * Open the train page and wait for a locator that only exists once the data
 * arrived, re-navigating if it does not.
 *
 * WHY THE PAINT BUDGET IS SO LARGE, AND WHY THERE IS A RETRY AT ALL. The server
 * side is already proven before this is called: waitForPhaseSamples polls the
 * very aggregate this panel renders and returns in milliseconds — over
 * `page.request`, which is Node-side and bypasses the browser entirely. So when
 * the page nonetheless sits in its loading state, the bottleneck is the BROWSER,
 * not PM. This spec runs last, directly after the suite's heaviest file, on a
 * box the repo already documents as running concurrent agent sessions whose CPU
 * spikes slow a full SPA load (playwright.config.ts's 60s budget comment). The
 * retry covers the case where a navigation lands in the middle of such a spike.
 *
 * None of this weakens an assertion: every check after this runs against a page
 * that genuinely painted, and a real defect still fails both attempts.
 *
 * Pass the first locator that proves the DATA arrived, NOT the card itself: a
 * card renders its header while its query is still pending, so the header only
 * proves the route mounted.
 */
async function openTrainPage(page: Page, projectId: string, dataMark: Locator): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto(`/projects/${projectId}/train`);
    await expect(page.getByRole("heading", { name: "Merge Train" })).toBeVisible(PAINT);
    try {
      await expect(dataMark).toBeVisible(PAINT);
      return;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

test.describe("Train phase timing + event trace", () => {
  test("un-instrumented lane: only the derived phase, the rest named as not observed", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN_USER, ADMIN_PASS);

    const token = await mintIntegratorToken(page, "bare");
    const { projectId } = await seedPickedUpTrip(page, `Phase Timing Bare ${RUN_TAG}`, token);

    // Server truth: EXACTLY one sample, and it is the derived wait. Nothing was
    // ingested, so this is the aggregate proving "absent" is real absence.
    expect(await waitForPhaseSamples(page, projectId, 1)).toEqual(["queue_wait"]);

    // ── The panel ────────────────────────────────────────────────
    const panel = page.locator('[data-slot="card"]', { hasText: /Where the time goes/ });
    // Queue wait is DERIVED — PM computes it from enqueued_at → picked_up_at, so
    // it exists on a lane whose daemon has never emitted anything. It is also
    // the first cell the panel can only render from real data, so it is the
    // page's paint mark.
    await openTrainPage(page, projectId, panel.getByRole("cell", { name: "Queue wait" }));

    // The denominator is stated on the card, and it is NOT "% of elapsed".
    await expect(panel.getByText("Share of measured phase time · last 24 h")).toBeVisible();

    // …and the six phases only the integrator can see are listed as ABSENT, by
    // name, rather than rendered as a row of zeros. This sentence IS the
    // "absent ≠ zero" contract, surfaced.
    const absent = panel.getByText(/Not observed in the last 24 h:/);
    await expect(absent).toBeVisible();
    await expect(absent).toContainText("Assemble");
    await expect(absent).toContainText("Materialize");
    await expect(absent).toContainText("Rebase");
    await expect(absent).toContainText("Verify");
    await expect(absent).toContainText("Land");
    await expect(absent).toContainText("left out rather than shown as zero");

    // The overlap disclosure — the reason a share can exceed a trip's own wall
    // clock, spelled out rather than left for the reader to discover.
    await expect(
      panel.getByText(/Share is of summed phase time, not elapsed wall clock/),
    ).toBeVisible();

    // ── In flight ────────────────────────────────────────────────
    const inFlight = page.locator('[data-slot="card"]', { hasText: /In Flight/ });
    await expect(inFlight.getByRole("columnheader", { name: "Phase progress" })).toBeVisible(PAINT);
    // The completed-phases-only contract, stated on the page.
    await expect(
      inFlight.getByText(/the one a member is running right now is deliberately unnamed/),
    ).toBeVisible();

    // ── The trace ────────────────────────────────────────────────
    const trace = page.locator('[data-slot="card"]', { hasText: /Recent events/ });
    await expect(trace).toBeVisible();
    // Lifecycle rows exist even with zero phase records — pickup is read off the
    // merge_requests row, not off the telemetry.
    await expect(trace.getByTestId("trace-row").first()).toBeVisible(PAINT);
    await expect(trace.getByText("Picked up").first()).toBeVisible();
    // The degraded-state footer: complete events, no durations, and WHY.
    await expect(
      trace.getByText(/Durations appear once the integrator reports phase boundaries/),
    ).toBeVisible();
    // A quiet lane and a broken feed must never look alike; neither empty nor
    // error state may be showing here.
    await expect(trace.getByTestId("trace-empty")).toHaveCount(0);
    await expect(trace.getByTestId("trace-error")).toHaveCount(0);
  });

  test("instrumented lane: ingested phases become bars, chips and durations", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN_USER, ADMIN_PASS);

    const token = await mintIntegratorToken(page, "phases");
    const { projectId, requestId } = await seedPickedUpTrip(
      page,
      `Phase Timing Live ${RUN_TAG}`,
      token,
    );

    // A trip that started 10 minutes ago and has 5m15s of RECORDED phases, so
    // the remainder is genuinely unaccounted-for and the in-flight cell has an
    // honest "unrecorded" tail to show.
    const start = Date.now() - 10 * 60_000;
    const at = (offsetMs: number) => new Date(start + offsetMs).toISOString();

    const ingest = await page.request.post(`/api/v1/projects/${projectId}/merge-phases`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        resource: LANE,
        phases: [
          { phase: "assemble", startedAt: at(0), durationMs: 45_000, requestId },
          { phase: "rebase", startedAt: at(45_000), durationMs: 30_000, requestId },
          // label: null is game_one's shape — ONE opaque `pm-verify.bat`. PM
          // cannot see inside a single shell command, so there must be no
          // breakdown offered for it.
          { phase: "verify", startedAt: at(75_000), durationMs: 240_000, requestId, label: null },
        ],
      },
    });
    // 202, not 201: telemetry is ACCEPTED, never transacted with.
    expect(ingest.status()).toBe(202);
    // `adjusted: 0` — nothing in the payload had to be normalized. A non-zero
    // value is the signal that the emitter is wrong.
    expect((await ingest.json()).data).toEqual({ recorded: 3, adjusted: 0 });

    // Server truth: the derived wait PLUS the three ingested phases, in pipeline
    // order — so what follows tests the RENDER of a known aggregate rather than
    // racing the aggregate itself.
    expect(await waitForPhaseSamples(page, projectId, 4)).toEqual([
      "queue_wait",
      "assemble",
      "rebase",
      "verify",
    ]);

    // ── The panel ────────────────────────────────────────────────
    const panel = page.locator('[data-slot="card"]', { hasText: /Where the time goes/ });
    await openTrainPage(page, projectId, panel.getByRole("cell", { name: "Assemble" }));
    await expect(panel.getByRole("cell", { name: "Rebase" })).toBeVisible();
    await expect(panel.getByRole("cell", { name: "Verify" })).toBeVisible();
    // Verify's p50 of the single sample, rendered as a duration and not as a
    // raw millisecond count.
    await expect(panel.getByRole("cell", { name: "4m 0s", exact: true }).first()).toBeVisible();

    // The share bar exists and is one segment per MEASURED phase.
    await expect(panel.getByTestId("phase-segment").first()).toBeVisible();

    // Absence is still reported — for exactly the phases this trip never
    // entered, and no longer for the ones it did.
    const absent = panel.getByText(/Not observed in the last 24 h:/);
    await expect(absent).toContainText("Materialize");
    await expect(absent).toContainText("Land");
    await expect(absent).not.toContainText("Verify");

    // DEGRADE HONESTLY: an unlabelled verify offers no drill-down, and the panel
    // says so rather than mounting an empty disclosure.
    await expect(panel.getByText(/Verify ran as one unlabelled step in this window/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Verify step breakdown" })).toHaveCount(0);

    // ── In flight: completed phases as chips, plus the honest tail ─
    const inFlight = page.locator('[data-slot="card"]', { hasText: /In Flight/ });
    const row = inFlight.getByRole("row").filter({ hasText: `Phase timing subject ${RUN_TAG}` });
    await expect(row.getByText("Verify", { exact: false }).first()).toBeVisible(PAINT);
    await expect(row.getByText(/unrecorded/)).toBeVisible();

    // ── The trace: the same rows, with durations ─────────────────
    const trace = page.locator('[data-slot="card"]', { hasText: /Recent events/ });
    await expect(trace.getByTestId("trace-row").first()).toBeVisible(PAINT);
    // `took` is the sentence for a `phase` elapsed — never for a since-pickup
    // number, which is the union the renderer exists to keep apart.
    await expect(trace.getByText("took 4m 0s")).toBeVisible();
    // …and with phase rows present, the "no durations yet" footer is gone.
    await expect(
      trace.getByText(/Durations appear once the integrator reports phase boundaries/),
    ).toHaveCount(0);

    // The per-request phase trace behind the chips, asserted at the API so a
    // rendering change cannot quietly drop the derived head. queue_wait first
    // (it ends at pickup, and nothing observable precedes pickup), then the
    // three ingested rows in started_at order.
    const phases = await page.request.get(`/api/v1/merge-requests/${requestId}/phases`);
    expect(phases.ok()).toBeTruthy();
    const entries = (await phases.json()).data as Array<{ phase: string; derived: boolean }>;
    expect(entries.map((e) => e.phase)).toEqual(["queue_wait", "assemble", "rebase", "verify"]);
    // `derived` is a real BOOLEAN on the wire, not the string "true" — the P1
    // discriminator defect P4 fixed by dropping the OpenAPI discriminator.
    expect(entries.map((e) => e.derived)).toEqual([true, false, false, false]);
  });
});
