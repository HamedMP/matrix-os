import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startProviderAuthGateway } from "./fixtures/provider-auth-gateway";
import { connectedOtherProvider, pickerCatalog } from "./fixtures/chat-picker-catalog";

const root = resolve(import.meta.dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const renderer = join(root, "desktop/out/renderer/index.html");
const built = existsSync(main) && existsSync(renderer);
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) throw new Error("Required Electron build is missing");
const suite = built ? describe : describe.skip;
const output = join(root, "output/playwright/chat-provider-background-cache");
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const freshnessMs = 5 * 60_000;

// Real production renderer/IPC/auth wiring; only the remote HTTP service is a fixture.
// No model turn is submitted and no owner credentials are read or changed.
suite("Electron Desktop application-owned provider background cache", () => {
  let app: ElectronApplication;
  let page: Page;
  let profile: string;
  let gateway: Awaited<ReturnType<typeof startProviderAuthGateway>>;
  let holdCatalog = false;
  let pendingCatalog: ServerResponse | undefined;
  const reads: Array<{ query: string; authenticated: boolean }> = [];
  const catalog = pickerCatalog();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/chat-providers") {
      // Test lifetime is bounded: unexpected storms fail rather than growing evidence.
      if (reads.length >= 64) { res.writeHead(429); res.end(); return; }
      const authenticated = req.headers.authorization === "Bearer stub-token-1";
      reads.push({ query: url.search, authenticated });
      if (!authenticated) { res.writeHead(401); res.end(); return; }
      if (holdCatalog) {
        if (pendingCatalog) { res.writeHead(429); res.end(); return; }
        pendingCatalog = res;
        res.on("close", () => { if (pendingCatalog === res) pendingCatalog = undefined; });
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(catalog));
      return;
    }
    const upstream = httpRequest(new URL(req.url ?? "/", gateway.url), {
      method: req.method, headers: req.headers, timeout: 10_000,
    }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Fixture request timeout")));
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });

  const chat = () => page.getByRole("dialog", { name: "Chat window", exact: true });
  const picker = () => chat().getByRole("button", { name: "Choose model and provider", exact: true });
  const draft = () => chat().getByRole("textbox", { name: "Start a chat", exact: true });
  const send = () => chat().getByRole("button", { name: "Send", exact: true });

  async function usablePicker() {
    expect(await picker().isEnabled()).toBe(true);
    expect(await picker().getAttribute("aria-busy")).toBe("false");
    expect(await picker().getAttribute("data-model")).toBe("gpt-5.6-sol");
    expect(await page.getByRole("status", { name: "Checking model availability" }).count()).toBe(0);
  }

  async function observeLoading() {
    await page.evaluate(() => {
      const state = { loadingObservations: 0 };
      const record = () => {
        if (document.querySelector('[data-slot="provider-model-trigger"][aria-busy="true"], [aria-label="Checking model availability"]')) {
          state.loadingObservations += 1;
        }
      };
      const observer = new MutationObserver(record);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
      Object.assign(window, { providerCacheEvidence: state, stopProviderCacheEvidence: () => observer.disconnect() });
      record();
    });
  }

  async function loadingObservations() {
    return page.evaluate(() => (window as unknown as { providerCacheEvidence: { loadingObservations: number } }).providerCacheEvidence.loadingObservations);
  }

  beforeAll(async () => {
    mkdirSync(output, { recursive: true });
    gateway = await startProviderAuthGateway({ catalog, settings: connectedOtherProvider });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const platformUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "matrix-provider-cache-"));
    const launch = () => _electron.launch({ executablePath,
      args: [resolve(import.meta.dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: platformUrl, OPERATOR_USER_DATA_DIR: profile },
    });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app: electronApp, safeStorage }) => {
      await electronApp.whenReady();
      return safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1",
        expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })).toString("base64");
    });
    writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 850));
    // Install before reloading so application timers use the browser clock from startup.
    // The production five-minute interval is unchanged; HTTP responses use real time.
    await page.clock.install();
    await page.reload();
    await chat().waitFor({ timeout: 20_000 });
    await expect.poll(() => picker().getAttribute("aria-busy")).toBe("false");
    await expect.poll(() => picker().getAttribute("data-model")).toBe("gpt-5.6-sol");
    const client = await page.evaluate(() => window.operator.invoke("app:get-version", {}));
    if (process.env.MATRIX_EXPECTED_CLIENT_COMMIT) expect(client.source?.commit).toBe(process.env.MATRIX_EXPECTED_CLIENT_COMMIT);
    writeFileSync(join(output, "provenance.json"), JSON.stringify({ client, executablePath, main,
      mainSha256: createHash("sha256").update(readFileSync(main)).digest("hex"),
      rendererHtmlSha256: createHash("sha256").update(readFileSync(renderer)).digest("hex"),
      runtime: "isolated authenticated provider HTTP fixture", account: "user-1", handle: "neo",
      realProviderAuth: false, modelTurnsSubmitted: 0, freshnessMs,
    }, null, 2));
    await observeLoading();
  }, 60_000);

  afterAll(async () => {
    pendingCatalog?.end();
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await gateway?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state !== "fail" || !page || page.isClosed()) return;
    await page.screenshot({ path: join(output, "failure.png") });
    writeFileSync(join(output, "failure-evidence.json"), JSON.stringify({ test: task.name, reads,
      pendingRefresh: Boolean(pendingCatalog), body: (await page.locator("body").innerText()).slice(0, 8_000),
    }, null, 2));
  });

  it("keeps warm discovery across twenty native foreground and Chat hide/reopen cycles", async () => {
    const baseline = reads.length;
    await draft().fill("Keep my draft while switching apps");
    for (let cycle = 0; cycle < 20; cycle += 1) {
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.blur();
        window.focus();
      });
      await chat().getByRole("button", { name: "Minimize", exact: true }).click();
      await chat().waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
      await chat().waitFor();
      await usablePicker();
      expect(await draft().innerText()).toBe("Keep my draft while switching apps");
      expect(await send().isEnabled()).toBe(true);
    }
    expect(reads.length).toBe(baseline);
    expect(await loadingObservations()).toBe(0);
    expect(reads.every(read => read.authenticated)).toBe(true);
    await page.screenshot({ path: join(output, "warm-switching.png") });
    writeFileSync(join(output, "switching-evidence.json"), JSON.stringify({ cycles: 20,
      catalogReadsBefore: baseline, catalogReadsAfter: reads.length, loadingObservations: await loadingObservations(), reads,
    }, null, 2));
  }, 90_000);

  it("retains cache after the last Chat closes and remains usable during a delayed routine refresh", async () => {
    const baseline = reads.length;
    await chat().getByRole("button", { name: "Close", exact: true }).click();
    await chat().waitFor({ state: "detached" });
    expect(reads.length).toBe(baseline);

    holdCatalog = true;
    try {
      // Application scheduling keeps running even with no Chat consumer mounted.
      await page.clock.fastForward(freshnessMs + 1_000);
      await expect.poll(() => reads.length).toBe(baseline + 1);
      await expect.poll(() => Boolean(pendingCatalog)).toBe(true);
      expect(reads.at(-1)!.query).not.toContain("refresh=true");
      expect(await chat().count()).toBe(0);
      await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
      await chat().waitFor();
      await usablePicker();
      await draft().fill("Sending stays available during background refresh");
      expect(await send().isEnabled()).toBe(true);
      expect(await draft().innerText()).toBe("Sending stays available during background refresh");
      await picker().click();
      const choices = page.locator('[data-slot="provider-model-picker"]');
      await choices.waitFor();
      expect(await choices.getByRole("button", { name: /Hermes agent/ }).isEnabled()).toBe(true);
      await choices.getByRole("button", { name: /Hermes agent/ }).click();
      expect(await choices.getByRole("option", { name: /gpt-5.6-sol via Hermes/ }).isEnabled()).toBe(true);
      await page.screenshot({ path: join(output, "delayed-background-refresh.png") });
      await page.keyboard.press("Escape");
      expect(await loadingObservations()).toBe(0);
      writeFileSync(join(output, "delayed-refresh-evidence.json"), JSON.stringify({ catalogReadsBefore: baseline,
        catalogReadsDuring: reads.length, refreshPending: Boolean(pendingCatalog),
        sendEnabled: await send().isEnabled(), loadingObservations: await loadingObservations(), reads,
      }, null, 2));
    } finally {
      holdCatalog = false;
      pendingCatalog?.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      pendingCatalog?.end(JSON.stringify(catalog));
    }
    await expect.poll(() => Boolean(pendingCatalog)).toBe(false);
    await usablePicker();
    expect(reads.length).toBe(baseline + 1);
  }, 40_000);
});
