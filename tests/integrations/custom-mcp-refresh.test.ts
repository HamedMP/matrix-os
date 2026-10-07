import { describe, expect, it, vi } from "vitest";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import { encryptCustomMcpCredential, decryptCustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import type { CustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import type { PlatformDb, CustomMcpServerBrokerRow } from "../../packages/gateway/src/platform-db.js";

const key = Buffer.alloc(32, 11);
const now = new Date("2026-10-07T12:00:00Z");
function fixture(oauth: NonNullable<CustomMcpCredential["oauth"]> = {}) {
  const initial: CustomMcpCredential = { oauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: "2026-10-07T11:00:00Z", tokenEndpoint: "https://auth.example/token", resource: "https://mcp.example/mcp", clientId: "client", ...oauth } };
  let row: CustomMcpServerBrokerRow = { id: "server", user_id: "owner", preset_id: "lemlist", name: "lemlist", url: "https://mcp.example/mcp", auth_mode: "oauth", status: "ready", enabled: true, revision: 7,
    tools: [], enforcement_projection: [], encrypted_credentials: encryptCustomMcpCredential(initial, key, { userId: "owner", serverId: "server" }),
    pending_expires_at: null, action_required_reason: null, discovered_at: now, created_at: now, updated_at: now };
  const db = {
    getCustomMcpServerForBroker: vi.fn(async (id, owner) => row.id === id && row.user_id === owner ? { ...row } : null),
    updateCustomMcpCredentialsIfCurrent: vi.fn(async (id, owner, revision, expected, encrypted, status) => {
      if (row.id !== id || row.user_id !== owner || row.revision !== revision || row.encrypted_credentials !== expected) return false;
      row = { ...row, encrypted_credentials: encrypted, status }; return true;
    }),
    updateCustomMcpCredentials: vi.fn(async (id, owner, revision, encrypted, status, advanceRevision) => {
      if (row.id !== id || row.user_id !== owner || row.revision !== revision) return false;
      row = { ...row, encrypted_credentials: encrypted, status, revision: row.revision + (advanceRevision ? 1 : 0) }; return true;
    }),
  } as unknown as PlatformDb;
  const request = vi.fn().mockResolvedValue({ status: 200, body: { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600, token_type: "bearer" } });
  const clock = { now };
  const manager = new CustomMcpOAuthManager({ db, encryptionKey: key, redirectUri: "https://matrix.example/oauth/callback", now: () => clock.now, request });
  return { db, request, clock, manager, row: () => ({ ...row }), setCredential: (credential: CustomMcpCredential, status = "ready", revision = row.revision) => { row = { ...row, status: status as CustomMcpServerBrokerRow["status"], revision, encrypted_credentials: encryptCustomMcpCredential(credential, key, { userId: "owner", serverId: "server" }) }; }, credential: () => decryptCustomMcpCredential<CustomMcpCredential>(row.encrypted_credentials!, key, { userId: "owner", serverId: "server" }) };
}
describe("Custom MCP rotating refresh", () => {
  it("claims the exact ciphertext before refresh and retains the policy revision", async () => {
    const f = fixture(); const old = f.row();
    expect(await f.manager.resolveAuthorization("owner", old)).toBe("Bearer fresh-access");
    expect(f.db.updateCustomMcpCredentialsIfCurrent).toHaveBeenCalledTimes(2);
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
