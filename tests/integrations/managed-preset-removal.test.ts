import { describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";

function fixture(presetId: string | null = "bokio", serverId = "server") {
  let row: any = { id: serverId, user_id: "owner", preset_id: presetId, auth_mode: "none", revision: 3, encrypted_credentials: "sealed", status: "ready", enabled: false };
  const db = {
    getCustomMcpServerForBroker: vi.fn(async (_id, owner) => owner === "owner" ? row : null),
    updateCustomMcpServer: vi.fn(async (_id, _owner, revision, update) => {
      if (!row || row.revision !== revision) return null;
      row = { ...row, ...update, revision: revision + 1 }; return row;
    }),
    deleteCustomMcpServer: vi.fn(async () => { row = null; return true; }),
    deleteCustomMcpServerIfRevision: vi.fn(async (_id, _owner, revision) => {
      if (!row || row.revision !== revision) return false;
      row = null; return true;
    }),
  };
  const removeManagedPreset = vi.fn(async (_owner: string, selected: any) => selected.preset_id === "bokio");
  const projection = { upsert: vi.fn(), remove: vi.fn() };
  const broker = new CustomMcpBroker({ db: db as unknown as PlatformDb, projection, encryptionKey: Buffer.alloc(32), removeManagedPreset });
  return { db, projection, removeManagedPreset, broker, row: () => row, reconnect: () => { row = { ...row, revision: row.revision + 1, encrypted_credentials: "new-grant", status: "ready" }; } };
}

describe("managed preset lifecycle removal", () => {
  it.each([false, true])("delegates Bokio removal before generic credential handling (account deletion=%s)", async deleted => {
    const f = fixture();
    await (deleted ? f.broker.removeForAccountDeletion("owner", "server") : f.broker.remove("owner", "server"));
    expect(f.removeManagedPreset).toHaveBeenCalledWith("owner", expect.objectContaining({ preset_id: "bokio", revision: 3 }), deleted);
    expect(f.db.updateCustomMcpServer).not.toHaveBeenCalled();
    expect(f.db.deleteCustomMcpServer).not.toHaveBeenCalled();
    expect(f.db.deleteCustomMcpServerIfRevision).not.toHaveBeenCalled();
    expect(f.projection.remove).not.toHaveBeenCalled();
  });
  it("preserves credentials when managed revocation fails and denies another owner", async () => {
    const f = fixture(); f.removeManagedPreset.mockRejectedValue(new Error("revocation failed"));
    await expect(f.broker.remove("owner", "server")).rejects.toThrow();
    expect(f.row().encrypted_credentials).toBe("sealed");
    expect(f.db.deleteCustomMcpServer).not.toHaveBeenCalled();
    await expect(f.broker.remove("foreign", "server")).rejects.toMatchObject({ code: "not_found" });
    expect(f.removeManagedPreset).toHaveBeenCalledOnce();
  });
  it("fences generic deletion against a reconnect during projection removal", async () => {
    const f = fixture(null); f.projection.remove.mockImplementation(async () => f.reconnect());
    await expect(f.broker.remove("owner", "server")).rejects.toMatchObject({ code: "conflict" });
    expect(f.db.deleteCustomMcpServerIfRevision).toHaveBeenCalledWith("server", "owner", 4);
    expect(f.db.deleteCustomMcpServer).not.toHaveBeenCalled();
    expect(f.row().encrypted_credentials).toBe("new-grant");
  });
  it("uses the same provider removal seam through the public raw DELETE route", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const f = fixture("bokio", id);
    const routes = createCustomMcpRoutes({ broker: f.broker, resolveUserId: async () => "owner" });
    f.removeManagedPreset.mockRejectedValueOnce(new Error("provider unavailable"));
    expect((await routes.request(`/${id}`, { method: "DELETE" })).status).toBe(502);
    expect(f.row().encrypted_credentials).toBe("sealed");
    expect((await routes.request(`/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(f.removeManagedPreset).toHaveBeenLastCalledWith("owner", expect.objectContaining({ id, preset_id: "bokio" }), false);
    expect(f.db.deleteCustomMcpServer).not.toHaveBeenCalled();
  });
});
