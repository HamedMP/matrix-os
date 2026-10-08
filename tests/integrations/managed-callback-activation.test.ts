import { expect, it, vi } from "vitest";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";

it("does not reactivate a preset disabled after the successful OAuth revision", async () => {
  const discover = vi.fn(); const update = vi.fn();
  const row = { id: "server", user_id: "owner", preset_id: "loops", status: "disabled", enabled: false, revision: 8 };
  const broker = new CustomMcpBroker({ encryptionKey: Buffer.alloc(32),
    db: { getCustomMcpPresetForBroker: vi.fn(async () => row), updateCustomMcpServer: update } as unknown as PlatformDb,
    client: { discover } as unknown as RemoteMcpClient, projection: { upsert: vi.fn(), remove: vi.fn() } });
  await expect(broker.activatePreset({ userId: "owner", presetId: "loops", allowedTools: ["teams"], requiredTools: [], expectedRevision: 7 })).rejects.toMatchObject({ code: "conflict" });
  expect(discover).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});
