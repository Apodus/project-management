import { test, expect } from "@playwright/test";
import { login, createProjectViaAPI, getCurrentUserId } from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

/**
 * Epic timeline-DAG roadmap view (Campaign C2).
 *
 * The load-bearing real-browser gate: it proves the ReactFlow canvas renders
 * with NON-ZERO height (a 0px canvas paints no visible nodes), draws the
 * dependency edge, and that clicking an epic opens the floating task panel
 * whose "Open full epic →" link drills into epic detail — the visual
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

    // Structure-default prerequisite-left: the default mode is the topological
    // DAG, where the prerequisite (Foundation epic / epicA) is laid out strictly
    // left of its dependent (Dependent epic / epicB). Poll until the fitView
    // animation settles and both nodes report a bounding box.
    await expect(async () => {
      const aBox = await page
        .locator(".react-flow__node", { hasText: "Foundation epic" })
        .boundingBox();
      const bBox = await page
        .locator(".react-flow__node", { hasText: "Dependent epic" })
        .boundingBox();
      expect(aBox).not.toBeNull();
      expect(bBox).not.toBeNull();
      expect(aBox!.x).toBeLessThan(bBox!.x);
    }).toPass({ timeout: 10_000 });

    // P1 readability win, end-to-end: a single-prerequisite dependent renders within
    // the alignment band of its prerequisite (assignCoordinates lands an n=1 dependent
    // on its prereq's exact y; band absorbs node-height + fitView <=0.65 zoom slack).
    await expect(async () => {
      const aBox = await page
        .locator(".react-flow__node", { hasText: "Foundation epic" })
        .boundingBox();
      const bBox = await page
        .locator(".react-flow__node", { hasText: "Dependent epic" })
        .boundingBox();
      expect(aBox).not.toBeNull();
      expect(bBox).not.toBeNull();
      const aCenterY = aBox!.y + aBox!.height / 2;
      const bCenterY = bBox!.y + bBox!.height / 2;
      expect(Math.abs(aCenterY - bCenterY)).toBeLessThan(140);
    }).toPass({ timeout: 10_000 });

    // The mode toggle flips between Structure and Timeline. The "Today" line
    // renders ONLY in timeline mode, so it is the observable discriminator.
    await page.getByRole("radio", { name: "Timeline" }).click();
    await expect(page.getByText("Today")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("radio", { name: "Structure" }).click();
    await expect(page.getByText("Today")).toHaveCount(0);

    // Clicking an epic node opens the floating task panel IN PLACE — it no
    // longer navigates away (that changed when the floating task mini-DAG
    // shipped). The panel's "Open full epic →" link is the drill-through.
    await page.locator(".react-flow__node", { hasText: "Foundation epic" }).click();
    const openEpicLink = page.getByRole("link", { name: /open full epic/i });
    await expect(openEpicLink).toBeVisible({ timeout: 10_000 });

    // Drill through to the epic detail route via the panel link. Assert the
    // epic-detail <h1> heading specifically (unambiguous — roadmap nodes/panel
    // use div/span, so a heading-role locator can't match the in-transition DOM).
    await openEpicLink.click();
    await page.waitForURL("**/epics/**", { timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: "Foundation epic" }),
    ).toBeVisible({ timeout: 10_000 });

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

  test("epic-scoped board drill shows only that epic's tasks + no epic dropdown", async ({
    page,
  }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    const project = await createProjectViaAPI(page, "Epic Board Drill Project");
    const projectId = project.id;
    const reporterId = await getCurrentUserId(page);

    // Two epics; only the first gets a task so we can assert scoping.
    const epicResp = await page.request.post(
      `/api/v1/projects/${projectId}/epics`,
      { data: { name: "Scoped epic" } },
    );
    expect(epicResp.ok()).toBeTruthy();
    const scopedEpic = (await epicResp.json()).data;

    const otherEpicResp = await page.request.post(
      `/api/v1/projects/${projectId}/epics`,
      { data: { name: "Other epic" } },
    );
    expect(otherEpicResp.ok()).toBeTruthy();
    const otherEpic = (await otherEpicResp.json()).data;

    // One task under the scoped epic, one under the other epic.
    const inEpicResp = await page.request.post(
      `/api/v1/projects/${projectId}/tasks`,
      {
        data: {
          title: "Task in scoped epic",
          reporterId,
          epicId: scopedEpic.id,
          status: "ready",
        },
      },
    );
    expect(inEpicResp.ok()).toBeTruthy();

    const otherTaskResp = await page.request.post(
      `/api/v1/projects/${projectId}/tasks`,
      {
        data: {
          title: "Task in other epic",
          reporterId,
          epicId: otherEpic.id,
          status: "ready",
        },
      },
    );
    expect(otherTaskResp.ok()).toBeTruthy();

    // Drill directly to the epic-scoped board.
    await page.goto(
      `/projects/${projectId}/epics/${scopedEpic.id}/board`,
    );

    // Epic-scoped chrome: the back-to-epic link (deep-links to /epics/{id}) is
    // the stable marker that the board is scoped to a single epic. (The h1 shows
    // the epic NAME once the epics list resolves, falling back to "Epic board" —
    // we assert the route-derived chrome, not the async-loaded name.)
    await expect(page.getByText("Back to epic")).toBeVisible({
      timeout: 10_000,
    });

    // Only the scoped epic's task appears; the other epic's task does NOT.
    await expect(page.getByText("Task in scoped epic")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Task in other epic")).toHaveCount(0);

    // The epic-filter dropdown is absent (the epic is pinned by the route):
    // its trigger placeholder "Epic" (exact) and the "Group by Epic" toggle are gone.
    await expect(page.getByText("Epic", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Group by Epic" }),
    ).toHaveCount(0);
  });
});
