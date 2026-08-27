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
const SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright/mat-335-regression");
const hasDesktopBuild = existsSync(DESKTOP_MAIN);

if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !hasDesktopBuild) {
  throw new Error(`Required Desktop E2E build is missing: ${DESKTOP_MAIN}`);
}

const suite = hasDesktopBuild ? describe : describe.skip;

async function closeElectronApp(app: ElectronApplication): Promise<void> {
  const electronProcess = app.process();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const closedGracefully = await Promise.race([
    app.close().then(() => true),
    new Promise<false>((resolve) => {
      closeTimer = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  if (closeTimer) clearTimeout(closeTimer);
  if (closedGracefully) return;

  if (electronProcess.exitCode === null) electronProcess.kill("SIGKILL");
  if (electronProcess.exitCode !== null) return;

  await new Promise<void>((resolve) => {
    const exitTimer = setTimeout(resolve, 5_000);
    electronProcess.once("exit", () => {
      clearTimeout(exitTimer);
      resolve();
    });
  });
}

suite("Desktop Add Project compact folder picker", () => {
  let app: ElectronApplication;
  let gateway: StubGateway;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway({
      rootFileEntries: Array.from({ length: 24 }, (_, index) => ({
        name: `workspace-${String(index + 1).padStart(2, "0")}`,
        type: "directory" as const,
        children: index + 1,
        modified: "2026-08-17T12:18:00.000Z",
      })),
    });
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-os-project-picker-layout-"));
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
    await page.setViewportSize({ width: 1224, height: 768 });
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.getByRole("button", { name: "Projects", exact: true }).waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    if (app) await closeElectronApp(app);
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  }, 30_000);

  it("keeps the sticky list header flush with the toolbar while rows scroll beneath it", async () => {
    await page.getByRole("button", { name: "Projects", exact: true }).dblclick();
    await page.getByRole("button", { name: "New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create a project" });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: /Existing folder/ }).click();
    await dialog.getByText("Connect an existing folder", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "List view" }).click();

    const listHeader = page.getByRole("button", { name: "Sort by name" }).locator("..");
    const listing = page.locator("[data-files-listing]");
    await listHeader.waitFor({ timeout: 10_000 });

    const toolbarBox = await listing.evaluate((element) => {
      const toolbar = element.previousElementSibling;
      if (!(toolbar instanceof HTMLElement)) return null;
      const rect = toolbar.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const initialHeaderBox = await listHeader.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(initialHeaderBox).not.toBeNull();
    expect(Math.abs((initialHeaderBox?.y ?? 0) - ((toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0))))
      .toBeLessThanOrEqual(1);

    await listing.evaluate((element) => {
      element.scrollTop = 96;
    });
    await expect.poll(() => listing.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const scrolledHeaderBox = await listHeader.boundingBox();
    expect(scrolledHeaderBox).not.toBeNull();
    expect(Math.abs((scrolledHeaderBox?.y ?? 0) - ((toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0))))
      .toBeLessThanOrEqual(1);

    await page.screenshot({
      path: join(SCREENSHOT_DIR, "compact-folder-picker-scrolled.png"),
    });
  }, 30_000);
});
