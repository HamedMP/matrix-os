import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
const desktopRequire = createRequire(resolve(__dirname, "../../../desktop/package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const SCREENSHOT_DIR = resolve(__dirname, "../../../desktop/screenshots/mat-328");
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("MAT-328 retained Terminal route containment", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "mat-328-e2e-"));
    app = await _electron.launch({
      executablePath: ELECTRON_EXECUTABLE,
      args: [DESKTOP_MAIN],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch (err: unknown) {
      console.warn("[mat-328-e2e] app close failed:", err instanceof Error ? err.message : String(err));
    }
    await gateway?.close();
    if (userDataDir) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch (err: unknown) {
        console.warn("[mat-328-e2e] user-data cleanup failed:", err instanceof Error ? err.message : String(err));
      }
    }
  });

  it("keeps a live Terminal mounted without painting or receiving interaction beneath peer routes", async () => {
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();

    const terminalPane = page.locator('[data-tab-kind="terminals"]');
    const terminalViewport = terminalPane.locator("[data-terminal-viewport]");
    await expect.poll(() => terminalViewport.textContent(), { timeout: 10_000 }).toContain("stub-shell$");
    await terminalViewport.click();
    await page.keyboard.type("mat328-retained");
    await page.keyboard.press("Enter");
    await expect.poll(() => terminalViewport.textContent(), { timeout: 10_000 }).toContain("mat328-retained");
    await expect.poll(() => terminalViewport.textContent(), { timeout: 10_000 }).toContain("ran!");
    expect(gateway.state.terminalInputs.join("")).toContain("mat328-retained");

    const routes = [
      { label: "Apps", kind: "apps", screenshot: "01-apps-contained.png" },
      { label: "Plugins", kind: "plugins", screenshot: "02-plugins-contained.png" },
      { label: "Chat", kind: "chat", screenshot: "03-chat-contained.png" },
    ];

    for (const route of routes) {
      await page.locator("aside button", { hasText: route.label }).first().click();
      const routePane = page.locator(`[data-tab-kind="${route.kind}"][data-active="true"]`);
      await routePane.waitFor({ state: "visible", timeout: 10_000 });

      const retainedState = await terminalPane.evaluate((pane) => {
        const style = getComputedStyle(pane);
        const artifactSelector = [
          'nav[aria-label="Terminal breadcrumb"]',
          "header",
          "[data-terminal-viewport]",
          ".xterm-cursor-layer",
        ].join(",");
        return {
          display: style.display,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
          ariaHidden: pane.getAttribute("aria-hidden"),
          inert: pane.hasAttribute("inert"),
          ownsFocus: pane.contains(document.activeElement),
          paintedArtifacts: Array.from(pane.querySelectorAll(artifactSelector))
            .filter((element) => element.getClientRects().length > 0).length,
        };
      });
      const routeBackground = await routePane.evaluate((pane) => getComputedStyle(pane).backgroundColor);

      expect(retainedState).toEqual({
        display: "none",
        visibility: "hidden",
        pointerEvents: "none",
        ariaHidden: "true",
        inert: true,
        ownsFocus: false,
        paintedArtifacts: 0,
      });
      expect(routeBackground).not.toBe("transparent");
      expect(routeBackground).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: join(SCREENSHOT_DIR, route.screenshot) });

      await page.locator("aside button", { hasText: "Terminal" }).first().click();
      await expect.poll(() => terminalPane.getAttribute("data-active")).toBe("true");
      await expect.poll(() => terminalViewport.textContent(), { timeout: 10_000 }).toContain("mat328-retained");
    }
  }, 40_000);
});
