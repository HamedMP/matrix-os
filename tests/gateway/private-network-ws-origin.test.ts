import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { registerHerdrTerminalWebSocket } from "../../packages/gateway/src/herdr/ws.js";
import { privateNetworkIdentityMiddleware } from "../../packages/gateway/src/private-network/identity.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createGatewayAllowedOriginController } from "../../packages/gateway/src/server/browser-setup-origin.js";
import { registerWebSocketOriginGate, resolveWebSocketOriginPolicy } from "../../packages/gateway/src/server/websocket-origin-gate.js";
import { createTerminalLiveOwnership } from "../../packages/gateway/src/terminal-live-ownership.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";

// Fault detected: with the owner's Tailscale identity and the runtime bearer
// both added by the ingress, a foreign page's socket passed identity and auth
// and attached to the owner's terminal. The gateway's middleware order is
// Origin gate, identity, bearer auth, then the route (server.ts).
const OWNER = "self-host-owner";
const OWNER_LOGIN = "alice@example.com";
const TOKEN = "p".repeat(48);
const TAILNET = "https://box.tail1.ts.net";
const ENV = { MATRIX_SELF_HOSTED: "1", MATRIX_ACCESS_MODE: "tailscale", MATRIX_TAILNET_URL: TAILNET, SHELL_ORIGIN: TAILNET };
const savedEnv = { ...process.env };
const cleanup: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  process.env.MATRIX_AUTH_TOKEN = TOKEN;
  process.env.MATRIX_USER_ID = OWNER;
  delete process.env.MATRIX_HANDLE;
  delete process.env.MATRIX_RUNTIME_SLOT;
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  process.env = { ...savedEnv };
});

async function gateway() {
  const core = createFakeHerdrCore();
  core.add("t1", { screen: "owner secrets" });
  const adapter = createHerdrAdapter({ open: async () => core.connect(), captureQuietMs: 5, captureMaxMs: 100 });
  cleanup.push(() => adapter.close());
  const app = new Hono();
  const ws = createNodeWebSocket({ app });
  const ownership = createTerminalLiveOwnership();
  cleanup.push(() => ownership.close());
  registerWebSocketOriginGate(app, resolveWebSocketOriginPolicy(ENV, createGatewayAllowedOriginController(ENV)));
  app.use("*", privateNetworkIdentityMiddleware({ accessMode: "tailscale", ownerLogin: async () => OWNER_LOGIN }));
  app.use("*", authMiddleware(TOKEN));
  const viewers = registerHerdrTerminalWebSocket({
    app, upgradeWebSocket: ws.upgradeWebSocket, adapter, getPrincipal: (c) => requireRequestPrincipal(c),
    terminalOwnerIds: [OWNER], terminalLiveOwnership: ownership,
  });
  cleanup.push(() => viewers.drain());
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  ws.injectWebSocket(server);
  if (!server.listening) await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  return { core, port: address.port };
}

function connect(port: number, origin: string | null) {
  // Everything the ingress adds, whatever page opened the socket.
  const headers: Record<string, string> = { "Tailscale-User-Login": OWNER_LOGIN, Authorization: `Bearer ${TOKEN}` };
  if (origin !== null) headers.Origin = origin;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/herdr?id=t1&lease=exclusive`, { headers });
  const frames: Array<Record<string, unknown>> = [];
  let status: number | null = null;
  let done = false;
  socket.on("message", (data) => { frames.push(JSON.parse(String(data))); });
  socket.on("unexpected-response", (_request, response) => { status = response.statusCode ?? null; socket.terminate(); done = true; });
  socket.on("error", () => { done = true; });
  socket.on("close", () => { done = true; });
  cleanup.push(() => { if (!done) socket.terminate(); });
  return {
    frames,
    status: () => status,
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    async until(check: () => boolean) {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > 2_000) throw new Error(`timed out; status ${status}; frames ${JSON.stringify(frames)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

describe("private network identity and the WebSocket Origin gate", () => {
  it("refuses a foreign page that carries the owner's identity and bearer, and admits the tailnet shell", async () => {
    const { core, port } = await gateway();
    const foreign = connect(port, "https://untrusted.example");
    await foreign.until(() => foreign.status() !== null);
    expect(foreign.status()).toBe(403);
    expect(foreign.frames).toEqual([]);
    expect(core.viewers).toEqual([]);
    expect(core.terminals.get("t1")!.input).toEqual([]);

    const shell = connect(port, TAILNET);
    await shell.until(() => shell.frames.some((frame) => frame.type === "output"));
    expect(shell.frames[0]).toMatchObject({ type: "attached", ownership: "writer" });
    shell.send({ type: "input", terminalRef: shell.frames[0]!.terminalRef, data: "ls\r" });
    await shell.until(() => core.terminals.get("t1")!.input.length === 1);

    const native = connect(port, null);
    await native.until(() => native.frames.some((frame) => frame.type === "attached"));
  });
});
