// MAT-346 end-to-end: Project Chats open as a chat-first workspace whose
// contextual tools can be opened, maximized, restored, and closed.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
const desktopRequire = createRequire(resolve(__dirname, "../../../desktop/package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const SCREENSHOT_DIR = resolve(__dirname, "../../../desktop/screenshots/mat-346");
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("project chat contextual inspector", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "mat-346-e2e-"));
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
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch (err: unknown) {
      console.warn("[mat-346 e2e] app close failed:", err instanceof Error ? err.message : String(err));
    }
    await gateway?.close();
    if (userDataDir) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch (err: unknown) {
        console.warn(
          "[mat-346 e2e] user-data cleanup failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  });

  it("keeps chat primary while contextual tools are opened and maximized", async () => {
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
    await page.locator("aside button", { hasText: "Matrix OS" }).last().click();
    await page.getByRole("button", { name: "Chats" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "Chat Investigate auth callback" }).click();
    await page.getByRole("region", { name: "Conversation Investigate auth callback" }).waitFor();

    const showTools = page.getByRole("button", { name: "Show conversation tools" });
    await showTools.waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-chat-first.png") });
    await showTools.click();

    await page.getByRole("tablist", { name: "Conversation tools" }).waitFor();
    await page.getByRole("button", { name: "Open review PR #917" }).click();
    await page.getByText("PR #917 review details").waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "02-contextual-tools.png") });

    await page.getByRole("button", { name: "Maximize conversation tools" }).click();
    await page.getByTestId("inspector-maximized").waitFor();
    await page.getByTestId("conversation-underlay").waitFor({ state: "attached" });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "03-tools-maximized.png") });

    await page.getByRole("button", { name: "Restore conversation tools" }).click();
    await page.getByTestId("inspector-maximized").waitFor({ state: "detached" });
    await page.setViewportSize({ width: 820, height: 720 });
    await page.getByRole("complementary", { name: "Conversation tools" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04-tools-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByRole("tab", { name: /^Terminal\b/ }).click();
    await page.getByText("This chat has no linked terminal session.").waitFor();
    await page.getByRole("tab", { name: /^Activity\b/ }).click();
    await page.getByRole("heading", { name: "Active Threads" }).waitFor();
    await page.getByRole("button", { name: "Close conversation tools" }).click();
    await showTools.waitFor();
  }, 40_000);
});
