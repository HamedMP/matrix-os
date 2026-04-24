import { test, expect } from "@playwright/test";

test.describe("Visual regression", () => {
  test.beforeEach(async ({ page }) => {
    // Mock gateway APIs so the shell renders without a running backend
    await page.route("**/api/settings/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname.endsWith("/onboarding-status")
        ? { complete: true }
        : {
            background: { type: "pattern" },
            dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
            pinnedApps: [],
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
        body: JSON.stringify([]),
      }),
    );
    // Block WebSocket upgrade requests so they don't keep reconnecting
    await page.route("**/ws/**", (route) => route.abort());

    await page.goto("/");
    // Wait for the dock to render (confirms the shell loaded past auth)
    await page.waitForSelector("[data-testid='dock-settings']", {
      timeout: 15000,
    });
  });

  test("desktop default state", async ({ page }) => {
    await expect(page).toHaveScreenshot("desktop-default.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("chat sidebar open", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);
    await page.keyboard.type("Chat");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("chat-sidebar.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("settings panel", async ({ page }) => {
    const settingsButton = page.getByTestId("dock-settings");
    await settingsButton.click();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("settings-panel.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("command palette", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("command-palette.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("mission control", async ({ page }) => {
    const tasksButton = page.getByTestId("dock-tasks");
    await tasksButton.click();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("mission-control.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("file browser", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);
    await page.keyboard.type("File Browser");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("file-browser.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("dark theme", async ({ page }) => {
    await page.evaluate(() => {
      const root = document.documentElement;
      root.classList.add("dark");
      root.setAttribute("data-theme", "dark");
      const colors: Record<string, string> = {
        "--background": "#1a1a2e",
        "--foreground": "#e0e0e0",
        "--card": "#232340",
        "--card-foreground": "#e0e0e0",
        "--popover": "#232340",
        "--popover-foreground": "#e0e0e0",
        "--primary": "#7c6ff7",
        "--primary-foreground": "#ffffff",
        "--secondary": "#2a2a45",
        "--secondary-foreground": "#b0b0c0",
        "--muted": "#2a2a45",
        "--muted-foreground": "#8888a0",
        "--accent": "#2a2a45",
        "--accent-foreground": "#b0b0c0",
        "--destructive": "#ef4444",
        "--border": "#3a3a5c",
        "--input": "#3a3a5c",
        "--ring": "#7c6ff7",
      };
      for (const [key, value] of Object.entries(colors)) {
        root.style.setProperty(key, value);
      }
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("dark-theme.png", {
      maxDiffPixelRatio: 0.01,
    });
  });
});
