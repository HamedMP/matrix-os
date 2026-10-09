import { describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";

describe("managed preset tool boundary", () => {
  it("denies raw meta-tool access and enforces exact trusted preset identity", async () => {
    const tool = { name: "execute", enabled: true, approval: "allow" as const };
    const projection = { id: "server", name: "Loops", url: "https://mcp.loops.so/", authMode: "none" as const, enabled: true, revision: 3, tools: [tool] };
    const row = { id: "server", preset_id: "loops", url: projection.url, auth_mode: "none", encrypted_credentials: null,
      enabled: true, status: "ready", revision: 3, enforcement_projection: [tool] };
    const call = vi.fn(async () => ({ ok: true }));
    const broker = new CustomMcpBroker({ db: { getCustomMcpServerForBroker: vi.fn(async () => row) } as unknown as PlatformDb,
      encryptionKey: Buffer.alloc(32), projection: { upsert: vi.fn(), remove: vi.fn(), read: vi.fn(async () => projection) },
      client: { callTool: call } as unknown as RemoteMcpClient });
    const input = { userId: "owner", serverId: "server", toolName: "execute", arguments: { method: "POST", path: "/v1/transactional" } };
    await expect(broker.callSelectedTool(input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(broker.callManagedPresetTool({ ...input, presetId: "posthog" })).rejects.toMatchObject({ code: "forbidden" });
    expect(call).not.toHaveBeenCalled();
    await expect(broker.callManagedPresetTool({ ...input, presetId: "loops", arguments: { method: "GET", path: "/v1/lists" } })).resolves.toEqual({ ok: true });
  });
});
