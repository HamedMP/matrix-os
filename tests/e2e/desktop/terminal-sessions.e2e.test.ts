import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const REPOSITORY_ROOT = resolve(__dirname, "../../..");
const DESKTOP_ROOT = join(REPOSITORY_ROOT, "desktop");
const DESKTOP_MAIN = join(DESKTOP_ROOT, "out/main/index.js");
const desktopRequire = createRequire(join(DESKTOP_ROOT, "package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const SCREENSHOT_DIR = join(REPOSITORY_ROOT, "docs/review-assets");
const DEBUG_PORT = 9232;

const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("Desktop terminal session handoff", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-os-mat-300-"));
    app = await _electron.launch({
      executablePath: ELECTRON_EXECUTABLE,
      args: [DESKTOP_MAIN, `--remote-debugging-port=${DEBUG_PORT}`],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /continue in browser/i }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("runs the exact built worktree and exposes its debug renderer", async () => {
    const identity = await app.evaluate(({ app: electronApp }) => ({
      appPath: electronApp.getAppPath(),
      cwd: process.cwd(),
      userData: electronApp.getPath("userData"),
    }));
    expect(identity.appPath).toBe(join(DESKTOP_ROOT, "out/main"));
    expect(identity.cwd).toBe(REPOSITORY_ROOT);
    expect(identity.userData).toBe(userDataDir);
    expect(page.url()).toContain("desktop/out/renderer/index.html");

    await expect.poll(async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).catch(() => null);
      return response?.ok ?? false;
    }).toBe(true);
  });

  it("renders the Figma-aligned list and preserves the live terminal across list-detail navigation", async () => {
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    await page.getByRole("heading", { name: "Terminal" }).waitFor({ timeout: 10_000 });
    await page.getByText("Active", { exact: true }).waitFor();
    await page.getByText("Waiting", { exact: true }).waitFor();
    await page.getByText("Closed", { exact: true }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-300-terminal-session-list.png") });

    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.getByRole("navigation", { name: "Terminal breadcrumb" }).getByText("matrix-task-1").waitFor();
    await page.getByText(/Started at .*main computer/).waitFor();
    const viewport = page.locator("[data-terminal-viewport]");
    await viewport.evaluate((element) => { element.setAttribute("data-mat-300-identity", "preserved"); });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-300-terminal-session-detail.png") });

    await page.getByRole("button", { name: "Back to terminal sessions" }).click();
    await page.getByRole("heading", { name: "Terminal" }).waitFor();
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await expect.poll(() => viewport.getAttribute("data-mat-300-identity")).toBe("preserved");
  }, 30_000);
});
