import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const ROOT = resolve(__dirname, "../../..");
const MAIN = join(ROOT, "desktop/out/main/index.js");
const electronPath = createRequire(join(ROOT, "desktop/package.json"))("electron") as string;
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(MAIN)) {
  throw new Error("Required terminal snapshot E2E needs desktop/out/main/index.js; run the desktop build first");
}
const suite = existsSync(MAIN) ? describe : describe.skip;

suite("Electron Desktop terminal snapshot recovery", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(join(ROOT, "output/playwright/terminal-snapshot"), { recursive: true });
    gateway = await startStubGateway({
      // Raw LF emulates an older host dump; the production Electron socket
      // must normalize it and replace the stub shell prompt already queued.
      terminalSnapshotAnsi: "\x1b[38;2;218;119;86m ▐▛███▜▌  Terminal snapshot restored\n ▝▜█████▛▘  Three aligned rows\n   ▘▘ ▝▝   ~/projects\x1b[0m\n\nReady for input > ",
    });
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-terminal-snapshot-"));
    app = await _electron.launch({
      executablePath: electronPath,
      args: [MAIN],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: userDataDir },
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /create account/i }).waitFor({ timeout: 15_000 });
    await page.evaluate(async () => { await window.operator.invoke("auth:start-device-flow", {}); });
    await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick({ timeout: 15_000 });
    await page.getByRole("button", { name: "Open matrix-task-1" }).click({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("replaces stale output with aligned rows and no false output-gap marker", async () => {
    const viewport = page.getByTestId("desktop-terminal-app")
      .locator('[data-retained-pane][data-active="true"] [data-terminal-surface]');
    const rows = viewport.locator(".xterm-accessibility-tree > div");
    await expect.poll(async () => (await rows.allTextContents()).join("\n"))
      .toContain("Terminal snapshot restored");
    const text = (await rows.allTextContents()).join("\n");
    expect(text).not.toContain("stub-shell$");
    expect(text).not.toContain("output gap");
    const visibleRows = await rows.allTextContents();
    expect(visibleRows.find((row) => row.includes("Three aligned rows"))?.indexOf("▝"))
      .toBe(1);
    expect(visibleRows.find((row) => row.includes("~/projects"))?.indexOf("▘"))
      .toBe(3);
    await page.getByRole("dialog", { name: "Terminal window" })
      .getByRole("button", { name: "Maximize", exact: true }).click();
    await viewport.click({ position: { x: 500, y: 300 } });
    await page.screenshot({ path: join(ROOT, "output/playwright/terminal-snapshot/restored.png") });
  });
});
