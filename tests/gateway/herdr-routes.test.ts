import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import { TerminalTabServerFrameSchema } from "@matrix-os/contracts";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { createHerdrAdapter, type HerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { herdrTabId } from "../../packages/gateway/src/herdr/refs.js";
import { createHerdrRoutes } from "../../packages/gateway/src/herdr/routes.js";
import { registerHerdrTerminalWebSocket } from "../../packages/gateway/src/herdr/ws.js";
import { createTerminalLiveOwnership } from "../../packages/gateway/src/terminal-live-ownership.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";

const OWNER = "user_owner";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const principalOf = (c: Context) => ({ userId: c.req.header("x-test-user") ?? new URL(c.req.url).searchParams.get("user") ?? "", source: "test" as never });

async function gateway(options: { adapter?: HerdrAdapter | null; maxViewersPerSession?: number; attachDelayMs?: number } = {}) {
  const core = createFakeHerdrCore();
  const real = options.adapter === undefined
    ? createHerdrAdapter({ open: async () => core.connect(), captureQuietMs: 5, captureMaxMs: 100 })
    : options.adapter;
  // A slow core answer, so frames a client sends right after opening arrive mid-attach.
  const adapter: HerdrAdapter | null = real && options.attachDelayMs
    ? { ...real, attach: async (...args: Parameters<HerdrAdapter["attach"]>) => {
      await new Promise((resolve) => setTimeout(resolve, options.attachDelayMs));
      return real.attach(...args);
    } }
    : real;
  if (adapter) cleanup.push(() => adapter.close());
  const app = new Hono();
  const ws = createNodeWebSocket({ app });
  const ownership = createTerminalLiveOwnership();
  cleanup.push(() => ownership.close());
  app.route("/api/terminal/herdr", createHerdrRoutes({ adapter, getPrincipal: principalOf, terminalOwnerIds: [OWNER] }));
  const viewers = registerHerdrTerminalWebSocket({
    app, upgradeWebSocket: ws.upgradeWebSocket, adapter, getPrincipal: principalOf, terminalOwnerIds: [OWNER],
    terminalLiveOwnership: ownership, maxViewersPerSession: options.maxViewersPerSession,
  });
  cleanup.push(() => viewers.drain());
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  ws.injectWebSocket(server);
  if (!server.listening) await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const base = `127.0.0.1:${address.port}`;
  return {
    core, adapter, viewers,
    http: (path: string, init: RequestInit & { user?: string } = {}) => fetch(`http://${base}${path}`, {
      ...init, headers: { "x-test-user": init.user ?? OWNER, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(5_000),
    }),
    connect(query: string) {
      const socket = new WebSocket(`ws://${base}/ws/terminal/herdr?${query}`);
      const frames: Array<Record<string, unknown>> = [];
      let closed = false;
      let closeCode: number | null = null;
      socket.on("message", (data) => { frames.push(JSON.parse(String(data))); });
      socket.on("close", (code) => { closed = true; closeCode = code; });
      cleanup.push(() => { if (!closed) socket.terminate(); });
      return {
        socket, frames,
        isClosed: () => closed,
        closeCode: () => closeCode,
        send: (frame: unknown) => socket.send(JSON.stringify(frame)),
        async until(check: () => boolean, ms = 2_000) {
          const start = Date.now();
          while (!check()) {
            if (Date.now() - start > ms) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        },
      };
    },
  };
}

const ref = (id: string) => ({ workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: herdrTabId(id) });

describe("GET /api/terminal/herdr", () => {
  it("lists Herdr sessions for the owner", async () => {
    const { core, http } = await gateway();
    core.add("t1", { title: "claude", status: { state: "working" } });
    const response = await http("/api/terminal/herdr");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true, status: "ready",
      sessions: [{ id: "t1", tabId: herdrTabId("t1"), title: "claude", status: "working" }],
    });
  });

  it("hides Herdr sessions from anyone but the owner", async () => {
    const { core, http } = await gateway();
    core.add("t1");
    const response = await http("/api/terminal/herdr", { user: "user_member" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Terminal operation failed" });
  });

  it("reports no Herdr when the adapter is not enabled", async () => {
    const { http } = await gateway({ adapter: null });
    expect(await (await http("/api/terminal/herdr")).json()).toEqual({ available: false, status: "unavailable", sessions: [] });
  });
});

describe("DELETE /api/terminal/herdr/:id", () => {
  it("ends a listed terminal for the owner", async () => {
    const { core, http } = await gateway();
    core.add("t1");
    const response = await http("/api/terminal/herdr/t1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(core.terminals.has("t1")).toBe(false);
  });

  it("refuses unknown, invalid, oversized and non-owner requests without touching the core", async () => {
    const { core, http } = await gateway();
    core.add("t1");
    expect((await http("/api/terminal/herdr/t9", { method: "DELETE" })).status).toBe(404);
    expect((await http("/api/terminal/herdr/..%2Fx", { method: "DELETE" })).status).toBe(400);
    expect((await http("/api/terminal/herdr/t1", { method: "DELETE", body: "x".repeat(4096), headers: { "content-type": "text/plain" } })).status).toBe(413);
    expect((await http("/api/terminal/herdr/t1", { method: "DELETE", user: "user_member" })).status).toBe(404);
    expect(core.calls.filter((call) => call.method === "terminal.kill")).toEqual([]);
  });
});

describe("WS /ws/terminal/herdr", () => {
  it("attaches as an observer by default with /ws/terminal/tab frames, and refuses input", async () => {
    const { core, connect } = await gateway();
    core.add("t1", { screen: "hello" });
    const client = connect(`id=t1&user=${OWNER}&cols=100&rows=30`);
    await client.until(() => client.frames.some((frame) => frame.type === "output"));

    for (const frame of client.frames) expect(TerminalTabServerFrameSchema.safeParse(frame).success).toBe(true);
    expect(client.frames[0]).toMatchObject({ type: "attached", terminalRef: ref("t1"), ownership: "observer", canonicalSize: { cols: 100, rows: 30 } });
    expect(client.frames[1]).toMatchObject({ type: "replay-start", terminalRef: ref("t1"), fromSeq: 0 });
    expect(client.frames[2]).toMatchObject({ type: "output", terminalRef: ref("t1"), data: "hello" });
    await client.until(() => core.viewers[0]?.credits === 5);

    client.send({ type: "input", terminalRef: ref("t1"), data: "ls\r" });
    client.send({ type: "ping", terminalRef: ref("t1") });
    await client.until(() => client.frames.some((frame) => frame.type === "pong"));
    expect(client.frames).toContainEqual({ type: "error", code: "read_only", message: "Terminal is read-only" });
    expect(core.terminals.get("t1")!.input).toEqual([]);
  });

  it("attaches an observer socket to the core as watch-only, and only the writer as a typing viewer", async () => {
    const { core, connect } = await gateway();
    core.add("t1");
    const observer = connect(`id=t1&user=${OWNER}&cols=400&rows=150`);
    await observer.until(() => observer.frames.some((frame) => frame.type === "attached"));
    const writer = connect(`id=t1&user=${OWNER}&lease=exclusive`);
    await writer.until(() => writer.frames.some((frame) => frame.type === "attached"));
    const attaches = core.calls.filter((call) => call.method === "terminal.attach");
    expect(attaches[0]!.params).toMatchObject({ observe: true, cols: 400, rows: 150 });
    expect(attaches[1]!.params).not.toHaveProperty("observe");
  });

  it("applies a writer's resize that arrives while the core attach is still pending", async () => {
    // Found live: the shell sends its real size right after the socket opens.
    // It reached the gateway mid-attach and was dropped, so the terminal kept
    // the attach-time size until the next resize or keystroke.
    const { core, connect } = await gateway({ attachDelayMs: 60 });
    core.add("t1");
    const client = connect(`id=t1&user=${OWNER}&lease=exclusive&cols=95&rows=31`);
    await new Promise<void>((resolve) => { client.socket.once("open", () => resolve()); });
    client.send({ type: "resize", terminalRef: ref("t1"), mode: "hard", size: { cols: 97, rows: 31 } });
    await client.until(() => client.frames.some((frame) => frame.type === "attached"));
    await client.until(() => core.terminals.get("t1")!.resizes.length > 0);
    const attach = core.calls.find((call) => call.method === "terminal.attach")!;
    expect(attach.params).toMatchObject({ cols: 95, rows: 31 });
    expect(core.terminals.get("t1")!.resizes).toEqual([{ cols: 97, rows: 31 }]);
  });

  it("never resizes for an observer's early resize", async () => {
    const { core, connect } = await gateway({ attachDelayMs: 60 });
    core.add("t1");
    const client = connect(`id=t1&user=${OWNER}&cols=95&rows=31`);
    await new Promise<void>((resolve) => { client.socket.once("open", () => resolve()); });
    client.send({ type: "resize", terminalRef: ref("t1"), mode: "hard", size: { cols: 97, rows: 31 } });
    await client.until(() => client.frames.some((frame) => frame.type === "replay-end"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(core.terminals.get("t1")!.resizes).toEqual([]);
  });

  it("brackets the core's first paint in a replay, so a browser pane reveals the terminal", async () => {
    // Found on a live VPS: the shell's terminal pane stays hidden until
    // replay-end, so a Herdr session opened blank although output arrived.
    const { core, connect } = await gateway();
    core.add("t1", { screen: "hello" });
    const client = connect(`id=t1&user=${OWNER}&cols=100&rows=30&lease=exclusive`);
    await client.until(() => client.frames.some((frame) => frame.type === "replay-end"));
    const types = client.frames.map((frame) => frame.type);
    expect(types.slice(0, 2)).toEqual(["attached", "replay-start"]);
    expect(types.indexOf("replay-end")).toBeGreaterThan(types.indexOf("replay-start"));
    expect(client.frames[0]).toMatchObject({ capabilities: ["binary-input-v1"] });
    const end = client.frames.find((frame) => frame.type === "replay-end")!;
    const replayed = client.frames.filter((frame, index) => frame.type === "output" && index < types.indexOf("replay-end"));
    expect(end).toMatchObject({ nextSeq: replayed.length });
    for (const frame of client.frames) expect(TerminalTabServerFrameSchema.safeParse(frame).success).toBe(true);
  });

  it("attaches by Matrix terminal ref, as the shell's terminal pane connects", async () => {
    const { core, connect } = await gateway();
    core.add("t1", { screen: "hi" });
    const { workspaceId, tabId } = ref("t1");
    const client = connect(`workspaceId=${workspaceId}&tabId=${tabId}&client=browser&fromSeq=0&inputCapability=binary-input-v1&user=${OWNER}`);
    await client.until(() => client.frames.some((frame) => frame.type === "output"));
    expect(client.frames[0]).toMatchObject({ type: "attached", terminalRef: ref("t1") });

    const other = connect(`workspaceId=tws_${"1".repeat(32)}&tabId=${tabId}&user=${OWNER}`);
    const unknown = connect(`workspaceId=${workspaceId}&tabId=tt_${"2".repeat(32)}&user=${OWNER}`);
    await other.until(() => other.isClosed());
    await unknown.until(() => unknown.isClosed());
    expect(other.frames).toEqual([{ type: "error", code: "invalid_request", message: "Invalid request" }]);
    expect(unknown.frames).toEqual([{ type: "error", code: "session_not_found", message: "Terminal ended" }]);
  });

  it("lets an exclusive viewer type and resize", async () => {
    const { core, connect } = await gateway();
    core.add("t1");
    const client = connect(`id=t1&user=${OWNER}&lease=exclusive`);
    await client.until(() => client.frames.some((frame) => frame.type === "attached"));
    expect(client.frames[0]).toMatchObject({ ownership: "writer" });

    client.send({ type: "input", terminalRef: ref("t1"), data: "ls\r" });
    client.send({ type: "binary", terminalRef: ref("t1"), dataBase64: Buffer.from([0x1b, 0x5b, 0x41]).toString("base64") });
    client.send({ type: "resize", terminalRef: ref("t1"), size: { cols: 90, rows: 25 }, mode: "hard" });
    await client.until(() => core.terminals.get("t1")!.resizes.length === 1);
    expect(core.terminals.get("t1")!.input).toEqual(["ls\r", "\x1b[A"]);
    expect(core.terminals.get("t1")!.resizes).toEqual([{ cols: 90, rows: 25 }]);
  });

  it("sends exit and closes when the terminal ends", async () => {
    const { core, connect, adapter } = await gateway();
    core.add("t1");
    const client = connect(`id=t1&user=${OWNER}`);
    await client.until(() => client.frames.some((frame) => frame.type === "attached"));
    await adapter!.kill("t1");
    await client.until(() => client.isClosed());
    expect(client.frames.at(-1)).toEqual({ type: "exit", terminalRef: ref("t1"), revision: 0, exitCode: null });
  });

  it("closes retryably, without exit, when the core connection drops but the terminal may live on", async () => {
    const { core, connect } = await gateway();
    core.add("t1");
    const client = connect(`id=t1&user=${OWNER}`);
    await client.until(() => client.frames.some((frame) => frame.type === "attached"));
    core.crash();
    await client.until(() => client.isClosed());
    expect(client.frames.some((frame) => frame.type === "exit")).toBe(false);
    // ShellSocket reconnects on any close without exit or a fatal error code.
    expect(client.frames.filter((frame) => frame.type === "error")).toEqual([]);
    expect(client.closeCode()).toBe(1012);
  });

  it("resumes a reconnecting viewer past its last sequence with a screen reset before the repaint", async () => {
    const { core, connect } = await gateway();
    core.add("t1", { screen: "hello" });
    const client = connect(`id=t1&user=${OWNER}&fromSeq=42`);
    await client.until(() => client.frames.some((frame) => frame.type === "replay-end"));
    expect(client.frames[0]).toMatchObject({ type: "attached", nextSeq: 42 });
    expect(client.frames[1]).toMatchObject({ type: "replay-start", fromSeq: 42 });
    const outputs = client.frames.filter((frame) => frame.type === "output");
    expect(outputs[0]).toMatchObject({ seq: 42, data: "\x1bchello" });
    expect(client.frames.find((frame) => frame.type === "replay-end")).toMatchObject({ nextSeq: 43, toSeq: 42 });
    for (const frame of client.frames) expect(TerminalTabServerFrameSchema.safeParse(frame).success).toBe(true);

    // A fresh viewer (no cursor, or Electron's live-tail sentinel) starts at 0 with no reset.
    for (const fresh of ["", "&fromSeq=0", `&fromSeq=${Number.MAX_SAFE_INTEGER}`]) {
      const viewer = connect(`id=t1&user=${OWNER}${fresh}`);
      await viewer.until(() => viewer.frames.some((frame) => frame.type === "output"));
      expect(viewer.frames.find((frame) => frame.type === "output")).toMatchObject({ seq: 0, data: "hello" });
      viewer.socket.close();
    }
  });

  it("ends a pane whose terminal is gone with a final session_not_found, not a retryable error", async () => {
    // Found live: an ended Herdr terminal answered every reconnect with a
    // retryable "Terminal unavailable", so the pane printed it forever.
    const { core, connect, http } = await gateway();
    core.add("t1");
    const gone = connect(`id=t2&user=${OWNER}`);
    await gone.until(() => gone.isClosed());
    expect(gone.frames).toEqual([{ type: "error", code: "session_not_found", message: "Terminal ended" }]);
    expect(gone.closeCode()).toBe(1000);

    // Listed a moment ago, ended before the core answered the attach.
    expect((await http("/api/terminal/herdr")).status).toBe(200);
    core.terminals.delete("t1");
    const raced = connect(`id=t1&user=${OWNER}`);
    await raced.until(() => raced.isClosed());
    expect(raced.frames).toEqual([{ type: "error", code: "session_not_found", message: "Terminal ended" }]);
    expect(raced.closeCode()).toBe(1000);
  });

  it("keeps a pane retrying while herdr-core cannot be reached", async () => {
    const core = createFakeHerdrCore();
    core.add("t1");
    core.failList("unavailable");
    const adapter = createHerdrAdapter({ open: async () => core.connect(), ttlMs: 0 });
    const { connect } = await gateway({ adapter });
    const client = connect(`id=t1&user=${OWNER}`);
    await client.until(() => client.isClosed());
    expect(client.frames).toEqual([{ type: "error", code: "unavailable", message: "Terminal unavailable" }]);
    expect(client.closeCode()).toBe(1013);
  });

  it("refuses non-owners, unknown terminals, bad requests and frames for another terminal", async () => {
    const { core, connect } = await gateway();
    core.add("t1");
    const member = connect("id=t1&user=user_member");
    const unknown = connect(`id=t9&user=${OWNER}`);
    const invalid = connect(`id=..&user=${OWNER}`);
    await member.until(() => member.isClosed());
    await unknown.until(() => unknown.isClosed());
    await invalid.until(() => invalid.isClosed());
    expect(member.frames).toEqual([{ type: "error", code: "not_found", message: "Terminal unavailable" }]);
    expect(unknown.frames).toEqual([{ type: "error", code: "session_not_found", message: "Terminal ended" }]);
    expect(invalid.frames).toEqual([{ type: "error", code: "invalid_request", message: "Invalid request" }]);

    const client = connect(`id=t1&user=${OWNER}&lease=exclusive`);
    await client.until(() => client.frames.some((frame) => frame.type === "attached"));
    client.send({ type: "input", terminalRef: { workspaceId: `tws_${"1".repeat(32)}`, tabId: herdrTabId("t1") }, data: "x" });
    await client.until(() => client.isClosed());
    expect(client.frames.at(-1)).toEqual({ type: "error", code: "invalid_message", message: "Invalid message" });
    expect(core.terminals.get("t1")!.input).toEqual([]);
  });

  it("caps viewers per terminal", async () => {
    const { core, connect } = await gateway({ maxViewersPerSession: 1 });
    core.add("t1");
    const first = connect(`id=t1&user=${OWNER}`);
    await first.until(() => first.frames.some((frame) => frame.type === "attached"));
    const second = connect(`id=t1&user=${OWNER}`);
    await second.until(() => second.isClosed());
    expect(second.frames).toEqual([{ type: "error", code: "capacity", message: "Too many viewers" }]);
  });

  it("drains every viewer on shutdown", async () => {
    const { core, connect, viewers } = await gateway();
    core.add("t1");
    const client = connect(`id=t1&user=${OWNER}`);
    await client.until(() => client.frames.some((frame) => frame.type === "attached"));
    expect(viewers.size()).toBe(1);
    viewers.drain();
    await client.until(() => client.isClosed());
    expect(viewers.size()).toBe(0);
    await client.until(() => core.viewers.length === 0);
  });
});
