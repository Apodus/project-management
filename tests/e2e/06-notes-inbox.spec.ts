import { test, expect } from "@playwright/test";
import { login, createProjectViaAPI, createNoteViaAPI } from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

/**
 * Campaign C3 seal: a note created via the API surfaces in the Inbox, and the
 * promote-to-proposal action records bidirectional provenance and triages the
 * note. Provenance is read from the promote RESPONSE — the GET proposal schema
 * does not expose sourceNoteId.
 */
test.describe("Notes Inbox", () => {
  let projectId: string;

  test("create project via API for notes tests", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);
    const project = await createProjectViaAPI(page, "Notes Inbox Test Project");
    projectId = project.id;
  });

  test("a note created via API appears in the Inbox", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    await createNoteViaAPI(page, projectId, {
      kind: "bug",
      title: "E2E finding: broken thing",
      body: "Something is broken and worth tracking.",
    });

    await page.goto(`/projects/${projectId}/notes`);
    // Positive load-gating: assert the page actually reached its loaded state
    // (the Inbox heading, then the project-name BADGE — which only renders
    // once the project query resolved) BEFORE asserting card text. The badge
    // locator is data-slot-scoped because the project name also appears in
    // the sidebar + breadcrumb (strict mode). The card assert then uses the
    // DEFAULT timeout — no bespoke padding, no sleeps.
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(
      page.locator('[data-slot="badge"]', { hasText: "Notes Inbox Test Project" }),
    ).toBeVisible();
    await expect(page.getByText("E2E finding: broken thing")).toBeVisible();
  });

  test("promote-to-proposal records provenance and triages the note", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    const note = await createNoteViaAPI(page, projectId, {
      kind: "idea",
      title: "E2E finding: promote me",
      body: "This should become a proposal.",
    });

    const resp = await page.request.post(`/api/v1/notes/${note.id}/promote-to-proposal`, {
      data: { title: "E2E promoted proposal" },
    });
    expect(resp.ok()).toBeTruthy();

    const { data: promotedNote, proposal } = await resp.json();

    // Bidirectional provenance + triage.
    expect(proposal.sourceNoteId).toBe(note.id);
    expect(promotedNote.promotedProposalId).toBe(proposal.id);
    expect(promotedNote.status).toBe("triaged");

    // The created proposal is fetchable.
    const proposalResp = await page.request.get(`/api/v1/proposals/${proposal.id}`);
    expect(proposalResp.ok()).toBeTruthy();
  });
});
