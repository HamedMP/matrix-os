import { expect, test } from "@playwright/test";

test.describe("onboarding visual QA", () => {
  test("keeps primary activation actions visible on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/settings/onboarding-status", async (route) => {
      await route.fulfill({ json: { complete: false } });
    });
    await page.route("**/api/onboarding/readiness", async (route) => {
      await route.fulfill({
        json: {
          overallStatus: "degraded",
          goals: [],
          gates: [],
          systemAgent: "hermes",
          activeAgents: ["hermes"],
          agents: [],
        },
      });
    });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Matrix OS" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("button", { name: /Talk to Aoede/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Set up manually/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Enter workspace/i })).toBeVisible();

    await page.getByRole("button", { name: /Set up manually/i }).click();

    await expect(page.getByText("Personal cloud computer")).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with text/i })).toBeVisible();
  });
});
