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
    // Poll loop approves; Home renders with the welcome heading.
    await page.getByText(/Welcome/i).first().waitFor({ timeout: 15_000 });
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

  it("starts an agent thread from the composer and streams it in the Agents tab", async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+j" : "Control+j");
    await page.getByPlaceholder(/ask hermes/i).fill("fix the failing auth tests");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await page.getByText("Done — all tests pass.").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04-agents.png") });
  }, 30_000);

  it("renders the app launcher from the gateway catalog", async () => {
    await page.getByRole("button", { name: "Apps" }).click();
    await page.getByText("Notes").waitFor({ timeout: 10_000 });
    await page.getByText("Pomodoro").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04-apps.png") });
  }, 30_000);
});
