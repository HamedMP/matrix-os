import { expect, test } from "@playwright/test";

test.describe("onboarding visual QA", () => {
  test("keeps primary activation actions visible on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
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

    await expect(page.getByRole("button", { name: /Start with voice/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Start with text/i })).toBeVisible();
    await expect(page.getByText("Personal cloud computer")).toBeVisible();
  });
});

