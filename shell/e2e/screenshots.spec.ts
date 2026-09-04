import { test, expect } from "@playwright/test";

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
    await page.route("**/billing/status**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          access: { runtimeProxyAllowed: false },
          trialOffer: { eligible: true, durationDays: 3 },
        }),
      }),
    );
    // Block WebSocket upgrade requests so they don't keep reconnecting
    await page.route("**/ws/**", (route) => route.abort());

    await page.goto("/");
    // Wait for the dock to render (confirms the shell loaded past auth)
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
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
    const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
    await settingsButton.dblclick();
    await page.mouse.move(720, 450);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("settings-panel.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("billing pricing", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).dblclick();
    await page.getByRole("button", { name: "Billing" }).click();
    await expect(page.getByRole("heading", { name: "Choose your Matrix computer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start 3-day trial" })).toBeVisible();
    await page.mouse.move(720, 450);
    await expect(page).toHaveScreenshot("billing-pricing.png", {
      maxDiffPixelRatio: 0.001,
    });
  });

  test("legacy trial keeps its locked Stripe price", async ({ page }) => {
    await page.goto("/?e2e_billing_state=legacy-trial");
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).dblclick();
    await page.getByRole("button", { name: "Billing" }).click();
    await expect(page.getByText("Free trial active")).toBeVisible();
    await expect(page.getByText("Your $20/month subscription starts on Sep 1, 2026.")).toBeVisible();
    await expect(page.getByText(/Your first \$100 monthly charge/)).toHaveCount(0);
    await page.mouse.move(720, 450);
    await expect(page).toHaveScreenshot("billing-legacy-trial.png", {
      maxDiffPixelRatio: 0.001,
    });
  });

  test("billing active provider-neutral", async ({ page }) => {
    await page.goto("/?e2e_billing_state=active");
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).dblclick();
    await page.getByRole("button", { name: "Billing" }).click();
    await expect(page.getByRole("heading", { name: "Builder" })).toBeVisible();
    await expect(page.getByText("Billing", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("$20/month", { exact: true })).toBeVisible();
    await expect(page.getByText("Ashburn, Virginia", { exact: true })).toBeVisible();
    await expect(page.getByText(/\$100/)).toHaveCount(0);
    await expect(page.getByText(/cpx\d+/i)).toHaveCount(0);
    await page.mouse.move(720, 450);
    await expect(page).toHaveScreenshot("billing-active-provider-neutral.png", {
      maxDiffPixelRatio: 0.001,
    });
  });

  test("billing computer plans", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).dblclick();
    await page.getByRole("button", { name: "Billing" }).click();
    await expect(page.getByText("For everyday use")).toBeVisible();
    await expect(page.getByText("For technical work and building")).toBeVisible();
    await expect(page.getByText("For serious, demanding workloads")).toBeVisible();
    await page.getByRole("button", { name: /^Max\b/ }).click();
    await page.mouse.move(720, 450);
    await expect(page).toHaveScreenshot("billing-computer-picker.png", {
      maxDiffPixelRatio: 0.001,
    });
  });

  test("billing region picker", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).dblclick();
    await page.getByRole("button", { name: "Billing" }).click();
    await page.getByRole("button", { name: "Advanced settings" }).click();
    await page.getByRole("button", { name: "Change server location" }).click();
    await expect(page.getByText("Choose a server location")).toBeVisible();
    await page.getByText("Hillsboro, Oregon").evaluate((element) => {
      element.scrollIntoView({ block: "center" });
    });
    await page.mouse.move(720, 450);
    await expect(page).toHaveScreenshot("billing-region-picker.png", {
      maxDiffPixelRatio: 0.001,
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

    await page.getByRole("button", { name: "Settings", exact: true }).dblclick();
    await page.getByRole("button", { name: "Billing" }).click();
    await expect(page.getByRole("heading", { name: "Choose your Matrix computer" })).toBeVisible();
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
    await page.getByRole("button", { name: "Settings", exact: true }).dblclick();
    await page.getByText("Agent", { exact: true }).click();
    await expect(page.getByText("Chat agent", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Install OpenClaw" })).toBeVisible();
    await page.mouse.move(720, 450);
    await expect(page).toHaveScreenshot("agent-settings.png", {
      animations: "allow",
      maxDiffPixelRatio: 0.001,
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

});
