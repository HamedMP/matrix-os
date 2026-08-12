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
const SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright/mat-299");
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("persistent Hermes Desktop conversations", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "mat-299-desktop-"));
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
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("discovers, switches, and creates canonical conversations", async () => {
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.locator("aside button", { hasText: "Chat" }).first().waitFor({ timeout: 15_000 });
    await page.locator("aside button", { hasText: "Chat" }).first().click();

    await page.getByRole("heading", { name: "Conversations" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).waitFor();
    await page.getByRole("button", {
      name: "Verify provider switching remains intact conversation",
    }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-conversation-index.png") });

    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).click();
    await page.getByRole("navigation", { name: "Chat breadcrumb" }).waitFor();
    await page.getByText("The canonical Gateway conversation is ready to continue.").waitFor();
    await expect.poll(() => gateway.state.kernelMessages).toContainEqual({
      type: "switch_session",
      sessionId: "hermes-desktop-index",
    });

    await page.getByRole("navigation", { name: "Chat breadcrumb" })
      .getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", {
      name: "Verify provider switching remains intact conversation",
    }).click();
    await page.getByText("Provider controls remain independent from the conversation index.").waitFor();
    await expect.poll(() => gateway.state.kernelMessages).toContainEqual({
      type: "switch_session",
      sessionId: "hermes-provider-check",
    });

    await page.getByRole("navigation", { name: "Chat breadcrumb" })
      .getByRole("button", { name: "Chat" }).click();
    await page.locator('section[aria-labelledby="conversation-index-title"]')
      .getByRole("button", { name: "New conversation" }).click();
    await page.getByRole("textbox", { name: "Do anything" }).waitFor();
    await page.getByRole("navigation", { name: "Chat breadcrumb" })
      .getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New conversation conversation" }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "02-new-conversation-index.png") });
  }, 40_000);
});
