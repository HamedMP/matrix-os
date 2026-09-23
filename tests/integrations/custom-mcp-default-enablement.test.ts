import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import type { CustomMcpTool } from "../../packages/gateway/src/integrations/custom-mcp/types.js";

const discoveredTool = (name: string): CustomMcpTool => ({
  name, description: `${name} description`, inputSchema: { type: "object" },
  enabled: false, approval: "always_ask",
});

describe("Custom MCP discovery defaults", () => {
  let db: PlatformDb;
  let userId: string;
  let broker: CustomMcpBroker;
  const discover = vi.fn<RemoteMcpClient["discover"]>();
  const upsert = vi.fn(async () => {});

  beforeEach(async () => {
    const pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();
    userId = (await db.createUser({
      clerkId: "clerk-mcp-default", handle: "mcp-default", displayName: "MCP Default",
      email: "mcp-default@example.test", containerId: "container-mcp-default",
    })).id;
    discover.mockReset();
    upsert.mockClear();
    broker = new CustomMcpBroker({
      db, encryptionKey: Buffer.alloc(32),
      projection: { upsert, remove: vi.fn(async () => {}) },
      client: { discover } as unknown as RemoteMcpClient,
      validateUrl: vi.fn(async () => ({})) as unknown as NonNullable<ConstructorParameters<typeof CustomMcpBroker>[0]["validateUrl"]>,
    });
  });

  afterEach(async () => { await db.destroy(); });

  async function createServer() {
    return broker.create(userId, { name: "Research", url: "https://example.com/mcp", authMode: "none" });
  }

  it("enables a new server and every discovered tool with per-call approval", async () => {
    const server = await createServer();
    discover.mockResolvedValueOnce([discoveredTool("search"), discoveredTool("write")]);

    const result = await broker.discover(userId, server.id);

    expect(result).toMatchObject({ enabled: true, status: "ready" });
    expect(result.tools).toEqual([
      { ...discoveredTool("search"), enabled: true },
      { ...discoveredTool("write"), enabled: true },
    ]);
    expect(upsert).toHaveBeenLastCalledWith(userId, expect.objectContaining({
      enabled: true,
      tools: [
        { name: "search", enabled: true, approval: "always_ask" },
        { name: "write", enabled: true, approval: "always_ask" },
      ],
    }));
  });

  it("preserves explicit tool opt-outs and server disablement on rediscovery", async () => {
    const server = await createServer();
    discover.mockResolvedValueOnce([discoveredTool("search"), discoveredTool("write")]);
    const first = await broker.discover(userId, server.id);
    const configured = await broker.patch(userId, server.id, {
      revision: first.revision, enabled: false,
      tools: [
        { name: "search", enabled: false, approval: "always_ask" },
        { name: "write", enabled: true, approval: "allow" },
      ],
    });
    discover.mockResolvedValueOnce([discoveredTool("search"), discoveredTool("write"), discoveredTool("new")]);

    const refreshed = await broker.discover(userId, server.id);

    expect(refreshed).toMatchObject({ enabled: false, status: "disabled", revision: configured.revision + 1 });
    expect(refreshed.tools.map(({ name, enabled, approval }) => ({ name, enabled, approval }))).toEqual([
      { name: "search", enabled: false, approval: "always_ask" },
      { name: "write", enabled: true, approval: "allow" },
      { name: "new", enabled: true, approval: "always_ask" },
    ]);
  });

  it("keeps an active server active while preserving its tool choices", async () => {
    const server = await createServer();
    discover.mockResolvedValueOnce([discoveredTool("search"), discoveredTool("write")]);
    const first = await broker.discover(userId, server.id);
    await broker.patch(userId, server.id, {
      revision: first.revision,
      tools: [
        { name: "search", enabled: false, approval: "always_ask" },
        { name: "write", enabled: true, approval: "allow" },
      ],
    });
    discover.mockResolvedValueOnce([discoveredTool("search"), discoveredTool("write")]);

    const refreshed = await broker.discover(userId, server.id);

    expect(refreshed).toMatchObject({ enabled: true, status: "ready" });
    expect(refreshed.tools.map(({ name, enabled, approval }) => ({ name, enabled, approval }))).toEqual([
      { name: "search", enabled: false, approval: "always_ask" },
      { name: "write", enabled: true, approval: "allow" },
    ]);
  });

  it("keeps a server disabled when discovery finds no tools", async () => {
    const server = await createServer();
    discover.mockResolvedValueOnce([]);

    const result = await broker.discover(userId, server.id);

    expect(result).toMatchObject({ enabled: false, status: "disabled", tools: [] });
  });
});
