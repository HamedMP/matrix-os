/**
 * Cloud Run treats an upgrade whose connection closes without any HTTP response as an instance
 * failure ("the HTTP response was malformed or connection to the instance had an error") and
 * stops routing new requests to that instance. One client retrying an unauthenticated `/ws`
 * every 30s took a platform instance out of service every 30s. Every refusal the upgrade
 * listener makes before the upstream answers must therefore send a real HTTP status first;
 * only a relay that has already passed upstream bytes to the client may be closed bare.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { insertUserMachine } from "../../packages/platform/src/db.js";
import { registerPlatformWebSocketUpgradeHandler, rejectWebSocketUpgrade } from "../../packages/platform/src/platform-websocket-upgrade.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { JWT_SECRET, setupProxyRoutingTest, cleanupProxyRoutingTest } from "./proxy-routing-test-utils.js";

const tls = vi.hoisted(() => ({ upstreams: [] as Array<EventEmitter & { writes: string[]; destroyed: boolean }> }));
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
      tls.upstreams.push(upstream as unknown as EventEmitter & { writes: string[]; destroyed: boolean });
      queueMicrotask(onConnect);
      return upstream;
    },
  };
});

/** A writable client socket that records what was written or ended on it. */
class ClientSocket extends EventEmitter {
  writes: string[] = [];
  ended: string[] = [];
  destroyed = false;
  writable = true;
  write(value: string) { this.writes.push(value); return true; }
  end(value?: string, callback?: () => void) {
    if (value !== undefined) this.ended.push(value);
    this.writable = false;
    queueMicrotask(() => callback?.());
    return this;
  }
  pipe() { return this; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.writable = false; this.emit("close"); } return this; }
}

const machineId = "22222222-2222-4222-8222-222222222222";
let db: PlatformDB;
beforeEach(async () => { db = await setupProxyRoutingTest(); tls.upstreams.length = 0; });
afterEach(async () => { await cleanupProxyRoutingTest(db); });

function listen(overrides: { runtimeProxyAllowed?: boolean } = {}) {
  const server = new EventEmitter();
  const decision = { runtimeProxyAllowed: overrides.runtimeProxyAllowed ?? true } as never;
  registerPlatformWebSocketUpgradeHandler({
    server: server as Server, app: { capturePlatformEvent: vi.fn() }, db,
    env: {}, platformSecret: "platform-secret-upgrade-rejection", platformJwtSecret: JWT_SECRET, legacyContainerRoutingEnabled: false,
    codeServerPort: 8080, getRuntimeEntitlementDecision: () => decision, getRuntimeEntitlementDecisionForUser: async () => decision,
  });
  return server.listeners("upgrade")[0] as (req: IncomingMessage, socket: ClientSocket, head: Buffer) => Promise<void>;
}

async function upgrade(listener: ReturnType<typeof listen>, req: { url: string; headers: Record<string, string> }): Promise<ClientSocket> {
  const socket = new ClientSocket();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await listener({ method: "GET", ...req } as unknown as IncomingMessage, socket, Buffer.alloc(0));
  } finally {
    warn.mockRestore();
  }
  return socket;
}

async function ownerToken(): Promise<string> {
  const { token } = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: "user_owner", handle: "owner-handle", gatewayUrl: "https://app.matrix-os.com" });
  return token;
}

async function seedRunningMachine(): Promise<void> {
  await insertUserMachine(db, {
    machineId, clerkUserId: "user_owner", handle: "owner-handle", runtimeSlot: "primary", status: "running",
    hetznerServerId: 200, publicIPv4: "203.0.113.20", imageVersion: "dev", serverType: "cpx22",
    provisionedAt: "2026-07-16T00:00:00.000Z",
  });
}

function statusLine(socket: ClientSocket): string | undefined {
  return [...socket.writes, ...socket.ended].join("").split("\r\n")[0];
}

describe("platform WebSocket upgrade refusals", () => {
  it("answers an unauthenticated upgrade with 401 before closing", async () => {
    const socket = await upgrade(listen(), { url: "/ws", headers: { host: "app.matrix-os.com", upgrade: "websocket" } });
    expect(statusLine(socket)).toBe("HTTP/1.1 401 Unauthorized");
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  });

  it("answers an upgrade for a host it does not route with 404 before closing", async () => {
    const socket = await upgrade(listen(), { url: "/ws", headers: { host: "unrouted.example.com", upgrade: "websocket" } });
    expect(statusLine(socket)).toBe("HTTP/1.1 404 Not Found");
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  });

  it("answers an entitlement-denied upgrade with 403 before closing", async () => {
    await seedRunningMachine();
    const socket = await upgrade(listen({ runtimeProxyAllowed: false }), {
      url: "/ws", headers: { host: "app.matrix-os.com", upgrade: "websocket", authorization: `Bearer ${await ownerToken()}` },
    });
    expect(statusLine(socket)).toBe("HTTP/1.1 403 Forbidden");
  });

  it("answers 502 when the home connection fails before the home has answered", async () => {
    await seedRunningMachine();
    const socket = await upgrade(listen(), {
      url: "/ws", headers: { host: "app.matrix-os.com", upgrade: "websocket", authorization: `Bearer ${await ownerToken()}` },
    });
    await vi.waitFor(() => expect(tls.upstreams.at(-1)?.writes.length).toBeGreaterThan(0));
    tls.upstreams.at(-1)!.emit("error", new Error("ECONNRESET"));
    expect(statusLine(socket)).toBe("HTTP/1.1 502 Bad Gateway");
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  });

  it("closes an established relay without writing an HTTP response", async () => {
    await seedRunningMachine();
    const socket = await upgrade(listen(), {
      url: "/ws", headers: { host: "app.matrix-os.com", upgrade: "websocket", authorization: `Bearer ${await ownerToken()}` },
    });
    await vi.waitFor(() => expect(tls.upstreams.at(-1)?.writes.length).toBeGreaterThan(0));
    const upstream = tls.upstreams.at(-1)!;
    // The home answered (101 and frames flow through the pipe); a later failure must not inject HTTP text.
    upstream.emit("data", Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"));
    upstream.emit("error", new Error("ECONNRESET"));
    expect(socket.writes).toEqual([]);
    expect(socket.ended).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });
});

describe("rejectWebSocketUpgrade", () => {
  it("only destroys a socket that can no longer be written", () => {
    const socket = new ClientSocket();
    socket.writable = false;
    rejectWebSocketUpgrade(socket as never, 401);
    expect(socket.ended).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("writes a bodyless status response with Connection: close", () => {
    const socket = new ClientSocket();
    rejectWebSocketUpgrade(socket as never, 503);
    expect(socket.ended).toEqual(["HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"]);
  });
});
