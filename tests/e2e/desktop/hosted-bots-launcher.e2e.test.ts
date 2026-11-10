import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { closeElectronApp } from "./fixtures/close-electron";
import { startStubGateway } from "./fixtures/stub-gateway";

const root = resolve(import.meta.dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(main)) {
  throw new Error("Required desktop build is missing");
}

it.skipIf(!existsSync(main)).each([
  { fullRuntime: false, label: "Matrix fallback" },
  { fullRuntime: true, label: "full upstream surface" },
])("opens Bots beside Chat in the built Matrix Electron window ($label)", async ({ fullRuntime }) => {
  const gateway = await startStubGateway();
  const profile = mkdtempSync(join(tmpdir(), "matrix-hosted-bots-e2e-"));
  const runtimeSlot = "pv-1907-3fa91c2e";
  let rosterRequests = 0;
  let readinessRequests = 0;
  let embeddedRequests = 0;
  let embeddedDocuments = 0;
  let socketRequests = 0;
  const session = "omb_session_8799_preview=omb_sess_" + "t".repeat(43);
  const prefix = "/vm/" + runtimeSlot + "/api/hosted-bots/runtime";
  let app: ElectronApplication | undefined;
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url!, gateway.url);
    function json(body: unknown) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(body));
    }
    if (incoming.method === "GET" && url.pathname === "/api/auth/computers") {
      json({
        items: [{ handle: runtimeSlot, runtimeSlot, label: "Preview Computer",
          availability: "available", kind: "preview", gatewayPath: "/vm/" + runtimeSlot, capabilities: [] }],
        selectedSlot: runtimeSlot, hasMore: false, limit: 20,
      });
      return;
    }
    if (fullRuntime && incoming.method === "GET" && url.pathname.startsWith(prefix + "/")) {
      if (incoming.headers["x-matrix-hosted-bots-proxy"] !== "1"
        || incoming.headers.authorization !== "Bearer stub-token-1"
        || incoming.headers.origin !== "https://matrix-bots.invalid") {
        outgoing.writeHead(403);
        outgoing.end();
        return;
      }
      embeddedRequests++;
      if (url.pathname === prefix + "/") {
        embeddedDocuments++;
        outgoing.writeHead(200, {
          "content-type": "text/html",
          "content-security-policy": "frame-ancestors 'none'",
          ...(embeddedDocuments === 1
            ? { "x-matrix-hosted-bots-set-session": session + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300" }
            : {}),
        });
        outgoing.end(
          '<!doctype html><html><head></head><body><main id="bots">Opening upstream fixture</main><script src="/assets/fixture.js"></script></body></html>',
        );
        return;
      }
      if (url.pathname === prefix + "/assets/fixture.js") {
        outgoing.writeHead(200, { "content-type": "text/javascript" });
        outgoing.end([
          'const socketBase = document.querySelector(\'meta[name="matrix-bots-websocket-base"]\').content;',
          'const socket = new WebSocket(socketBase + "/api/bots/bot-1/browser/stream");',
          'socket.onmessage = event => document.body.dataset.socket = event.data;',
          'fetch("/api/bots").then(res => res.json()).then(data => document.querySelector("#bots").textContent = data.name);',
        ].join("\n"));
        return;
      }
      if (url.pathname === prefix + "/api/bots" && incoming.headers["x-matrix-hosted-bots-session"] === session) {
        json({ name: "Paired Bots fixture" });
        return;
      }
      outgoing.writeHead(403);
      outgoing.end();
      return;
    }
    if (incoming.method === "GET" && url.searchParams.get("runtime") === runtimeSlot) {
      if (url.pathname === "/api/hosted-bots/runtime") {
        readinessRequests++;
        if (fullRuntime && readinessRequests > 1) {
          rosterRequests++;
          json({ ready: true });
        } else if (fullRuntime) {
          outgoing.writeHead(503);
          outgoing.end();
        } else {
          outgoing.writeHead(404);
          outgoing.end();
        }
        return;
      }
      if (url.pathname === "/api/hosted-bots") {
        rosterRequests++;
        json({ bots: [] });
        return;
      }
      if (url.pathname === "/api/hosted-bots/model") {
        json({ connected: false });
        return;
      }
    }
    const upstream = request(url, {
      method: incoming.method, headers: incoming.headers, timeout: 10_000,
    }, response => {
      outgoing.writeHead(response.statusCode!, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Fixture gateway timed out")));
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (incoming, socket, head) => {
    if (!fullRuntime || incoming.url !== prefix + "/api/bots/bot-1/browser/stream"
      || incoming.headers["x-matrix-hosted-bots-proxy"] !== "1"
      || incoming.headers["x-matrix-hosted-bots-session"] !== session
      || incoming.headers.authorization !== "Bearer stub-token-1"
      || incoming.headers.origin !== "https://matrix-bots.invalid") {
      socket.destroy();
      return;
    }
    socketRequests++;
    sockets.handleUpgrade(incoming, socket, head, (connection) => connection.send("Paired socket fixture"));
  });
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
    const launch = () => _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [join(import.meta.dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: url, OPERATOR_USER_DATA_DIR: profile, MATRIX_DESKTOP_QA_IDENTITY: "isolated" },
    });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app: electron, safeStorage }) => {
      await electron.whenReady();
      return Array.from(safeStorage.encryptString(JSON.stringify({
        accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo",
      })));
    });
    writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted));
    writeFileSync(join(profile, "state.json"), JSON.stringify({
      profile: { handle: "neo", userId: "user-1", platformHost: url, runtimeSlot },
    }));
    await closeElectronApp(app);
    app = await launch();

    async function openBots(electron: ElectronApplication) {
      const page = await electron.firstWindow();
      page.setDefaultTimeout(8_000);
      await page.getByRole("button", { name: "Open App Launcher", exact: true }).click();
      const bots = page.getByRole("button", { name: "Bots", exact: true });
      await bots.waitFor();
      expect(await page.getByRole("button", { name: "Chat", exact: true }).count()).toBeGreaterThan(0);
      expect(rosterRequests).toBeGreaterThan(0);
      await bots.click();
      return page;
    }
    const page = await openBots(app);
    if (fullRuntime) {
      const readEmbedded = (electron: ElectronApplication) => electron.evaluate(async ({ BrowserWindow }) => {
        const browserWindow = BrowserWindow.getAllWindows()[0];
        const contents = browserWindow?.contentView.children
          .flatMap(view => "webContents" in view ? [view.webContents as typeof browserWindow.webContents] : [])
          .find(child => child.getURL() === "https://matrix-bots.invalid/");
        if (!contents) return null;
        return contents.executeJavaScript("[document.querySelector('#bots')?.textContent, document.body.dataset.socket]", false) as Promise<[string, string]>;
      });
      await expect.poll(() => readEmbedded(app!)).toEqual(["Paired Bots fixture", "Paired socket fixture"]);
      expect(readinessRequests).toBeGreaterThanOrEqual(2);
      expect(embeddedRequests).toBeGreaterThanOrEqual(3);
      expect(socketRequests).toBe(1);

      await closeElectronApp(app);
      app = await launch();
      await openBots(app);
      await expect.poll(() => readEmbedded(app!)).toEqual(["Paired Bots fixture", "Paired socket fixture"]);
      expect(embeddedDocuments).toBeGreaterThanOrEqual(2);
      expect(socketRequests).toBeGreaterThanOrEqual(2);
    } else {
      await page.getByRole("button", { name: "New Bot", exact: true }).waitFor();
    }
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    if (app) await closeElectronApp(app);
    for (const connection of sockets.clients) connection.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await gateway.close();
    rmSync(profile, { recursive: true, force: true });
  }
}, 60_000);
