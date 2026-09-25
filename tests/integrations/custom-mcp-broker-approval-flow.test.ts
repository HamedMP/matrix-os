import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import type { CustomMcpServerProjection } from "../../packages/gateway/src/integrations/custom-mcp/types.js";

describe("Custom MCP broker approved dispatch", () => {
  let db: PlatformDb;
  let pglite: InstanceType<typeof KyselyPGlite>;
  let userId: string;
  let serverId: string;
  let projection: CustomMcpServerProjection;
  let broker: CustomMcpBroker;
  let remoteCall: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();
    userId = (await db.createUser({ clerkId: "actor-owner", handle: "owner", displayName: "Owner",
      email: "owner@example.test", containerId: "container-owner" })).id;
    const server = await db.createCustomMcpServer({ userId, name: "Fixture", url: "https://mcp.example.test/mcp",
      authMode: "none", pendingExpiresAt: new Date(Date.now() + 60_000) });
    serverId = server.id;
    await db.updateCustomMcpServer(serverId, userId, server.revision, { enabled: true, status: "ready",
      tools: [
        { name: "publish", description: "Publish", inputSchema: { type: "object" }, enabled: true, approval: "always_ask" },
        { name: "search", description: "Search", inputSchema: { type: "object" }, enabled: true, approval: "allow" },
      ] });
    projection = { id: serverId, name: "Fixture", url: server.url, authMode: "none", enabled: true,
      revision: 2, tools: [
        { name: "publish", enabled: true, approval: "always_ask" },
        { name: "search", enabled: true, approval: "allow" },
      ] };
    remoteCall = vi.fn(async () => ({ ok: true }));
    broker = new CustomMcpBroker({ db, encryptionKey: Buffer.alloc(32),
      projection: { upsert: vi.fn(), remove: vi.fn(), read: vi.fn(async () => projection) },
      client: { callTool: remoteCall } as unknown as RemoteMcpClient });
    expect(await db.registerCustomMcpRunLease({ userId, actorId: "actor-owner", runId: "run_owner",
      expiresAt: new Date(Date.now() + 35 * 60_000) })).not.toBeNull();
  });

  afterEach(async () => { await db.destroy(); });

  it("reserves an always_ask challenge and dispatches exactly once after a trusted decision", async () => {
    const argumentsValue = { document: "synthetic" };
    const prepared = await (broker as any).prepareToolApproval({ userId, actorId: "actor-owner",
      runId: "run_owner", generation: 1, nativeRequestId: "native_1", serverId, toolName: "publish",
      arguments: argumentsValue });
    expect(prepared).toMatchObject({ kind: "pending", approvalId: expect.any(String) });
    const deniedBeforeDecision = broker.callSelectedTool({ userId, serverId, toolName: "publish",
      arguments: argumentsValue, approvalGranted: true });
    await expect(deniedBeforeDecision).rejects.toMatchObject({ code: "forbidden" });
    const decided = await db.decideCustomMcpToolApproval({ userId, actorId: "actor-owner",
      runId: "run_owner", approvalId: prepared.approvalId, decision: "approve" });
    const call = () => (broker as any).callSelectedTool({ userId, actorId: "actor-owner", runId: "run_owner",
      serverId, toolName: "publish", arguments: argumentsValue, approvalReceipt: decided?.receipt });
    await expect(call()).resolves.toEqual({ ok: true });
    await expect(call()).rejects.toMatchObject({ code: "forbidden" });
    expect(remoteCall).toHaveBeenCalledTimes(1);
    expect(remoteCall.mock.calls[0]?.[0]?.arguments).toEqual(argumentsValue);
  });

  it("fast-paths allow without a user prompt and rejects changed input or policy", async () => {
    const prepared = await (broker as any).prepareToolApproval({ userId, actorId: "actor-owner",
      runId: "run_owner", generation: 1, nativeRequestId: "native_allow", serverId, toolName: "search",
      arguments: { q: "fixture" } });
    expect(prepared).toEqual({ kind: "allow" });
    await expect(broker.callSelectedTool({ userId, serverId, toolName: "search",
      arguments: { q: "fixture" }, approvalGranted: false })).resolves.toEqual({ ok: true });
    const pending = await (broker as any).prepareToolApproval({ userId, actorId: "actor-owner",
      runId: "run_owner", generation: 1, nativeRequestId: "native_2", serverId, toolName: "publish",
      arguments: { document: "original" } });
    const receipt = (await db.decideCustomMcpToolApproval({ userId, actorId: "actor-owner",
      runId: "run_owner", approvalId: pending.approvalId, decision: "approve" }))!.receipt!;
    await expect((broker as any).callSelectedTool({ userId, actorId: "actor-owner", runId: "run_owner",
      serverId, toolName: "publish", arguments: { document: "changed" }, approvalReceipt: receipt }))
      .rejects.toMatchObject({ code: "forbidden" });
    projection.revision = 3;
    await expect((broker as any).callSelectedTool({ userId, actorId: "actor-owner", runId: "run_owner",
      serverId, toolName: "publish", arguments: { document: "original" }, approvalReceipt: receipt }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(remoteCall).toHaveBeenCalledTimes(1);
  });
});
