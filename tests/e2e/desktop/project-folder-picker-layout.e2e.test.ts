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
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

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
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("keeps the sticky list header flush with the toolbar while rows scroll beneath it", async () => {
    await page.getByRole("button", { name: "Add project" }).click();
    await page.getByText("Add project", { exact: true }).waitFor();
    await page.getByRole("button", { name: /Existing folder/ }).click();

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
