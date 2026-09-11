import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { readBuildSource } from "../../../scripts/release/build-source.mjs";
import { closeElectronApp } from "./fixtures/close-electron";
import hostInfo from "../../fixtures/host-release-system-info.json";

// Keep this filename and evidence directory: CI requires this built Electron suite.
const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const evidence = join(root, "output/playwright/release-alignment");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(main)) {
  throw new Error("Required Desktop build is missing");
}
const suite = existsSync(main) ? describe : describe.skip;
const scenarios = ["source-mismatch", "incompatible", "502"] as const;

suite("Electron Desktop keeps cloud updates out of the workspace", () => {
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let gateway: StubGateway | undefined;
  let profile: string | undefined;
  let scenarioName = "startup";

  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === "fail" && page && !page.isClosed()) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `${scenarioName}-failure.png`) });
      }
    } finally {
      try {
        if (app) await closeElectronApp(app);
      } finally {
        await gateway?.close();
        if (profile) rmSync(profile, { recursive: true, force: true });
        app = undefined;
        page = undefined;
        gateway = undefined;
        profile = undefined;
      }
    }
  }, 20_000);

  it.each(scenarios)("%s never offers cloud repair, while Chat and local Software Update work", async (scenario) => {
    scenarioName = scenario;
    const source = readBuildSource(root);
    if (!source) throw new Error("Electron E2E requires a committed source checkout");
    const otherCommit = source.commit === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
    const info = {
      ...structuredClone(hostInfo),
      build: { ...hostInfo.build, sha: scenario === "source-mismatch" ? otherCommit : source.commit },
      release: { ...hostInfo.release, gitCommit: scenario === "source-mismatch" ? otherCommit : source.commit },
      runtimeCompatibility: scenario === "incompatible"
        ? { schemaVersion: 1, minDesktopProtocol: 2, maxDesktopProtocol: 2 }
        : hostInfo.runtimeCompatibility,
    };
    gateway = await startStubGateway();
    gateway.setSystemInfo(info);
    profile = mkdtempSync(join(tmpdir(), "matrix-release-alignment-"));
    app = await _electron.launch({
      executablePath: requireDesktop("electron") as string,
      args: [main],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    const window = page = await app.firstWindow();
    window.setDefaultTimeout(8_000);
    await window.setViewportSize({ width: 1280, height: 800 });
    // Reject stale or dirty-built artifacts, even when the checkout is now clean.
    const installed = await window.evaluate(() => (window as unknown as {
      operator: { invoke: (channel: string, payload: object) => Promise<unknown> };
    }).operator.invoke("app:get-version", {}));
    expect(installed).toMatchObject({ source });

    // Install network fixtures before authenticating, so even the first gate probe
    // sees the outage/mismatch. Never replace renderer components or the IPC bridge.
    let cloudUpdatePosts = 0;
    window.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/system/update") {
        cloudUpdatePosts += 1;
      }
    });
    await window.route("**/api/system/info", (route) => route.fulfill({
      status: scenario === "502" ? 502 : 200,
      contentType: "application/json",
      body: JSON.stringify(scenario === "502" ? { error: "Service unavailable" } : info),
    }));
    // Advertise an available release to catch install actions that would otherwise
    // be absent simply because the stub returns 404 for release discovery.
    const latest = { version: "v2099.01.01-0001", channel: "dev", gitCommit: otherCommit };
    await window.route("**/api/system/update*", (route) => route.fulfill({
      status: route.request().method() === "POST" ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify({ channel: "dev", latest, updateAvailable: true }),
    }));
    await window.route("**/api/system/releases*", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ releases: [latest] }),
    }));

    // Authentication is confined to the loopback fixture's fake device flow.
    await window.getByRole("button", { name: /continue in browser/i }).click();
    const chat = window.getByRole("button", { name: "Chat", exact: true });
    await chat.waitFor({ timeout: 15_000 });
    const cloudDialog = window.getByRole("dialog", { name: "Update Matrix OS", exact: true });
    const assertNoCloudUpdate = async () => {
      expect(await cloudDialog.count()).toBe(0);
      expect(cloudUpdatePosts).toBe(0);
    };
    await chat.dblclick();
    await window.getByRole("button", { name: "New chat", exact: true }).click();
    const composer = window.getByRole("textbox", { name: "Start a chat" });
    const draft = `Unsent ${scenario} regression draft`;
    await composer.fill(draft);

    // Removed listeners need not make a request. Observe a bounded interval after
    // reconnect/online/focus instead of waiting forever for the deleted gate probe.
    await window.evaluate(() => {
      for (const event of ["matrix:runtime-reconnected", "online", "focus"]) {
        window.dispatchEvent(new Event(event));
      }
    });
    await window.waitForTimeout(750);
    await assertNoCloudUpdate();
    await expect.poll(() => composer.textContent()).toBe(draft);
    await composer.fill(`${draft} — still editable`);

    const sidebar = window.locator("aside");
    const settings = sidebar.getByRole("button", { name: "Settings", exact: true }).first();
    if (await settings.isVisible()) {
      await settings.click();
    } else {
      await sidebar.getByRole("button", { name: "Open account menu" }).click();
      await window.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Settings" }).click();
    }
    const systemResponse = window.waitForResponse((response) => new URL(response.url()).pathname === "/api/system/info");
    await window.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "System", exact: true }).click();
    const response = await systemResponse;
    expect(response.status()).toBe(scenario === "502" ? 502 : 200);
    await response.finished();
    await window.waitForTimeout(250);
    expect(await window.getByRole("combobox", { name: "Release channel" }).count()).toBe(0);
    expect(await window.getByRole("button", { name: "Refresh releases", exact: true }).count()).toBe(0);
    expect(await window.getByRole("button", { name: /^(Upgrade|Downgrade|Install update)(\b|$)/i }).count()).toBe(0);
    await assertNoCloudUpdate();
    mkdirSync(evidence, { recursive: true });
    await window.screenshot({ path: join(evidence, `${scenario}-system.png`) });

    // Exercise the actual main-process application menu and preload IPC, without
    // synthesizing update state. Unpackaged builds should show the preview status.
    const opened = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.items[0]?.submenu?.items
        .find((candidate) => candidate.label === "Check for Updates…");
      if (!item) return false;
      item.click();
      return true;
    });
    expect(opened).toBe(true);
    const localDialog = window.getByRole("dialog", { name: "Software Update", exact: true });
    await localDialog.waitFor();
    await localDialog.getByRole("heading", { name: "Updates are unavailable in this preview" }).waitFor();
    await assertNoCloudUpdate();
    await window.screenshot({ path: join(evidence, `${scenario}-local-update.png`) });
    await localDialog.getByRole("button", { name: "Close", exact: true }).click();
    await localDialog.waitFor({ state: "hidden" });
    await chat.dblclick();
    await expect.poll(() => composer.textContent()).toBe(`${draft} — still editable`);
    await composer.fill(`${draft} — usable after local update dialog`);
    await assertNoCloudUpdate();
    await window.screenshot({ path: join(evidence, `${scenario}-workspace.png`) });
  }, 60_000);
});
