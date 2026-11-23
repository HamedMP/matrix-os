import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { registerTerminalEventWebSocket } from "../../packages/gateway/src/terminal-agent/events-ws.js";
import type { TerminalEventHub, TerminalEventSubscriber } from "../../packages/gateway/src/terminal-agent/events.js";

// Spec 2706 layer 4: the events socket accepts a bounded "seen" frame from the
// owner and still closes on anything else.

const ref = { workspaceId: "tws_0123456789abcdef0123456789abcdef", tabId: "tt_0123456789abcdef0123456789abcdef" };

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
      markSeen: (seenRef) => { marks.push(seenRef); return true; },
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
    h.handlers.onMessage({ data: JSON.stringify({ type: "seen", ref }) }, h.ws);
    expect(h.marks).toEqual([ref]);
    expect(h.ws.sent).toEqual([]);
    expect(h.ws.closed).toEqual([]);
  });

  it("still answers pings", () => {
    const h = harness();
    h.handlers.onMessage({ data: JSON.stringify({ type: "ping" }) }, h.ws);
    expect(h.ws.sent).toEqual([JSON.stringify({ type: "pong" })]);
  });

  it.each([
    ["a malformed ref", { type: "seen", ref: { workspaceId: "../x", tabId: ref.tabId } }],
    ["extra fields", { type: "seen", ref, at: "2026-11-11T10:00:00.000Z" }],
    ["an unknown type", { type: "mark-all-seen" }],
  ])("closes the socket on %s", (_label, frame) => {
    const h = harness();
    h.handlers.onMessage({ data: JSON.stringify(frame) }, h.ws);
    expect(h.marks).toEqual([]);
    expect(h.ws.closed[0]?.[0]).toBe(1003);
  });
});
