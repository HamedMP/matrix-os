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
const MAT_322_SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright/mat-322");
const MAT_318_SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright/mat-318");
const VIEWPORT = { width: 1440, height: 900 } as const;
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("persistent Hermes Desktop conversations", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    mkdirSync(MAT_322_SCREENSHOT_DIR, { recursive: true });
    mkdirSync(MAT_318_SCREENSHOT_DIR, { recursive: true });
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
    await page.setViewportSize(VIEWPORT);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("discovers, switches, searches, deletes, and restores canonical conversations", async () => {
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.locator("aside button", { hasText: "Chat" }).first().waitFor({ timeout: 15_000 });
    await page.locator("aside button", { hasText: "Chat" }).first().click();

    await page.getByRole("heading", { name: "Chats" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).waitFor();
    await page.getByRole("button", {
      name: "Verify provider switching remains intact conversation",
    }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-conversation-index.png") });
    await page.screenshot({ path: join(MAT_322_SCREENSHOT_DIR, "01-chats-index-wide.png") });

    await page.getByRole("button", { name: "Search chats" }).click();
    await page.getByRole("searchbox", { name: "Search chats" }).fill("provider");
    await page.getByRole("button", {
      name: "Verify provider switching remains intact conversation",
    }).waitFor();
    await expect.poll(() => page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).count()).toBe(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "02-conversation-search.png") });
    await page.getByRole("searchbox", { name: "Search chats" }).fill("no such chat");
    await page.getByRole("heading", { name: "No matching chats" }).waitFor();
    await page.getByRole("searchbox", { name: "Search chats" }).fill("provider");
    await page.getByRole("searchbox", { name: "Search chats" }).press("Escape");

    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).click();
    await page.getByText("The canonical Gateway conversation is ready to continue.").waitFor();
    await page.screenshot({ path: join(MAT_322_SCREENSHOT_DIR, "02-active-conversation-wide.png") });
    await page.getByRole("button", { name: "Resources" }).click();
    await page.getByRole("complementary", { name: "Resources" }).waitFor();
    await page.screenshot({ path: join(MAT_322_SCREENSHOT_DIR, "03-resources-wide.png") });
    await page.getByRole("button", { name: "Close Resources" }).click();
    await expect.poll(() => gateway.state.kernelMessages).toContainEqual({
      type: "switch_session",
      sessionId: "hermes-desktop-index",
    });

    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("button", {
      name: "Verify provider switching remains intact conversation",
    }).click();
    await page.getByText("Provider controls remain independent from the conversation index.").waitFor();
    await expect.poll(() => gateway.state.kernelMessages).toContainEqual({
      type: "switch_session",
      sessionId: "hermes-provider-check",
    });

    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.locator('section[aria-labelledby="conversation-index-title"]')
      .getByRole("button", { name: "New chat" }).click();
    await page.getByRole("textbox", { name: "How can I help you today?" }).waitFor();
    await page.screenshot({ path: join(MAT_322_SCREENSHOT_DIR, "04-empty-conversation-wide.png") });
    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("button", { name: "New conversation conversation" }).waitFor();

    const providerRow = page.getByRole("button", {
      name: "Verify provider switching remains intact conversation",
    });
    await providerRow.hover();
    await page.getByRole("button", {
      name: "Delete Verify provider switching remains intact",
    }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "03-conversation-delete-hover.png") });

    const deleteProvider = page.getByRole("button", {
      name: "Delete Verify provider switching remains intact",
    });
    await providerRow.focus();
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")))
      .toBe("Delete Verify provider switching remains intact");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => page.getByRole("alertdialog").count()).toBe(0);
    expect(gateway.state.deletedConversationIds).toEqual([]);

    await providerRow.hover();
    await deleteProvider.click();
    const deleteDialog = page.getByRole("alertdialog", {
      name: "Delete Verify provider switching remains intact?",
    });
    await deleteDialog.waitFor();
    await deleteDialog.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04-conversation-delete-confirmation.png") });

    gateway.setConversationBusy("hermes-provider-check", true);
    await page.getByRole("button", { name: "Delete chat" }).click();
    await page.getByRole("alert").getByText(
      "Stop the active response before deleting this chat.",
    ).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05-conversation-delete-busy.png") });

    gateway.setConversationBusy("hermes-provider-check", false);
    await page.getByRole("button", { name: "Delete chat" }).click();
    await expect.poll(() => providerRow.count()).toBe(0);
    expect(gateway.state.deletedConversationIds).toContain("hermes-provider-check");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "06-conversation-delete-success.png") });

    await app.close();
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
    await page.setViewportSize(VIEWPORT);
    await page.locator("aside button", { hasText: "Chat" }).first().waitFor({ timeout: 15_000 });
    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("heading", { name: "Chats" }).waitFor({ timeout: 10_000 });
    await expect.poll(() => page.getByRole("button", {
      name: "Verify provider switching remains intact conversation",
    }).count()).toBe(0);
    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).waitFor();
  }, 40_000);

  it("persists project context across restart and uses it for future turns", async () => {
    await page.locator('section[aria-labelledby="conversation-index-title"]')
      .getByRole("button", { name: "New chat" }).click();
    await page.getByRole("textbox", { name: "How can I help you today?" }).waitFor();
    await page.screenshot({ path: join(MAT_318_SCREENSHOT_DIR, "00-empty-context.png") });
    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).click();
    await page.getByText("The canonical Gateway conversation is ready to continue.").waitFor();

    await page.getByRole("button", { name: "Add to project" }).click();
    await page.getByRole("option", { name: /Matrix OS, GitHub/ }).waitFor();
    await page.screenshot({ path: join(MAT_318_SCREENSHOT_DIR, "01-project-picker.png") });
    await page.getByRole("option", { name: /Matrix OS, GitHub/ }).click();
    await page.getByRole("button", { name: "Project Matrix OS" }).waitFor();
    await page.getByRole("button", { name: "Repository FinnaAI/matrix-os" }).waitFor();
    await page.screenshot({ path: join(MAT_318_SCREENSHOT_DIR, "02-project-selected.png") });

    await app.close();
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
    await page.setViewportSize(VIEWPORT);
    await page.locator("aside button", { hasText: "Chat" }).first().waitFor({ timeout: 15_000 });
    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).click();
    await page.getByRole("button", { name: "Project Matrix OS" }).waitFor();

    await page.getByRole("textbox", { name: "Reply to Hermes…" }).fill("Report the current repository name");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Repository context: FinnaAI/matrix-os").waitFor();
  }, 40_000);

  it("blocks stale context, recovers explicitly, and survives a kernel reconnect", async () => {
    gateway.setProjectLifecycle("archived");
    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).click();
    await page.getByRole("button", { name: "Project Matrix OS, unavailable" }).waitFor();
    const composer = page.getByRole("textbox", { name: "Reply to Hermes…" });
    await composer.fill("Do not fall back to home");
    await expect.poll(() => page.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);
    await page.screenshot({ path: join(MAT_318_SCREENSHOT_DIR, "03-project-stale.png") });

    await page.getByRole("button", { name: "Remove project context" }).click();
    await page.getByRole("button", { name: "Add to project" }).waitFor();
    await page.screenshot({ path: join(MAT_318_SCREENSHOT_DIR, "04-project-recovered.png") });

    gateway.setProjectLifecycle("active");
    await page.getByRole("button", { name: "Add to project" }).click();
    await page.getByRole("option", { name: /Matrix OS, GitHub/ }).click();
    gateway.setKernelResponseDelay(750);
    await composer.fill("Keep this project through the active turn");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.getByRole("button", { name: "Project Matrix OS" }).isDisabled()).toBe(true);
    await page.getByText("Repository context: FinnaAI/matrix-os").waitFor();
    gateway.setKernelResponseDelay(0);

    const connectionsBefore = gateway.state.kernelConnections;
    gateway.disconnectKernel();
    await expect.poll(() => gateway.state.kernelConnections).toBeGreaterThan(connectionsBefore);
    await page.getByRole("button", { name: "Project Matrix OS" }).waitFor();
    await composer.fill("Continue after reconnect");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => gateway.state.kernelMessages.filter(
      (message) => message.type === "message" && message.text === "Continue after reconnect",
    ).length).toBe(1);
    const outbound = gateway.state.kernelMessages.find(
      (message) => message.type === "message" && message.text === "Continue after reconnect",
    );
    expect(outbound).not.toHaveProperty("workingDirectory");
    expect(outbound).not.toHaveProperty("path");
  }, 40_000);

  it("does not carry project context into a different runtime", async () => {
    await page.getByRole("button", { name: /Change computer, currently/ }).click();
    await page.getByRole("menuitemradio", { name: /Additional Computer/ }).click();
    await expect.poll(() => gateway.state.runtimeSelections).toContain("review");
    await page.getByRole("button", { name: "Change computer, currently Additional Computer" }).waitFor();
    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).click();
    await page.getByRole("button", { name: "Add to project" }).waitFor();
    await expect.poll(() => page.getByRole("button", { name: "Project Matrix OS" }).count()).toBe(0);
  }, 40_000);
});
