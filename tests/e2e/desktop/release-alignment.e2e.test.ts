import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    // Authentication is confined to the loopback fixture's fake device flow.
    const initialInfo = page.waitForResponse((value) => value.url().endsWith("/api/system/info"));
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await (await initialInfo).finished();
    await page.getByRole("button", { name: "Chat", exact: true }).waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    try {
      if (app) await closeElectronApp(app);
    } finally {
      await gateway?.close();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  }, 20_000);

  it("embeds the actual source and prompts only after the running cloud source differs", async () => {
    const installed = await page.evaluate(() => (window as unknown as {
      operator: { invoke: (channel: string, payload: object) => Promise<unknown> };
    }).operator.invoke("app:get-version", {}));
    expect(installed).toMatchObject({ source });
    expect(await page.getByRole("dialog", { name: "Update Matrix OS" }).count()).toBe(0);

    gateway.setBuildCommit(source.ancestors[0] ?? "a".repeat(40));
    await recheck();
    await page.getByRole("dialog", { name: "Update Matrix OS" }).waitFor();
    await page.getByRole("rowheader", { name: /^Cloud computer/ }).waitFor();
    await page.getByRole("button", { name: "Check again", exact: true }).waitFor();
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "source-mismatch.png") });
    await page.getByRole("button", { name: "Later", exact: true }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, "dismissed-workspace.png") });

    await recheck();
    expect(await page.getByRole("dialog", { name: "Update Matrix OS" }).count()).toBe(0);
    gateway.setBuildCommit(source.ancestors[1] ?? "d".repeat(40));
    await recheck();
    await page.getByRole("dialog", { name: "Update Matrix OS" }).waitFor();
    await page.getByRole("button", { name: "Later", exact: true }).click();
    gateway.setBuildCommit(source.commit);
    await recheck();
    expect(await page.getByRole("dialog", { name: "Update Matrix OS" }).count()).toBe(0);
  });

  it("shows the host-bundle replay and preserves a draft after dismissal", async () => {
    const dialog = page.getByRole("dialog", { name: "Update Matrix OS" });
    await page.getByRole("button", { name: "Chat", exact: true }).dblclick();
    const composer = page.getByRole("textbox", { name: "Start a chat" });
    await composer.fill("Unsent release alignment regression draft");
    let response = structuredClone(hostInfo);
    await page.route("**/api/system/info", (route) => route.fulfill({ json: response }));
    await recheck();
    await dialog.waitFor();
    await page.screenshot({ path: join(evidence, "host-bundle-mismatch.png") });
    await dialog.getByRole("button", { name: "Later", exact: true }).click();
    await expect.poll(() => composer.inputValue()).toBe("Unsent release alignment regression draft");
    await recheck();
    expect(await dialog.count()).toBe(0);

    // A different installed release is not proof that the running process changed.
    response = { ...hostInfo, version: "v2026.09.10-1209",
      release: { ...hostInfo.release, version: "v2026.09.10-1209", gitCommit: source.commit } };
    await recheck();
    expect(await dialog.count()).toBe(0);
    response.runningVersion = response.version;
    await recheck();
    expect(await dialog.count()).toBe(0);
    await composer.fill("");
    await page.unroute("**/api/system/info");
  });
});
