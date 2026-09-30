/**
 * The CLI's shared-terminal WebSocket through the real platform upgrade listener and relay: the
 * listener names the actor from the upgrade's bearer before it relays the socket, and the relayed
 * upgrade the home receives carries the ticket but no platform credential.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { insertUserMachine } from "../../packages/platform/src/db.js";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import { registerPlatformWebSocketUpgradeHandler } from "../../packages/platform/src/platform-websocket-upgrade.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { createCliCollaborationTransport } from "../../packages/sync-client/src/cli/collaboration-direct-transport.js";
import { watchCollaborationTerminal } from "../../packages/sync-client/src/cli/commands/collaboration.js";
import { PLATFORM, RELAY, fakeDirectWorld, scopeId } from "../helpers/collaboration-direct-world.js";
import { JWT_SECRET, cleanupProxyRoutingTest, setupProxyRoutingTest } from "../platform/proxy-routing-test-utils.js";

/** Upstream TLS connections the listener opens to the home; each records what it was sent. */
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

class ClientTransport extends EventEmitter {
  destroyed = false;
  write() { return true; }
  pipe() { return this; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
}

const machineId = "11111111-1111-4111-8111-111111111111";
const home = { runtimeId: `vps-${machineId}`, origin: "https://203.0.113.10:443" };
let db: PlatformDB;
let relay: CollaborationRelay;
let upgrade: (req: IncomingMessage, socket: ClientTransport, head: Buffer) => Promise<void>;

beforeEach(async () => {
  db = await setupProxyRoutingTest();
  tls.upstreams.length = 0;
  await insertUserMachine(db, {
    machineId, clerkUserId: "user_owner", handle: "owner-handle", runtimeSlot: "primary", status: "running",
    hetznerServerId: 100, publicIPv4: "203.0.113.10", imageVersion: "dev", serverType: "cpx22",
    provisionedAt: "2026-07-16T00:00:00.000Z",
  });
  relay = new CollaborationRelay({
    resolveScopeHome: async (id) => (id === scopeId ? home : null),
    resolveInvitationHome: async () => null,
    resolveRuntimeHome: async () => null,
    resolveSessionHome: async () => null,
  });
  const server = new EventEmitter();
  const permitted = { runtimeProxyAllowed: true } as never;
  registerPlatformWebSocketUpgradeHandler({
    server: server as Server, app: { capturePlatformEvent: vi.fn() }, db,
    env: {}, platformSecret: "platform-secret-cli-terminal", platformJwtSecret: JWT_SECRET, legacyContainerRoutingEnabled: false,
    codeServerPort: 8080, getRuntimeEntitlementDecision: () => permitted, getRuntimeEntitlementDecisionForUser: async () => permitted,
    collaborationDirect: { handleUpgrade: async () => false, relay },
  });
  upgrade = server.listeners("upgrade")[0] as typeof upgrade;
});

afterEach(async () => {
  relay.close();
  await cleanupProxyRoutingTest(db);
});

/** A CLI transport whose tickets name the platform relay, as production does. */
async function cliTerminal(bearer: string) {
  const world = fakeDirectWorld();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/api/collaboration/connections") {
      const response = await world.fetchImpl(input, init);
      const body = await response.json() as { endpoint: { origin: string } };
      return Response.json({ ...body, endpoint: { ...body.endpoint, origin: PLATFORM } }, { status: response.status });
    }
    return world.fetchImpl(`${RELAY}${url.pathname}${url.search}`, init);
  });
  return createCliCollaborationTransport({ platformUrl: PLATFORM, token: bearer, fetchImpl, now: world.now }).terminal(scopeId);
}

/** Opens the CLI's WebSocket against the real platform upgrade listener instead of the network. */
function upgradeSocket(opened: ClientTransport[]) {
  return class {
    private readonly client = new ClientTransport();
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      opened.push(this.client);
      const target = new URL(url);
      const req = {
        url: `${target.pathname}${target.search}`, method: "GET",
        headers: { host: target.host, upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...options?.headers },
      };
      void upgrade(req as unknown as IncomingMessage, this.client, Buffer.alloc(0));
    }
    on(event: string, listener: (...args: unknown[]) => void) { this.client.on(event, listener); return this; }
    send() { /* the home's frames are not part of this test */ }
    close() { this.client.destroy(); }
  };
}

describe("CLI shared terminal through the platform relay", () => {
  it("relays the CLI's terminal upgrade to the home without its bearer", async () => {
    const { token: bearer } = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: "user_member", handle: "member-handle", gatewayUrl: PLATFORM });
    const connection = await cliTerminal(bearer);
    const opened: ClientTransport[] = [];
    const watching = watchCollaborationTerminal({
      platformUrl: PLATFORM, token: bearer, scopeId, transport: { request: vi.fn(), terminal: async () => connection } as never,
      WebSocketImpl: upgradeSocket(opened) as never, writeOutput: vi.fn(), writeState: vi.fn(),
    });
    await vi.waitFor(() => expect(tls.upstreams.at(-1)?.writes.length).toBeGreaterThan(0));
    expect(opened[0]!.destroyed).toBe(false);
    const relayed = tls.upstreams.at(-1)!.writes.join("");
    expect(relayed).toMatch(new RegExp(`^GET /ws/collaboration/direct/scopes/${scopeId}/terminal\\?ticket=`));
    expect(relayed.toLowerCase()).not.toContain("authorization");
    expect(relayed).not.toContain(bearer);
    opened[0]!.destroy();
    await expect(watching).resolves.toBeUndefined();
  });

  it("is refused before any home is dialed when the upgrade carries no platform credential", async () => {
    const { token: bearer } = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: "user_member", handle: "member-handle", gatewayUrl: PLATFORM });
    const connection = await cliTerminal(bearer);
    const opened: ClientTransport[] = [];
    const Socket = upgradeSocket(opened);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // What the CLI sent before this fix: the ticket URL alone.
      new Socket(connection.url, { headers: {} });
      await vi.waitFor(() => expect(opened[0]!.destroyed).toBe(true));
    } finally {
      warn.mockRestore();
    }
    expect(tls.upstreams).toHaveLength(0);
  });
});
