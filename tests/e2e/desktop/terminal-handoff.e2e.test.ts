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

const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

async function launchDesktop(
  gatewayUrl: string,
  userDataDir: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    executablePath: ELECTRON_EXECUTABLE,
    args: [DESKTOP_MAIN],
    env: {
      ...process.env,
      OPERATOR_GATEWAY_URL: gatewayUrl,
      OPERATOR_USER_DATA_DIR: userDataDir,
    },
  });
  const page = await app.firstWindow();
  const continueButton = page.getByRole("button", { name: /continue in browser/i });
  const terminalNavigation = page.locator("aside button", { hasText: "Terminal" }).first();
  const needsAuthentication = await Promise.race([
    continueButton.waitFor({ timeout: 15_000 }).then(() => true),
    terminalNavigation.waitFor({ timeout: 15_000 }).then(() => false),
  ]);

  // Start the trusted-core flow directly. This intentionally never invokes
  // shell:open-external, so local UI verification cannot steal focus by
  // opening the stub approval URL in the operator's browser.
  if (needsAuthentication) {
    await page.evaluate(async () => {
      await window.operator.invoke("auth:start-device-flow", {});
    });
  }
  await terminalNavigation.waitFor({ timeout: 15_000 });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1512, 982);
  });
  return { app, page };
}

suite("Desktop Terminal Figma handoff", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-os-mat-454-"));
    ({ app, page } = await launchDesktop(gateway.url, userDataDir));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("matches the overview and keeps only the top-level breadcrumb", async () => {
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    const heading = page.getByRole("heading", { name: "Terminal" });
    await heading.waitFor({ timeout: 10_000 });

    expect(await page.getByRole("navigation", { name: "Breadcrumb" }).count()).toBe(1);
    expect(await page.getByRole("navigation", { name: "Terminal breadcrumb" }).count()).toBe(0);
    expect(await heading.evaluate((element) => getComputedStyle(element).fontSize)).toBe("36px");
    expect(await page.getByRole("button", { name: "Search terminal sessions" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "New shell" }).count()).toBe(1);
    const overview = page.locator("[data-terminal-overview]");
    expect(Math.round((await overview.boundingBox())?.width ?? 0)).toBe(1022);
    const overviewFrame = overview.locator("..").locator("..");
    expect(await overviewFrame.evaluate((element) => getComputedStyle(element).borderRadius))
      .toBe("8px");
    expect(await overviewFrame.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    })).toEqual(["0px", "0px", "0px", "0px"]);
    const overviewScroller = page.locator("[data-terminal-overview]").locator("..");
    expect(await overviewScroller.evaluate((element) => element.scrollWidth)).toBe(
      await overviewScroller.evaluate((element) => element.clientWidth),
    );
    expect(gateway.state.tokenRequests).toBeGreaterThan(0);

    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-454-terminal-overview.png") });
  });

  it("opens dark by default and switches the same retained terminal to light", async () => {
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.getByRole("heading", { name: "matrix-task-1" }).waitFor();
    await page.locator(".xterm").waitFor({ timeout: 10_000 });

    expect(await page.getByRole("navigation", { name: "Terminal breadcrumb" }).count()).toBe(0);
    expect(await page.getByRole("navigation", { name: "Terminal session switcher" }).count()).toBe(0);
    await expect.poll(() => page.getByRole("button", { name: "Use dark Terminal theme" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(await page.getByRole("button", { name: "Use dark Terminal theme" })
      .evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgb(67, 78, 63)");
    const surface = page.locator("section[aria-hidden='false'] [data-terminal-surface]");
    const detailFrame = page.locator("section[aria-hidden='false'] [data-terminal-detail]").locator("..");
    expect(await detailFrame.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    })).toEqual(["0px", "0px", "0px", "0px"]);
    const xterm = page.locator("section[aria-hidden='false'] .xterm");
    await xterm.evaluate((element) => element.setAttribute("data-mat-454-identity", "preserved"));
    expect(await surface.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgb(50, 53, 46)");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-454-terminal-dark.png") });

    await page.getByRole("button", { name: "Use light Terminal theme" }).click();
    await expect.poll(() => page.getByRole("button", { name: "Use light Terminal theme" }).getAttribute("aria-pressed"))
      .toBe("true");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.getByRole("button", { name: "Use light Terminal theme" })
      .evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgb(255, 255, 253)");
    expect(await surface.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgb(255, 255, 253)");
    expect(await xterm.getAttribute("data-mat-454-identity")).toBe("preserved");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-454-terminal-light.png") });

    await app.close();
    ({ app, page } = await launchDesktop(gateway.url, userDataDir));
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    await page.getByRole("heading", { name: "Terminal" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.locator(".xterm").waitFor({ timeout: 10_000 });

    await expect.poll(() => page.getByRole("button", { name: "Use light Terminal theme" }).getAttribute("aria-pressed"))
      .toBe("true");
    const relaunchedSurface = page.locator("section[aria-hidden='false'] [data-terminal-surface]");
    expect(await relaunchedSurface.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgb(255, 255, 253)");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-454-terminal-light-relaunch.png") });
  }, 30_000);
});
