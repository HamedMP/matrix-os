// US1/US2 end-to-end: sign-in → board → terminal echo → agent thread.
// Drives the BUILT Electron app (desktop/out) with Playwright against the
// stub gateway — no VPS, no credentials, screenshots saved as evidence
// (lesson L12: the agent can finally verify the running app).
import { mkdtempSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { inspectDesktopHandoffBaseline } from "./handoff-electron-baseline";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
const desktopRequire = createRequire(resolve(__dirname, "../../../desktop/package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const SCREENSHOT_DIR = resolve(__dirname, "../../../desktop/screenshots");
const MAT_322_SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright/mat-322");
const MAT_327_SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright/mat-327");
const MAT_348_SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright/mat-348");
const hasBuild = existsSync(DESKTOP_MAIN);

const suite = hasBuild ? describe : describe.skip;

async function openSettings(page: Page): Promise<void> {
  const sidebar = page.locator("aside");
  const directSettings = sidebar
    .getByRole("button", { name: "Settings", exact: true })
    .first();

  if ((await directSettings.count()) > 0 && await directSettings.isVisible()) {
    await directSettings.click();
  } else {
    await sidebar.getByRole("button", { name: "Open account menu" }).click();
    await page
      .getByRole("menu", { name: "Account" })
      .getByRole("menuitem", { name: "Settings" })
      .click();
  }

  await page
    .getByRole("heading", { name: "Settings" })
    .waitFor({ timeout: 10_000 });
}

async function ensureSignedIn(page: Page): Promise<void> {
  const continueButton = page.getByRole("button", { name: /continue in browser/i });
  const terminalNavigation = page.locator("aside button", { hasText: "Terminal" }).first();
  const bootState = await Promise.race([
    continueButton.waitFor({ state: "visible", timeout: 15_000 }).then(() => "signed-out" as const),
    terminalNavigation.waitFor({ state: "visible", timeout: 15_000 }).then(() => "signed-in" as const),
  ]);
  if (bootState === "signed-out") await continueButton.click();
  await terminalNavigation.waitFor({ timeout: 15_000 });
}

async function verticalGap(before: Locator, after: Locator): Promise<number> {
  const [beforeBox, afterBox] = await Promise.all([before.boundingBox(), after.boundingBox()]);
  if (!beforeBox || !afterBox) throw new Error("Could not measure transcript rows");
  return afterBox.y - (beforeBox.y + beforeBox.height);
}

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
    mkdirSync(MAT_322_SCREENSHOT_DIR, { recursive: true });
    mkdirSync(MAT_327_SCREENSHOT_DIR, { recursive: true });
    mkdirSync(MAT_348_SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "operator-e2e-"));
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
    // Browser sign-in unambiguously starts the device flow; the approval page
    // presents the available providers and the stub approves instantly.
    await page.getByRole("button", { name: /continue in browser/i }).click();
    // Poll loop approves; the signed-in shell (sidebar nav) renders.
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
    expect(gateway.state.tokenRequests).toBeGreaterThan(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-home.png") });

    // Open the project and choose Board explicitly; the following tests rely
    // on the persisted Board view before exercising Chats separately.
    await page.locator("aside button", { hasText: "Matrix OS" }).last().click();
    await page.getByRole("button", { name: "Board", exact: true }).click();
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

  it("renders the project commit DAG in the task Git panel", async () => {
    await page.getByRole("button", { name: "Git (⌘3)" }).click();
    await page.getByRole("button", { name: "Terminal (⌘1)" }).click();
    await page.getByRole("tab", { name: "Graph" }).waitFor({ timeout: 10_000 });
    await page.getByText("feat(desktop): add project-centric shell").waitFor({ timeout: 10_000 });
    await page.getByText("fix(gateway): bound commit history").waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "03b-git-dag.png") });
  }, 30_000);

  it("opens the project chats from the command palette", async () => {
    await page.locator("aside button", { hasText: "Home" }).first().click();
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.waitFor({ timeout: 10_000 });
    await palette.getByRole("group", { name: "Projects" }).getByText("Matrix OS").click();
    // The earlier explicit Board choice persists; switch to Chats and exercise
    // the project-scoped conversation rail in the exact production build.
    await page.getByRole("button", { name: "Chats" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "New chat in Matrix OS" }).waitFor({ timeout: 10_000 });
    await page.getByRole("navigation", { name: "Project conversations" }).waitFor();
    await page.getByRole("group", { name: "Project chats" }).waitFor();
    await page.getByRole("group", { name: "Task Fix the failing auth tests" }).waitFor();
    await page.getByRole("button", { name: "Chat Investigate auth callback" }).waitFor();
    await page.getByRole("button", { name: "Chat Verify token refresh" }).waitFor();

    const railSearch = page.getByRole("searchbox", { name: "Search chats" });
    await railSearch.fill("token");
    await page.getByRole("button", { name: "Chat Verify token refresh" }).waitFor();
    await expect.poll(
      () => page.getByRole("button", { name: "Chat Investigate auth callback" }).count(),
    ).toBe(0);
    await railSearch.fill("");
    const statusFilter = page.getByRole("combobox", { name: "Filter chats by status" });
    await statusFilter.selectOption("done");
    await page.getByRole("button", { name: "Chat Verify token refresh" }).waitFor();
    await expect.poll(
      () => page.getByRole("button", { name: "Chat Investigate auth callback" }).count(),
    ).toBe(0);
    await statusFilter.selectOption("all");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04-project-chats-list.png") });

    // The segmented control switches back to the project's board.
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.getByText("Polish the board design").waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04b-project-board.png") });

    // Back in Chats, the selected conversation keeps the shared inspector.
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "Chat Investigate auth callback" }).click();
    await page.getByRole("region", { name: "Conversation Investigate auth callback" }).waitFor();
    await page.getByText("Trace why the OAuth callback drops the return path.").waitFor();
    await page.getByText("auth-callback.ts").waitFor();
    await page.getByRole("button", { name: "Tool call Read auth callback" }).waitFor();
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
    await page.getByLabel("Message new chat").waitFor({ timeout: 5_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05a-draft-chat.png") });
    await page.getByLabel("Message new chat").fill("fix the failing auth tests");
    await page.getByRole("button", { name: "Send" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => gateway.state.codingAgentCreates.length, { timeout: 5_000 }).toBe(1);
    expect(gateway.state.codingAgentCreates[0]).toMatchObject({ projectId: "matrix-os" });
    await page.getByText("fix the failing auth tests").first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05-project-chats-composer.png") });
    await page.locator("span:visible", { hasText: /^Done$/ }).first().waitFor({ timeout: 10_000 });
  }, 30_000);

  it("validates MAT-348 tool hierarchy and composer in built Electron", async () => {
    await ensureSignedIn(page);
    await page.locator("aside button", { hasText: "Matrix OS" }).first().click();
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "New chat in Matrix OS" }).click();

    const prompt = "MAT-348: validate a long tool-heavy agent turn";
    await page.getByLabel("Message new chat").fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();

    const toolSummary = page.getByRole("button", { name: "9 tool calls, completed" });
    await toolSummary.waitFor({ timeout: 10_000 });
    await page.getByText("Historical tool activity is grouped", { exact: false }).waitFor();
    expect(await toolSummary.getAttribute("aria-expanded")).toBe("false");
    expect(await page.getByRole("button", { name: "Tool call Read conversation renderer" }).count()).toBe(0);
    expect(await page.getByLabel("Agent provider").textContent()).toBe("Codex");

    const userRow = page.locator('[data-message-id="user:msg_mat_348_user"]');
    const introRow = page.locator('[data-message-id="assistant:msg_mat_348_intro"]');
    const toolRow = toolSummary.locator('xpath=ancestor::*[@data-message-id][1]');
    const resultRow = page.locator('[data-message-id="assistant:msg_mat_348_result"]');
    const gaps = await Promise.all([
      verticalGap(userRow, introRow),
      verticalGap(introRow, toolRow),
      verticalGap(toolRow, resultRow),
    ]);
    const visibleGaps = await Promise.all([
      verticalGap(userRow.locator('[data-slot="bubble-content"]'), introRow.locator("[data-selectable]")),
      verticalGap(introRow.locator("[data-selectable]"), toolSummary),
      verticalGap(toolSummary, resultRow.locator("[data-selectable]")),
    ]);
    // T3's current timeline uses a 16px boundary after a user message and an
    // 8px cadence for commentary/work/result rows. Matrix may preserve its
    // own typography, but a settled turn must keep that compact hierarchy.
    expect(gaps[0]).toBeLessThanOrEqual(20);
    expect(gaps[1]).toBeLessThanOrEqual(12);
    expect(gaps[2]).toBeLessThanOrEqual(12);
    expect(visibleGaps[0]).toBeLessThanOrEqual(44);
    expect(visibleGaps[1]).toBeLessThanOrEqual(20);
    expect(visibleGaps[2]).toBeLessThanOrEqual(20);
    await page.screenshot({ path: join(MAT_348_SCREENSHOT_DIR, "01-settled-tool-group.png") });

    await toolSummary.click();
    await page.getByRole("button", { name: "Tool call Read conversation renderer" }).waitFor();
    await page.getByRole("button", { name: "Tool call Summarize validation" }).waitFor();
    await page.screenshot({ path: join(MAT_348_SCREENSHOT_DIR, "02-expanded-tool-group.png") });

    await toolSummary.click();
    await page.setViewportSize({ width: 820, height: 720 });
    await toolSummary.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: join(MAT_348_SCREENSHOT_DIR, "03-settled-tool-group-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByRole("button", { name: "Chat Investigate auth callback" }).click();
    const busyDraft = page.getByLabel("Message conversation");
    await busyDraft.fill("Draft this follow-up while the agent is working");
    await busyDraft.press("Enter");
    expect(await busyDraft.inputValue()).toBe("Draft this follow-up while the agent is working");
    await page.getByRole("button", { name: "Stop" }).waitFor();
    await page.getByText("Agent is working — draft now, send when this turn finishes").waitFor();
    await page.screenshot({ path: join(MAT_348_SCREENSHOT_DIR, "04-running-composer-draft.png") });
  }, 40_000);

  it("shows provider and integration settings for the selected computer", async () => {
    await openSettings(page);

    await page.getByRole("button", { name: "Providers" }).click();
    await page.getByText("Coding agents on this computer").waitFor({ timeout: 10_000 });
    await page.mouse.move(1_000, 680);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05b-settings-providers.png") });

    await page.getByRole("button", { name: "Integrations" }).click();
    await page.getByRole("heading", { name: "Integrations" }).waitFor({ timeout: 10_000 });
    await page.getByText("Matrix OS Team").waitFor({ timeout: 10_000 });
    await page.getByText("GitHub").waitFor();
    await page.getByText("Slack").waitFor();
    await page.mouse.move(1_000, 680);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05c-settings-integrations.png") });
  }, 30_000);

  it("opens the add-project flow from the project rail", async () => {
    await page.getByRole("button", { name: "Add project" }).click();
    await page.getByText("Add project", { exact: true }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05d-add-project.png") });

    await page.getByRole("button", { name: /Clone from GitHub/ }).click();
    await page.getByPlaceholder("https://github.com/owner/repo").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05e-clone-project.png") });
    await page.getByRole("button", { name: "Cancel" }).click();
  }, 30_000);

  it("opens the plugins hub and its Matrix-computer skills surface", async () => {
    await page.keyboard.press("Escape");
    await page.locator("aside button", { hasText: "Plugins" }).first().click();
    await page.getByRole("heading", { name: "Plugins" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: /Skills/i }).click();
    await page.getByRole("heading", { name: "Skills" }).waitFor({ timeout: 10_000 });
    await page.mouse.move(1_000, 680);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05f-plugins-skills.png") });
  }, 30_000);

  it("browses Matrix-computer files in Finder-style list and grid views", async () => {
    await page.locator("aside button", { hasText: "Files" }).first().click();
    await page.getByRole("heading", { name: "Files" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Open workspaces" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05g-files-list.png") });

    await page.getByRole("button", { name: "Grid view" }).click();
    await page.getByRole("button", { name: "Open SOUL.md" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05h-files-grid.png") });
  }, 30_000);

  it("opens the Terminal workspace with a canonical session list", async () => {
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    await page.getByRole("heading", { name: "Terminal" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Open matrix-task-1" }).waitFor({ state: "visible", timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "06-terminal-workspace.png") });
  }, 30_000);

  it("lists apps and opens one as a tab", async () => {
    await page.locator("aside button", { hasText: "Apps" }).first().click();
    await page.getByText("Notes").first().waitFor({ timeout: 10_000 });
    await page.getByText("Pomodoro").first().waitFor({ timeout: 10_000 });
    await page.getByText("Notes").first().click();
    // Legacy Desktop exposes a tab chip; the navigation handoff keeps that
    // cached tab mounted behind a breadcrumb-only header.
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
    if ((await breadcrumb.count()) > 0) {
      await breadcrumb.getByText("Notes", { exact: true }).waitFor({ timeout: 10_000 });
    } else {
      await page.locator('[role="tab"]', { hasText: "Notes" }).first().waitFor({ timeout: 10_000 });
    }
    await page.screenshot({ path: join(SCREENSHOT_DIR, "07-apps.png") });
  }, 30_000);

  it("detaches the hosted shell while non-Home tabs are active", async () => {
    await page.locator("aside button", { hasText: "Home" }).first().click();
    await expect.poll(attachedNativeViewCount).toBe(1);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "08-home-shell-active.png") });

    await openSettings(page);
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
    await openSettings(page);
    await page.getByRole("button", { name: "Computers" }).click();
    await page.getByRole("button", { name: "Current computer" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Use Main Computer" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "09c-settings-current-computer.png") });

    // Sidebar computer menu evidence: expanded rail, then the collapsed rail
    // popup that must keep a readable fixed width.
    await page.getByRole("button", { name: /Change computer, currently/ }).click();
    await page.getByRole("menu", { name: "Choose computer" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "09d-computer-menu.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Collapse sidebar/ }).click();
    await page.getByRole("button", { name: /Change computer, currently/ }).click();
    await page.getByRole("menu", { name: "Choose computer" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "09e-computer-menu-collapsed.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Expand sidebar/ }).click();

    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page
      .locator(
        '[role="region"][aria-label="Hermes conversation"], #conversation-index-title',
      )
      .first()
      .waitFor({ timeout: 10_000 });
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
    await openSettings(page);
    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("radiogroup", { name: "Theme" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "13-appearance-theme-picker.png") });

    await page.getByRole("radio", { name: "Use Dracula theme" }).click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme-id") === "dracula");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "14-theme-dracula.png") });

    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("heading", { name: "Chats" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(MAT_322_SCREENSHOT_DIR, "06-chats-dark.png") });
    await page.getByRole("button", {
      name: "Plan the persistent Desktop conversation experience conversation",
    }).click();
    await page.getByText("The canonical Gateway conversation is ready to continue.").waitFor();
    const hermesConversation = page.getByRole("region", { name: "Hermes conversation" });
    await hermesConversation.getByLabel("Reply to Hermes…").fill("Plan the persistent Desktop conversation experience");
    await hermesConversation.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", {
      name: "Open recent Plan the persistent Desktop conversation experience",
    }).waitFor({ timeout: 10_000 });

    // The terminal palette follows the unified theme.
    await page.locator("aside button", { hasText: "Terminal" }).first().click();
    await page.getByRole("heading", { name: "Terminal" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "15-theme-dracula-terminal.png") });

    // Restore the default so later suites see the stock palette.
    await openSettings(page);
    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("radio", { name: "Use Operator theme" }).click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme-id") === "operator");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "16-theme-operator-default.png") });
  }, 40_000);

  it("captures sidebar and computer-menu parity in light and dark at both widths", async () => {
    const sidebar = page.getByRole("complementary", { name: "Matrix OS navigation" });

    for (const mode of ["Light", "Dark"] as const) {
      await openSettings(page);
      await page.getByRole("button", { name: "Appearance" }).click();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.waitForFunction(
        (expected) => document.documentElement.getAttribute("data-theme") === expected,
        mode.toLowerCase(),
      );
      await page.locator("aside button", { hasText: "Chat" }).first().click();

      if (await sidebar.getAttribute("data-sidebar-state") === "collapsed") {
        await page.getByRole("button", { name: /^Expand sidebar/ }).click();
      }
      await page.screenshot({
        path: join(MAT_327_SCREENSHOT_DIR, `${mode.toLowerCase()}-expanded.png`),
      });
      await page.getByRole("button", { name: /Change computer, currently/ }).click();
      await page.getByRole("menu", { name: "Choose computer" }).waitFor({ timeout: 10_000 });
      await page.screenshot({
        path: join(MAT_327_SCREENSHOT_DIR, `${mode.toLowerCase()}-expanded-menu.png`),
      });
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: /^Collapse sidebar/ }).click();
      await page.screenshot({
        path: join(MAT_327_SCREENSHOT_DIR, `${mode.toLowerCase()}-collapsed.png`),
      });
      await page.getByRole("button", { name: /Change computer, currently/ }).click();
      await page.getByRole("menu", { name: "Choose computer" }).waitFor({ timeout: 10_000 });
      await page.screenshot({
        path: join(MAT_327_SCREENSHOT_DIR, `${mode.toLowerCase()}-collapsed-menu.png`),
      });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^Expand sidebar/ }).click();
    }

    await openSettings(page);
    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("button", { name: "System", exact: true }).last().click();
  }, 40_000);

  it("keeps coding-agent navigation in global Recents instead of a Chat rail", async () => {
    // The earlier computer switch cleared the workspace summary. Create a
    // project chat through the fixture-supported path so the successful run
    // is promoted into the shared Recents section.
    await page.locator("aside button", { hasText: "Matrix OS" }).last().click();
    await page.getByRole("button", { name: "Board", exact: true }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "New chat in Matrix OS" }).click();
    await page.getByLabel("Message new chat").fill("verify global Recents navigation");
    await page.getByRole("button", { name: "Send" }).focus();
    await page.keyboard.press("Enter");
    const recent = page.getByRole("button", { name: "Open recent verify global Recents navigation" });
    await recent.waitFor({ timeout: 10_000 });

    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("heading", { name: "Chats" }).waitFor({ timeout: 10_000 });
    await expect.poll(() => page.getByText("Agent runs").count()).toBe(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "17-chat-without-internal-rail.png") });

    // Global Recents owns the route back to the project conversation.
    await recent.click();
    await page.getByRole("button", { name: "New chat in Matrix OS" }).waitFor({ timeout: 10_000 });
    await page.getByRole("region", { name: "Conversation verify global Recents navigation" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "18-global-recent-routes-to-project.png") });
  }, 30_000);

  it("archives, restores, and permanently deletes a project through Desktop lifecycle controls", async () => {
    await page.locator("aside button", { hasText: "Home" }).first().click();
    await expect.poll(attachedNativeViewCount).toBe(1);
    await page.getByRole("button", { name: "Project actions for Matrix OS" }).click();
    await expect.poll(attachedNativeViewCount).toBe(0);
    await page.getByText("Archive project", { exact: true }).click();
    await expect.poll(() => page.getByRole("button", { name: "Open Matrix OS" }).count()).toBe(0);

    await openSettings(page);
    const settingsNav = page.locator("nav", { has: page.getByRole("heading", { name: "Settings" }) });
    await settingsNav.getByRole("button", { name: "Projects" }).click();
    await page.getByRole("heading", { name: "Archived projects" }).waitFor({ timeout: 10_000 });
    await page.getByText("GitHub repository").waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "19-archived-projects-settings.png") });

    await page.getByRole("button", { name: "Restore Matrix OS" }).click();
    await page.getByText("No archived projects").waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Open Matrix OS" }).waitFor();

    await page.getByRole("button", { name: "Project actions for Matrix OS" }).click();
    await page.getByText("Delete project", { exact: true }).click();
    await page.getByLabel("Type Matrix OS to confirm").fill("Matrix OS");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "20-delete-project-confirmation.png") });
    await page.getByRole("button", { name: "Delete project" }).click();
    await page.getByRole("button", { name: "Open Matrix OS" }).waitFor({ state: "detached", timeout: 10_000 });
  }, 40_000);

  it("keeps the handoff surfaces named, keyboard reachable, and resize safe", async () => {
    const evidence = await inspectDesktopHandoffBaseline(page);

    expect(evidence.navigationNames).toEqual([
      "Home",
      "Chat",
      "Terminal",
      "Files",
    ]);
    expect(evidence.focusTargets.Home).toBe("Home");
    expect(["Chat", "How can I help you today?"]).toContain(evidence.focusTargets.Chat);
    expect(["Terminal", "Terminal input"]).toContain(
      evidence.focusTargets.Terminal,
    );
    expect(evidence.focusTargets.Files).toBe("Files");
    if (evidence.historyTargets) {
      expect(evidence.historyTargets).toEqual({
        back: "Terminal",
        forward: "Files",
      });
    }
    if (evidence.recentConversationTarget) {
      expect(evidence.recentConversationTarget).toBe("Conversations");
    }
    expect(evidence.hiddenPanesMissingInert).toBe(0);
    expect(evidence.narrowViewport).toEqual({
      width: 820,
      hasHorizontalDocumentOverflow: false,
    });
    expect(evidence.reducedMotion).toBe("reduce");
  }, 40_000);
});
