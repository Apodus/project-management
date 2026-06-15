import { type Page, expect } from "@playwright/test";

/**
 * Complete the first-run setup wizard by creating an admin account.
 * Assumes the database is fresh (needsSetup === true).
 */
export async function setupAdmin(
  page: Page,
  { username = "admin", displayName = "Admin User", password = "password123" } = {},
): Promise<void> {
  await page.goto("/");

  // Defensive landing branch. With per-run fresh DBs the WIZARD path is the
  // only reachable one, but a pre-set-up DB would land on /login. The wizard
  // and login "titles" are CardTitle DIVS (`<div data-slot="card-title">`),
  // NOT heading-role elements — so we match them with getByText / the
  // data-slot locator, matching the spec-01 idiom.
  await Promise.race([
    page.getByText("Welcome to Project Management").waitFor({ timeout: 15_000 }),
    page.locator('[data-slot="card-title"]', { hasText: "Sign In" }).waitFor({ timeout: 15_000 }),
  ]);

  if (page.url().includes("/login")) {
    // Already set up (defensive — unreachable with per-run fresh DBs).
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("**/projects");
    return;
  }

  // WIZARD path.
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Display Name").fill(displayName);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill(password);

  // Wait for the setup API call to complete and set the session cookie.
  const [response] = await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes("/api/v1/auth/setup") && resp.status() === 201,
    ),
    page.getByRole("button", { name: "Create Admin Account" }).click(),
  ]);
  expect(response.ok()).toBeTruthy();

  // Drive the wizard deterministically through its remaining steps. Each step
  // is conditionally rendered, so exactly one "Skip" button is mounted at a
  // time. Gate each transition on the next step's visible content.
  await expect(page.getByText("Create your first project")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();

  await expect(page.getByText("Connect your agents")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();

  await page.waitForURL("**/projects");
  // This one IS a real <h1> — the only true heading among these screens.
  // `exact: true` is load-bearing: Playwright's string name-match is a
  // case-insensitive SUBSTRING match, and the post-load empty state renders
  // an <h3>No projects yet</h3> which contains "projects" — without exact
  // matching, both headings match and the assertion strict-mode-races on
  // whichever renders first.
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}

/**
 * Login with the given credentials.
 * Navigates to /login and fills the form.
 */
export async function login(page: Page, username: string, password: string): Promise<void> {
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

  const response = await page.request.post(`/api/v1/projects/${projectId}/tasks`, {
    data: {
      reporterId: userId,
      ...data,
    },
  });

  expect(response.ok()).toBeTruthy();
  const json = await response.json();
  return json.data;
}

/**
 * Helper to create a note via the API directly (Campaign C3 — Inbox).
 * Returns the created note object.
 */
export async function createNoteViaAPI(
  page: Page,
  projectId: string,
  data: {
    kind: string;
    title: string;
    body?: string;
    anchorType?: "task" | "epic" | "proposal";
    anchorId?: string;
  },
): Promise<{ id: string; title: string; status: string; kind: string }> {
  const response = await page.request.post(`/api/v1/projects/${projectId}/notes`, { data });

  expect(response.ok()).toBeTruthy();
  const json = await response.json();
  return json.data;
}

/**
 * Helper to create a user via the API directly (Campaign C3 — claims surface).
 * Requires an ADMIN session on `page`. Defaults to an ai_agent member (the
 * worker shape the claims panel cares about). Returns the created user.
 */
export async function createUserViaAPI(
  page: Page,
  data: {
    username: string;
    displayName: string;
    role?: string;
    type?: string;
  },
): Promise<{
  id: string;
  username: string;
  displayName: string;
  type: string;
  // The create response for an ai_agent user includes its minted apiToken
  // (a one-time reveal). C2 §P5 needs it to drive a SECOND-user Bearer flow.
  apiToken?: string;
}> {
  const response = await page.request.post("/api/v1/users", {
    data: {
      role: "member",
      type: "ai_agent",
      ...data,
    },
  });

  expect(response.ok()).toBeTruthy();
  const json = await response.json();
  return json.data;
}

/**
 * Helper to assign a task via the API (PATCH assigneeId). The server keeps the
 * claim lease in sync with a direct assignee PATCH — the lease is acquired AS
 * the assignee (task.service update fold-in), so this is the E2E stale-claim
 * injection primitive: assign, then let the env-shortened TTL+grace lapse.
 */
export async function assignTaskViaAPI(
  page: Page,
  taskId: string,
  assigneeId: string,
): Promise<void> {
  const response = await page.request.patch(`/api/v1/tasks/${taskId}`, {
    data: { assigneeId },
  });
  expect(response.ok()).toBeTruthy();
}

/**
 * Helper to raise an escalation via the API directly (Campaign C1 — escalation
 * channel). `originRepo` and `originWorkerKey` are REQUIRED provenance params.
 * Returns the created escalation (POST → 201).
 */
export async function raiseEscalationViaAPI(
  page: Page,
  projectId: string,
  data: {
    kind: string;
    title: string;
    originRepo: string;
    originWorkerKey: string;
    body?: string;
    severity?: string;
  },
): Promise<{ id: string; status: string; originRepo: string; originWorkerKey: string }> {
  const response = await page.request.post(`/api/v1/projects/${projectId}/escalations`, { data });

  expect(response.status()).toBe(201);
  const json = await response.json();
  return json.data;
}

/**
 * Wait for the page to settle after navigation (avoid networkidle with SSE).
 */
export async function waitForPageReady(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
}
