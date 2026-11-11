import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createOpenMausBotGateway, OPENMAUSBOT_PROXY_BASE } from "../../packages/gateway/src/hosted-bots/oss-gateway.js";

it("relays bounded owner-authorized upstream browser bytes on the real Unix socket without forwarding Matrix credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omb-ws-"));
  const socketPath = join(directory, "http.sock");
  const upstream = createServer();
  const upstreamWs = new WebSocketServer({ server: upstream });
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const gateway = createOpenMausBotGateway({ socketPath, admitted: true, isOwner: (c) => c.req.header("Authorization") === "Bearer matrix-owner", upgradeWebSocket });
  app.route(OPENMAUSBOT_PROXY_BASE, gateway.routes);
  const listener = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  injectWebSocket(listener);
  try {
    upstream.listen(socketPath);
    await Promise.all([once(upstream, "listening"), once(listener, "listening")]);
    let receivedPath: string | undefined;
    let session: string | undefined;
    let auth: string | undefined;
    upstreamWs.on("connection", (socket, req) => {
      receivedPath = req.url;
      session = req.headers.cookie;
      auth = req.headers.authorization;
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    const origin = "ws://127.0.0.1:" + (listener.address() as AddressInfo).port + OPENMAUSBOT_PROXY_BASE;
    const headers = { origin: "https://matrix-bots.invalid", "x-matrix-hosted-bots-proxy": "1", "x-matrix-hosted-bots-session": "omb_session_8799_abc=omb_sess_fixture" };
    const wrong = new WebSocket(origin + "/api/bots/demo/browser/stream", { headers });
    const [_, denied] = await once(wrong, "unexpected-response");
    expect(denied.statusCode).toBe(403);
    wrong.on("error", () => { /* Expected socket termination after refusal. */ });
    wrong.terminate();

    const client = new WebSocket(origin + "/api/bots/demo/browser/stream?threadId=test", {
      headers: { ...headers, Authorization: "Bearer matrix-owner" },
    });
    await once(client, "open");
    client.send(Buffer.from([1, 2, 3]));
    const [bytes, binary] = await once(client, "message");
    expect(binary).toBe(true);
    expect(bytes).toEqual(Buffer.from([1, 2, 3]));
    expect(receivedPath).toBe("/api/bots/demo/browser/stream?threadId=test");
    expect(session).toBe("omb_session_8799_abc=omb_sess_fixture");
    expect(auth).toBeUndefined();
    client.close();
    await once(client, "close");
  } finally {
    gateway.close();
    for (const client of upstreamWs.clients) client.terminate();
    upstreamWs.close();
    await Promise.all([
      new Promise<void>((resolve) => listener.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});
