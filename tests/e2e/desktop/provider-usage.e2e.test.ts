import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
const desktopRequire = createRequire(resolve(__dirname, "../../../desktop/package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright");
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("provider usage desktop e2e", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "provider-usage-e2e-"));
    app = await _electron.launch({
      args: [DESKTOP_MAIN],
      executablePath: ELECTRON_EXECUTABLE,
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /continue with github/i }).click();
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({ timeout: 15_000 });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("renders, expands, refreshes, and collapses exact provider usage", async () => {
    const usage = page.getByRole("button", {
      name: /Codex, 41% left, resets in 6 days, updated just now/i,
    });
    await usage.waitFor({ timeout: 10_000 });

    const computer = page.getByRole("button", { name: /Change computer/i });
    const [usageBox, computerBox] = await Promise.all([usage.boundingBox(), computer.boundingBox()]);
    expect(usageBox?.y).toBeLessThan(computerBox?.y ?? 0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-265-usage-expanded.png") });

    await usage.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Provider usage" });
    await dialog.waitFor();
    await dialog.getByText("OpenAI / ChatGPT").waitFor();
    await dialog.getByText("5-hour window").waitFor();
    await dialog.getByText("7-day window").waitFor();
    await dialog.getByText("$12.50 remaining").waitFor();
    await dialog.getByRole("heading", { name: "Claude" }).waitFor();
    await dialog.getByRole("heading", { name: "OpenCode" }).waitFor();
    await dialog.getByRole("heading", { name: "Pi" }).waitFor();
    expect(await dialog.getByText("Usage not reported").count()).toBe(3);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-265-usage-popover.png") });

    const requestsBeforeRefresh = gateway.state.providerUsageRequests;
    const refresh = dialog.getByRole("button", { name: "Refresh usage" });
    await refresh.click();
    await expect.poll(() => gateway.state.providerUsageRequests).toBeGreaterThan(requestsBeforeRefresh);
    await expect.poll(() => refresh.isEnabled()).toBe(true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    await page.getByRole("button", { name: /Collapse sidebar/i }).click();
    await page.getByRole("button", { name: /Expand sidebar/i }).waitFor();
    await page.getByRole("button", {
      name: /Codex, 41% left, resets in 6 days, updated just now/i,
    }).waitFor();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-265-usage-collapsed.png") });
  }, 30_000);

  it("marks stale values and removes unavailable percentages", async () => {
    gateway.state.providerUsageMode = "stale";
    await page.getByRole("button", {
      name: /Codex, 41% left, resets in 6 days, updated just now/i,
    }).click();
    const dialog = page.getByRole("dialog", { name: "Provider usage" });

    await dialog.getByText("Last known").waitFor();
    expect(await page.getByRole("progressbar").count()).toBe(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-265-usage-stale.png") });

    gateway.state.providerUsageMode = "unavailable";
    await dialog.getByRole("button", { name: "Refresh usage" }).click();
    await page.getByText("Temporarily unavailable").first().waitFor();
    expect(await page.getByText(/% left/).count()).toBe(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "mat-265-usage-unavailable.png") });
  }, 30_000);
});
