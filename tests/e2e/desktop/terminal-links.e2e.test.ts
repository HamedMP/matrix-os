import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
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
      args: [DESKTOP_MAIN],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /continue with github/i }).click();
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    await page.getByText("Shells").first().waitFor({ timeout: 10_000 });
    await page.locator(".xterm-helper-textarea").last().focus();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  async function rightClickTerminalText(text: string): Promise<void> {
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
    await page.mouse.click(x, y, { button: "right" });
  }

  it("uses Matrix actions for plain-text and OSC 8 links without xterm confirmation", async () => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    const plainUrl = "https://example.org/desktop-terminal";
    await page.keyboard.type(plainUrl);
    await page.keyboard.press("Enter");
    await rightClickTerminalText(plainUrl);
    await page.getByRole("menu", { name: "Link actions" }).waitFor();
    await page.getByRole("menuitem", { name: "Copy Link" }).click();

    const oscUrl = "https://example.org/osc-terminal";
    const oscLabel = "Open OSC link";
    gateway.sendTerminalOutput(`\r\n\u001b]8;;${oscUrl}\u0007${oscLabel}\u001b]8;;\u0007\r\n`);
    await rightClickTerminalText(oscLabel);
    await page.getByRole("menu", { name: "Link actions" }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "19-terminal-link-actions.png") });
    await page.getByRole("menuitem", { name: "Copy Link" }).click();

    expect(dialogs).toEqual([]);
  }, 30_000);
});
