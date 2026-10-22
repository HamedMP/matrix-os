import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket, WebSocketServer } from "ws";
import { deriveAppSessionKey, signAppSession } from "../../packages/gateway/src/app-runtime/app-session.js";
import { registerBrowserLabRoutes } from "../../packages/gateway/src/browser-lab/routes.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
describe("browser lab full HTTP to WebSocket transport", () => {
  it("forwards binary pixels and human input over a cookie-minted one-use ticket", async () => {
    const kasmServer = createServer();
    const kasmWs = new WebSocketServer({ server: kasmServer, path: "/websockify",
      verifyClient: ({ req }) => req.headers.origin === "http://127.0.0.1:6901" });
    cleanup.push(async () => { for (const socket of kasmWs.clients) socket.terminate(); kasmWs.close(); await new Promise<void>((resolve) => kasmServer.close(() => resolve())); });
    await new Promise<void>((resolve, reject) => {
      kasmServer.once("error", reject);
      kasmServer.listen(6901, "127.0.0.1", () => { kasmServer.off("error", reject); resolve(); });
    });
    const app = new Hono();
    const ws = createNodeWebSocket({ app });
    const master = "live-viewer-test-master-32-bytes";
    const lab = registerBrowserLabRoutes(app, {
      enabled: true, viewerAuthorization: "Basic c3ludGhldGljOm9ubHk=", deriveKey: () => deriveAppSessionKey(master, "browser-lab"),
      isAllowedOrigin: (origin) => origin === "https://app.matrix-os.com", upgradeWebSocket: ws.upgradeWebSocket,
    });
    cleanup.push(lab.close);
    const gateway = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    ws.injectWebSocket(gateway); if (!gateway.listening) await once(gateway, "listening");
    cleanup.push(async () => { for (const socket of ws.wss.clients) socket.terminate(); await new Promise<void>((resolve) => gateway.close(() => resolve())); });
    const now = Math.floor(Date.now() / 1000);
    const token = signAppSession(deriveAppSessionKey(master, "browser-lab"), { v: 1, slug: "browser-lab", principal: "gateway-owner", scope: "personal", iat: now, exp: now + 600 });
    const { ticket } = await (await app.request("/apps/browser-lab/api/viewer-session", { headers: { cookie: `matrix_app_session__browser-lab=${token}` } })).json();
    const connection = once(kasmWs, "connection", { signal: AbortSignal.timeout(2000) });
    const address = gateway.address(); if (!address || typeof address === "string") throw new Error("Missing test listener");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}`, ["binary"], { origin: "https://app.matrix-os.com" });
    cleanup.push(() => client.terminate());
    const [upstream] = await connection;
    await once(client, "open", { signal: AbortSignal.timeout(2000) });
    const pixels = once(client, "message", { signal: AbortSignal.timeout(2000) });
    upstream.send(Buffer.from([0, 1, 2]));
    expect((await pixels)[0]).toEqual(Buffer.from([0, 1, 2]));
    const humanInput = once(upstream, "message", { signal: AbortSignal.timeout(2000) });
    client.send(Buffer.from([3, 4, 5]));
    expect((await humanInput)[0]).toEqual(Buffer.from([3, 4, 5]));
    const closed = once(client, "close", { signal: AbortSignal.timeout(2000) });
    lab.close(); await closed;
    expect((await app.request("/apps/browser-lab/api/status")).status).toBe(404);
  }, 10_000);
});
