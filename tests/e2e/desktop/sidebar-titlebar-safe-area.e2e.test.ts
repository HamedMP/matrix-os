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
const FIGMA_TOPBAR_HEIGHT = 38;
const FIGMA_SURFACE_INSET = 4;
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

  async function expectFigmaSidebarShell(
    viewport: { width: number; height: number },
    viewportName: "normal" | "narrow",
  ): Promise<void> {
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await page.locator("aside").boundingBox())?.width).toBe(240);
    const expandedSurface = await page.getByTestId("mission-control-content-surface").boundingBox();
    expect(expandedSurface).toMatchObject({ x: 240, y: FIGMA_TOPBAR_HEIGHT });
    expect(expandedSurface?.width).toBe(viewport.width - 240 - FIGMA_SURFACE_INSET);
    expect(expandedSurface?.height).toBe(viewport.height - FIGMA_TOPBAR_HEIGHT - FIGMA_SURFACE_INSET);
    expect(await page.locator("aside").evaluate((element) => getComputedStyle(element).borderRightWidth)).toBe("0px");
    const computerSelector = await page.getByRole("button", { name: /Change computer, currently/ }).boundingBox();
    const homeRow = await page.getByRole("button", { name: "Home", exact: true }).boundingBox();
    const accountRow = await page.getByRole("button", { name: "Open account menu" }).boundingBox();
    expect(computerSelector?.height).toBeGreaterThanOrEqual(24);
    expect((computerSelector?.y ?? 0) + ((computerSelector?.height ?? 0) / 2)).toBe(65);
    expect(homeRow?.y).toBe(101);
    expect((accountRow?.y ?? 0) + (accountRow?.height ?? 0)).toBe(viewport.height - 16);
    const headerActions = [];
    for (const label of ["Go back", "Go forward", "Collapse sidebar"]) {
      const action = await page.getByRole("button", { name: label }).boundingBox();
      expect(action?.width).toBeGreaterThanOrEqual(24);
      expect(action?.height).toBeGreaterThanOrEqual(24);
      if (action) headerActions.push(action);
    }
    for (let index = 1; index < headerActions.length; index += 1) {
      const previous = headerActions[index - 1]!;
      const current = headerActions[index]!;
      expect(previous.x + previous.width).toBeLessThanOrEqual(current.x);
    }
    await page.screenshot({
      path: join(SCREENSHOT_DIR, `mat-450-sidebar-expanded-${viewportName}.png`),
    });

    const collapse = page.getByRole("button", { name: "Collapse sidebar" });
    await collapse.focus();
    await page.keyboard.press("Enter");

    await expect.poll(async () => (await page.locator("aside").boundingBox())?.width).toBe(0);
    const sidebarBox = await page.locator("aside").boundingBox();
    const expand = page.getByRole("button", { name: "Expand sidebar" });
    const expandBox = await expand.boundingBox();
    const collapsedSurface = await page.getByTestId("mission-control-content-surface").boundingBox();
    await page.screenshot({
      path: join(SCREENSHOT_DIR, `mat-450-sidebar-collapsed-${viewportName}.png`),
    });

    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox?.width).toBe(0);
    expect(collapsedSurface).toMatchObject({ x: FIGMA_SURFACE_INSET, y: FIGMA_TOPBAR_HEIGHT });
    expect(collapsedSurface?.width).toBe(viewport.width - (FIGMA_SURFACE_INSET * 2));
    expect(collapsedSurface?.height).toBe(viewport.height - FIGMA_TOPBAR_HEIGHT - FIGMA_SURFACE_INSET);
    expect(await page.getByTestId("mission-control-content-surface").evaluate((element) => {
      const style = getComputedStyle(element);
      return { borderRadius: style.borderRadius, borderWidth: style.borderWidth };
    })).toEqual({ borderRadius: "8px", borderWidth: "1px" });
    expect(expandBox).not.toBeNull();
    expect(expandBox?.x ?? 0).toBeGreaterThanOrEqual(MACOS_TITLEBAR_SAFE_X);
    expect(await expand.isVisible()).toBe(true);

    await expand.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Collapse sidebar" }).waitFor();
    await expect.poll(async () => (await page.locator("aside").boundingBox())?.width).toBe(240);
  }

  it("matches the expanded and collapsed Figma sidebar shell", async () => {
    await expectFigmaSidebarShell(
      { width: 1280, height: 820 },
      "normal",
    );
    await expectFigmaSidebarShell(
      { width: 880, height: 560 },
      "narrow",
    );
  }, 30_000);
});
