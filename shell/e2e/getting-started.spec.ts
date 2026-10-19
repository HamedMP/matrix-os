import { test, expect, type Page } from "@playwright/test";

async function openShell(page: Page, presentation: "canvas" | "desktop") {
  await page.setExtraHTTPHeaders({ "x-matrix-platform-session": "platform" });
  await page.addInitScript((mode) => {
    localStorage.setItem("matrix-os-desktop-mode", JSON.stringify({ state: { mode }, version: 0 }));
    localStorage.setItem("matrix:getting-started:auto-opened:web:%2F", "1");
  }, presentation);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("onboarding-status") ? { complete: true }
      : path.endsWith("/shell/bootstrap") ? { layout: { windows: [] }, apps: [], modules: [], icons: {} }
      : path.endsWith("/github/status") ? { installed: true, authenticated: false, user: null }
      : path.endsWith("/credentials/status") ? { agents: [] }
      : path.endsWith("/projects") ? { projects: [] }
      : path.endsWith("/chats") ? { items: [] }
      : path.endsWith("/identity") ? { handle: "test", displayName: "Test User" }
      : path.includes("/settings") ? { background: { type: "pattern" }, dock: { position: "left", size: 56, iconSize: 40, autoHide: false }, pinnedApps: [], hasKey: true }
      : [];
    return route.fulfill({ json: body });
  });
  await page.route("**/billing/status**", (route) => route.fulfill({ json: { access: { runtimeProxyAllowed: false } } }));
  await page.route("**/ws/**", (route) => route.abort());
  await page.goto("/");
}

for (const presentation of ["canvas", "desktop"] as const) {
  test(`${presentation}: Help handoff keeps one checklist anchored to the title bar`, async ({ page }, testInfo) => {
    await openShell(page, presentation);
    const help = page.getByRole("button", { name: "Help", exact: true });
    const menu = page.getByRole("dialog", { name: "Help", exact: true });
    const card = page.getByRole("dialog", { name: "Getting started", exact: true });
    for (const width of [1440, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await help.click();
      await expect(menu).toBeVisible();
      const row = page.getByRole("button", { name: /Getting started —/ });
      await row.focus();
      await row.press("Enter");
      await expect(card).toBeVisible();
      await expect(menu).toBeHidden();
      const anchor = await help.boundingBox();
      await expect.poll(async () => {
        const bounds = await card.boundingBox();
        return Math.abs(bounds!.x + bounds!.width - anchor!.x - anchor!.width);
      }).toBeLessThan(2);
      const bounds = await card.boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
      expect(bounds!.y).toBeLessThan(anchor!.y + anchor!.height + 16);
      await page.screenshot({ path: testInfo.outputPath(`${presentation}-${width}-checklist.png`) });
      await help.click();
      await expect(card).toBeHidden();
      await expect(menu).toBeVisible();
      await help.click();
    }
  });

  test(`${presentation}: checklist yields to launcher and command palette`, async ({ page }, testInfo) => {
    await openShell(page, presentation);
    await page.getByRole("button", { name: "Help", exact: true }).click();
    const trigger = page.locator('button[aria-label^="Getting started —"]');
    await expect(trigger).toBeVisible();
    await trigger.click();
    const card = page.getByRole("dialog", { name: "Getting started" });
    await expect(card).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${presentation}-checklist.png`) });
    await page.keyboard.press("F3");
    await expect(page.locator("[data-launchpad], [data-mission-control]")).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect(trigger).toBeDisabled();
    // Let the two-frame entrance latch and staggered app tiles settle.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.waitForFunction(() => {
      const launcher = document.querySelector("[data-launchpad], [data-mission-control]");
      return launcher && launcher.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
    });
    await page.screenshot({ path: testInfo.outputPath(`${presentation}-launcher.png`) });
    await page.keyboard.press("Escape");
    await expect(card).toBeVisible();
    await expect(trigger).not.toBeFocused();
    await page.keyboard.press("Meta+k");
    const search = page.getByRole("combobox");
    await expect(search).toBeFocused();
    await expect(card).toHaveCount(0);
    await search.fill("Terminal");
    await page.screenshot({ path: testInfo.outputPath(`${presentation}-palette.png`) });
    await page.keyboard.press("Escape");
    await expect(card).toBeVisible();
    await expect(trigger).not.toBeFocused();
    await page.getByRole("button", { name: "Help", exact: true }).click();
    await page.keyboard.press("F3");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-launchpad], [data-mission-control]")).toHaveCount(0);
    await expect(card).toHaveCount(0);
  });
}
