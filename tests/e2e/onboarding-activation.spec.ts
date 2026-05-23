import { expect, test } from "@playwright/test";

test.describe("onboarding activation", () => {
  test("shows goal-based activation and readiness copy", async ({ page }) => {
    await page.route("**/api/onboarding/readiness", async (route) => {
      await route.fulfill({
        json: {
          overallStatus: "degraded",
          goals: [
            { id: "coding", selected: false, label: "Code with Matrix", description: "Ship code" },
            { id: "assistant", selected: false, label: "Use Matrix as an assistant", description: "Operate tasks" },
          ],
          gates: [
            {
              id: "hermes.available",
              category: "agent",
              criticality: "release_critical",
              status: "pass",
              message: "Hermes is available as the Matrix system agent",
              remediation: null,
              owner: "matrix",
              lastCheckedAt: null,
            },
          ],
          systemAgent: "hermes",
          activeAgents: ["hermes"],
          agents: [],
        },
      });
    });
    await page.route("**/api/onboarding/goals", async (route) => {
      await route.fulfill({
        json: {
          goalIds: ["coding"],
          steps: [
            { id: "github.connected", required: true, title: "Connect GitHub", unlocks: ["coding"] },
          ],
        },
      });
    });

    await page.goto("/");

    await expect(page.getByText("Set up Matrix around the work you want done first.")).toBeVisible();
    await page.getByRole("button", { name: /Code with Matrix/i }).click();
    await expect(page.getByText("Required · Connect GitHub")).toBeVisible();
    await expect(page.getByText("Hermes is available as the Matrix system agent")).toBeVisible();
  });
});

