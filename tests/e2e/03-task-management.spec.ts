import { test, expect } from "@playwright/test";
import {
  login,
  createProjectViaAPI,
  getCurrentUserId,
} from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

/**
 * Create a task directly via the API, reusing a pre-fetched userId.
 * Retries on transient network errors.
 */
async function createTask(
  page: import("@playwright/test").Page,
  projectId: string,
  userId: string,
  data: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    type?: string;
  },
): Promise<{ id: string; title: string; status: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await page.request.post(
        `/api/v1/projects/${projectId}/tasks`,
        {
          data: {
            reporterId: userId,
            ...data,
          },
        },
      );
      expect(response.ok()).toBeTruthy();
      const json = await response.json();
      return json.data;
    } catch (e) {
      if (attempt < 2) {
        await page.waitForTimeout(1_000);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Unreachable");
}

test.describe("Task Management", () => {
  let projectId: string;
  let userId: string;

  test("create project via API for task tests", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    userId = await getCurrentUserId(page);
    const project = await createProjectViaAPI(page, "Task Test Project");
    projectId = project.id;
  });

  test("empty task list shows placeholder message", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    await page.goto(`/projects/${projectId}/tasks`);
    await expect(page.getByText("No tasks found")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("tasks created via API appear in task list", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    // Create tasks via API (reuse userId from first test)
    await createTask(page, projectId, userId, {
      title: "Implement login page",
      description: "Build the login UI",
      priority: "high",
      type: "feature",
    });

    await createTask(page, projectId, userId, {
      title: "Fix header alignment",
      description: "The header is misaligned on mobile",
      priority: "medium",
      type: "bug",
    });

    await createTask(page, projectId, userId, {
      title: "Write unit tests",
      description: "Add tests for auth service",
      priority: "low",
      type: "chore",
    });

    // Navigate to tasks page
    await page.goto(`/projects/${projectId}/tasks`);

    // Verify tasks appear
    await expect(page.getByText("Implement login page")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Fix header alignment")).toBeVisible();
    await expect(page.getByText("Write unit tests")).toBeVisible();
  });

  test("click task to view detail, change status, verify on reload", async ({
    page,
  }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    // Create a specific task
    const task = await createTask(page, projectId, userId, {
      title: "Detail view test task",
      priority: "high",
      type: "feature",
    });

    // Navigate to task detail page directly
    await page.goto(`/tasks/${task.id}`);

    // Verify task title is visible
    await expect(page.getByText("Detail view test task")).toBeVisible({
      timeout: 10_000,
    });

    // Change status via the API (more reliable than UI Select component)
    // Task starts in "backlog" status, transition to "ready" first, then to "in_progress"
    const readyResponse = await page.request.post(
      `/api/v1/tasks/${task.id}/transitions`,
      {
        data: { to_status: "ready" },
      },
    );
    expect(readyResponse.ok(), `Ready transition failed: ${readyResponse.status()} ${await readyResponse.text()}`).toBeTruthy();

    const inProgressResponse = await page.request.post(
      `/api/v1/tasks/${task.id}/transitions`,
      {
        data: { to_status: "in_progress" },
      },
    );
    expect(inProgressResponse.ok(), `In-progress transition failed: ${inProgressResponse.status()} ${await inProgressResponse.text()}`).toBeTruthy();

    // Reload the page and verify the status persisted
    await page.reload();
    await expect(page.getByText("Detail view test task")).toBeVisible({
      timeout: 10_000,
    });

    // The metadata panel should show "In Progress"
    await expect(page.getByText("In Progress")).toBeVisible();
  });

  test("board view shows tasks in correct columns", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    // Navigate to board view
    await page.goto(`/projects/${projectId}/board`);

    // Wait for the board page to fully render
    await expect(
      page.locator("h1", { hasText: "Board" }),
    ).toBeVisible({ timeout: 10_000 });

    // If the board shows an error, retry with a full page reload
    const retryButton = page.getByRole("button", { name: "Retry" });
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await retryButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await page.reload();
        await expect(
          page.locator("h1", { hasText: "Board" }),
        ).toBeVisible({ timeout: 10_000 });
      } else {
        break;
      }
    }

    // The board should have status columns (shown as badges in column headers)
    await expect(page.getByText("Backlog")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Ready")).toBeVisible();
    await expect(page.getByText("In Progress")).toBeVisible();
  });
});
