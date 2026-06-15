import { test, expect, type Page } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  login,
  getCurrentUserId,
  createProjectViaAPI,
  createTaskViaAPI,
  createUserViaAPI,
  assignTaskViaAPI,
} from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

// Unique per run so repeated local runs never collide on usernames.
const RUN_TAG = Date.now().toString(36);

/**
 * Campaign C3 seal — the claims operations surface.
 *
 * The webServer injects PM_LEASE_TTL_SEC=1 PM_LEASE_GRACE_SEC=1, so an
 * assigned task's lease lapses to STALE ~2s after assignment (assignTaskViaAPI
 * acquires the lease AS the assignee). Self-contained like spec 06 — depends
 * only on 01's admin.
 *
 * AMENDMENT (binding): never assert stale COUNTS — claims-health pins the 24h
 * default grace and diverges from the env-tuned row staleness. Rows-only.
 */
/**
 * Poll the claims aggregate API until the given entity's claim_state matches.
 * Server-truth first: claim_state derives from the clock on every read, so the
 * API is the deterministic signal — the UI is asserted AFTER the state holds.
 */
async function waitForClaimState(
  page: Page,
  projectId: string,
  entityId: string,
  state: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const resp = await page.request.get(`/api/v1/projects/${projectId}/claims`);
        if (!resp.ok()) return "request-failed";
        const { data } = await resp.json();
        const item = (data.items as Array<{ id: string; claimState: string }>).find(
          (i) => i.id === entityId,
        );
        return item?.claimState ?? "absent";
      },
      { timeout: timeoutMs, intervals: [500, 1000] },
    )
    .toBe(state);
}

test.describe("Claims surface", () => {
  test("claim → stale → request-takeover auto-grants to the requester", async ({ page }) => {
    // Generous budget: this box runs concurrent agent sessions, and the test
    // spans API seeding + a liveness lapse + two page loads.
    test.setTimeout(120_000);

    await login(page, ADMIN_USER, ADMIN_PASS);
    const adminId = await getCurrentUserId(page);

    const project = await createProjectViaAPI(page, "Claims Surface Project A");
    const task = await createTaskViaAPI(page, project.id, {
      title: "E2E stale-claim task",
      status: "in_progress",
    });
    const agent = await createUserViaAPI(page, {
      username: `claims-agent-${RUN_TAG}`,
      displayName: "Claims Agent One",
    });
    await assignTaskViaAPI(page, task.id, agent.id);

    // Server-truth first: wait until the claim derives STALE (TTL 1s + grace
    // 1s injected via webServer env), THEN load the panel — the UI assertions
    // run against a deterministic state.
    await waitForClaimState(page, project.id, task.id, "stale");

    await page.goto(`/projects/${project.id}/claims`);
    await expect(page.getByText("E2E stale-claim task")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Claims Agent One")).toBeVisible();
    await expect(page.getByText("Stale", { exact: true })).toBeVisible();

    // Request takeover (stale → auto-grant to the admin).
    await page.getByRole("button", { name: "Request takeover" }).click();
    const dialog = page.locator("[data-slot='dialog-content']");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Reason").fill("holder went dark — picking it up");
    await dialog.getByRole("button", { name: "Request takeover" }).click();

    // The row re-derives as YOURS for the admin (mutation invalidates the
    // claims query, so no reload needed).
    await expect(page.getByText("Yours", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // API-level proof of the transfer.
    const taskResp = await page.request.get(`/api/v1/tasks/${task.id}`);
    expect(taskResp.ok()).toBeTruthy();
    const { data: taskAfter } = await taskResp.json();
    expect(taskAfter.assigneeId).toBe(adminId);
  });

  test("release-to hands the claim to a named worker", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN_USER, ADMIN_PASS);

    const project = await createProjectViaAPI(page, "Claims Surface Project B");
    const task = await createTaskViaAPI(page, project.id, {
      title: "E2E release-to task",
      status: "in_progress",
    });
    const agentA = await createUserViaAPI(page, {
      username: `claims-agent-a-${RUN_TAG}`,
      displayName: "Release Agent A",
    });
    const agentB = await createUserViaAPI(page, {
      username: `claims-agent-b-${RUN_TAG}`,
      displayName: "Release Agent B",
    });
    await assignTaskViaAPI(page, task.id, agentA.id);

    await page.goto(`/projects/${project.id}/claims`);
    await expect(page.getByText("E2E release-to task")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Release to…" }).click();
    const dialog = page.locator("[data-slot='dialog-content']");
    await expect(dialog).toBeVisible();

    // Radix Select: open the trigger, pick agent B from the portalled listbox.
    await dialog.locator("#release-to-target").click();
    await page.getByRole("option", { name: /Release Agent B/ }).click();
    await dialog.getByLabel("Reason").fill("rebalancing work to agent B");
    await dialog.getByRole("button", { name: "Release claim" }).click();

    // The row's holder updates live (claims query invalidated on success).
    await expect(page.getByText("Release Agent B")).toBeVisible({
      timeout: 10_000,
    });

    // API-level proof of the transfer.
    const taskResp = await page.request.get(`/api/v1/tasks/${task.id}`);
    expect(taskResp.ok()).toBeTruthy();
    const { data: taskAfter } = await taskResp.json();
    expect(taskAfter.assigneeId).toBe(agentB.id);
  });

  test("code-split smoke: build emits multiple js chunks and a cold deep-link renders", async ({
    page,
  }) => {
    // The production build the webServer serves must be route-split (P6).
    // process.cwd() is the repo root (Playwright runs from the workspace root;
    // __dirname is unavailable in this ESM spec context).
    const assetsDir = path.resolve(process.cwd(), "packages/web/dist/assets");
    expect(existsSync(assetsDir)).toBeTruthy();
    const jsChunks = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
    expect(jsChunks.length).toBeGreaterThan(1);

    // Cold deep-link straight into the lazy claims route (fresh navigation —
    // the chunk loads on demand and renders).
    await login(page, ADMIN_USER, ADMIN_PASS);
    const project = await createProjectViaAPI(page, "Claims Surface Project C");
    await page.goto(`/projects/${project.id}/claims`);
    await expect(page.getByRole("heading", { name: "Claims" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No active claims.")).toBeVisible({
      timeout: 10_000,
    });
  });
});
