import { test, expect } from "@playwright/test";

test.describe("Visual regression", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("desktop default state", async ({ page }) => {
    await expect(page).toHaveScreenshot("desktop-default.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("chat sidebar open", async ({ page }) => {
    // Chat toggle button is fixed at top-right corner
    const chatToggle = page.locator("button", { has: page.locator("svg.lucide-message-square") }).first();
    await chatToggle.click();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("chat-sidebar.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("settings panel", async ({ page }) => {
    // Settings button is in the dock, identified by the SettingsIcon
    const settingsButton = page.locator("aside button", { has: page.locator("svg.lucide-settings") }).first();
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
    // Mission control / Tasks button in the dock (KanbanSquareIcon)
    const tasksButton = page.locator("aside button", { has: page.locator("svg.lucide-kanban-square") }).first();
    await tasksButton.click();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("mission-control.png", {
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
