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

  it("signs in via the device flow and reaches the board", async () => {
    await page.getByRole("button", { name: /sign in with matrix os/i }).click();
    await page.getByText("STUB-1234").waitFor({ timeout: 5000 });
    // Poll loop approves instantly; board renders.
    await page.getByText("Fix the failing auth tests").waitFor({ timeout: 15_000 });
    await page.getByText("Polish the board design").waitFor();
    expect(gateway.state.tokenRequests).toBeGreaterThan(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-board.png") });
  }, 30_000);

  it("opens a task and reaches a live terminal with echo", async () => {
    await page.getByText("Fix the failing auth tests").click();
    await page.getByText("matrix-task-1").first().waitFor({ timeout: 10_000 });
    // Terminal attached and printed the stub prompt.
    await page.getByText("stub-shell$").first().waitFor({ timeout: 10_000 });
    await page.keyboard.type("ls");
    await page.keyboard.press("Enter");
    await page.getByText("ran!").first().waitFor({ timeout: 10_000 });
    expect(gateway.state.terminalInputs.join("")).toContain("ls");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "02-terminal.png") });
  }, 30_000);

  it("starts an agent thread from the composer and streams a transcript", async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+j" : "Control+j");
    await page.getByPlaceholder(/ask hermes/i).fill("fix the failing auth tests");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await page.getByText("Done — all tests pass.").waitFor({ timeout: 10_000 });
    await page.getByText(/^Done$/).first().waitFor({ timeout: 5_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "03-thread.png") });
  }, 30_000);

  it("renders the app launcher from the gateway catalog", async () => {
    await page.getByRole("button", { name: "Apps" }).click();
    await page.getByText("Notes").waitFor({ timeout: 10_000 });
    await page.getByText("Pomodoro").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04-apps.png") });
  }, 30_000);
});
