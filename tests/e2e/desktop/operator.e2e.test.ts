// US1/US2 end-to-end: sign-in → board → terminal echo → agent thread.
// Drives the BUILT Electron app (desktop/out) with Playwright against the
// stub gateway — no VPS, no credentials, screenshots saved as evidence
// (lesson L12: the agent can finally verify the running app).
import { mkdtempSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
const SCREENSHOT_DIR = resolve(__dirname, "../../../desktop/screenshots");
const hasBuild = existsSync(DESKTOP_MAIN);

const suite = hasBuild ? describe : describe.skip;

suite("operator desktop e2e", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  async function attachedNativeViewCount(): Promise<number> {
    return app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window?.contentView.children.length ?? 0;
    });
  }

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "operator-e2e-"));
    app = await _electron.launch({
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
      console.warn("[e2e] app close failed:", err instanceof Error ? err.message : String(err));
    }
    await gateway?.close();
    if (userDataDir) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch (err: unknown) {
        console.warn("[e2e] user-data cleanup failed:", err instanceof Error ? err.message : String(err));
      }
    }
  });

  it("signs in via the device flow and reaches Home, then opens a project board", async () => {
    // "Continue with GitHub" unambiguously starts the device flow (the browser
    // would present the provider). The stub approves instantly.
    await page.getByRole("button", { name: /continue with github/i }).click();
    // Poll loop approves; the signed-in shell (sidebar nav) renders.
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
    expect(gateway.state.tokenRequests).toBeGreaterThan(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-home.png") });

    // Open the project board from the sidebar; tasks render.
    await page.locator("aside button", { hasText: "Matrix OS" }).last().click();
    await page.getByText("Fix the failing auth tests").waitFor({ timeout: 10_000 });
    await page.getByText("Polish the board design").waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "02-board.png") });
  }, 40_000);

  it("opens a task as a cached tab with a live terminal", async () => {
    await page.getByText("Fix the failing auth tests").click();
    // The task opens as a tab; the terminal panel attaches and prints the prompt.
    await page.getByText("stub-shell$").first().waitFor({ timeout: 10_000 });
    await page.keyboard.type("ls");
    await page.keyboard.press("Enter");
    await page.getByText("ran!").first().waitFor({ timeout: 10_000 });
    expect(gateway.state.terminalInputs.join("")).toContain("ls");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "03-task-tab.png") });
  }, 30_000);

  it("opens the project chats from the command palette", async () => {
    await page.locator("aside button", { hasText: "Home" }).first().click();
    await page.keyboard.press("Control+K");
    await page.getByLabel("Command palette").waitFor({ timeout: 10_000 });
    await page.getByLabel("Command palette").getByText("Matrix OS").click();
    // The project tab opens on the board; switching to Chats shows the threads.
    await page.getByRole("button", { name: "Chats" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "New chat in Matrix OS" }).waitFor({ timeout: 10_000 });
    await page.getByRole("navigation", { name: "Project conversations" }).waitFor();
    await page.getByRole("group", { name: "Project chats" }).waitFor();
    await page.getByRole("group", { name: "Task Fix the failing auth tests" }).waitFor();
    await page.getByRole("button", { name: "Chat Investigate auth callback" }).waitFor();
    await page.getByRole("button", { name: "Chat Verify token refresh" }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04-project-chats-list.png") });

    // The segmented control switches back to the project's board.
    await page.getByRole("button", { name: "Board" }).click();
    await page.getByText("Polish the board design").waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04b-project-board.png") });

    // Back in Chats, the selected conversation keeps the shared inspector.
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "Chat Investigate auth callback" }).click();
    await page.getByRole("region", { name: "Conversation Investigate auth callback" }).waitFor();
    await page.getByRole("tablist", { name: "Conversation tools" }).waitFor();
    await page.getByRole("button", { name: "Open review PR #917" }).click();
    await page.getByText("PR #917 review details").waitFor();
    await page.getByRole("button", { name: "Prepare commit for review PR #917" }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04d-chats-changes-inspector.png") });
    await page.setViewportSize({ width: 820, height: 720 });
    await page.getByRole("complementary", { name: "Conversation tools" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04e-chats-changes-inspector-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByRole("tab", { name: /^Terminal\b/ }).click();
    await page.getByText("Matrix shell").waitFor();
    await page.getByRole("tab", { name: /^Preview\b/ }).click();
    await page.getByRole("button", { name: "Inspect preview Matrix OS web" }).waitFor();
    await page.getByRole("tab", { name: /^Activity\b/ }).click();
    await page.getByRole("heading", { name: "Codex" }).waitFor();
    await page.getByRole("tab", { name: /^Changes\b/ }).click();
  }, 30_000);

  it("starts an agent thread from the project chats composer", async () => {
    await page.locator("aside button", { hasText: "Matrix OS" }).first().click({ timeout: 5_000 });
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "New chat in Matrix OS" }).click();
    await page.getByLabel("Agent run prompt").fill("fix the failing auth tests", { timeout: 5_000 });
    await page.getByRole("button", { name: "Start run" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => gateway.state.codingAgentCreates.length, { timeout: 5_000 }).toBe(1);
    expect(gateway.state.codingAgentCreates[0]).toMatchObject({ projectId: "matrix-os" });
    await page.getByText("fix the failing auth tests").first().waitFor({ timeout: 10_000 });
    await page.getByText("Completed").first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05-project-chats-composer.png") });
  }, 30_000);

  it("opens the Terminal workspace with a session sidebar", async () => {
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    // Inner sessions sidebar lists the VPS session as a clickable button
    // (the hidden task-tab chip with the same name is a span, not matched here).
    await page.getByText("Shells").first().waitFor({ timeout: 10_000 });
    await page.locator("button", { hasText: "matrix-task-1" }).first().waitFor({ state: "visible", timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "06-terminal-workspace.png") });
  }, 30_000);

  it("lists apps and opens one as a tab", async () => {
    await page.locator("aside button", { hasText: "Apps" }).first().click();
    await page.getByText("Notes").first().waitFor({ timeout: 10_000 });
    await page.getByText("Pomodoro").first().waitFor({ timeout: 10_000 });
    await page.getByText("Notes").first().click();
    // The app opens in its own tab (tab chip with the app name).
    await page.locator('[role="tab"]', { hasText: "Notes" }).first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "07-apps.png") });
  }, 30_000);

  it("detaches the hosted shell while non-Home tabs are active", async () => {
    await page.locator("aside button", { hasText: "Home" }).first().click();
    await expect.poll(attachedNativeViewCount).toBe(1);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "08-home-shell-active.png") });

    await page.locator("aside button", { hasText: "Settings" }).first().click();
    await page.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 10_000 });
    await expect.poll(attachedNativeViewCount).toBe(0);
    await page.getByRole("button", { name: "Computers" }).click();
    await page.getByText("Additional Computer").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "09-settings-no-shell-overlay.png") });
    await page.getByRole("button", { name: "Use Additional Computer" }).click();
    await expect.poll(() => gateway.state.runtimeSelections).toEqual(["review"]);
    // A successful switch tears down the previous computer's desktop (all tabs
    // close), so the persistent sidebar computer menu is the post-switch
    // assertion surface: it must report the server-selected computer.
    await page.getByRole("button", { name: "Change computer, currently Additional Computer" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "09b-computer-switched.png") });

    // Reopening Settings must mark the server-reported slot as current and
    // leave the other computer selectable.
    await page.locator("aside button", { hasText: "Settings" }).first().click();
    await page.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Computers" }).click();
    await page.getByRole("button", { name: "Current computer" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Use Main Computer" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "09c-settings-current-computer.png") });

    // Sidebar computer menu evidence: expanded rail, then the collapsed rail
    // popup that must keep a readable fixed width.
    await page.getByRole("button", { name: /Change computer, currently/ }).click();
    await page.getByRole("listbox", { name: "Choose computer" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "09d-computer-menu.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Collapse sidebar (⌘B)" }).click();
    await page.getByRole("button", { name: /Change computer, currently/ }).click();
    await page.getByRole("listbox", { name: "Choose computer" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "09e-computer-menu-collapsed.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Expand sidebar (⌘B)" }).click();

    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("heading", { name: /What should we build/i }).waitFor({ timeout: 10_000 });
    await expect.poll(attachedNativeViewCount).toBe(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "10-chat-no-shell-overlay.png") });

    await page.locator("aside button", { hasText: "Apps" }).first().click();
    await page.getByText("Notes").first().waitFor({ timeout: 10_000 });
    await expect.poll(attachedNativeViewCount).toBe(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "11-apps-no-shell-overlay.png") });

    await page.locator("aside button", { hasText: "Home" }).first().click();
    await expect.poll(attachedNativeViewCount).toBe(1);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "12-home-shell-restored.png") });
  }, 40_000);

  it("switches unified themes from Appearance settings", async () => {
    await page.locator("aside button", { hasText: "Settings" }).first().click();
    await page.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("radiogroup", { name: "Theme" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "13-appearance-theme-picker.png") });

    await page.getByRole("radio", { name: "Use Dracula theme" }).click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme-id") === "dracula");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "14-theme-dracula.png") });

    // The terminal palette follows the unified theme.
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    await page.getByText("Shells").first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "15-theme-dracula-terminal.png") });

    // Restore the default so later suites see the stock palette.
    await page.locator("aside button", { hasText: "Settings" }).first().click();
    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("radio", { name: "Use Operator theme" }).click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme-id") === "operator");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "16-theme-operator-default.png") });
  }, 40_000);

  it("lists coding-agent threads in the unified chat rail and routes selection to the project", async () => {
    // The earlier computer switch cleared the workspace summary; opening the
    // project refreshes it before the rail is inspected.
    await page.locator("aside button", { hasText: "Matrix OS" }).last().click();
    await page.getByRole("button", { name: "Board" }).waitFor({ timeout: 10_000 });
    await page.locator("aside button", { hasText: "Chat" }).first().click();
    // The rail lists the server-backed run alongside Hermes under "Agent runs".
    await page.getByText("Agent runs").waitFor({ timeout: 10_000 });
    const railItem = page.getByRole("button", { name: "fix the failing auth tests" }).first();
    await railItem.waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "17-chat-unified-rail.png") });

    // Selecting a coding-agent thread routes to its project tab's Chats view.
    await railItem.click();
    await page.getByRole("button", { name: "New chat in Matrix OS" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "18-chat-rail-routes-to-project.png") });
  }, 30_000);
});
