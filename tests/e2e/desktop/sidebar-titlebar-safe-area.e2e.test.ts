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
const SCREENSHOT_DIR = resolve(__dirname, "../../../desktop/screenshots");
const MACOS_TITLEBAR_SAFE_X = 76;
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("Desktop sidebar macOS titlebar safe area", () => {
  let app: ElectronApplication;
  let gateway: StubGateway;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-os-sidebar-safe-area-"));
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
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({
      timeout: 15_000,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  async function expectSidebarLayoutsClearOfTrafficLights(
    viewport: { width: number; height: number },
    viewportName: "normal" | "narrow",
  ): Promise<void> {
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await page.locator("aside").boundingBox())?.width).toBe(240);
    await page.screenshot({
      path: join(SCREENSHOT_DIR, `mat-449-sidebar-expanded-${viewportName}.png`),
    });

    const collapse = page.getByRole("button", { name: "Collapse sidebar" });
    await collapse.focus();
    await page.keyboard.press("Enter");

    await expect.poll(async () => (await page.locator("aside").boundingBox())?.width).toBe(56);
    const sidebarBox = await page.locator("aside").boundingBox();
    const titlebarBox = await page.locator("aside > .titlebar-drag").boundingBox();
    const dividerBox = await page.getByTestId("collapsed-sidebar-divider").boundingBox();
    const expand = page.getByRole("button", { name: "Expand sidebar" });
    const expandBox = await expand.boundingBox();
    await page.screenshot({
      path: join(SCREENSHOT_DIR, `mat-449-sidebar-collapsed-${viewportName}.png`),
    });

    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox?.width).toBe(56);
    expect(await page.locator("aside").evaluate((element) =>
      window.getComputedStyle(element).borderRightWidth)).toBe("0px");
    expect(titlebarBox).not.toBeNull();
    expect(dividerBox).not.toBeNull();
    expect(dividerBox?.y ?? 0).toBeGreaterThanOrEqual(
      (titlebarBox?.y ?? 0) + (titlebarBox?.height ?? 0),
    );
    expect(expandBox).not.toBeNull();
    expect(expandBox?.x ?? 0).toBeGreaterThanOrEqual(MACOS_TITLEBAR_SAFE_X);
    expect(await expand.isVisible()).toBe(true);

    await expand.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Collapse sidebar" }).waitFor();
    await expect.poll(async () => (await page.locator("aside").boundingBox())?.width).toBe(240);
  }

  it("keeps collapsed sidebar chrome outside native traffic lights", async () => {
    await expectSidebarLayoutsClearOfTrafficLights(
      { width: 1280, height: 820 },
      "normal",
    );
    await expectSidebarLayoutsClearOfTrafficLights(
      { width: 880, height: 560 },
      "narrow",
    );
  }, 30_000);
});
