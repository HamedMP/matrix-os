import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const REPOSITORY_ROOT = resolve(__dirname, "../../..");
const DESKTOP_ROOT = join(REPOSITORY_ROOT, "desktop");
const DESKTOP_MAIN = join(DESKTOP_ROOT, "out/main/index.js");
const desktopRequire = createRequire(join(DESKTOP_ROOT, "package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const SCREENSHOT_DIR = join(REPOSITORY_ROOT, "output/playwright/mat-300");
const DEBUG_PORT = 9232;

interface TerminalViewportGeometry {
  frameBackground: string;
  headerBottom: number;
  hostBottom: number;
  hostHeight: number;
  hostLeft: number;
  hostPaddingLeft: string;
  hostPaddingTop: string;
  hostTop: number;
  hostWidth: number;
  rootBackground: string;
  rootBottom: number;
  rootHeight: number;
  rootLeft: number;
  rootTop: number;
  rootWidth: number;
  viewportBackground: string;
}

async function readTerminalViewportGeometry(viewport: Locator): Promise<TerminalViewportGeometry> {
  await viewport.locator(".xterm").waitFor();
  return viewport.evaluate((host) => {
    const frame = host.closest("section");
    const header = frame?.querySelector("header");
    const root = host.querySelector<HTMLElement>(".xterm");
    const xtermViewport = host.querySelector<HTMLElement>(".xterm-viewport");
    if (!(frame instanceof HTMLElement) || !(header instanceof HTMLElement) || !root || !xtermViewport) {
      throw new Error("terminal viewport geometry is incomplete");
    }
    const headerRect = header.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const hostStyle = getComputedStyle(host);
    return {
      frameBackground: getComputedStyle(host).backgroundColor,
      headerBottom: headerRect.bottom,
      hostBottom: hostRect.bottom,
      hostHeight: hostRect.height,
      hostLeft: hostRect.left,
      hostPaddingLeft: hostStyle.paddingLeft,
      hostPaddingTop: hostStyle.paddingTop,
      hostTop: hostRect.top,
      hostWidth: hostRect.width,
      rootBackground: getComputedStyle(root).backgroundColor,
      rootBottom: rootRect.bottom,
      rootHeight: rootRect.height,
      rootLeft: rootRect.left,
      rootTop: rootRect.top,
      rootWidth: rootRect.width,
      viewportBackground: getComputedStyle(xtermViewport).backgroundColor,
    };
  });
}

async function expectTerminalViewportToFill(viewport: Locator): Promise<TerminalViewportGeometry> {
  const geometry = await readTerminalViewportGeometry(viewport);
  expect(Math.abs(geometry.hostTop - geometry.headerBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.rootTop - geometry.hostTop - 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.rootLeft - geometry.hostLeft - 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.rootBottom - geometry.hostBottom + 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.rootWidth - geometry.hostWidth + 32)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.rootHeight - geometry.hostHeight + 32)).toBeLessThanOrEqual(1);
  expect(geometry.hostPaddingLeft).toBe("16px");
  expect(geometry.hostPaddingTop).toBe("16px");
  expect(geometry.rootBackground).toBe(geometry.frameBackground);
  expect(geometry.viewportBackground).toBe(geometry.frameBackground);
  return geometry;
}

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
    await page.evaluate(async () => {
      await window.operator.invoke("auth:start-device-flow", {});
    });
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

  it("renders the Figma-aligned list and preserves the mounted terminal buffer across list-detail navigation", async () => {
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    await page.getByRole("heading", { name: "Terminal" }).waitFor({ timeout: 10_000 });
    await page.getByText("Active", { exact: true }).waitFor();
    await page.getByText("Waiting", { exact: true }).waitFor();
    await page.getByText("Closed", { exact: true }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-300-terminal-session-list.png") });

    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.getByRole("heading", { name: "matrix-task-1" }).waitFor();
    expect(await page.getByRole("navigation", { name: "Terminal breadcrumb" }).count()).toBe(0);
    await page.getByText(/Started at .*main computer/).waitFor();
    const viewport = page.locator("section[aria-hidden='false'] [data-terminal-surface]");
    await viewport.evaluate((element) => { element.setAttribute("data-mat-300-identity", "preserved"); });
    const initialGeometry = await expectTerminalViewportToFill(viewport);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-300-terminal-session-detail.png") });

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect.poll(async () => (await readTerminalViewportGeometry(viewport)).hostWidth)
      .toBeGreaterThan(initialGeometry.hostWidth + 20);
    const collapsedGeometry = await expectTerminalViewportToFill(viewport);

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("desktop window is unavailable");
      const [width, height] = window.getSize();
      window.setSize(Math.max(900, width - 140), Math.max(650, height - 100));
    });
    await expect.poll(async () => {
      const resized = await readTerminalViewportGeometry(viewport);
      return Math.abs(resized.hostWidth - collapsedGeometry.hostWidth)
        + Math.abs(resized.hostHeight - collapsedGeometry.hostHeight);
    }).toBeGreaterThan(20);
    await expectTerminalViewportToFill(viewport);

    await page.getByRole("button", { name: "Back to terminal sessions" }).click();
    await page.getByRole("heading", { name: "Terminal" }).waitFor();
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await expect.poll(() => viewport.getAttribute("data-mat-300-identity")).toBe("preserved");
    await expectTerminalViewportToFill(viewport);

    await page.getByRole("button", { name: "Back to terminal sessions" }).click();
    await page.getByRole("button", { name: "New shell" }).click();
    const newSessionViewport = page.locator(
      'section[aria-hidden="false"] [data-terminal-surface]',
    );
    await newSessionViewport.waitFor();
    await expectTerminalViewportToFill(newSessionViewport);
  }, 30_000);
});
