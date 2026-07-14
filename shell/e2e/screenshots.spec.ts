import { test, expect } from "@playwright/test";

type MenuBarTheme = "standard" | "macos-glass";

async function useCanvasMode(page: import("@playwright/test").Page) {
  const canvasMode = page.getByRole("button", { name: "Canvas mode" });
  if ((await canvasMode.getAttribute("aria-pressed")) !== "true") {
    await canvasMode.click();
  }
  await expect(canvasMode).toHaveAttribute("aria-pressed", "true");
}

async function useMenuBarTheme(page: import("@playwright/test").Page, theme: MenuBarTheme) {
  await page.evaluate((themeName) => {
    document.documentElement.setAttribute(
      "data-theme-style",
      themeName === "macos-glass" ? "macos-glass" : "flat",
    );
  }, theme);
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-style",
    theme === "macos-glass" ? "macos-glass" : "flat",
  );
}

async function expectResponsiveMenuBar(page: import("@playwright/test").Page, width: number) {
  const full = width >= 1024;
  const header = page.locator("[data-menu-bar]");
  await expect(header).toBeVisible();
  await expect(header).toHaveCSS("height", "32px");

  const geometry = await header.evaluate((element) => {
    const headerRect = element.getBoundingClientRect();
    const visibleControls = [...element.querySelectorAll<HTMLElement>("button, input")]
      .filter((control) => {
        const style = getComputedStyle(control);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return { label: control.getAttribute("aria-label") ?? control.textContent, top: rect.top, bottom: rect.bottom };
      });
    return {
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      visibleControls,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  expect(geometry.headerBottom - geometry.headerTop).toBe(32);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(
    geometry.visibleControls.filter(
      (control) => control.top < geometry.headerTop - 0.5 || control.bottom > geometry.headerBottom + 0.5,
    ),
  ).toEqual([]);

  if (full) {
    const fullApplicationActions = page.getByTestId("full-application-actions");
    await expect(fullApplicationActions).toBeVisible();
    await expect(fullApplicationActions.getByRole("button", { name: "File", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "More application actions" })).toBeHidden();
    await expect(page.getByRole("slider", { name: "Zoom level" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More canvas controls" })).toBeHidden();
    await expect(page.getByText("Canvas", { exact: true })).toBeVisible();
  } else {
    const fullApplicationActions = page.getByTestId("full-application-actions");
    await expect(fullApplicationActions).toBeHidden();
    await expect(fullApplicationActions.getByRole("button", { name: "File", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "More application actions" })).toBeVisible();
    await expect(page.getByRole("slider", { name: "Zoom level" })).toBeHidden();
    await expect(page.getByRole("button", { name: "More canvas controls" })).toBeVisible();
    await expect(page.getByText("Canvas", { exact: true })).toBeHidden();
    await expect(page.locator('[data-menu-clock="compact"]')).toBeVisible();
    await expect(page.locator('[data-menu-clock="full"]')).toBeHidden();
  }
}

function agentSettingsView() {
  const chat = {
    provider: "anthropic",
    model: "claude-opus-4-6",
    effort: "high",
    source: "saved",
    authKind: "platform",
  };
  return {
    identity: {},
    kernel: { model: chat.model, effort: chat.effort },
    availableModels: [{ id: chat.model, label: "Claude Opus 4.6", tier: "Most capable" }],
    availableEfforts: ["low", "medium", "high", "max"],
    defaults: { model: chat.model, effort: chat.effort },
    contractVersion: 2,
    revision: 4,
    chat,
    runtime: {
      selected: "hermes",
      options: [
        {
          id: "hermes",
          displayName: "Hermes",
          installState: "installed",
          health: "healthy",
          selectionState: "active",
          configured: true,
          capabilities: ["provider_catalog", "model_selection", "authentication", "messaging_dashboard"],
          version: "1.2.0",
        },
        {
          id: "openclaw",
          displayName: "OpenClaw",
          installState: "missing",
          health: "stopped",
          selectionState: "unavailable",
          configured: false,
          capabilities: ["install"],
          setupAction: "install",
        },
      ],
      transition: null,
    },
    providers: [
      {
        id: "anthropic",
        displayName: "Anthropic",
        runtime: null,
        scopes: ["chat"],
        authKind: "platform",
        supportedAuthKinds: ["platform", "api_key", "oauth_login"],
        models: [{
          id: chat.model,
          displayName: "Claude Opus 4.6",
          capabilities: ["tools", "vision", "reasoning"],
          efforts: ["low", "medium", "high", "max"],
          available: true,
        }],
        authStatus: { state: "ready", authenticated: true, action: "none" },
      },
      {
        id: "nous",
        displayName: "Nous Research",
        runtime: "hermes",
        scopes: ["messaging"],
        authKind: "oauth_login",
        supportedAuthKinds: ["oauth_login"],
        models: [{
          id: "hermes-4-405b",
          displayName: "Hermes 4 405B",
          capabilities: ["tools"],
          efforts: [],
          available: true,
        }],
        authStatus: { state: "ready", authenticated: true, action: "none" },
      },
    ],
    currentSelection: {
      chat,
      messaging: {
        runtime: "hermes",
        provider: "nous",
        model: "hermes-4-405b",
        configured: true,
      },
    },
  };
}

test.describe("Visual regression", () => {
  test.beforeEach(async ({ page }) => {
    // Match the platform-owned app shell request boundary so the server-rendered
    // page enters the authenticated workspace before client screenshots begin.
    await page.setExtraHTTPHeaders({
      "x-matrix-platform-session": "platform",
    });
    // Mock gateway APIs so the shell renders without a running backend
    await page.route("**/api/settings/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname.endsWith("/agent")
        ? agentSettingsView()
        : pathname.endsWith("/onboarding-status")
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
    await page.route("**/api/shell/bootstrap", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          layout: { windows: [] },
          apps: [],
          modules: [],
          icons: {},
        }),
      }),
    );
    await page.route("**/api/layout", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
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
    await settingsButton.dispatchEvent("click");
    await page.mouse.move(720, 450);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("settings-panel.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("billing checkout selection conflict", async ({ page }) => {
    await page.route("**/billing/status**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access: { runtimeProxyAllowed: false } }),
      }),
    );
    await page.route("**/billing/checkout", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Checkout selection conflicts with an open session",
          code: "checkout_selection_conflict",
          selection: {
            planSlug: "matrix_starter",
            interval: "annual",
            regionSlug: "region_nbg1",
          },
        }),
      }),
    );

    await page.getByTestId("dock-settings").dispatchEvent("click");
    await page.getByRole("button", { name: "Billing" }).click();
    await expect(page.getByText("Not active")).toBeVisible();
    await page.getByRole("button", { name: "Continue to pay" }).click();
    await expect(
      page.getByText(
        "A Starter annual checkout in Nuremberg, Germany is already open. Select those choices to continue it.",
      ),
    ).toBeVisible();
    await page.mouse.move(720, 450);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("billing-checkout-selection-conflict.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("Agent runtime settings", async ({ page }) => {
    await page.getByTestId("dock-settings").dispatchEvent("click");
    await page.getByText("Agent", { exact: true }).click();
    await expect(page.getByText("Chat agent", { exact: true })).toBeVisible();
    await page.mouse.move(720, 450);
    await expect(page).toHaveScreenshot("agent-settings.png", {
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
    await tasksButton.dispatchEvent("click");
    await page.mouse.move(720, 450);
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

  for (const theme of ["standard", "macos-glass"] as const) {
    test(`menu bar stays single-line while resizing in ${theme}`, async ({ page }) => {
      await useCanvasMode(page);
      await useMenuBarTheme(page, theme);

      const widths = [1440, 1024, 900, 768, 900, 1440];
      for (let index = 0; index < widths.length; index += 1) {
        const width = widths[index]!;
        await page.setViewportSize({ width, height: 900 });
        await expectResponsiveMenuBar(page, width);

        if (width === 900 && index === 4) {
          const trigger = page.getByRole("button", { name: "More application actions" });
          await trigger.focus();
          await page.keyboard.press("Enter");
          const menu = page.getByRole("menu", { name: "More application actions" });
          await expect(menu).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(trigger).toBeFocused();

          await page.keyboard.press("Enter");
          const newWindow = page.getByRole("menuitem", { name: /^New Window/ });
          await newWindow.focus();
          await page.keyboard.press("Enter");
          await expect(page.getByRole("button", { name: "Terminal", exact: true })).toBeVisible();
        }
      }
    });

    test(`compact ${theme} menu bar`, async ({ page }) => {
      await useCanvasMode(page);
      await useMenuBarTheme(page, theme);
      await page.setViewportSize({ width: 900, height: 900 });
      await expectResponsiveMenuBar(page, 900);
      await expect(page).toHaveScreenshot(`menu-bar-compact-${theme}.png`, {
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});
