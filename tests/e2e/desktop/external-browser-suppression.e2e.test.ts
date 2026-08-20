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
const EVIDENCE_DIR = resolve(__dirname, "../../../output/playwright/mat-452");
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("automated Desktop external-browser policy", () => {
  let app: ElectronApplication;
  let gateway: StubGateway;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-os-browser-suppression-"));
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

  it("completes stub authorization without invoking the operating-system browser", async () => {
    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { openedExternalUrls?: string[] };
      state.openedExternalUrls = [];
      shell.openExternal = async (url) => {
        state.openedExternalUrls?.push(url);
      };
    });

    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.locator("aside button", { hasText: "Terminal" }).first().waitFor({
      timeout: 15_000,
    });

    const openedExternalUrls = await app.evaluate(() => {
      const state = globalThis as typeof globalThis & { openedExternalUrls?: string[] };
      return state.openedExternalUrls ?? [];
    });
    expect(openedExternalUrls).toEqual([]);
    expect(gateway.state.tokenRequests).toBeGreaterThan(0);

    await page.screenshot({
      path: join(EVIDENCE_DIR, "stub-auth-without-external-browser.png"),
    });
  }, 30_000);
});
