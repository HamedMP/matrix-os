/**
 * S05 review: the direct-socket branch of the platform upgrade listener must
 * settle every failure by destroying the client socket. A rejected relay
 * preparation (directory database down) must never surface as an unhandled
 * rejection with the socket left open.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { registerPlatformWebSocketUpgradeHandler } from "../../packages/platform/src/platform-websocket-upgrade.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { JWT_SECRET, setupProxyRoutingTest, cleanupProxyRoutingTest } from "./proxy-routing-test-utils.js";

class Transport extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  write(value: string) { this.writes.push(value); return true; }
  pipe() { return this; }
  destroy() { this.destroyed = true; return this; }
}

const scopeId = "10000000-0000-4000-8000-000000000001";
let db: PlatformDB;
beforeEach(async () => { db = await setupProxyRoutingTest(); });
afterEach(async () => { await cleanupProxyRoutingTest(db); });

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
});
