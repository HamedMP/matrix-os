import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import { CustomMcpProjectionStore } from "../../packages/gateway/src/integrations/custom-mcp/projection-store.js";
import type { CustomMcpTool } from "../../packages/gateway/src/integrations/custom-mcp/types.js";
import { createIntegrationApprovalHook } from "../../packages/kernel/src/hooks.js";

const discoveredTool = (name: string): CustomMcpTool => ({
  name, description: `${name} description`, inputSchema: { type: "object" },
  enabled: false, approval: "always_ask",
});

describe("Custom MCP discovery defaults", () => {
  let db: PlatformDb;
  let userId: string;
  let broker: CustomMcpBroker;
  let homePath: string;
  let projection: CustomMcpProjectionStore;
  const discover = vi.fn<RemoteMcpClient["discover"]>();

  beforeEach(async () => {
    const pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();
    userId = (await db.createUser({
      clerkId: "clerk-mcp-default", handle: "mcp-default", displayName: "MCP Default",
      email: "mcp-default@example.test", containerId: "container-mcp-default",
    })).id;
    discover.mockReset();
    homePath = await mkdtemp(join(tmpdir(), "matrix-mcp-default-"));
    projection = new CustomMcpProjectionStore(homePath);
    broker = new CustomMcpBroker({
      db, encryptionKey: Buffer.alloc(32),
      projection: {
        upsert: async (_userId, server) => projection.upsert(server),
        remove: async (_userId, serverId) => projection.remove(serverId),
      },
      client: { discover } as unknown as RemoteMcpClient,
      validateUrl: vi.fn(async () => ({})) as unknown as NonNullable<ConstructorParameters<typeof CustomMcpBroker>[0]["validateUrl"]>,
    });
  });

  afterEach(async () => { await db.destroy(); await rm(homePath, { recursive: true, force: true }); });

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
    expect((await projection.read()).servers).toContainEqual(expect.objectContaining({
      enabled: true,
      tools: [
        { name: "search", enabled: true, approval: "always_ask" },
        { name: "write", enabled: true, approval: "always_ask" },
      ],
    }));
    const requestApproval = vi.fn(async () => true);
    const approvalHook = createIntegrationApprovalHook(homePath, requestApproval);
    const decision = await approvalHook({
      hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_custom_mcp_tool",
      tool_input: { server_id: server.id, tool: "search" }, session_id: "test-session",
    });
    expect(decision.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(requestApproval).toHaveBeenCalledOnce();
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

  it("disables a ready server when rediscovery removes its only enabled tool", async () => {
    const server = await createServer();
    discover.mockResolvedValueOnce([discoveredTool("off"), discoveredTool("on")]);
    const first = await broker.discover(userId, server.id);
    await broker.patch(userId, server.id, {
      revision: first.revision,
      tools: [
        { name: "off", enabled: false, approval: "always_ask" },
        { name: "on", enabled: true, approval: "always_ask" },
      ],
    });
    discover.mockResolvedValueOnce([discoveredTool("off")]);

    const refreshed = await broker.discover(userId, server.id);

    expect(refreshed).toMatchObject({ enabled: false, status: "disabled" });
    expect(refreshed.tools).toEqual([{ ...discoveredTool("off"), enabled: false }]);
  });

  it("does not reactivate a manually disabled server after an empty catalog", async () => {
    const server = await createServer();
    discover.mockResolvedValueOnce([discoveredTool("first")]);
    const first = await broker.discover(userId, server.id);
    await broker.patch(userId, server.id, { revision: first.revision, enabled: false });
    discover.mockResolvedValueOnce([]);
    await broker.discover(userId, server.id);
    discover.mockResolvedValueOnce([discoveredTool("later")]);

    const refreshed = await broker.discover(userId, server.id);

    expect(refreshed).toMatchObject({ enabled: false, status: "disabled" });
    expect(refreshed.tools).toEqual([{ ...discoveredTool("later"), enabled: true }]);
  });
});
