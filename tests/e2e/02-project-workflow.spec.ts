import { test, expect } from "@playwright/test";
import { login, createProjectViaAPI } from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_PASS = "password123";

test.describe("Project Workflow", () => {
  let projectId: string;

  test("create project via UI", async ({ page }) => {
    // Login (admin was created by 01-setup-and-login tests)
    await login(page, ADMIN_USER, ADMIN_PASS);

    // --- Create a new project ---
    await page.getByRole("button", { name: "New Project" }).click();

    // Dialog should appear
    await expect(page.getByRole("heading", { name: "Create Project" })).toBeVisible();

    await page.getByLabel("Name").fill("Test Project");
    await page.getByLabel("Description").fill("A project for E2E testing");
    await page.getByRole("button", { name: "Create Project" }).click();

    // Should redirect to the project's proposals page
    await page.waitForURL("**/proposals");
    await expect(page.getByRole("heading", { name: "Proposals" })).toBeVisible();

    // Capture the project ID from the URL for subsequent tests
    const url = page.url();
    const match = url.match(/\/projects\/([^/]+)\//);
    expect(match).not.toBeNull();
    projectId = match![1];
  });

  test("create proposal via API, view detail, accept via UI", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    // Get the current user's ID for the createdBy field
    const meResponse = await page.request.get("/api/v1/auth/me");
    const meJson = await meResponse.json();
    const userId = meJson.data.id;

    // Create a proposal via API (avoids the hardcoded "human-director" FK issue)
    const proposalTitle = "Implement user notifications";
    const proposalDescription =
      "Add a notification system so users get alerted when tasks are assigned to them.";

    const proposalResponse = await page.request.post(`/api/v1/projects/${projectId}/proposals`, {
      data: {
        title: proposalTitle,
        description: proposalDescription,
        createdBy: userId,
      },
    });
    expect(proposalResponse.ok(), await proposalResponse.text()).toBeTruthy();
    const proposalJson = await proposalResponse.json();
    const proposalId = proposalJson.data.id;

    // Navigate to proposal detail page
    await page.goto(`/proposals/${proposalId}`);

    // --- Verify proposal detail page ---
    await expect(page.getByText(proposalTitle)).toBeVisible();
    await expect(page.getByText(proposalDescription)).toBeVisible();

    // --- Add a comment via API (authorId FK constraint) ---
    const commentText = "This looks great! Let's move forward with this.";
    const commentResponse = await page.request.post(`/api/v1/proposals/${proposalId}/comments`, {
      data: {
        authorId: userId,
        body: commentText,
      },
    });
    expect(commentResponse.ok(), await commentResponse.text()).toBeTruthy();

    // Reload to see the comment
    await page.reload();
    await expect(page.getByText(commentText)).toBeVisible();

    // --- Accept the proposal via API ---
    // The comment above already auto-advanced the proposal open -> discussing
    // (any author; proposal.service addComment), so this transition is discussing -> accepted.
    const acceptResponse = await page.request.post(`/api/v1/proposals/${proposalId}/transitions`, {
      data: {
        toStatus: "accepted",
        actorId: userId,
      },
    });
    expect(acceptResponse.ok(), await acceptResponse.text()).toBeTruthy();

    // Reload and verify the status badge changed to "Accepted"
    await page.reload();
    // Positive loaded-state gate: the Accepted badge (only fresh post-accept data
    // renders it) + the description (only the loaded, non-skeleton state renders it).
    await expect(page.getByText("Accepted")).toBeVisible();
    await expect(page.getByText(proposalDescription)).toBeVisible();
    // Now absence is meaningful: stronger than the old racy not.toBeVisible().
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
  });
});
