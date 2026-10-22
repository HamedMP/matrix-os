import { describe, expect, it, vi } from "vitest";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import { encryptCustomMcpCredential, decryptCustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import { CustomMcpBroker, type CustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { PlatformDb, CustomMcpServerBrokerRow } from "../../packages/gateway/src/platform-db.js";

const key = Buffer.alloc(32, 11);
const now = new Date("2026-10-07T12:00:00Z");
function fixture(oauth: NonNullable<CustomMcpCredential["oauth"]> = {}, status: CustomMcpServerBrokerRow["status"] = "ready") {
  const initial: CustomMcpCredential = { oauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: "2026-10-07T11:00:00Z", tokenEndpoint: "https://auth.example/token", resource: "https://mcp.example/mcp", clientId: "client", ...oauth } };
  let row: CustomMcpServerBrokerRow = { id: "server", user_id: "owner", preset_id: "lemlist", name: "lemlist", url: "https://mcp.example/mcp", auth_mode: "oauth", status, enabled: true, revision: 7,
    tools: [], enforcement_projection: [], encrypted_credentials: encryptCustomMcpCredential(initial, key, { userId: "owner", serverId: "server" }),
    pending_expires_at: null, action_required_reason: null, discovered_at: now, created_at: now, updated_at: now };
  let deleted = false;
  const db = {
    getCustomMcpServerForBroker: vi.fn(async (id, owner) => !deleted && row.id === id && row.user_id === owner ? { ...row } : null),
    claimCustomMcpRemovalIfCurrent: vi.fn(async (id, owner, revision, expected, removal) => {
      if (row.id !== id || row.user_id !== owner || row.revision !== revision || row.encrypted_credentials !== expected) return false;
      row = { ...row, encrypted_credentials: removal, enabled: false, status: "disabled", revision: revision + 1 }; return true;
    }),
    updateCustomMcpServer: vi.fn(async (_id, _owner, revision, patch) => {
      if (row.revision !== revision) return null;
      row = { ...row, status: patch.status ?? row.status, enabled: patch.enabled ?? row.enabled, revision: revision + 1 }; return { ...row };
    }),
    deleteCustomMcpServerIfRevision: vi.fn(async (_id, _owner, revision) => {
      if (row.revision !== revision) return false;
      deleted = true; return true;
    }),
    updateCustomMcpCredentialsIfCurrent: vi.fn(async (id, owner, revision, expected, encrypted, status) => {
      if (row.id !== id || row.user_id !== owner || row.revision !== revision || row.encrypted_credentials !== expected) return false;
      row = { ...row, encrypted_credentials: encrypted, status }; return true;
    }),
    settleCustomMcpRefreshIfCurrent: vi.fn(async (id, owner, expected, encrypted, authorizationRequired) => {
      if (row.id !== id || row.user_id !== owner || row.encrypted_credentials !== expected) return false;
      row = { ...row, encrypted_credentials: encrypted, ...(authorizationRequired ? { status: "action_required" } : {}) }; return true;
    }),
    updateCustomMcpCredentials: vi.fn(async (id, owner, revision, encrypted, status, advanceRevision) => {
      if (row.id !== id || row.user_id !== owner || row.revision !== revision) return false;
      row = { ...row, encrypted_credentials: encrypted, status, revision: row.revision + (advanceRevision ? 1 : 0) }; return true;
    }),
  } as unknown as PlatformDb;
  const request = vi.fn().mockResolvedValue({ status: 200, body: { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600, token_type: "bearer" } });
  const clock = { now };
  const manager = new CustomMcpOAuthManager({ db, encryptionKey: key, redirectUri: "https://matrix.example/oauth/callback", now: () => clock.now, request });
  const projection = { upsert: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) };
  const revokeOAuth = vi.fn().mockResolvedValue(undefined);
  const broker = new CustomMcpBroker({ db, encryptionKey: key, projection, revokeOAuth, now: () => clock.now });
  return { db, request, clock, manager, broker, projection, revokeOAuth, row: () => ({ ...row }), setCredential: (credential: CustomMcpCredential, status = "ready", revision = row.revision) => { row = { ...row, status: status as CustomMcpServerBrokerRow["status"], revision, encrypted_credentials: encryptCustomMcpCredential(credential, key, { userId: "owner", serverId: "server" }) }; }, credential: () => decryptCustomMcpCredential<CustomMcpCredential>(row.encrypted_credentials!, key, { userId: "owner", serverId: "server" }) };
}
describe("Custom MCP rotating refresh", () => {
  it("claims the exact ciphertext before refresh and retains the policy revision", async () => {
    const f = fixture(); const old = f.row();
    expect(await f.manager.resolveAuthorization("owner", old)).toBe("Bearer fresh-access");
    expect(f.db.updateCustomMcpCredentialsIfCurrent).toHaveBeenCalledOnce();
    expect(f.db.settleCustomMcpRefreshIfCurrent).toHaveBeenCalledOnce();
    expect(f.row().revision).toBe(7);
    expect(f.credential().oauth?.refreshToken).toBe("fresh-refresh");
    expect(f.request).toHaveBeenCalledOnce();
  });
  it("does not exchange an in-flight rotating token twice", async () => {
    const f = fixture(); let release!: (value: unknown) => void; let started!: () => void;
    const begin = new Promise<void>((resolve) => { started = resolve; });
    f.request.mockImplementation(async () => { started(); return new Promise((resolve) => { release = resolve; }); });
    const first = f.manager.resolveAuthorization("owner", f.row());
    await begin;
    await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toMatchObject({ refreshPending: true });
    expect(f.request).toHaveBeenCalledOnce();
    release({ status: 200, body: { access_token: "fresh", refresh_token: "rotated", token_type: "bearer", expires_in: 3600 } });
    await expect(first).resolves.toBe("Bearer fresh");
  });
  it("defers removal until an active rotating refresh persists its replacement", async () => {
    const f = fixture(); let release!: (value: unknown) => void; let started!: () => void;
    const begin = new Promise<void>(resolve => { started = resolve; });
    f.request.mockImplementation(async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const refresh = f.manager.resolveAuthorization("owner", f.row());
    await begin;
    const removalError = await f.broker.remove("owner", "server").then(() => null, error => error);
    const before = f.row();
    release({ status: 200, body: { access_token: "fresh", refresh_token: "rotated", token_type: "bearer", expires_in: 3600 } });
    const result = await refresh.then(value => value, error => error);
    expect(removalError).toMatchObject({ refreshPending: true });
    expect(before).toMatchObject({ revision: 7, enabled: true });
    expect(result).toBe("Bearer fresh");
    expect(f.projection.remove).not.toHaveBeenCalled(); expect(f.revokeOAuth).not.toHaveBeenCalled();
    await f.broker.remove("owner", "server");
    expect(f.revokeOAuth).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ oauth: expect.objectContaining({ refreshToken: "rotated" }) }));
    expect(f.request).toHaveBeenCalledOnce();
  });
  it("fences a refresh claim arriving between removal's credential read and disable", async () => {
    const f = fixture(); const cached = f.row();
    vi.mocked(f.db.getCustomMcpServerForBroker).mockImplementationOnce(async () => {
      f.setCredential({ ...f.credential(), oauth: { ...f.credential().oauth, refreshing: true, refreshStartedAt: now.toISOString() } });
      return cached;
    });
    await expect(f.broker.remove("owner", "server")).rejects.toMatchObject({ code: "conflict" });
    expect(f.row()).toMatchObject({ revision: 7, enabled: true });
    expect(f.credential().oauth?.refreshing).toBe(true);
    expect(f.projection.remove).not.toHaveBeenCalled(); expect(f.revokeOAuth).not.toHaveBeenCalled();
  });
  it("blocks normal token refresh after removal has claimed the exact credential", async () => {
    const f = fixture();
    f.revokeOAuth.mockImplementation(async () => {
      await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toMatchObject({ code: "action_required" });
    });
    await f.broker.remove("owner", "server");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("permits removal of a crashed expired claim without replaying its uncertain token", async () => {
    const f = fixture({ refreshing: true, refreshStartedAt: "2026-10-07T11:00:00Z" });
    await f.broker.remove("owner", "server");
    expect(f.revokeOAuth).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ oauth: expect.objectContaining({ refreshToken: "old-refresh" }) }));
    expect(f.request).not.toHaveBeenCalled();
  });
  it("retains the removal claim and grant evidence for retry after revocation fails", async () => {
    const f = fixture({ refreshing: true, refreshStartedAt: "2026-10-07T11:00:00Z" });
    f.revokeOAuth.mockRejectedValueOnce(new Error("remote unavailable"));
    await expect(f.broker.remove("owner", "server")).rejects.toMatchObject({ code: "action_required" });
    expect(f.row()).toMatchObject({ enabled: false, status: "action_required" });
    expect(f.credential().oauth).toMatchObject({ removing: true, refreshToken: "old-refresh" });
    await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toMatchObject({ code: "action_required" });
    await f.broker.remove("owner", "server");
    expect(f.revokeOAuth).toHaveBeenCalledTimes(2); expect(f.request).not.toHaveBeenCalled();
  });
  it("requires finishing removal before reconnect can replace retained grant evidence", async () => {
    const f = fixture({ removing: true }, "action_required");
    const before = f.row().encrypted_credentials;
    await expect(f.manager.start("owner", "server")).rejects.toMatchObject({ code: "action_required" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.row().encrypted_credentials).toBe(before);
  });
  it("preserves a newer credential even when a late refresh succeeds at the same policy revision", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => { f.setCredential({ oauth: { accessToken: "reconnected", refreshToken: "new-login" } }); return { status: 200, body: { access_token: "late", token_type: "bearer" } }; });
    await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toMatchObject({ code: "conflict" });
    expect(f.credential().oauth?.accessToken).toBe("reconnected");
  });
  it("preserves a newer credential even when a late refresh fails at the same policy revision", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => { f.setCredential({ oauth: { accessToken: "reconnected", refreshToken: "new-login" } }); throw new Error("upstream failed"); });
    await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toThrow();
    expect(f.credential().oauth?.accessToken).toBe("reconnected"); expect(f.row().status).toBe("ready");
  });
  it("reads the current encrypted credentials instead of refreshing a stale cached token", async () => {
    const f = fixture(); const cached = f.row();
    f.setCredential({ oauth: { accessToken: "current", expiresAt: "2026-10-08T00:00:00Z" } });
    await expect(f.manager.resolveAuthorization("owner", cached)).resolves.toBe("Bearer current");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("never anonymously calls an OAuth service with a missing token", async () => {
    const f = fixture({ accessToken: undefined, refreshToken: undefined });
    await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toMatchObject({ code: "action_required" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("fails closed after a crashed refresh lease expires", async () => {
    const f = fixture({ refreshing: true, refreshStartedAt: "2026-10-07T11:00:00Z" } as NonNullable<CustomMcpCredential["oauth"]>);
    await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toMatchObject({ code: "action_required" });
    expect(f.row().status).toBe("action_required"); expect(f.request).not.toHaveBeenCalled();
  });
  it("requires explicit reconnect after a refresh failure without retrying the consumed token", async () => {
    const f = fixture(); f.request.mockRejectedValue(new Error("timeout"));
    await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toMatchObject({ code: "action_required" });
    await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toMatchObject({ code: "action_required" });
    expect(f.request).toHaveBeenCalledOnce(); expect(f.row().revision).toBe(7);
  });
  it("rejects wrong owner and stale policy before using any token", async () => {
    const f = fixture();
    await expect(f.manager.resolveAuthorization("other", f.row())).rejects.toThrow();
    const cached = f.row(); f.setCredential({ oauth: { accessToken: "new" } }, "ready", 8);
    await expect(f.manager.resolveAuthorization("owner", cached)).rejects.toMatchObject({ code: "conflict" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([{ access_token: "bad\r\nAuthorization: Bearer other", token_type: "bearer" }, { access_token: "new", token_type: "bearer", expires_in: -1 }, { access_token: "new", token_type: "bearer", refresh_token: 42 }])("rejects malformed token responses %j", async (body) => {
    const f = fixture(); f.request.mockResolvedValue({ status: 200, body });
    await expect(f.manager.resolveAuthorization("owner", f.row())).rejects.toMatchObject({ code: "action_required" });
    expect(f.row().status).toBe("action_required");
  });
});
