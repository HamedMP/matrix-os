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
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("native Desktop Terminal links", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "operator-terminal-links-"));
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
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    await page.getByRole("heading", { name: "Terminal" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.locator(".xterm-helper-textarea").last().focus();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  async function clickTerminalText(
    text: string,
    button: "left" | "right",
  ): Promise<void> {
    const row = page.locator('.xterm-accessibility-tree [role="listitem"]', {
      hasText: text,
    }).last();
    await row.waitFor({ timeout: 10_000 });
    const [rowText, rowBox, screenBox] = await Promise.all([
      row.textContent(),
      row.boundingBox(),
      page.locator(".xterm-screen").last().boundingBox(),
    ]);
    if (!rowText || !rowBox || !screenBox) throw new Error("terminal text geometry unavailable");
    const start = rowText.indexOf(text);
    if (start < 0) throw new Error("terminal text not present in accessibility row");
    const cellWidth = screenBox.width / 80;
    const x = screenBox.x + (start + Math.min(2, text.length - 1) + 0.5) * cellWidth;
    const y = rowBox.y + rowBox.height / 2;
    await page.mouse.move(x, y);
    await page.waitForTimeout(100);
    await page.mouse.click(x, y, { button });
  }

  it("uses Matrix actions for plain-text and OSC 8 links without xterm confirmation", async () => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    const plainUrl = `https://example.org/desktop-terminal/${"segment/".repeat(12)}final-check`;
    const plainLinkTarget = "https://example.org/desktop-terminal/";
    gateway.sendTerminalOutput(`\r\n${plainUrl}\r\n`);
    await page.evaluate(() => {
      Object.defineProperty(window, "__openedTerminalLinks", {
        configurable: true,
        value: [] as string[],
      });
      window.open = ((url?: string | URL) => {
        (window as Window & { __openedTerminalLinks: string[] }).__openedTerminalLinks.push(
          String(url),
        );
        return null;
      }) as typeof window.open;
    });
    await clickTerminalText(plainLinkTarget, "left");
    await expect.poll(() => page.evaluate(
      () => (window as Window & { __openedTerminalLinks: string[] }).__openedTerminalLinks,
    )).toEqual([plainUrl]);

    await clickTerminalText(plainLinkTarget, "right");
    await page.getByRole("menu", { name: "Link actions" }).waitFor();
    await page.getByRole("menuitem", { name: "Copy Link" }).click();

    const oscUrl = "https://example.org/osc-terminal";
    const oscLabel = "Open OSC link";
    gateway.sendTerminalOutput(`\r\n\u001b]8;;${oscUrl}\u0007${oscLabel}\u001b]8;;\u0007\r\n`);
    await clickTerminalText(oscLabel, "left");
    await expect.poll(() => page.evaluate(
      () => (window as Window & { __openedTerminalLinks: string[] }).__openedTerminalLinks,
    )).toEqual([plainUrl, oscUrl]);

    await clickTerminalText(oscLabel, "right");
    await page.getByRole("menu", { name: "Link actions" }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "19-terminal-link-actions.png") });
    await page.getByRole("menuitem", { name: "Copy Link" }).click();

    expect(dialogs).toEqual([]);
  }, 30_000);
});
