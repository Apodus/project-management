import { test, expect } from "@playwright/test";
import { login, createProjectViaAPI } from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

/**
 * Epic timeline-DAG roadmap view (Campaign C2).
 *
 * The load-bearing real-browser gate: it proves the ReactFlow canvas renders
 * with NON-ZERO height (a 0px canvas paints no visible nodes), draws the
 * dependency edge, and click-drills into the epic detail route — the visual
 * verification deferred from P3–P5.
 *
 * Seeds two epics + an explicit dependency (epicB depends on epicA) via the API,
 * then drives the `/roadmap` route in actual Chromium.
 */
test.describe("Epic Timeline (Roadmap)", () => {
  test("renders nodes + edges and drills into epic detail", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    const project = await createProjectViaAPI(page, "Roadmap E2E Project");
    const projectId = project.id;

    // Two epics — create needs only `name` (createdBy is server-filled).
    const epicAResp = await page.request.post(
      `/api/v1/projects/${projectId}/epics`,
      { data: { name: "Foundation epic" } },
    );
    expect(epicAResp.ok()).toBeTruthy();
    const epicA = (await epicAResp.json()).data;

    const epicBResp = await page.request.post(
      `/api/v1/projects/${projectId}/epics`,
      { data: { name: "Dependent epic" } },
    );
    expect(epicBResp.ok()).toBeTruthy();
    const epicB = (await epicBResp.json()).data;

    // Explicit edge: epicB depends on epicA (arrow points A → B).
    const depResp = await page.request.post(
      `/api/v1/projects/${projectId}/epics/${epicB.id}/dependencies`,
      { data: { dependsOnEpicId: epicA.id } },
    );
    expect(depResp.ok()).toBeTruthy();

    // A milestone with a target date exercises a vertical guide line.
    const msResp = await page.request.post(
      `/api/v1/projects/${projectId}/milestones`,
      { data: { name: "Beta", targetDate: "2026-09-01T00:00:00.000Z" } },
    );
    expect(msResp.ok()).toBeTruthy();

    // The page lives at /roadmap (NOT /timeline).
    await page.goto(`/projects/${projectId}/roadmap`);

    // Non-zero-canvas gate: a 0px-height canvas renders NO visible nodes, so a
    // visible node proves the canvas has real height.
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(".react-flow__edge").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Foundation epic")).toBeVisible({
      timeout: 10_000,
    });

    // Click-drill: clicking the node navigates to the epic detail route.
    await page.locator(".react-flow__node", { hasText: "Foundation epic" }).click();
    await page.waitForURL("**/epics/**", { timeout: 10_000 });
    await expect(page.getByText("Foundation epic")).toBeVisible({
      timeout: 10_000,
    });

    // Past-rail ABSENT assertion (deterministic, not a soft skip):
    // API-seeded epics have activity_recency ≈ now → always partitioned to the
    // ACTIVE set, never to Past. So the "N older" chip must be absent for this
    // known seed; its presence would signal a partition regression (fresh epics
    // wrongly bucketed past).
    await page.goto(`/projects/${projectId}/roadmap`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: /older/i })).toHaveCount(0);
  });
});
