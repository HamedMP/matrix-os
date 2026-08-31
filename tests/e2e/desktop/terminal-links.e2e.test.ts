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
    const terminalLauncher = page.getByRole("button", { name: "Terminal", exact: true }).first();
    await terminalLauncher.waitFor({ timeout: 15_000 });
    await terminalLauncher.dblclick();
    const terminalInput = page.locator(".xterm-helper-textarea").last();
    await terminalInput.waitFor({ timeout: 10_000 });
    await terminalInput.focus();
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

  it("opens localhost preview links in Matrix Browser without xterm confirmation", async () => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    const plainUrl = "http://localhost:4173";
    const plainLinkTarget = plainUrl;
    gateway.sendTerminalOutput(`\r\n${plainUrl}\r\n`);
    await clickTerminalText(plainLinkTarget, "left");
    const browserAddress = page.getByRole("textbox", { name: "Browser address" });
    await expect.poll(() => browserAddress.inputValue()).toBe(new URL(plainUrl).toString());
    await page.screenshot({ path: join(SCREENSHOT_DIR, "20-matrix-browser-localhost-4173.png") });

    expect(dialogs).toEqual([]);
  }, 30_000);
});
