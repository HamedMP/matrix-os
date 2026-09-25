import { describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import type { CustomMcpServerProjection } from "../../packages/gateway/src/integrations/custom-mcp/types.js";

describe("Custom MCP broker Run policy", () => {
  it("allows the selected public-doc fixture but denies disabled, stale, unapproved, and foreign-owner calls", async () => {
    const serverId = "123e4567-e89b-42d3-a456-426614174000";
    const projection: CustomMcpServerProjection = {
      id: serverId, name: "Public docs fixture", url: "https://docs.example.test/mcp",
      authMode: "none", enabled: true, revision: 10,
      tools: [{ name: "search", enabled: true, approval: "allow" }],
    };
    const row = {
      id: serverId, url: projection.url, auth_mode: "none", encrypted_credentials: null,
      enabled: true, status: "ready", revision: 10,
      enforcement_projection: [{ name: "search", enabled: true, approval: "allow" }],
    };
    const db = {
      getCustomMcpServerForBroker: vi.fn(async (_serverId: string, userId: string) => userId === "owner_claude" ? row : null),
    } as unknown as PlatformDb;
    const remoteCall = vi.fn(async () => ({ text: "Synthetic public documentation result" }));
    const broker = new CustomMcpBroker({
      db, encryptionKey: Buffer.alloc(32),
      projection: {
        upsert: vi.fn(), remove: vi.fn(), read: vi.fn(async () => projection),
      },
      client: { callTool: remoteCall } as unknown as RemoteMcpClient,
    });
    const request = { userId: "owner_claude", serverId, toolName: "search", arguments: { query: "public docs" }, approvalGranted: false };

    await expect(broker.callSelectedTool(request)).resolves.toEqual({ text: "Synthetic public documentation result" });
    expect(remoteCall).toHaveBeenCalledOnce();
    row.enabled = false;
    await expect(broker.callSelectedTool(request)).rejects.toMatchObject({ code: "forbidden" });
    row.enabled = true;
    projection.tools[0]!.enabled = false;
    await expect(broker.callSelectedTool(request)).rejects.toMatchObject({ code: "forbidden" });
    projection.tools[0]!.enabled = true;
    projection.revision = 9;
    await expect(broker.callSelectedTool(request)).rejects.toMatchObject({ code: "forbidden" });
    projection.revision = 10;
    projection.tools[0]!.approval = "always_ask";
    await expect(broker.callSelectedTool(request)).rejects.toMatchObject({ code: "forbidden" });
    await expect(broker.callSelectedTool({ ...request, userId: "foreign_owner" })).rejects.toMatchObject({ code: "not_found" });
    expect(remoteCall).toHaveBeenCalledOnce();
  });
});
