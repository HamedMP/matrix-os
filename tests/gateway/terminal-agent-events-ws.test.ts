import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import type { UpgradeWebSocket } from "hono/ws";
import { createTerminalEventHub, type TerminalEventHub, type TerminalEventSubscriber } from "../../packages/gateway/src/terminal-agent/events.js";
import type { TerminalSeenStore } from "../../packages/gateway/src/terminal-agent/seen-store.js";
import { registerTerminalEventWebSocket } from "../../packages/gateway/src/terminal-agent/events-ws.js";

const OWNER = "user_owner";
const matrixWorkspace = "tws_0123456789abcdef0123456789abcdef";
const matrixTab = "tt_0123456789abcdef0123456789abcdef";
const herdrTab = "tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function workspace(id: string, tabId: string, status = "running") {
  return {
    id, scope: "main", canonicalSize: { cols: 80, rows: 24 }, status: "running", revision: 0,
    createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
    tabs: [{
      id: tabId, workspaceId: id, name: "shell", cwd: "", status, revision: 0, order: 0, accessScope: "owner",
      createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
    }],
  };
}

function memorySeen(): TerminalSeenStore & { marked: string[] } {
  const entries = new Map<string, { at: number; finished: boolean }>();
  const marked: string[] = [];
  return {
    marked,
    get: (key) => entries.get(key),
    mark: (key, at, finished) => { marked.push(key); entries.set(key, { at, finished }); },
    retain: () => undefined,
    size: () => entries.size,
    load: async () => undefined,
  };
}

async function gateway(options: { tabStatus?: string; seen?: TerminalSeenStore } = {}) {
  const hub = createTerminalEventHub({
    runtime: {
      listWorkspaces: async () => [
        workspace(matrixWorkspace, matrixTab, options.tabStatus), workspace(HERDR_TERMINAL_WORKSPACE_ID, herdrTab, options.tabStatus),
      ] as never,
    },
    status: { get: async () => undefined, list: async () => new Map() },
    ...(options.seen ? { seen: options.seen } : {}),
    autoStart: false,
  });
  cleanup.push(() => hub.shutdown());
  const app = new Hono();
  const ws = createNodeWebSocket({ app });
  const query = (c: Context, name: string) => new URL(c.req.url).searchParams.get(name) ?? undefined;
  registerTerminalEventWebSocket({
    app, upgradeWebSocket: ws.upgradeWebSocket, hub,
    getPrincipal: (c) => ({ userId: query(c, "user") ?? "", source: "test" as never }),
    getPreviewTerminalOwner: (c) => query(c, "previewOwner"),
    terminalOwnerIds: [OWNER],
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  ws.injectWebSocket(server);
  if (!server.listening) await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  async function connect(search: string, until: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${address!.port}/ws/terminal/events?${search}`);
    cleanup.push(() => socket.terminate());
    const frames: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => { frames.push(JSON.parse(String(data))); });
    const start = Date.now();
    while (!frames.some((frame) => frame.type === until)) {
      if (Date.now() - start > 2_000) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`);
      await hub.tick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { socket, frames, frame: frames.find((frame) => frame.type === until)! };
  }
  return {
    connect,
    async snapshot(search: string) {
      return (await connect(search, "snapshot")).frame as { tabs: Array<{ ref: { workspaceId: string } }> };
    },
  };
}

// Fault detected: a delegated preview collaborator discovers the owner's personal Herdr shells.
describe("WS /ws/terminal/events", () => {
  it("streams Herdr terminals to the owner but not to a delegated preview collaborator", async () => {
    const { snapshot } = await gateway();
    const owner = await snapshot(`user=${OWNER}`);
    expect(owner.tabs.map((tab) => tab.ref.workspaceId)).toEqual([matrixWorkspace, HERDR_TERMINAL_WORKSPACE_ID]);
    const collaborator = await snapshot(`user=user_collaborator&previewOwner=${OWNER}`);
    expect(collaborator.tabs.map((tab) => tab.ref.workspaceId)).toEqual([matrixWorkspace]);
  });

  // Fault detected: attention (done/seen) names the owner's Herdr tabs to a
  // collaborator, or lets the collaborator mark them seen for the owner.
  it("keeps Herdr tabs out of a delegated collaborator's attention and seen marks", async () => {
    const seen = memorySeen();
    const { connect } = await gateway({ tabStatus: "exited", seen });
    const owner = await connect(`user=${OWNER}`, "attention");
    expect(Object.keys(owner.frame.tabs as object).some((key) => key.startsWith(HERDR_TERMINAL_WORKSPACE_ID))).toBe(true);
    const collaborator = await connect(`user=user_collaborator&previewOwner=${OWNER}`, "attention");
    const keys = Object.keys(collaborator.frame.tabs as object);
    expect(keys.length).toBe(1);
    expect(keys.some((key) => key.startsWith(HERDR_TERMINAL_WORKSPACE_ID))).toBe(false);

    collaborator.socket.send(JSON.stringify({ type: "seen", ref: { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: herdrTab } }));
    collaborator.socket.send(JSON.stringify({ type: "seen", ref: { workspaceId: matrixWorkspace, tabId: matrixTab } }));
    const start = Date.now();
    while (seen.marked.length === 0) {
      if (Date.now() - start > 2_000) throw new Error("no seen mark arrived");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.marked.every((key) => !key.startsWith(HERDR_TERMINAL_WORKSPACE_ID))).toBe(true);
  });
});

// Spec 2706 layer 4: the events socket accepts a bounded "seen" frame from the
// owner and still closes on anything else.

const seenRef = { workspaceId: "tws_0123456789abcdef0123456789abcdef", tabId: "tt_0123456789abcdef0123456789abcdef" };

type Handlers = {
  onOpen(event: unknown, ws: FakeSocket): void;
  onMessage(event: { data: unknown }, ws: FakeSocket): void;
  onClose(): void;
};
interface FakeSocket { sent: string[]; closed: Array<[number, string]>; send(data: string): void; close(code: number, reason: string): void; raw?: unknown }

function harness() {
  let factory: ((c: unknown) => Handlers) | null = null;
  const marks: unknown[] = [];
  const hub: TerminalEventHub = {
    subscribe: (_subscriber: TerminalEventSubscriber) => ({
      touch: () => undefined,
      close: () => undefined,
      markSeen: (marked) => { marks.push(marked); return true; },
    }),
    tick: async () => undefined,
    size: () => 1,
    shutdown: () => undefined,
  };
  registerTerminalEventWebSocket({
    app: { get: () => undefined } as unknown as Hono,
    upgradeWebSocket: ((created: (c: unknown) => Handlers) => { factory = created; return () => undefined; }) as unknown as UpgradeWebSocket,
    hub,
    getPrincipal: () => ({ userId: "owner" }) as never,
    terminalOwnerIds: ["owner"],
  });
  const ws: FakeSocket = {
    sent: [], closed: [],
    send(data) { this.sent.push(data); },
    close(code, reason) { this.closed.push([code, reason]); },
  };
  const handlers = factory!({ get: () => undefined });
  handlers.onOpen({}, ws);
  return { ws, handlers, marks };
}

describe("terminal events socket", () => {
  it("passes a seen mark to the hub without a reply", () => {
    const h = harness();
    h.handlers.onMessage({ data: JSON.stringify({ type: "seen", ref: seenRef }) }, h.ws);
    expect(h.marks).toEqual([seenRef]);
    expect(h.ws.sent).toEqual([]);
    expect(h.ws.closed).toEqual([]);
  });

  it("still answers pings", () => {
    const h = harness();
    h.handlers.onMessage({ data: JSON.stringify({ type: "ping" }) }, h.ws);
    expect(h.ws.sent).toEqual([JSON.stringify({ type: "pong" })]);
  });

  it.each([
    ["a malformed ref", { type: "seen", ref: { workspaceId: "../x", tabId: seenRef.tabId } }],
    ["extra fields", { type: "seen", ref: seenRef, at: "2026-11-11T10:00:00.000Z" }],
    ["an unknown type", { type: "mark-all-seen" }],
  ])("closes the socket on %s", (_label, frame) => {
    const h = harness();
    h.handlers.onMessage({ data: JSON.stringify(frame) }, h.ws);
    expect(h.marks).toEqual([]);
    expect(h.ws.closed[0]?.[0]).toBe(1003);
  });
});
