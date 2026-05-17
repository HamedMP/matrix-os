import { test, expect } from "@playwright/test";

test.describe("Icon generate-once: no regeneration UI", () => {
  const mockApps = [
    {
      name: "Todo",
      slug: "todo",
      path: "~/apps/todo",
      runtime: "static",
      category: "productivity",
      description: "A todo app",
      iconUrl: "/files/system/icons/todo.png",
    },
    {
      name: "Notes",
      slug: "notes",
      path: "~/apps/notes",
      runtime: "static",
      category: "productivity",
      description: "A notes app",
      iconUrl: "/files/system/icons/notes.png",
    },
  ];

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/settings/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname.endsWith("/onboarding-status")
        ? { complete: true }
        : {
            background: { type: "pattern" },
            dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
            pinnedApps: ["~/apps/todo"],
            hasKey: true,
          };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    await page.route("**/api/identity", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ handle: "test", displayName: "Test User" }),
      }),
    );
    await page.route("**/api/apps**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockApps),
      }),
    );
    await page.route("**/files/system/icons/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from("fake-png"),
      }),
    );
    await page.route("**/ws/**", (route) => route.abort());

    await page.goto("/");
    await page.waitForSelector("[data-testid='dock-settings']", {
      timeout: 15000,
    });
  });

  test("context menu on app tile does not show Regenerate Icon", async ({
    page,
  }) => {
    const launcherBtn = page.locator("[data-testid='dock-tasks']");
    await expect(launcherBtn).toBeVisible({ timeout: 10000 });
    await launcherBtn.click();

    const appTile = page.locator("[data-app-tile]").first();
    await expect(appTile).toBeVisible({ timeout: 10000 });

    await appTile.click({ button: "right" });

    const contextMenu = page.locator("[role='menu']");
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    const menuItems = contextMenu.locator("[role='menuitem']");
    const count = await menuItems.count();
    for (let i = 0; i < count; i++) {
      const text = await menuItems.nth(i).textContent();
      expect(text).not.toContain("Regenerate");
    }
  });

  test("context menu on dock icon does not show Regenerate Icon", async ({
    page,
  }) => {
    const dockIcon = page.locator("[data-dock-icon]").first();
    if (await dockIcon.isVisible()) {
      await dockIcon.click({ button: "right" });

      const contextMenu = page.locator("[role='menu']");
      if (await contextMenu.isVisible({ timeout: 3000 }).catch(() => false)) {
        const menuItems = contextMenu.locator("[role='menuitem']");
        const count = await menuItems.count();
        for (let i = 0; i < count; i++) {
          const text = await menuItems.nth(i).textContent();
          expect(text).not.toContain("Regenerate");
        }
      }
    }
  });

  test("no regenerate-all API call is made on page load", async ({ page }) => {
    const regenerateRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("regenerate-all")) {
        regenerateRequests.push(req.url());
      }
    });

    await page.goto("/");
    await page.waitForSelector("[data-testid='dock-settings']", {
      timeout: 15000,
    });
    await page.waitForTimeout(2000);

    expect(regenerateRequests).toHaveLength(0);
  });
});
