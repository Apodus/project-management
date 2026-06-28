import { test, expect, type Page } from "@playwright/test";
import {
  login,
  createProjectViaAPI,
  createNoteViaAPI,
  promoteNoteToProposalViaAPI,
  claimProposalViaAPI,
  implementProposalViaAPI,
  dismissNoteViaAPI,
  flagNeedsHumanViaAPI,
  getNoteViaAPI,
  listTasksViaAPI,
  recordTriageDecisionViaAPI,
  listTriageDecisionsViaAPI,
  setNotesTriageModeViaAPI,
} from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

/**
 * Notes-triage loop seal (T3·P5).
 *
 * Proves the durable notes-triage server + web contract end-to-end through a
 * REAL browser against a REAL prod server, with the triage decisions driven
 * over HTTP — the e2e ACTS AS the triage agent (NO real claude, NO daemon
 * process). The daemon loop itself is sealed separately by
 * packages/triager-ref/tests/e2e.test.ts (fake client + scripted verdicts);
 * this spec does NOT duplicate that.
 *
 * LAYERING NOTE: the admin is a human, so `mode` does NOT gate the admin's
 * server-side mutations (the mode gate lives in the daemon's executor, not the
 * REST surface). Server-enforced shadow-immutability is therefore T2's seal.
 * The shadow/on assertions here seal WEB + DASHBOARD reflection + side-log
 * recording: a shadow decision recorded with no mutation leaves the note open
 * and surfaces in the dashboard; an on decision paired with a real mutation
 * moves the note.
 */
// SERIAL: these tests share one project (created in the first test) and the
// dashboard scenario (F) asserts the decision mix ACCUMULATED across A–E. Serial
// mode pins them to one worker in order so the shared module state holds — and,
// critically, avoids Playwright's default "restart the worker after a failure"
// behavior silently wiping `projectId` for the tests that follow a failure.
test.describe.configure({ mode: "serial" });

test.describe("Notes triage seal", () => {
  let projectId: string;

  // Generous timeout for navigation-gated visibility (heading / first card /
  // dashboard cards). This box runs concurrent agent sessions whose CPU spikes
  // can push a fresh SPA load + data-query render past the 5s default — the same
  // reason the suite's per-test budget is 60s. It only raises the worst case; a
  // genuinely missing element still fails (just later).
  const LOAD = 30_000;

  // Read a dashboard MetricCard's numeric value by its testid.
  async function metricValue(page: Page, testid: string): Promise<number> {
    const card = page.getByTestId(testid);
    await expect(card).toBeVisible({ timeout: LOAD });
    const text = await card.locator("p.text-2xl").first().textContent();
    return parseInt((text ?? "0").trim(), 10);
  }

  test("create project via API for the triage seal", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);
    const project = await createProjectViaAPI(page, "Notes Triage Seal Project");
    projectId = project.id;
  });

  // ── Scenario A — fast-track: note → proposal[fast_track] → claim → implement → tasks ──
  test("A: fast-track promote mints tasks ONLY through the proposal (gate intact)", async ({
    page,
  }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);
    // Title/body deliberately avoid the word "fast-track" so the only match for
    // the "Fast-track" badge in the card is the badge itself.
    const title = `T3P5 promote-ft ${Date.now()}-A`;

    const note = await createNoteViaAPI(page, projectId, {
      kind: "bug",
      title,
      body: "A tightly-scoped fix worth promoting.",
    });

    // Promote into a fast_track proposal (the ONLY note→proposal path).
    const { note: promotedNote, proposal } = await promoteNoteToProposalViaAPI(page, note.id, {
      title: `${title} (proposal)`,
      proposalKind: "fast_track",
    });
    expect(proposal.proposalKind).toBe("fast_track");
    expect(proposal.sourceNoteId).toBe(note.id);
    expect(promotedNote.status).toBe("triaged");
    expect(promotedNote.triageOutcome).toBe("promoted");
    expect(promotedNote.promotedProposalId).toBe(proposal.id);

    // Record the decision AFTER promote so the row carries the proposal id —
    // matching the daemon executor's order.
    await recordTriageDecisionViaAPI(page, projectId, {
      noteId: note.id,
      mode: "on",
      decision: "promote_fast_track",
      rationale: "scoped fix — fast-track",
      resultingProposalId: proposal.id,
    });

    // Claim + implement: the proposal-gate materialization step.
    const claim = await claimProposalViaAPI(page, proposal.id);
    expect(claim.ok).toBeTruthy();

    await implementProposalViaAPI(page, proposal.id, {
      epics: [{ name: "E1" }],
      tasks: [{ title: "T1" }, { title: "T2", epicIndex: 0 }],
    });

    // R1: assert the chain via promotedProposalId AND that the minted tasks
    // carry proposalId === proposal.id (NOT sourceNoteId — implementProposal
    // sets proposalId/epicId only). This proves tasks are minted exclusively
    // through the proposal: the note→task gate is intact.
    const tasks = await listTasksViaAPI(page, projectId);
    const proposalTasks = tasks.filter((t) => t.proposalId === proposal.id);
    expect(proposalTasks.length).toBe(2);
    for (const t of proposalTasks) {
      expect(t.proposalId).toBe(proposal.id);
      expect(t.sourceNoteId).toBeNull();
    }

    // Web: the inbox card reflects fast-track promotion.
    await page.goto(`/projects/${projectId}/notes`);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible({ timeout: LOAD });
    const card = page.getByTestId(`note-card-${note.id}`);
    await expect(card).toBeVisible({ timeout: LOAD });
    await expect(card.getByText("Fast-track", { exact: true })).toBeVisible();
    await expect(card.getByText("Triaged · Promoted")).toBeVisible();

    // Detail dialog → audit feed shows the promote_fast_track decision row.
    await card.getByRole("button", { name: title }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: LOAD });
    await expect(dialog.getByText("Triage history")).toBeVisible({ timeout: LOAD });
    await expect(dialog.getByText("Promote Fast Track")).toBeVisible({ timeout: LOAD });
  });

  // ── Scenario B — needs_human queue ──
  test("B: flag-needs-human routes a note to the needs_human lane", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);
    const nonce = Date.now();
    const flaggedTitle = `T3P5 needs-human ${nonce}-B`;
    const openTitle = `T3P5 still-open ${nonce}-B2`;

    const flagged = await createNoteViaAPI(page, projectId, {
      kind: "question",
      title: flaggedTitle,
      body: "Needs a human call.",
    });
    // A second, NON-flagged open note: it must NOT appear under the filter.
    const stillOpen = await createNoteViaAPI(page, projectId, {
      kind: "idea",
      title: openTitle,
    });

    const after = await flagNeedsHumanViaAPI(page, flagged.id);
    expect(after.status).toBe("needs_human");
    await recordTriageDecisionViaAPI(page, projectId, {
      noteId: flagged.id,
      mode: "on",
      decision: "needs_human",
      rationale: "ambiguous — punting to a human",
    });

    // Web: the needs_human filter shows the flagged note (+ badge) and excludes
    // the still-open one.
    await page.goto(`/projects/${projectId}/notes?status=needs_human`);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible({ timeout: LOAD });
    const flaggedCard = page.getByTestId(`note-card-${flagged.id}`);
    await expect(flaggedCard).toBeVisible({ timeout: LOAD });
    await expect(flaggedCard.getByText("Needs Human")).toBeVisible();
    await expect(page.getByTestId(`note-card-${stillOpen.id}`)).toHaveCount(0);
  });

  // ── Scenario C — dismiss terminal ──
  test("C: dismiss terminally triages a note with a reason", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);
    const title = `T3P5 dismiss ${Date.now()}-C`;
    const reason = "not reproducible; out of scope";

    const note = await createNoteViaAPI(page, projectId, {
      kind: "wtf",
      title,
      body: "Probably noise.",
    });

    const dismissed = await dismissNoteViaAPI(page, note.id, reason);
    expect(dismissed.status).toBe("triaged");
    expect(dismissed.triageOutcome).toBe("dismissed");
    expect(dismissed.triageReason).toBe(reason);
    await recordTriageDecisionViaAPI(page, projectId, {
      noteId: note.id,
      mode: "on",
      decision: "dismiss",
      rationale: reason,
    });

    // Web: card shows the dismissed badge; detail shows the reason + audit row.
    await page.goto(`/projects/${projectId}/notes`);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible({ timeout: LOAD });
    const card = page.getByTestId(`note-card-${note.id}`);
    await expect(card).toBeVisible({ timeout: LOAD });
    await expect(card.getByText("Triaged · Dismissed")).toBeVisible();

    await card.getByRole("button", { name: title }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: LOAD });
    await expect(dialog.getByText(reason)).toBeVisible({ timeout: LOAD });
    await expect(dialog.getByText("Dismiss", { exact: true })).toBeVisible({ timeout: LOAD });
  });

  // ── Scenario D — reopen via UI ──
  test("D: a human reopens a dismissed note from the inbox", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);
    // Title avoids the word "reopen" so the Reopen button locator (a substring
    // role-name match) does not also match the title button.
    const title = `T3P5 undismiss ${Date.now()}-D`;

    const note = await createNoteViaAPI(page, projectId, {
      kind: "bug",
      title,
      body: "Dismissed then brought back.",
    });
    await dismissNoteViaAPI(page, note.id, "premature dismiss");

    await page.goto(`/projects/${projectId}/notes`);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible({ timeout: LOAD });
    const card = page.getByTestId(`note-card-${note.id}`);
    await expect(card).toBeVisible({ timeout: LOAD });
    await expect(card.getByText("Triaged · Dismissed")).toBeVisible();

    // Reopen via the detail dialog (human-only — admin is human). The dialog is
    // a stable portaled modal, so its Reopen click reliably fires the mutation —
    // unlike the inline list-card button, whose host re-renders on the list
    // refetch can race the click. Gate on the success toast so the assertion
    // that follows is decoupled from invalidation timing.
    await card.getByRole("button", { name: title }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: LOAD });
    await dialog.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(page.getByText("Note reopened")).toBeVisible({ timeout: LOAD });

    // Card flips to Open + the Reopen action disappears.
    await expect(card.getByText("Open", { exact: true })).toBeVisible({ timeout: LOAD });
    await expect(card.getByRole("button", { name: "Reopen", exact: true })).toHaveCount(0);

    // API read-back: status open + triage metadata cleared.
    const reopened = await getNoteViaAPI(page, note.id);
    expect(reopened.status).toBe("open");
    expect(reopened.triageOutcome).toBeNull();
    expect(reopened.triageReason).toBeNull();
    expect(reopened.triagedBy).toBeNull();
  });

  // ── Scenario E — mode-toggle gating (web + dashboard reflection + side-log) ──
  test("E: shadow records-only (note stays open); on mutates", async ({ page }) => {
    // Heavy: 4 page navigations (settings, inbox, dashboard ×2) + the live
    // triage-metrics query, which can be slow under late-run box load. Triple
    // the budget so the per-element waits have room.
    test.slow();
    await login(page, ADMIN_USER, ADMIN_PASS);
    const nonce = Date.now();

    // ── Shadow rung ──
    await setNotesTriageModeViaAPI(page, projectId, { enabled: true, mode: "shadow" });

    // Optional UI check: the settings page reflects the shadow mode.
    await page.goto(`/projects/${projectId}/settings/notes-triage`);
    await expect(page.getByRole("heading", { name: "Notes triage" })).toBeVisible({
      timeout: LOAD,
    });
    await expect(page.getByRole("combobox", { name: "Mode" })).toContainText("shadow", {
      timeout: LOAD,
    });

    const shadowTitle = `T3P5 shadow ${nonce}-E-S`;
    const shadowNote = await createNoteViaAPI(page, projectId, {
      kind: "idea",
      title: shadowTitle,
    });
    // SHADOW: record a would-be decision and DO NOTHING else.
    await recordTriageDecisionViaAPI(page, projectId, {
      noteId: shadowNote.id,
      mode: "shadow",
      decision: "promote_standard",
      rationale: "would promote — shadow only",
    });

    // The note is untouched: still open, with exactly one shadow side-log row.
    const shadowRead = await getNoteViaAPI(page, shadowNote.id);
    expect(shadowRead.status).toBe("open");
    const shadowDecisions = await listTriageDecisionsViaAPI(page, projectId, {
      noteId: shadowNote.id,
    });
    expect(shadowDecisions.length).toBe(1);
    expect(shadowDecisions[0].mode).toBe("shadow");

    // Inbox shows the note still Open.
    await page.goto(`/projects/${projectId}/notes`);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible({ timeout: LOAD });
    const shadowCard = page.getByTestId(`note-card-${shadowNote.id}`);
    await expect(shadowCard).toBeVisible({ timeout: LOAD });
    await expect(shadowCard.getByText("Open", { exact: true })).toBeVisible();

    // Dashboard reflects the shadow decision.
    await page.goto(`/projects/${projectId}/triage`);
    await expect(page.getByRole("heading", { name: "Triage" })).toBeVisible({ timeout: LOAD });
    expect(await metricValue(page, "triage-mix-shadow-total")).toBeGreaterThanOrEqual(1);

    // ── On rung ──
    await setNotesTriageModeViaAPI(page, projectId, { enabled: true, mode: "on" });

    const onTitle = `T3P5 on ${nonce}-E-O`;
    const onNote = await createNoteViaAPI(page, projectId, { kind: "bug", title: onTitle });
    // ON: record + perform the real action (dismiss).
    await recordTriageDecisionViaAPI(page, projectId, {
      noteId: onNote.id,
      mode: "on",
      decision: "dismiss",
      rationale: "noise",
    });
    const onDismissed = await dismissNoteViaAPI(page, onNote.id, "noise");
    expect(onDismissed.status).toBe("triaged");
    expect(onDismissed.triageOutcome).toBe("dismissed");

    // Dashboard reflects the on decisions.
    await page.goto(`/projects/${projectId}/triage`);
    await expect(page.getByRole("heading", { name: "Triage" })).toBeVisible({ timeout: LOAD });
    expect(await metricValue(page, "triage-mix-on-total")).toBeGreaterThanOrEqual(1);
  });

  // ── Scenario F — dashboard reflects the mix + audit chain ──
  test("F: triage dashboard renders lanes, decision mix, and the audit chain", async ({ page }) => {
    // The live triage-metrics query can be slow under late-run box load.
    test.slow();
    await login(page, ADMIN_USER, ADMIN_PASS);

    await page.goto(`/projects/${projectId}/triage`);
    await expect(page.getByRole("heading", { name: "Triage" })).toBeVisible({ timeout: LOAD });

    // Lane-count cards render.
    await expect(page.getByTestId("triage-lane-open")).toBeVisible({ timeout: LOAD });
    await expect(page.getByTestId("triage-lane-needs-human")).toBeVisible();
    await expect(page.getByTestId("triage-lane-triaged")).toBeVisible();

    // The decision-mix table shows both shadow + on columns, and the summary
    // cards reflect the accumulated mix (shadow from E, on from A/B/C/E).
    await expect(page.getByRole("columnheader", { name: "Shadow", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "On", exact: true })).toBeVisible();
    expect(await metricValue(page, "triage-mix-shadow-total")).toBeGreaterThanOrEqual(1);
    expect(await metricValue(page, "triage-mix-on-total")).toBeGreaterThanOrEqual(1);

    // The audit chain surfaces our triage activity (all seal notes share the
    // "T3P5" title prefix — enriched onto note activity rows).
    await expect(page.getByText(/T3P5/).first()).toBeVisible({ timeout: LOAD });
  });
});
