import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { createAllowedOriginController } from "../../packages/gateway/src/allowed-origins.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { herdrTabId } from "../../packages/gateway/src/herdr/refs.js";
import { registerHerdrTerminalWebSocket } from "../../packages/gateway/src/herdr/ws.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import {
  registerBrowserOriginPolicies,
  registerWebSocketOriginGate,
  resolveWebSocketOriginPolicy,
} from "../../packages/gateway/src/server/websocket-origin-gate.js";
import { createTerminalLiveOwnership } from "../../packages/gateway/src/terminal-live-ownership.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";

// Fault detected: a page on another site, opened in the owner's browser, attaches
// to the owner's terminal through an ingress that adds the owner's credentials
// (self-host nginx injects the runtime bearer on /ws), reads its output and types.
const OWNER = "self-host-owner";
const TOKEN = "t".repeat(48);
const TAILNET = "https://matrix.example-tailnet.ts.net";
const ref = { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: herdrTabId("t1") };
const cleanup: Array<() => Promise<void> | void> = [];
const savedEnv = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, { MATRIX_AUTH_TOKEN: TOKEN, MATRIX_USER_ID: OWNER });
  delete process.env.MATRIX_HANDLE;
  delete process.env.MATRIX_RUNTIME_SLOT;
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  process.env = { ...savedEnv };
});

const SELF_HOST_ENV = { MATRIX_SELF_HOSTED: "1", MATRIX_ACCESS_MODE: "tailscale", SHELL_ORIGIN: TAILNET, MATRIX_TAILNET_URL: TAILNET };

/** The production middleware order: Origin gate, then bearer auth, then the route. */
async function gateway(env: NodeJS.ProcessEnv) {
  const core = createFakeHerdrCore();
  core.add("t1", { screen: "secret output" });
  const adapter = createHerdrAdapter({ open: async () => core.connect(), captureQuietMs: 5, captureMaxMs: 100 });
  cleanup.push(() => adapter.close());
  const app = new Hono();
  const ws = createNodeWebSocket({ app });
  const ownership = createTerminalLiveOwnership();
  cleanup.push(() => ownership.close());
  const controller = createAllowedOriginController({ shellOrigin: env.SHELL_ORIGIN, proxyOrigin: env.PROXY_ORIGIN });
  registerWebSocketOriginGate(app, resolveWebSocketOriginPolicy(env, controller));
  app.use("*", authMiddleware(TOKEN));
  const viewers = registerHerdrTerminalWebSocket({
    app, upgradeWebSocket: ws.upgradeWebSocket, adapter, getPrincipal: (c) => requireRequestPrincipal(c),
    terminalOwnerIds: [OWNER], terminalLiveOwnership: ownership,
  });
  cleanup.push(() => viewers.drain());
  // Every other socket shares the gate, under /ws or not (the ingress adds credentials on /api too).
  for (const path of ["/ws/terminal/tab", "/api/canvases/:canvasId/ws"]) {
    app.get(path, ws.upgradeWebSocket(() => ({ onOpen: (_event, socket) => socket.send("open") })));
  }
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  ws.injectWebSocket(server);
  if (!server.listening) await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  return {
    core,
    connect(path: string, headers: Record<string, string>) {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers });
      const frames: Array<Record<string, unknown>> = [];
      let refusedStatus: number | null = null;
      let opened = false;
      let closed = false;
      socket.on("open", () => { opened = true; });
      socket.on("message", (data) => {
        const text = String(data);
        frames.push(text.startsWith("{") ? JSON.parse(text) : { raw: text });
      });
      socket.on("unexpected-response", (_request, response) => { refusedStatus = response.statusCode ?? null; socket.terminate(); closed = true; });
      socket.on("error", () => { closed = true; });
      socket.on("close", () => { closed = true; });
      cleanup.push(() => { if (!closed) socket.terminate(); });
      return {
        socket, frames,
        opened: () => opened,
        refusedStatus: () => refusedStatus,
        send: (frame: unknown) => socket.send(JSON.stringify(frame)),
        async until(check: () => boolean, ms = 2_000) {
          const start = Date.now();
          while (!check()) {
            if (Date.now() - start > ms) throw new Error(`timed out; frames: ${JSON.stringify(frames)} refused: ${refusedStatus}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        },
      };
    },
  };
}

const herdrPath = `/ws/terminal/herdr?id=t1&lease=exclusive&cols=80&rows=24`;
// What the self-host nginx adds to every /ws request, whatever page made it.
const injected = { Authorization: `Bearer ${TOKEN}` };

describe("WebSocket Origin gate", () => {
  it("refuses a foreign browser Origin before the upgrade, even with the ingress's credentials", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { core, connect } = await gateway(SELF_HOST_ENV);
      const foreign = connect(herdrPath, { ...injected, Origin: "https://untrusted.example" });
      await foreign.until(() => foreign.refusedStatus() !== null);
      expect(foreign.refusedStatus()).toBe(403);
      expect(foreign.opened()).toBe(false);
      expect(foreign.frames).toEqual([]);
      // Never attached: no viewer on the core, so no output was read and nothing could be typed.
      expect(core.viewers).toEqual([]);
      expect(core.calls.filter((call) => call.method === "terminal.attach")).toEqual([]);
      expect(core.terminals.get("t1")!.input).toEqual([]);

      for (const origin of ["null", "http://matrix.example-tailnet.ts.net.evil.example", "https://untrusted.example:443"]) {
        const other = connect(herdrPath, { ...injected, Origin: origin });
        await other.until(() => other.refusedStatus() !== null);
        expect(other.refusedStatus(), origin).toBe(403);
      }
      for (const path of ["/ws/terminal/tab", "/api/canvases/c1/ws"]) {
        const other = connect(path, { ...injected, Origin: "https://untrusted.example" });
        await other.until(() => other.refusedStatus() !== null);
        expect(other.refusedStatus(), path).toBe(403);
      }
      expect(JSON.stringify(warn.mock.calls)).not.toContain("untrusted.example");
    } finally {
      warn.mockRestore();
    }
  });

  it("lets the shell's own Origin attach, read and type", async () => {
    const { core, connect } = await gateway(SELF_HOST_ENV);
    const shell = connect(herdrPath, { ...injected, Origin: TAILNET });
    await shell.until(() => shell.frames.some((frame) => frame.type === "output"));
    expect(shell.frames[0]).toMatchObject({ type: "attached", ownership: "writer" });
    expect(shell.frames.find((frame) => frame.type === "output")).toMatchObject({ data: "secret output" });
    shell.send({ type: "input", terminalRef: ref, data: "ls\r" });
    await shell.until(() => core.terminals.get("t1")!.input.length === 1);
    expect(core.terminals.get("t1")!.input).toEqual(["ls\r"]);
  });

  it("accepts the tailnet's plain-HTTP origin, the installer's fallback when certificates are off", async () => {
    const { connect } = await gateway(SELF_HOST_ENV);
    const fallback = connect(herdrPath, { ...injected, Origin: "http://matrix.example-tailnet.ts.net" });
    await fallback.until(() => fallback.frames.some((frame) => frame.type === "attached"));
    const secure = await gateway({ ...SELF_HOST_ENV, SHELL_ORIGIN: "http://matrix.example-tailnet.ts.net", MATRIX_TAILNET_URL: "http://matrix.example-tailnet.ts.net" });
    const https = secure.connect(herdrPath, { ...injected, Origin: TAILNET });
    await https.until(() => https.frames.some((frame) => frame.type === "attached"));
  });

  it("keeps non-browser clients working: no Origin with a valid bearer attaches, no bearer is still refused", async () => {
    const { connect } = await gateway(SELF_HOST_ENV);
    const cli = connect(herdrPath, injected);
    await cli.until(() => cli.frames.some((frame) => frame.type === "attached"));
    const anonymous = connect(herdrPath, {});
    await anonymous.until(() => anonymous.refusedStatus() !== null);
    expect(anonymous.refusedStatus()).toBe(401);
  });

  it("changes nothing where credentials are never ambient (managed computers, local dev)", async () => {
    for (const env of [{}, { SHELL_ORIGIN: "https://app.matrix-os.com" }, { MATRIX_SELF_HOSTED: "1", MATRIX_ACCESS_MODE: "public" }]) {
      expect(resolveWebSocketOriginPolicy(env, createAllowedOriginController({ shellOrigin: env.SHELL_ORIGIN })).enforce, JSON.stringify(env)).toBe(false);
    }
    const { connect } = await gateway({});
    const tab = connect("/ws/terminal/tab", { ...injected, Origin: "https://untrusted.example" });
    await tab.until(() => tab.frames.length > 0);
    expect(tab.frames).toEqual([{ raw: "open" }]);
  });

  it("registers the gate before CORS, and CORS answers only the allowed origins", async () => {
    const app = new Hono();
    const allowedOrigins = createAllowedOriginController({ shellOrigin: TAILNET });
    registerBrowserOriginPolicies(app, { env: SELF_HOST_ENV, allowedOrigins, devNullOrigin: false });
    app.get("/api/ping", (c) => c.text("pong"));
    const cors = async (origin: string) => (await app.request("/api/ping", { headers: { Origin: origin } })).headers.get("access-control-allow-origin");
    expect(await cors(TAILNET)).toBe(TAILNET);
    expect(await cors("https://untrusted.example")).toBeNull();
    expect(await cors("null")).toBeNull();
    const upgrade = await app.request("/ws/terminal/tab", { headers: { Origin: "https://untrusted.example", Upgrade: "websocket" } });
    expect(upgrade.status).toBe(403);
    expect(upgrade.headers.get("access-control-allow-origin")).toBeNull();
    const dev = new Hono();
    registerBrowserOriginPolicies(dev, { env: {}, allowedOrigins, devNullOrigin: true });
    dev.get("/api/ping", (c) => c.text("pong"));
    expect((await dev.request("/api/ping", { headers: { Origin: "null" } })).headers.get("access-control-allow-origin")).toBe("null");
  });
});
