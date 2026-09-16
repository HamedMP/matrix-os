import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { readBuildSource } from "../../../scripts/release/build-source.mjs";
import { closeElectronApp } from "./fixtures/close-electron";
import hostInfo from "../../fixtures/host-release-system-info.json";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const evidence = join(root, "output/playwright/release-alignment");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(main)) {
  throw new Error("Required Desktop build is missing");
}
const suite = existsSync(main) ? describe : describe.skip;

suite("Desktop release alignment through the built IPC and gateway", () => {
  let app: ElectronApplication;
  let page: Page;
  let gateway: StubGateway;
  let profile: string;
  const source = readBuildSource(root)!;

  async function recheck() {
    const response = page.waitForResponse((value) => value.url().endsWith("/api/system/info"));
    await page.evaluate(() => window.dispatchEvent(new Event("matrix:runtime-reconnected")));
    await (await response).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  }

  beforeAll(async () => {
    if (!source) throw new Error("Release alignment E2E requires a committed source checkout");
    gateway = await startStubGateway();
    profile = mkdtempSync(join(tmpdir(), "matrix-release-alignment-"));
    app = await _electron.launch({ executablePath: requireDesktop("electron") as string, args: [main],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
    page = await app.firstWindow();
    page.setDefaultTimeout(8_000);
    // Authentication is confined to the loopback fixture's fake device flow.
    const initialInfo = page.waitForResponse((value) => value.url().endsWith("/api/system/info"));
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await (await initialInfo).finished();
    await page.getByRole("button", { name: "Chat", exact: true }).waitFor({ timeout: 15_000 });
  }, 60_000);

  afterEach(async ({ task }) => {
    if (task.result?.state === "fail" && page && !page.isClosed()) {
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ animations: "disabled", path: join(evidence, "failure.png") });
    }
  });

  afterAll(async () => {
    try {
      if (app) await closeElectronApp(app);
    } finally {
      await gateway?.close();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  }, 20_000);

  it("accepts independently released sources without interrupting the workspace", async () => {
    const installed = await page.evaluate(() => (window as unknown as {
      operator: { invoke: (channel: string, payload: object) => Promise<unknown> };
    }).operator.invoke("app:get-version", {}));
    expect(installed).toMatchObject({ source });
    gateway.setBuildCommit(source.ancestors[0] ?? "a".repeat(40));
    await recheck();
    expect(await page.getByRole("dialog", { name: "Update Matrix OS" }).count()).toBe(0);
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ animations: "disabled", path: join(evidence, "compatible-different-source.png") });
  });

  it("prompts only for an unsupported protocol and preserves an unsent draft", async () => {
    const dialog = page.getByRole("dialog", { name: "Update Matrix OS" });
    await page.getByRole("button", { name: "Chat", exact: true }).dblclick();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Start a chat" });
    await composer.fill("Unsent compatibility regression draft");
    gateway.setSystemInfo({ ...hostInfo, runtimeCompatibility: {
      schemaVersion: 1, minDesktopProtocol: 2, maxDesktopProtocol: 2,
    } });
    await recheck();
    await dialog.waitFor();
    await page.getByText(/desktop app must be updated/).waitFor();
    await page.screenshot({ animations: "disabled", path: join(evidence, "desktop-update-required.png") });
    await dialog.getByRole("button", { name: "Later", exact: true }).click();
    await expect.poll(() => composer.textContent()).toBe("Unsent compatibility regression draft");
    await page.screenshot({ animations: "disabled", path: join(evidence, "dismissed-draft-preserved.png") });
    await recheck();
    expect(await dialog.count()).toBe(0);

    // Changing source alone must not repeat a dismissed protocol warning.
    gateway.setSystemInfo({ ...hostInfo, build: { sha: "d".repeat(40) }, runtimeCompatibility: {
      schemaVersion: 1, minDesktopProtocol: 2, maxDesktopProtocol: 2,
    } });
    await recheck();
    expect(await dialog.count()).toBe(0);
    gateway.setSystemInfo(hostInfo);
    await recheck();
    expect(await dialog.count()).toBe(0);
    await composer.fill("");
  });
});
