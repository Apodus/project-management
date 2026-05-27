import { type Page, expect } from "@playwright/test";

/**
 * Complete the first-run setup wizard by creating an admin account.
 * Assumes the database is fresh (needsSetup === true).
 */
export async function setupAdmin(
  page: Page,
  {
    username = "admin",
    displayName = "Admin User",
    password = "password123",
  } = {},
): Promise<void> {
  await page.goto("/");
  // Should redirect to /setup on fresh DB
  await page.waitForURL("**/setup");

  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Display Name").fill(displayName);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill(password);

  // Wait for the setup API call to complete and set the session cookie.
  const [response] = await Promise.all([
    page.waitForResponse((resp) =>
      resp.url().includes("/api/v1/auth/setup") && resp.status() === 201,
    ),
    page.getByRole("button", { name: "Create Admin Account" }).click(),
  ]);

  // Verify the setup response was successful
  expect(response.ok()).toBeTruthy();

  // The SPA navigates to /projects after setup.  The auth guard in the
  // router may briefly redirect to /login if the session cookie isn't
  // picked up in time.  Wait a moment, then if we ended up on /login,
  // explicitly log in to reach the projects page.
  await page.waitForTimeout(1_000);

  if (page.url().includes("/login")) {
    // The auth guard didn't pick up the session from setup.
    // Log in explicitly.
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
  }

  await page.waitForURL("**/projects", { timeout: 10_000 });
  await expect(
    page.locator("h1", { hasText: "Projects" }),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Login with the given credentials.
 * Navigates to /login and fills the form.
 */
export async function login(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.waitForURL("**/login");

  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();

  // Should land on the projects page
  await page.waitForURL("**/projects");
}

/**
 * Logout the current user via the user menu in the header.
 */
export async function logout(page: Page): Promise<void> {
  // Open the user dropdown (the rounded avatar button)
  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();

  // Should land on /login
  await page.waitForURL("**/login");
}

/**
 * Get the current user's ID from the API.
 * Retries on transient failures (ECONNRESET, etc.).
 */
export async function getCurrentUserId(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await page.request.get("/api/v1/auth/me");
      if (response.ok()) {
        const json = await response.json();
        return json.data.id;
      }
    } catch {
      // Retry on network errors
      if (attempt < 2) {
        await page.waitForTimeout(500);
      }
    }
  }
  throw new Error("Failed to get current user ID after retries");
}

/**
 * Helper to create a project via the API directly.
 * Returns the project object.
 */
export async function createProjectViaAPI(
  page: Page,
  name: string,
  description?: string,
): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/v1/projects", {
    data: { name, description },
  });

  expect(response.ok()).toBeTruthy();
  const json = await response.json();
  return json.data;
}

/**
 * Helper to create a task via the API directly.
 * Returns the created task object.
 */
export async function createTaskViaAPI(
  page: Page,
  projectId: string,
  data: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    type?: string;
  },
): Promise<{ id: string; title: string; status: string }> {
  const userId = await getCurrentUserId(page);

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
}

/**
 * Wait for the page to settle after navigation (avoid networkidle with SSE).
 */
export async function waitForPageReady(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
}
