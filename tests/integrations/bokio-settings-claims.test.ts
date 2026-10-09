import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import * as credentialCrypto from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import { createBokioPresetBroker } from "../../packages/platform/src/bokio-preset-broker.js";
import { BokioOAuthManager } from "../../packages/platform/src/bokio-oauth.js";

const key = Buffer.alloc(32, 17);
const now = new Date("2026-10-07T12:00:00Z");
const token = { connection_id: "e8888888-7777-4444-9999-111111111111", tenant_id: "1be29990-f977-4a62-bb03-f0e126e685d0",
  tenant_type: "company", access_token: "access", token_type: "bearer", expires_in: 3600, refresh_token: "refresh" };

describe("Bokio settings cannot invalidate a consumed OAuth grant", () => {
  let db: PlatformDb; let userId: string; let serverId: string;
  beforeEach(async () => {
    const instance = await KyselyPGlite.create(); db = createPlatformDb({ dialect: instance.dialect }); await db.migrate();
    userId = (await db.createUser({ clerkId: "owner", handle: "owner", displayName: "Owner", email: "owner@example.test", containerId: "fixture" })).id;
    serverId = randomUUID();
    await db.createCustomMcpServer({ id: serverId, userId, presetId: "bokio", name: "Bokio", url: "https://api.bokio.se/v1", authMode: "oauth", pendingExpiresAt: new Date(now.getTime() + 60000) });
  });
  afterEach(async () => { await db.destroy(); });
  const row = async () => (await db.getCustomMcpServerForBroker(serverId, userId))!;
  const decrypt = async () => credentialCrypto.decryptCustomMcpCredential<Record<string, unknown>>((await row()).encrypted_credentials!, key, { userId, serverId });
  function fixture() {
    const clock = { now };
    const fetcher = vi.fn().mockResolvedValue(Response.json(token));
    const oauth = new BokioOAuthManager({ db, encryptionKey: key, credentialCrypto,
      clientId: "ed56c798-0ac8-4700-abd9-3dac99f7eca1", clientSecret: "secret", redirectUri: "https://matrix.example/callback", fetcher, now: () => clock.now });
    const projection = { upsert: vi.fn(), remove: vi.fn() };
    const broker = new CustomMcpBroker({ db, encryptionKey: key, projection });
    return { clock, fetcher, oauth, broker, projection };
  }
  it.each(["callback", "refresh"] as const)("rejects owner edits during %s and retains the newly issued tokens", async phase => {
    const f = fixture();
    let state = new URL(await f.oauth.start(userId, serverId)).searchParams.get("state")!;
    if (phase === "refresh") { await f.oauth.complete(state, "code"); f.clock.now = new Date(now.getTime() + 3600000); }
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.fetcher.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return Response.json({ ...token, access_token: "replacement", refresh_token: "rotated" });
    });
    const pending = (phase === "callback" ? f.oauth.complete(state, "code") : f.oauth.resolveAuthorization(userId, await row()))
      .then(value => ({ value }), error => ({ error }));
    await started;
    try {
      const claimed = await row();
      for (const change of [{ name: "Renamed" }, { enabled: false }]) {
        await expect(f.broker.patch(userId, serverId, { revision: claimed.revision, ...change })).rejects.toMatchObject({ code: "action_required" });
      }
      expect(await row()).toMatchObject({ revision: claimed.revision, encrypted_credentials: claimed.encrypted_credentials });
    } finally { release(); }
    expect(await pending).not.toHaveProperty("error");
    expect(await decrypt()).toMatchObject({ accessToken: "replacement", refreshToken: "rotated" });
    expect(await decrypt()).not.toHaveProperty("refreshing");
    expect(await decrypt()).not.toHaveProperty("authorizing");
    expect((await row()).status).toBe("ready");
    f.projection.upsert.mockRejectedValue(new Error("Offline MCP settings"));
    await expect(f.broker.patch(userId, serverId, { revision: (await row()).revision, name: "Renamed" })).resolves.toMatchObject({ name: "Renamed", status: "ready", enabled: false });
    expect(f.projection.upsert).not.toHaveBeenCalled();
    const read = vi.fn().mockResolvedValue(Response.json({ items: [{ name: "Customer" }] }));
    const native = createBokioPresetBroker({ db, oauth: f.oauth, fetcher: read });
    expect(await native.listAvailableActions(userId, "bokio")).toContain("list_customers");
    expect(await native.listConnections(userId)).toMatchObject([{ status: "active" }]);
    await expect(native.call({ userId, service: { id: "bokio" }, actionId: "list_customers", connectionId: serverId, params: {} }))
      .resolves.toEqual({ items: [{ name: "Customer" }] });
    expect(read).toHaveBeenCalledWith(expect.stringContaining("/companies/" + token.tenant_id + "/customers"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer replacement" }) }));
    const selected = await row();
    for (const change of [{ enabled: true }, { enabled: false }, { tools: [] }]) {
      await expect(f.broker.patch(userId, serverId, { revision: selected.revision, ...change })).rejects.toMatchObject({ code: "invalid" });
    }
    expect(await row()).toMatchObject({ status: "ready", enabled: false, revision: selected.revision });
  });
  it.each(["auth_required", "action_required", "disabled"] as const)("preserves %s on rename and rejects MCP-only settings", async status => {
    const f = fixture();
    const state = new URL(await f.oauth.start(userId, serverId)).searchParams.get("state")!;
    await f.oauth.complete(state, "code");
    await db.updateCustomMcpServer(serverId, userId, (await row()).revision, { status });
    await expect(f.broker.patch(userId, serverId, { revision: (await row()).revision, name: "Renamed" }))
      .resolves.toMatchObject({ status, name: "Renamed", enabled: false });
    const selected = await row();
    for (const change of [{ enabled: true }, { enabled: false }, { tools: [] }]) {
      await expect(f.broker.patch(userId, serverId, { revision: selected.revision, ...change })).rejects.toMatchObject({ code: "invalid" });
    }
    expect(await row()).toMatchObject({ status, revision: selected.revision, encrypted_credentials: selected.encrypted_credentials });
    await expect(f.oauth.resolveAuthorization(userId, await row())).rejects.toMatchObject({ code: "action_required" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("requires explicit claim recovery before editing an expired or removing grant", async () => {
    const f = fixture();
    for (const claim of [{ refreshing: true, refreshStartedAt: "2026-10-07T10:00:00Z" },
      { authorizing: true, authorizingStartedAt: "2026-10-07T10:00:00Z" }, { removingAt: now.toISOString() }]) {
      const selected = await row();
      await db.updateCustomMcpServer(serverId, userId, selected.revision, { encryptedCredentials:
        credentialCrypto.encryptCustomMcpCredential({ kind: "bokio", ...claim }, key, { userId, serverId }) });
      await expect(f.broker.patch(userId, serverId, { revision: (await row()).revision, name: "Renamed" })).rejects.toMatchObject({ code: "action_required" });
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("allows edits before a callback claims its one-use code", async () => {
    const f = fixture(); const state = new URL(await f.oauth.start(userId, serverId)).searchParams.get("state")!;
    await expect(f.broker.patch(userId, serverId, { revision: (await row()).revision, name: "Renamed" })).resolves.toMatchObject({ name: "Renamed", status: "auth_required" });
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.oauth.complete(state, "code");
    expect(await f.oauth.resolveAuthorization(userId, await row())).toMatchObject({ authorization: "Bearer access", companyId: token.tenant_id });
  });
});
