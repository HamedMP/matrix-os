/**
 * S05 review: the direct-socket branch of the platform upgrade listener must
 * settle every failure by destroying the client socket. A rejected relay
 * preparation (directory database down) must never surface as an unhandled
 * rejection with the socket left open, and a relayed socket is a pair: idle
 * eviction and the relay's shutdown drain must destroy the upstream TLS
 * connection to the home as well, releasing its counts exactly once.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { insertUserMachine } from "../../packages/platform/src/db.js";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import { registerPlatformWebSocketUpgradeHandler } from "../../packages/platform/src/platform-websocket-upgrade.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { JWT_SECRET, setupProxyRoutingTest, cleanupProxyRoutingTest } from "./proxy-routing-test-utils.js";

/** Upstream TLS sockets the listener opened; the fake behaves like a socket, closing on destroy. */
const tls = vi.hoisted(() => ({ upstreams: [] as Array<{ writes: string[]; destroyed: boolean }> }));
vi.mock("node:tls", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class Upstream extends Emitter {
    writes: string[] = [];
    destroyed = false;
    write(value: string) { this.writes.push(value); return true; }
    pipe() { return this; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
  }
  return {
    connect: (_options: unknown, onConnect: () => void) => {
      const upstream = new Upstream();
      tls.upstreams.push(upstream as unknown as { writes: string[]; destroyed: boolean });
      queueMicrotask(onConnect);
      return upstream;
    },
  };
});

class Transport extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  write(value: string) { this.writes.push(value); return true; }
  pipe() { return this; }
  // A real socket emits `close`, never `error`, when it is destroyed deliberately.
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
}

const scopeId = "10000000-0000-4000-8000-000000000001";
const machineId = "11111111-1111-4111-8111-111111111111";
const home = { runtimeId: `vps-${machineId}`, origin: "https://203.0.113.10:443" };
let db: PlatformDB;
beforeEach(async () => { db = await setupProxyRoutingTest(); tls.upstreams.length = 0; });
afterEach(async () => { await cleanupProxyRoutingTest(db); });

function directRelay(now: () => number) {
  return new CollaborationRelay({
    resolveScopeHome: async (id) => (id === scopeId ? home : null),
    resolveInvitationHome: async () => null,
    resolveRuntimeHome: async () => null,
    resolveSessionHome: async () => null,
    now,
  });
}

/** Drives the real upgrade listener until the relayed pair is connected. */
async function openDirectPair(relay: CollaborationRelay): Promise<Transport> {
  const server = new EventEmitter();
  const permitted = { runtimeProxyAllowed: true } as never;
  registerPlatformWebSocketUpgradeHandler({
    server: server as Server, app: { capturePlatformEvent: vi.fn() }, db,
    env: {}, platformSecret: "platform-secret-direct-upgrade", platformJwtSecret: JWT_SECRET, legacyContainerRoutingEnabled: false,
    codeServerPort: 8080, getRuntimeEntitlementDecision: () => permitted, getRuntimeEntitlementDecisionForUser: async () => permitted,
    collaborationDirect: { handleUpgrade: async () => false, relay },
  });
  const { token } = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: "user_member", handle: "member-handle", gatewayUrl: "https://app.matrix-os.com" });
  const socket = new Transport();
  const req = {
    url: `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=abc`, method: "GET",
    headers: { host: "app.matrix-os.com", upgrade: "websocket", authorization: `Bearer ${token}` },
  };
  const listener = server.listeners("upgrade")[0] as (req: IncomingMessage, socket: Transport, head: Buffer) => Promise<void>;
  await listener(req as unknown as IncomingMessage, socket, Buffer.alloc(0));
  await vi.waitFor(() => { expect(tls.upstreams.at(-1)?.writes.length).toBeGreaterThan(0); });
  expect(socket.destroyed).toBe(false);
  return socket;
}

async function seedRunningHome(): Promise<void> {
  await insertUserMachine(db, {
    machineId, clerkUserId: "user_owner", handle: "owner-handle", runtimeSlot: "primary", status: "running",
    hetznerServerId: 100, publicIPv4: "203.0.113.10", imageVersion: "dev", serverType: "cpx22",
    provisionedAt: "2026-07-16T00:00:00.000Z",
  });
}

describe("platform direct-socket upgrade failure handling", () => {
  it("destroys the client socket and settles when relay preparation rejects", async () => {
    const server = new EventEmitter();
    const permitted = { runtimeProxyAllowed: true } as never;
    const prepareSocket = vi.fn(async () => { throw new Error("connection terminated unexpectedly"); });
    registerPlatformWebSocketUpgradeHandler({
      server: server as Server, app: { capturePlatformEvent: vi.fn() }, db,
      env: {}, platformSecret: "platform-secret-direct-upgrade", platformJwtSecret: JWT_SECRET, legacyContainerRoutingEnabled: false,
      codeServerPort: 8080, getRuntimeEntitlementDecision: () => permitted, getRuntimeEntitlementDecisionForUser: async () => permitted,
      collaborationDirect: { handleUpgrade: async () => false, relay: { prepareSocket } },
    });
    const { token } = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: "user_member", handle: "member-handle", gatewayUrl: "https://app.matrix-os.com" });
    const socket = new Transport();
    const req = {
      url: `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=abc`, method: "GET",
      headers: { host: "app.matrix-os.com", upgrade: "websocket", authorization: `Bearer ${token}` },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const listener = server.listeners("upgrade")[0] as (req: IncomingMessage, socket: Transport, head: Buffer) => Promise<void>;
      await expect(listener(req as unknown as IncomingMessage, socket, Buffer.alloc(0))).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
    expect(prepareSocket).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
    expect(socket.writes).toEqual([]);
  });

  it("destroys the upstream socket when the idle sweep evicts a relayed pair", async () => {
    await seedRunningHome();
    let clock = 1_000_000;
    const relay = directRelay(() => clock);
    const socket = await openDirectPair(relay);
    const upstream = tls.upstreams.at(-1)!;
    expect(relay.connectionCounts()).toEqual({ homes: 1, actors: 1 });
    expect(upstream.destroyed).toBe(false);
    // No bytes in either direction past the idle window: the reservation is swept.
    clock += 11 * 60_000;
    expect(relay.sweepStaleSockets()).toBe(1);
    expect(socket.destroyed).toBe(true);
    // The TLS connection to the customer's home must die with the client half.
    expect(upstream.destroyed).toBe(true);
    expect(relay.connectionCounts()).toEqual({ homes: 0, actors: 0 });
    // Counts are released exactly once however many times teardown is repeated.
    socket.destroy();
    upstream.destroy();
    expect(relay.connectionCounts()).toEqual({ homes: 0, actors: 0 });
  });

  it("destroys both halves of an active relayed pair when the relay shuts down", async () => {
    await seedRunningHome();
    const relay = directRelay(() => 2_000_000);
    const socket = await openDirectPair(relay);
    const upstream = tls.upstreams.at(-1)!;
    expect(relay.connectionCounts()).toEqual({ homes: 1, actors: 1 });
    relay.close();
    expect(socket.destroyed).toBe(true);
    expect(upstream.destroyed).toBe(true);
    expect(relay.connectionCounts()).toEqual({ homes: 0, actors: 0 });
  });

  it("destroys the client half when the upstream socket closes first", async () => {
    await seedRunningHome();
    const relay = directRelay(() => 3_000_000);
    const socket = await openDirectPair(relay);
    const upstream = tls.upstreams.at(-1)! as unknown as { destroy(): void };
    upstream.destroy();
    await vi.waitFor(() => { expect(socket.destroyed).toBe(true); });
    expect(relay.connectionCounts()).toEqual({ homes: 0, actors: 0 });
  });
});
