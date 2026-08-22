import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
const SCREENSHOT_DIR = resolve(__dirname, "../../../desktop/screenshots");
const requireDesktop = createRequire(resolve(__dirname, "../../../desktop/package.json"));
const ELECTRON_PATH = requireDesktop("electron") as string;
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("desktop update experience", () => {
  let app: ElectronApplication;
  let gateway: StubGateway;
  let page: Page;
  let userDataDir: string;

  function attachedNativeViewCount(): Promise<number> {
    return app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window?.contentView.children.length ?? 0;
    });
  }

  function seedRelease(version: string): void {
    const statePath = join(userDataDir, "state.json");
    const state = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>
      : {};
    writeFileSync(statePath, JSON.stringify({
      ...state,
      desktopUpdateRelease: {
        version,
        releaseDate: "2026-08-11T09:00:00.000Z",
        notes: [
          "## New",
          "",
          "- Automatic background downloads for Matrix OS updates",
          "- One-click restart and install from the sidebar",
          "",
          "## Improved",
          "",
          "- Release notes now open inside the desktop app after an update",
        ].join("\n"),
        shown: false,
      },
    }));
  }

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-os-update-evidence-"));
    gateway = await startStubGateway();
    app = await _electron.launch({
      executablePath: ELECTRON_PATH,
      args: [DESKTOP_MAIN],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    const runningVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
    seedRelease(runningVersion);
    await page.reload();
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("opens visible update status from Check for Updates in the application menu", async () => {
    const applicationMenu = await app.evaluate(({ app: electronApp, Menu }) => {
      const root = Menu.getApplicationMenu();
      const appMenu = root?.items[0];
      appMenu?.submenu?.items.find((item) => item.label === "Check for Updates…")?.click();
      return {
        appName: electronApp.name,
        appMenuLabel: appMenu?.label,
        labels: appMenu?.submenu?.items.map((item) => item.label) ?? [],
      };
    });

    expect(applicationMenu.appName).toBe("Matrix OS");
    expect(applicationMenu.appMenuLabel).toBe("Matrix OS");
    expect(applicationMenu.labels).toContain("Check for Updates…");
    await page.getByRole("dialog", { name: "Software Update" }).waitFor({ timeout: 10_000 });
    await page.getByRole("heading", {
      name: "Updates are unavailable in this preview",
    }).waitFor();
    await expect.poll(attachedNativeViewCount).toBe(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-441-manual-update-dialog.png") });
    await page.getByRole("button", { name: "Close" }).click();
    await expect.poll(attachedNativeViewCount).toBe(0);
  });

  it("shows What's New after launch and places Update at the right edge of the account row", async () => {
    await page.getByRole("heading", { name: "What's New", level: 1 }).waitFor({ timeout: 10_000 });
    await page.getByText("Automatic background downloads for Matrix OS updates").waitFor();
    await page.mouse.move(80, 400);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-291-whats-new.png") });

    await page.setViewportSize({ width: 880, height: 560 });
    const compactDialog = await page.getByRole("dialog").boundingBox();
    expect(compactDialog).not.toBeNull();
    expect(compactDialog?.x ?? 0).toBeGreaterThanOrEqual(16);
    expect((compactDialog?.x ?? 0) + (compactDialog?.width ?? 0)).toBeLessThanOrEqual(864);
    expect((compactDialog?.y ?? 0) + (compactDialog?.height ?? 0)).toBeLessThanOrEqual(560);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByRole("button", { name: "Close What's New" }).click();
    await expect.poll(attachedNativeViewCount).toBe(1);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("update:state-changed", {
        status: "ready",
        version: "0.2.0",
        progress: 100,
        release: {
          version: "0.2.0",
          notes: "## Improved\n\n- Faster updates",
        },
      });
    });

    const update = page.getByRole("button", { name: "Update Matrix OS to 0.2.0" });
    await update.waitFor({ timeout: 10_000 });
    const account = page.getByRole("button", { name: "Open account menu" });
    const updateBox = await update.boundingBox();
    const accountBox = await account.boundingBox();
    expect(accountBox).not.toBeNull();
    expect(updateBox).not.toBeNull();
    expect(updateBox?.x ?? 0).toBeGreaterThan((accountBox?.x ?? 0) + (accountBox?.width ?? 0));
    expect(updateBox?.y ?? 0).toBeGreaterThanOrEqual(accountBox?.y ?? 0);
    expect((updateBox?.y ?? 0) + (updateBox?.height ?? 0)).toBeLessThanOrEqual(
      (accountBox?.y ?? 0) + (accountBox?.height ?? 0),
    );
    expect(Math.abs((updateBox?.width ?? 0) - (updateBox?.height ?? 0))).toBeLessThanOrEqual(2);
    expect(updateBox?.width ?? 0).toBeLessThanOrEqual(28);
    const updateIconBox = await update.locator("svg").boundingBox();
    expect(updateIconBox?.width ?? 0).toBeLessThanOrEqual(13);
    expect(await update.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      "rgb(47, 155, 255)",
    );
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-291-update-ready.png") });

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    const collapsedUpdateBox = await update.boundingBox();
    expect(collapsedUpdateBox).not.toBeNull();
    expect(Math.abs((collapsedUpdateBox?.width ?? 0) - (collapsedUpdateBox?.height ?? 0))).toBeLessThanOrEqual(2);
    expect(collapsedUpdateBox?.width ?? 0).toBeLessThanOrEqual(28);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-291-update-ready-collapsed.png") });
  }, 30_000);
});
