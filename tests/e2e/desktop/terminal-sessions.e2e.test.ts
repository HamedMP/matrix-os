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
    try {
      await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 15_000 });
    } catch (error: unknown) {
      await page.screenshot({ path: join(SCREENSHOT_DIR, "terminal-session-boot-failure.png") });
      throw new Error(`Desktop shell did not become ready: ${await page.locator("body").innerText()}`, { cause: error });
    }
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

  it("opens the compact shell-theme picker through Electron hit testing", async () => {
    await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick({ timeout: 5_000 });
    const terminalWindow = page.getByRole("dialog", { name: "Terminal window" });
    const fullWidthChrome = terminalWindow.locator('[data-os-window-chrome-placement="full-width"]');
    await fullWidthChrome.waitFor({ timeout: 5_000 });
    expect(await fullWidthChrome.textContent()).toContain("Terminal");

    await terminalWindow.getByRole("button", { name: "Choose session type" }).click();
    for (const agent of ["Claude Code", "Codex", "OpenCode", "Pi"]) {
      await page.getByRole("menuitem", { name: new RegExp(agent) }).waitFor({ timeout: 5_000 });
    }
    await page.keyboard.press("Escape");

    const session = page.getByRole("button", { name: "Open matrix-task-1" });
    await session.waitFor({ timeout: 10_000 });
    await session.click({ timeout: 5_000 });

    const trigger = page.getByRole("button", { name: "Shell theme" });
    await trigger.waitFor({ timeout: 5_000 });
    expect(await trigger.isEnabled()).toBe(true);
    const [dragBounds, triggerBounds] = await Promise.all([
      terminalWindow.locator("[data-os-window-gesture-layer]").boundingBox(),
      trigger.boundingBox(),
    ]);
    expect(dragBounds).not.toBeNull();
    expect(triggerBounds).not.toBeNull();
    expect(triggerBounds!.y).toBeGreaterThanOrEqual(dragBounds!.y + dragBounds!.height);
    await trigger.click();

    await page.getByRole("menu", { name: "Shell theme" }).waitFor({ timeout: 5_000 });
    await page.getByRole("menuitemradio", { name: /P10k Rainbow/ }).waitFor({ timeout: 5_000 });
    await page.keyboard.press("Escape");
  });

  it("renders the Figma-aligned list and preserves the mounted terminal buffer across list-detail navigation", async () => {
    await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick();
    await page.getByRole("heading", { name: "Terminal" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-300-terminal-session-list.png") });
    await page.getByRole("button", { name: "Open matrix-task-1" }).waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Open matrix-review" }).click();
    await page.getByRole("heading", { name: "matrix-review" }).waitFor({ timeout: 5_000 });
    await page.getByText("Waiting", { exact: true }).waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Open matrix-closed" }).click();
    await page.getByRole("heading", { name: "matrix-closed" }).waitFor({ timeout: 5_000 });
    await page.getByText("Closed", { exact: true }).waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.getByText("Active", { exact: true }).waitFor({ timeout: 5_000 });

    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.getByRole("heading", { name: "matrix-task-1" }).waitFor({ timeout: 5_000 });
    expect(await page.getByRole("navigation", { name: "Terminal breadcrumb" }).count()).toBe(0);
    const activePane = page.locator("section[data-retained-pane][data-active='true']");
    await activePane.getByText(/Started at .*main computer/).waitFor({ timeout: 5_000 });
    const viewport = activePane.locator("[data-terminal-surface]");
    await viewport.waitFor({ timeout: 5_000 });
    await viewport.evaluate((element) => { element.setAttribute("data-mat-300-identity", "preserved"); });
    await expectTerminalViewportToFill(viewport);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-300-terminal-session-detail.png") });

    await page.getByRole("button", { name: "Open matrix-review" }).click();
    await page.getByRole("heading", { name: "matrix-review" }).waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await expect.poll(() => viewport.getAttribute("data-mat-300-identity")).toBe("preserved");
    await expectTerminalViewportToFill(viewport);

    await page.getByRole("button", { name: "New shell session" }).click();
    const newSessionViewport = page.locator(
      "section[data-retained-pane][data-active='true'] [data-terminal-surface]",
    );
    await newSessionViewport.waitFor({ timeout: 5_000 });
    await expectTerminalViewportToFill(newSessionViewport);
  }, 30_000);
});
