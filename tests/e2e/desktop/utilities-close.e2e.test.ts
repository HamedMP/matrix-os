import { createServer, request } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway } from "./fixtures/stub-gateway";

const root = resolve(__dirname, "../../..");
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const output = "/private/tmp/matrix-utilities-electron-evidence";
const assets = join(root, "home/apps/utilities/dist");
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
let app: ElectronApplication; let page: Page; let native: Page; let userData: string;
let stub: Awaited<ReturnType<typeof startStubGateway>>; let server: ReturnType<typeof createServer>;

describe("Utilities close in built Electron Desktop", () => {
  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    stub = await startStubGateway({ identity: { userId: "fixture-user", handle: "fixture", displayName: "Fixture User" } });
    let origin = "";
    server = createServer(async (req, res) => {
      const path = new URL(req.url!, "http://fixture.test").pathname;
      if (path === "/api/apps") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ apps: [{ slug: "utilities", appIdentity: "utilities", name: "Utilities", category: "productivity", path: "apps/utilities/index.html" }] })); return; }
      if (path === "/api/apps/utilities/session-token") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ launchUrl: "/apps/utilities/", expiresAt: Date.now() + 60_000 })); return; }
      if (path.startsWith("/apps/utilities/")) {
        const file = resolve(assets, path.slice("/apps/utilities/".length) || "index.html");
        if (!file.startsWith(`${assets}/`)) { res.writeHead(400); res.end(); return; }
        try { const content = await readFile(file); res.setHeader("content-type", mime[extname(file)] ?? "application/octet-stream"); res.end(content); }
        catch (error: unknown) { console.warn("[utilities-e2e] asset unavailable", error instanceof Error ? "Error" : "UnknownError"); res.writeHead(404); res.end(); }
        return;
      }
      const upstream = request(`${stub.url}${req.url}`, { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res); });
      upstream.setTimeout(10_000, () => upstream.destroy());
      upstream.on("error", (error: unknown) => { console.warn("[utilities-e2e] stub unavailable", error instanceof Error ? "Error" : "UnknownError"); if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    userData = await mkdtemp(join(tmpdir(), "utilities-native-profile-"));
    const launch = () => _electron.launch({ executablePath, args: [join(root, "tests/e2e/desktop/fixtures/canonical-input-electron.mjs")], env: { ...process.env, OPERATOR_GATEWAY_URL: origin, OPERATOR_USER_DATA_DIR: userData } });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app, safeStorage }) => { await app.whenReady(); return Array.from(safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "fixture-user", handle: "fixture" }))); });
    await writeFile(join(userData, "credential.bin"), Buffer.from(encrypted));
    await writeFile(join(userData, "state.json"), JSON.stringify({ profile: { platformHost: origin, runtimeSlot: "primary", userId: "fixture-user", handle: "fixture" } }));
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addLocatorHandler(page.getByRole("dialog", { name: "Getting started", exact: true }), async () => { await page.getByRole("button", { name: /^Getting started —/ }).click(); });
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).click({ timeout: 20_000 });
    await page.getByRole("button", { name: "Utilities", exact: true }).click({ timeout: 20_000 });
    const deadline = Date.now() + 10_000;
    while (!app.context().pages().some(candidate => candidate.url().includes("/apps/utilities/"))) {
      if (Date.now() > deadline) { console.log("Native targets", await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => ({ id: contents.id, url: contents.getURL(), type: contents.getType() })))); await page.screenshot({ path: join(output, "electron-native-discovery.png") }); throw new Error("Native Utilities view did not open"); }
      await new Promise(done => setTimeout(done, 50));
    }
    native = app.context().pages().find(candidate => candidate.url().includes("/apps/utilities/"))!;
    await native.getByText("Word Counter", { exact: true }).click();
    await native.getByRole("textbox").fill("Controlled input stays edited.");
    expect(await native.getByRole("textbox").inputValue()).toBe("Controlled input stays edited.");
    await native.getByRole("textbox").focus();
    const id = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getURL().includes("/apps/utilities/"))!.id);
    await app.evaluate(async ({ webContents }, { id, text }) => {
      const contents = webContents.fromId(id)!; contents.focus();
      await contents.executeJavaScript("document.querySelector('textarea').select()");
      await contents.insertText(text);
    }, { id, text: "Keep this Electron draft." });

  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally { if (server) await new Promise<void>(done => server.close(() => done())); await stub?.close(); if (userData) await rm(userData, { recursive: true, force: true }); }
  });
  it("retains the actual native app view on cancel, then destroys it after confirmation", async () => {
    const nativeId = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getURL().includes("/apps/utilities/"))!.id);
    expect(await native.evaluate(() => ({ electronBridge: Boolean((window as any).MatrixOS?.utilitiesClose), topFrame: window.parent === window }))).toEqual({ electronBridge: true, topFrame: true });
    await page.getByRole("dialog", { name: "Utilities window" }).getByRole("button", { name: "Close", exact: true }).click();
    await native.getByRole("dialog", { name: "Close Utilities?" }).waitFor();
    await native.screenshot({ path: join(output, "electron-utilities-close-confirmation.png") });
    await native.getByRole("button", { name: "Keep working" }).click();
    expect(await native.getByRole("textbox").inputValue()).toBe("Keep this Electron draft.");
    expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isDestroyed() === false, nativeId)).toBe(true);
    await native.screenshot({ path: join(output, "electron-utilities-kept-draft.png") });
    await page.getByRole("tab", { name: "Sidebar" }).click();
    await page.getByRole("button", { name: "Close all open apps" }).click();
    await native.getByRole("dialog", { name: "Close Utilities?" }).waitFor();
    await native.getByRole("button", { name: "Keep working" }).click();
    expect(await native.getByRole("textbox").inputValue()).toBe("Keep this Electron draft.");
    await page.getByRole("dialog", { name: "Utilities window" }).getByRole("button", { name: "Close", exact: true }).click();
    await native.getByRole("button", { name: "Close Utilities", exact: true }).click();
    await expect.poll(() => app.evaluate(({ webContents }, id) => !webContents.fromId(id) || webContents.fromId(id)!.isDestroyed(), nativeId)).toBe(true);
    await page.getByRole("dialog", { name: "Utilities window" }).waitFor({ state: "hidden" });
    await page.screenshot({ path: join(output, "electron-utilities-closed.png") });
  });
});
