import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker, type CustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import { encryptCustomMcpCredential, decryptCustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import type { CustomMcpServerProjection } from "../../packages/gateway/src/integrations/custom-mcp/types.js";

const key = Buffer.alloc(32, 13);
const now = new Date("2026-10-07T12:00:00Z");
describe("OAuth refresh survives current owner policy changes", () => {
  let db: PlatformDb; let userId: string; let serverId: string;
  beforeEach(async () => {
    const instance = await KyselyPGlite.create(); db = createPlatformDb({ dialect: instance.dialect }); await db.migrate();
    userId = (await db.createUser({ clerkId: "owner", handle: "owner", displayName: "Owner", email: "owner@example.test", containerId: "fixture" })).id;
    serverId = randomUUID();
    const encrypted = encryptCustomMcpCredential({ oauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: "2026-10-07T11:00:00Z",
      tokenEndpoint: "https://auth.example/token", resource: "https://public.example/mcp", clientId: "client" } }, key, { userId, serverId });
    await db.createCustomMcpServer({ id: serverId, userId, name: "Original", url: "https://public.example/mcp", authMode: "oauth", encryptedCredentials: encrypted, pendingExpiresAt: new Date(now.getTime() + 60000) });
    await db.updateCustomMcpServer(serverId, userId, 1, { enabled: true, status: "ready", tools: [
      { name: "search", description: "Search", inputSchema: {}, enabled: true, approval: "allow" },
      { name: "read", description: "Read", inputSchema: {}, enabled: true, approval: "allow" },
    ] });
  });
  afterEach(async () => { await db.destroy(); });
  it.each(["oauth", "none", "bearer", "api_key"] as const)("fences settings while %s disconnect awaits external cleanup", async authMode => {
    const id = randomUUID();
    await db.createCustomMcpServer({ id, userId, presetId: "loops", name: "Disconnect", url: "https://public.example/mcp", authMode,
      ...(authMode !== "none" ? { encryptedCredentials: encryptCustomMcpCredential(authMode === "oauth"
        ? { oauth: { accessToken: "access", refreshToken: "refresh" } } : { authorization: "Bearer private" }, key, { userId, serverId: id }) } : {}),
      pendingExpiresAt: new Date(now.getTime() + 60000) });
    await db.updateCustomMcpServer(id, userId, 1, { enabled: true, status: "ready", tools: [
      { name: "read", description: "Read", inputSchema: {}, enabled: true, approval: "allow" },
    ] });
    let begin!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const wait = async () => { begin(); await new Promise<void>(resolve => { release = resolve; }); };
    const cleanup = vi.fn().mockImplementationOnce(wait).mockRejectedValue(new Error("Duplicate cleanup must not run"));
    const projection = { upsert: vi.fn(), remove: authMode === "oauth" ? vi.fn() : cleanup };
    const revokeOAuth = authMode === "oauth" ? cleanup : vi.fn();
    const discover = vi.fn(async () => [{ name: "read", description: "Read", inputSchema: {} }]);
    const broker = new CustomMcpBroker({ db, encryptionKey: key, projection, revokeOAuth,
      client: { discover } as unknown as RemoteMcpClient });
    const removal = broker.remove(userId, id).then(() => undefined, error => error);
    await started;
    const secondRemoval = await broker.remove(userId, id).then(() => undefined, error => error);
    const results: unknown[] = [];
    for (const patch of [{ name: "Renamed" }, { enabled: true }, { tools: [{ name: "read", enabled: false, approval: "always_ask" as const }] }]) {
      const row = (await db.getCustomMcpServerForBroker(id, userId))!;
      results.push(await broker.patch(userId, id, { revision: row.revision, ...patch }).then(value => value, error => error));
    }
    results.push(await broker.discover(userId, id).then(value => value, error => error));
    results.push(await broker.activatePreset({ userId, presetId: "loops", allowedTools: ["read"] }).then(value => value, error => error));
    release();
    const result = await removal;
    expect(secondRemoval).toMatchObject({ code: "conflict" });
    expect(cleanup).toHaveBeenCalledOnce();
    for (const rejected of results) expect(rejected).toMatchObject({ code: "action_required" });
    expect(result).toBeUndefined();
    expect(await db.getCustomMcpServerForBroker(id, userId)).toBeNull();
    expect(projection.upsert).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(revokeOAuth).toHaveBeenCalledTimes(authMode === "oauth" ? 1 : 0);
  });
  it("retains the settings fence after failed revocation and permits explicit disconnect retry", async () => {
    const projection = { upsert: vi.fn(), remove: vi.fn() };
    const revokeOAuth = vi.fn().mockRejectedValueOnce(new Error("Revocation unavailable")).mockResolvedValue(undefined);
    const broker = new CustomMcpBroker({ db, encryptionKey: key, projection, revokeOAuth });
    await expect(broker.remove(userId, serverId)).rejects.toMatchObject({ code: "action_required" });
    const row = (await db.getCustomMcpServerForBroker(serverId, userId))!;
    await expect(broker.patch(userId, serverId, { revision: row.revision, name: "Renamed" })).rejects.toMatchObject({ code: "action_required" });
    await expect(broker.remove(userId, serverId)).resolves.toBeUndefined();
    expect(await db.getCustomMcpServerForBroker(serverId, userId)).toBeNull();
    expect(revokeOAuth).toHaveBeenCalledTimes(2);
  });
  it("fences a pre-existing OAuth removal marker without a newer database reason", async () => {
    const row = (await db.getCustomMcpServerForBroker(serverId, userId))!;
    const credential = decryptCustomMcpCredential<CustomMcpCredential>(row.encrypted_credentials!, key, { userId, serverId });
    const encrypted = encryptCustomMcpCredential({ ...credential, oauth: { ...credential.oauth, removing: true } }, key, { userId, serverId });
    await db.updateCustomMcpCredentials(serverId, userId, row.revision, encrypted, "disabled");
    const broker = new CustomMcpBroker({ db, encryptionKey: key, projection: { upsert: vi.fn(), remove: vi.fn() } });
    await expect(broker.patch(userId, serverId, { revision: row.revision, name: "Renamed" })).rejects.toMatchObject({ code: "action_required" });
  });
  async function fixture() {
    const initial = (await db.getCustomMcpServerForBroker(serverId, userId))!;
    const projection: CustomMcpServerProjection = { id: serverId, name: initial.name, url: initial.url, authMode: "oauth", enabled: true,
      revision: initial.revision, tools: initial.tools.map(({ name, enabled, approval }) => ({ name, enabled, approval })) };
    let begin!: () => void; let release!: (response: { status: number; body: unknown }) => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const request = vi.fn(async () => { begin(); return new Promise<{ status: number; body: unknown }>(resolve => { release = resolve; }); });
    const manager = new CustomMcpOAuthManager({ db, encryptionKey: key, now: () => now, redirectUri: "https://matrix.example/callback", request });
    const callTool = vi.fn(async () => "called");
    const broker = new CustomMcpBroker({ db, encryptionKey: key, projection: { upsert: vi.fn(), remove: vi.fn() },
      client: { callTool } as unknown as RemoteMcpClient, resolveOAuthAuthorization: (owner, row) => manager.resolveAuthorization(owner, row) });
    const pending = broker.callTool({ userId, serverId, toolName: "search", localProjection: projection }).then(value => value, error => error);
    await started;
    return { initial, manager, broker, callTool, request, pending, release,
      credential: async () => decryptCustomMcpCredential<CustomMcpCredential>((await db.getCustomMcpServerForBroker(serverId, userId))!.encrypted_credentials!, key, { userId, serverId }) };
  }
  it.each(["rename", "disable", "tool-policy"])("persists a rotated grant without restoring stale %s or executing the stale call", async change => {
    const f = await fixture();
    const updated = await f.broker.patch(userId, serverId, { revision: f.initial.revision,
      ...(change === "rename" ? { name: "Renamed" } : change === "disable" ? { enabled: false }
        : { tools: [{ name: "search", enabled: false, approval: "allow" }, { name: "read", enabled: true, approval: "always_ask" }] }),
    });
    f.release({ status: 200, body: { access_token: "new-access", refresh_token: "new-refresh", token_type: "bearer", expires_in: 3600 } });
    expect(await f.pending).toMatchObject({ code: "conflict" });
    expect((await f.credential()).oauth).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect((await f.credential()).oauth?.refreshing).toBeUndefined();
    expect(await db.getCustomMcpServerForBroker(serverId, userId)).toMatchObject({ name: updated.name, enabled: updated.enabled, status: updated.status,
      revision: updated.revision, tools: updated.tools, enforcement_projection: updated.tools });
    expect(f.callTool).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
    if (change === "rename") {
      await expect(f.broker.callTool({ userId, serverId, toolName: "search", localProjection: updated })).resolves.toBe("called");
      expect(f.request).toHaveBeenCalledOnce(); expect(f.callTool).toHaveBeenCalledOnce();
    }
  });
  it("clears a failed refresh claim after a settings change and prevents token replay", async () => {
    const f = await fixture();
    const updated = await f.broker.patch(userId, serverId, { revision: f.initial.revision, name: "Renamed", enabled: false });
    f.release({ status: 500, body: {} });
    expect(await f.pending).toMatchObject({ code: "action_required" });
    expect(await db.getCustomMcpServerForBroker(serverId, userId)).toMatchObject({ name: "Renamed", enabled: false, revision: updated.revision, status: "action_required" });
    expect((await f.credential()).oauth).toMatchObject({ refreshToken: "old-refresh" });
    expect((await f.credential()).oauth?.accessToken).toBeUndefined();
    expect((await f.credential()).oauth?.refreshing).toBeUndefined();
    await expect(f.manager.resolveAuthorization(userId, (await db.getCustomMcpServerForBroker(serverId, userId))!)).rejects.toMatchObject({ code: "action_required" });
    expect(f.callTool).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
  });
  it("checks current policy again after authorization completes before a provider tool call", async () => {
    const initial = (await db.getCustomMcpServerForBroker(serverId, userId))!;
    const callTool = vi.fn();
    let broker: CustomMcpBroker;
    broker = new CustomMcpBroker({ db, encryptionKey: key, projection: { upsert: vi.fn(), remove: vi.fn() }, client: { callTool } as unknown as RemoteMcpClient,
      resolveOAuthAuthorization: async () => { await broker.patch(userId, serverId, { revision: initial.revision, enabled: false }); return "Bearer already-valid"; } });
    const projection: CustomMcpServerProjection = { id: serverId, name: initial.name, url: initial.url, authMode: "oauth", enabled: true, revision: initial.revision, tools: initial.tools };
    await expect(broker.callTool({ userId, serverId, toolName: "search", localProjection: projection })).rejects.toMatchObject({ code: "forbidden" });
    expect(callTool).not.toHaveBeenCalled();
  });
});
