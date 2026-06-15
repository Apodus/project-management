import { test, expect } from "@playwright/test";
import { setupAdmin, login, logout } from "./helpers";

const ADMIN_USER = "admin";
const ADMIN_DISPLAY = "Admin User";
const ADMIN_PASS = "password123";

test.describe("Setup and Login", () => {
  test("first visit redirects to /setup", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL("**/setup");
    await expect(page.getByText("Welcome to Project Management")).toBeVisible();
  });

  test("setup wizard creates admin and redirects to projects", async ({ page }) => {
    await setupAdmin(page, {
      username: ADMIN_USER,
      displayName: ADMIN_DISPLAY,
      password: ADMIN_PASS,
    });

    // Verify we see the projects page heading
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  });

  test("logout redirects to login page", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);
    await logout(page);

    // Verify we're on the login page
    await expect(page.locator('[data-slot="card-title"]', { hasText: "Sign In" })).toBeVisible();
  });

  test("login with valid credentials shows projects", async ({ page }) => {
    await login(page, ADMIN_USER, ADMIN_PASS);

    // Verify we see the projects page heading
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  });

  test("invalid login shows error message", async ({ page }) => {
    await page.goto("/login");
    await page.waitForURL("**/login");

    await page.getByLabel("Username").fill(ADMIN_USER);
    await page.getByLabel("Password").fill("wrongpassword");
    await page.getByRole("button", { name: "Sign In" }).click();

    // Should see an error message and stay on login page
    await expect(page.locator(".text-destructive")).toBeVisible();
    expect(page.url()).toContain("/login");
  });
});
