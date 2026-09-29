import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const suite = existsSync(main) ? describe : describe.skip;

suite("Electron Desktop browser import", () => {
  let gateway: StubGateway | undefined;
  let app: ElectronApplication | undefined;
  let page: Page;
  let userDataDir: string | undefined;

  beforeAll(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), "matrix-browser-import-e2e-"));
    const arc = join(userDataDir, "Library/Application Support/Arc");
    await mkdir(arc, { recursive: true });
    await writeFile(join(arc, "StorableSidebar.json"), JSON.stringify({ sidebar: {
      containers: [{ items: [
        "one", { id: "one", data: { tab: { savedURL: "https://example.com/imported", savedTitle: "Imported page" } } },
      ] }],
    } }));
    gateway = await startStubGateway();
    app = await _electron.launch({
      executablePath,
      args: [main],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    await page.evaluate(async () => { await window.operator.invoke("auth:start-device-flow", {}); });
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).waitFor({ timeout: 20_000 });
    const gettingStarted = page.getByRole("dialog", { name: "Getting started" });
    if (await gettingStarted.isVisible()) {
      await page.getByRole("button", { name: /Getting started/ }).click();
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  });

  it("imports a local Arc page and reopens it from Saved pages", async () => {
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).click();
    await page.getByRole("dialog", { name: "App launcher" })
      .getByRole("button", { name: "Browser", exact: true }).click();
    await page.getByRole("button", { name: "Browser settings" }).click();
    await page.getByRole("button", { name: "Import from another browser" }).click();
    const evidence = join(root, "output/playwright/browser-import");
    await mkdir(evidence, { recursive: true });
    await page.getByRole("button", { name: "Import 1 page from Arc Sidebar" }).waitFor();
    await page.screenshot({ path: join(evidence, "electron-browser-import-picker.png") });
    await page.getByRole("button", { name: "Import 1 page from Arc Sidebar" }).click();
    await page.getByRole("button", { name: "Open Imported page" }).click();
    await expect.poll(async () => page.getByRole("textbox", { name: "Browser address" }).inputValue())
      .toBe("https://example.com/imported");
    await page.screenshot({ path: join(evidence, "electron-browser-import.png") });
  }, 60_000);
});
