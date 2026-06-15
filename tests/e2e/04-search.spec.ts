import { test, expect } from "@playwright/test";
import { login, createProjectViaAPI, getCurrentUserId } from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

test.describe("Search via Command Palette", () => {
  let projectId: string;

  test("setup project and tasks for search", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    const userId = await getCurrentUserId(page);

    const project = await createProjectViaAPI(
      page,
      "Search Test Project",
      "Project for testing search",
    );
    projectId = project.id;

    // Create several tasks with distinctive names (direct API, no helper overhead)
    for (const task of [
      { title: "Implement dark mode toggle", priority: "high", type: "feature" },
      { title: "Fix pagination bug", priority: "critical", type: "bug" },
      { title: "Refactor authentication module", priority: "medium", type: "chore" },
    ]) {
      const resp = await page.request.post(`/api/v1/projects/${projectId}/tasks`, {
        data: { reporterId: userId, ...task },
      });
      expect(resp.ok(), await resp.text()).toBeTruthy();
    }
  });

  test("Ctrl+K opens command palette, search finds task, click navigates", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    // First navigate into the project so the command palette has a projectId
    await page.goto(`/projects/${projectId}/tasks`);

    // Wait for the page to fully render (task list heading should be visible)
    await expect(page.locator("h1", { hasText: "Tasks" })).toBeVisible({
      timeout: 10_000,
    });

    // Data-loaded gate: ensure the project + tasks data has actually rendered
    // (not just the static shell) before opening the palette, so the search
    // queries don't race readiness.
    await expect(page.getByText("Implement dark mode toggle").first()).toBeVisible({
      timeout: 10_000,
    });

    // Open command palette with Ctrl+K
    await page.keyboard.press("Control+k");

    // The command dialog should appear
    await expect(
      page.getByPlaceholder("Search tasks, proposals, or type a command..."),
    ).toBeVisible({ timeout: 5_000 });

    // Type a search query
    await page.getByPlaceholder("Search tasks, proposals, or type a command...").fill("dark mode");

    // Wait for debounced search results to appear in the command palette
    const commandDialog = page.locator('[role="dialog"]');
    await expect(commandDialog.getByText("Implement dark mode toggle")).toBeVisible({
      timeout: 10_000,
    });

    // Click the result within the command palette
    await commandDialog.getByText("Implement dark mode toggle").click();

    // Should navigate to the task detail page
    await page.waitForURL("**/tasks/**");
    await expect(page.getByText("Implement dark mode toggle")).toBeVisible();
  });

  test("Escape closes command palette", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    // Navigate into the project first
    await page.goto(`/projects/${projectId}/tasks`);

    // Wait for the page to fully render
    await expect(page.locator("h1", { hasText: "Tasks" })).toBeVisible({
      timeout: 10_000,
    });

    // Open command palette
    await page.keyboard.press("Control+k");

    // Verify it's open
    await expect(
      page.getByPlaceholder("Search tasks, proposals, or type a command..."),
    ).toBeVisible({ timeout: 5_000 });

    // Press Escape to close
    await page.keyboard.press("Escape");

    // Verify it's closed
    await expect(
      page.getByPlaceholder("Search tasks, proposals, or type a command..."),
    ).not.toBeVisible();
  });
});
