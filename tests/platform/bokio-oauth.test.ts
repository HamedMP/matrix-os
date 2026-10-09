import { describe, expect, it, vi } from "vitest";
import { BokioOAuthManager } from "../../packages/platform/src/bokio-oauth.js";
import { createBokioPresetBroker } from "../../packages/platform/src/bokio-preset-broker.js";
import { BOKIO_ACTIONS, planBokioRead } from "../../packages/platform/src/bokio-integration.js";
import * as credentialCrypto from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
const { decryptCustomMcpCredential } = credentialCrypto;
import type { PlatformDb, CustomMcpServerBrokerRow } from "../../packages/gateway/src/platform-db.js";

const key = Buffer.alloc(32, 17);
const tenant = "1be29990-f977-4a62-bb03-f0e126e685d0";
const clientId = "ed56c798-0ac8-4700-abd9-3dac99f7eca1";
const now = new Date("2026-10-07T12:00:00Z");
const token = { connection_id: "e8888888-7777-4444-9999-111111111111", tenant_id: tenant, tenant_type: "company", access_token: "access", token_type: "bearer", expires_in: 3600, refresh_token: "refresh" };
function setup(fetcher = vi.fn().mockResolvedValue(Response.json(token))) {
  let row: CustomMcpServerBrokerRow | null = {
    id: "server", user_id: "owner", preset_id: "bokio", name: "Bokio", url: "https://api.bokio.se/v1",
    auth_mode: "oauth", status: "auth_required", enabled: false, revision: 1,
    tools: [], enforcement_projection: [], encrypted_credentials: null, pending_expires_at: null,
    action_required_reason: null, discovered_at: null, created_at: now, updated_at: now,
  };
  const db = {
    getCustomMcpServerForBroker: vi.fn(async (id, owner) => row?.id === id && row.user_id === owner ? { ...row } : null),
    getCustomMcpPresetForBroker: vi.fn(async (preset, owner) => row?.preset_id === preset && row.user_id === owner ? { ...row } : null),
    updateCustomMcpServer: vi.fn(async (id, owner, revision, update) => {
      if (!row || row.id !== id || row.user_id !== owner || row.revision !== revision) return null;
      row = { ...row, revision: row.revision + 1,
        ...(update.encryptedCredentials !== undefined ? { encrypted_credentials: update.encryptedCredentials } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
        ...(update.pendingExpiresAt !== undefined ? { pending_expires_at: update.pendingExpiresAt } : {}),
      };
      return { id: row.id, revision: row.revision, status: row.status };
    }),
    deleteCustomMcpServer: vi.fn(async (id, owner) => { if (row?.id !== id || row.user_id !== owner) return false; row = null; return true; }),
    deleteCustomMcpServerIfRevision: vi.fn(async (id, owner, revision) => { if (row?.id !== id || row.user_id !== owner || row.revision !== revision) return false; row = null; return true; }),
  } as unknown as PlatformDb;
  const clock = { now };
  const oauth = new BokioOAuthManager({ db, encryptionKey: key, credentialCrypto, clientId, clientSecret: "secret", redirectUri: "https://matrix.example/oauth/callback", now: () => clock.now, fetcher });
  return { db, oauth, fetcher, clock, row: () => row!, credential: () => decryptCustomMcpCredential<Record<string, unknown>>(row!.encrypted_credentials!, key, { userId: "owner", serverId: "server" }) };
}
async function connect(fixture: ReturnType<typeof setup>) {
  const url = new URL(await fixture.oauth.start("owner", "server"));
  await fixture.oauth.complete(url.searchParams.get("state")!, "code");
}
describe("Bokio OAuth", () => {
  it("fails closed when platform client registration is missing", async () => {
    const fixture = setup();
    const oauth = new BokioOAuthManager({ db: fixture.db, encryptionKey: key });
    expect(oauth.configured).toBe(false);
    await expect(oauth.start("owner", "server")).rejects.toThrow();
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });
  it("creates one-use encrypted state and requests only reviewed read scopes", async () => {
    const fixture = setup();
    const url = new URL(await fixture.oauth.start("owner", "server"));
    expect(url.origin + url.pathname).toBe("https://api.bokio.se/v1/authorize");
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("scope")).toContain("journal-entries:read");
    expect(url.searchParams.get("scope")).not.toContain(":write");
    expect(url.searchParams.get("state")).not.toContain("owner");
    expect(fixture.row().encrypted_credentials).not.toContain("access");
    expect(fixture.row().enabled).toBe(false);
    await expect(fixture.oauth.start("other-owner", "server")).rejects.toThrow();
  });
  it("consumes state before token exchange, binds the company and denies callback replay", async () => {
    const fixture = setup();
    const url = new URL(await fixture.oauth.start("owner", "server"));
    const state = url.searchParams.get("state")!;
    await expect(fixture.oauth.complete(state, "code")).resolves.toEqual({ serverId: "server" });
    expect(fixture.fetcher).toHaveBeenCalledExactlyOnceWith("https://api.bokio.se/v1/token", expect.objectContaining({ method: "POST", redirect: "error", signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: `Basic ${Buffer.from(clientId + ":secret").toString("base64")}` }) }));
    expect(fixture.credential()).toMatchObject({ kind: "bokio", companyId: tenant, accessToken: "access", refreshToken: "refresh" });
    expect(fixture.row().status).toBe("ready");
    expect(fixture.row().enabled).toBe(false);
    expect(fixture.row().tools).toEqual([]);
    await expect(fixture.oauth.complete(state, "code")).rejects.toThrow();
    expect(fixture.fetcher).toHaveBeenCalledOnce();
  });
  it("uses CAS to prevent simultaneous callbacks from exchanging the same code", async () => {
    const fixture = setup();
    const state = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
    const results = await Promise.allSettled([fixture.oauth.complete(state, "code"), fixture.oauth.complete(state, "code")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fixture.fetcher).toHaveBeenCalledOnce();
  });
  it("denies tampered, expired or wrong-kind state before token exchange", async () => {
    const fixture = setup();
    const state = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
    await expect(fixture.oauth.complete(state + "x", "code")).rejects.toThrow();
    await expect(fixture.oauth.complete(credentialCrypto.encryptCustomMcpOAuthState({ kind: "granola", userId: "owner", serverId: "server" }, key), "code")).rejects.toThrow();
    fixture.clock.now = new Date(now.getTime() + 11 * 60 * 1000);
    await expect(fixture.oauth.complete(state, "code")).rejects.toThrow();
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });
  it("clears a failed callback claim so an initial pending account can be removed", async () => {
    const fixture = setup(vi.fn().mockRejectedValue(new Error("code exchange failed")));
    const state = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
    await expect(fixture.oauth.complete(state, "code")).rejects.toThrow();
    expect(fixture.credential()).not.toHaveProperty("authorizing");
    expect(fixture.credential()).not.toHaveProperty("state");
    await expect(fixture.oauth.disconnect("owner", fixture.row())).resolves.toBeUndefined();
    expect(fixture.row()).toBeNull();
    expect(fixture.fetcher).toHaveBeenCalledOnce();
  });
  it("retains exact company/connection after failed reconnect and revokes only that connection", async () => {
    const fixture = setup(); await connect(fixture);
    const state = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
    fixture.fetcher.mockRejectedValueOnce(new Error("code exchange failed"));
    await expect(fixture.oauth.complete(state, "code")).rejects.toThrow();
    expect(fixture.credential()).toEqual({ kind: "bokio", companyId: tenant, connectionId: token.connection_id });
    fixture.fetcher.mockResolvedValueOnce(Response.json({ access_token: "general", token_type: "bearer", tenant_type: "general" })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(fixture.oauth.disconnect("owner", fixture.row())).resolves.toBeUndefined();
    expect(fixture.fetcher.mock.calls.at(-1)).toEqual([`https://api.bokio.se/v1/connections/${token.connection_id}`, expect.objectContaining({ method: "DELETE" })]);
  });
  it.each(["authorizing", "refreshing"] as const)("fences active %s claims but allows exact disconnect after bounded expiry", async claim => {
    const fixture = setup(); await connect(fixture);
    const row = fixture.row();
    const claimed = { ...fixture.credential(), [claim]: true, [claim === "authorizing" ? "authorizingStartedAt" : "refreshStartedAt"]: now.toISOString() };
    await fixture.db.updateCustomMcpServer(row.id, row.user_id, row.revision, { encryptedCredentials: credentialCrypto.encryptCustomMcpCredential(claimed, key, { userId: "owner", serverId: "server" }), status: claim === "authorizing" ? "auth_required" : "ready" });
    await expect(fixture.oauth.start("owner", "server")).rejects.toThrow();
    await expect(fixture.oauth.resolveAuthorization("owner", fixture.row())).rejects.toThrow();
    await expect(fixture.oauth.disconnect("owner", fixture.row())).rejects.toThrow();
    expect(fixture.fetcher).toHaveBeenCalledOnce();
    fixture.clock.now = new Date(now.getTime() + 31000);
    fixture.fetcher.mockResolvedValueOnce(Response.json({ access_token: "general", token_type: "bearer", tenant_type: "general" })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(fixture.oauth.disconnect("owner", fixture.row())).resolves.toBeUndefined();
    expect(fixture.fetcher.mock.calls.at(-1)).toEqual([`https://api.bokio.se/v1/connections/${token.connection_id}`, expect.objectContaining({ method: "DELETE" })]);
  });
  it("recovers an expired rotating refresh without retrying its ambiguous token", async () => {
    const fixture = setup(); await connect(fixture);
    const row = fixture.row();
    await fixture.db.updateCustomMcpServer(row.id, row.user_id, row.revision, { encryptedCredentials: credentialCrypto.encryptCustomMcpCredential({ ...fixture.credential(), refreshing: true, refreshStartedAt: now.toISOString() }, key, { userId: "owner", serverId: "server" }) });
    fixture.clock.now = new Date(now.getTime() + 31000);
    await expect(fixture.oauth.resolveAuthorization("owner", fixture.row())).rejects.toThrow();
    expect(fixture.row().status).toBe("action_required");
    expect(fixture.credential()).toEqual({ kind: "bokio", companyId: tenant, connectionId: token.connection_id });
    expect(fixture.fetcher).toHaveBeenCalledOnce();
    await expect(fixture.oauth.start("owner", "server")).resolves.toContain("bokio_tenantid=" + tenant);
  });
  it("recovers an expired initial callback claim by local removal without unknown remote revocation", async () => {
    const fixture = setup(); const state = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
    const row = fixture.row();
    await fixture.db.updateCustomMcpServer(row.id, row.user_id, row.revision, { encryptedCredentials: credentialCrypto.encryptCustomMcpCredential({ kind: "bokio", authorizing: true, authorizingStartedAt: now.toISOString() }, key, { userId: "owner", serverId: "server" }) });
    await expect(fixture.oauth.complete(state, "code")).rejects.toThrow();
    fixture.clock.now = new Date(now.getTime() + 31000);
    await expect(fixture.oauth.disconnect("owner", fixture.row())).resolves.toBeUndefined();
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(fixture.row()).toBeNull();
  });
  it("does not let a late callback failure erase a newer authorization after its claim expires", async () => {
    const fixture = setup(); await connect(fixture);
    const state = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    fixture.fetcher.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; entered(); });
      throw new Error("late failed code exchange");
    });
    const pending = fixture.oauth.complete(state, "code");
    await started;
    try {
      expect(fixture.credential()).toMatchObject({ authorizing: true, authorizingStartedAt: now.toISOString() });
      await expect(fixture.oauth.start("owner", "server")).rejects.toThrow();
      fixture.clock.now = new Date(now.getTime() + 31000);
      const newerState = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
      release();
      await expect(pending).rejects.toThrow();
      expect(fixture.row().status).toBe("auth_required");
      expect(fixture.credential()).toMatchObject({ state: newerState, companyId: tenant, connectionId: token.connection_id });
      expect(fixture.credential()).not.toHaveProperty("authorizing");
    } finally { release(); }
  });
  it("requires a connection_id before a successful company token becomes ready", async () => {
    const { connection_id: _removed, ...missing } = token;
    const fixture = setup(vi.fn().mockResolvedValue(Response.json(missing)));
    const state = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
    await expect(fixture.oauth.complete(state, "code")).rejects.toThrow();
    expect(fixture.row().status).not.toBe("ready");
    expect(fixture.credential()).not.toHaveProperty("accessToken");
    expect(fixture.credential()).not.toHaveProperty("authorizing");
    await expect(fixture.oauth.resolveAuthorization("owner", fixture.row())).rejects.toThrow();
  });
  it("rejects a rotating refresh without connection_id and retains the exact revocable grant", async () => {
    const fixture = setup(); await connect(fixture);
    fixture.clock.now = new Date(now.getTime() + 3600 * 1000);
    const { connection_id: _removed, ...missing } = token;
    fixture.fetcher.mockResolvedValue(Response.json(missing));
    await expect(fixture.oauth.resolveAuthorization("owner", fixture.row())).rejects.toThrow();
    expect(fixture.row().status).toBe("action_required");
    expect(fixture.credential()).toEqual({ kind: "bokio", companyId: tenant, connectionId: token.connection_id });
  });
  it("rejects General API tokens and oversized token bodies", async () => {
    for (const response of [Response.json({ ...token, tenant_type: "general", tenant_id: "" }), new Response("bad", { headers: { "content-length": "100000" } })]) {
      const fixture = setup(vi.fn().mockResolvedValue(response));
      const state = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
      await expect(fixture.oauth.complete(state, "code")).rejects.toThrow();
      expect(fixture.row().status).toBe("auth_required");
    }
  });
  it("refreshes once with rotating token CAS and retains immutable company", async () => {
    const fixture = setup(); await connect(fixture);
    fixture.clock.now = new Date(now.getTime() + 3600 * 1000);
    fixture.fetcher.mockResolvedValue(Response.json({ ...token, access_token: "access-2", refresh_token: "refresh-2" }));
    const results = await Promise.allSettled([fixture.oauth.resolveAuthorization("owner", fixture.row()), fixture.oauth.resolveAuthorization("owner", fixture.row())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
    expect(fixture.credential()).toMatchObject({ companyId: tenant, refreshToken: "refresh-2" });
    expect(String(fixture.fetcher.mock.calls[1][1].body)).toContain("grant_type=refresh_token");
  });
  it("rejects a refresh changing tenant identity", async () => {
    const fixture = setup(); await connect(fixture);
    fixture.clock.now = new Date(now.getTime() + 3600 * 1000);
    fixture.fetcher.mockResolvedValue(Response.json({ ...token, tenant_id: "22222222-2222-4444-8888-222222222222" }));
    await expect(fixture.oauth.resolveAuthorization("owner", fixture.row())).rejects.toThrow();
    expect(fixture.credential().companyId).toBe(tenant);
    expect(fixture.row().status).toBe("action_required");
  });
  it("does not overwrite new authorization when refresh completion loses CAS", async () => {
    const fixture = setup(); await connect(fixture);
    fixture.clock.now = new Date(now.getTime() + 3600 * 1000);
    fixture.fetcher.mockImplementation(async () => {
      const claimed = fixture.row();
      await fixture.db.updateCustomMcpServer(claimed.id, claimed.user_id, claimed.revision, {
        status: "auth_required", encryptedCredentials: credentialCrypto.encryptCustomMcpCredential({ kind: "bokio", companyId: tenant, connectionId: token.connection_id, state: "new-authorization-state", stateExpiresAt: new Date(fixture.clock.now.getTime() + 600000).toISOString() }, key, { userId: "owner", serverId: "server" }),
      });
      return Response.json({ ...token, access_token: "late", refresh_token: "late-refresh" });
    });
    await expect(fixture.oauth.resolveAuthorization("owner", fixture.row())).rejects.toThrow();
    expect(fixture.row().status).toBe("auth_required");
    expect(fixture.credential()).not.toHaveProperty("accessToken");
    expect(fixture.credential()).toHaveProperty("state");
  });
  it("requires reconnection after a failed rotating refresh without retry", async () => {
    const fixture = setup(); await connect(fixture);
    fixture.clock.now = new Date(now.getTime() + 3600 * 1000);
    fixture.fetcher.mockRejectedValue(new Error("network failure"));
    await expect(fixture.oauth.resolveAuthorization("owner", fixture.row())).rejects.toThrow();
    await expect(fixture.oauth.resolveAuthorization("owner", fixture.row())).rejects.toThrow();
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
    expect(fixture.row().status).toBe("action_required");
    expect(fixture.credential()).not.toHaveProperty("refreshToken");
  });
});
describe("Bokio read broker", () => {
  it("binds all fixed-host reads to the token company, with bounded pages", () => {
    expect(planBokioRead("list_invoices", { page: 2, pageSize: 50 }, tenant).url).toBe(`https://api.bokio.se/v1/companies/${tenant}/invoices?page=2&pageSize=50`);
    expect(planBokioRead("get_company", {}, tenant).url).toBe(`https://api.bokio.se/v1/companies/${tenant}/company-information`);
    expect(() => planBokioRead("list_invoices", { companyId: "other" }, tenant)).toThrow();
    expect(() => planBokioRead("list_invoices", { pageSize: 101 }, tenant)).toThrow();
    expect(() => planBokioRead("get_customer", { customerId: "../secret" }, tenant)).toThrow();
    expect(Object.values(BOKIO_ACTIONS).every((action) => action.risk === "read")).toBe(true);
  });
  it("executes a selected read and denies wrong-owner or account override", async () => {
    const fixture = setup(); await connect(fixture);
    const fetcher = vi.fn().mockResolvedValue(Response.json({ result: [] }));
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth, fetcher });
    await expect(broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "list_invoices", params: { pageSize: 25 } })).resolves.toEqual({ result: [] });
    expect(fetcher).toHaveBeenCalledWith(`https://api.bokio.se/v1/companies/${tenant}/invoices?page=1&pageSize=25`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer access" }), redirect: "error", signal: expect.any(AbortSignal) }));
    await expect(broker.call({ userId: "other", service: { id: "bokio" }, actionId: "list_invoices" })).rejects.toThrow();
    await expect(broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "list_invoices", connectionId: "foreign-account" })).rejects.toThrow();
    await expect(broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "list_invoices", params: { url: "https://evil.example" } })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not expose Bokio through raw custom MCP tools", async () => {
    const fixture = setup(); await connect(fixture);
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth });
    expect(await broker.listAvailableActions("owner", "bokio")).toContain("list_journal_entries");
    expect(await broker.listAvailableActions("owner", "other")).toBeNull();
    expect(fixture.row().tools).toEqual([]);
    expect(fixture.row().enabled).toBe(false);
  });
  it("rejects response byte overflow and redirects without retry", async () => {
    const fixture = setup(); await connect(fixture);
    const fetcher = vi.fn().mockResolvedValue(new Response("bad", { headers: { "content-length": "2097152" } }));
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth, fetcher });
    await expect(broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "list_invoices" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("cancels oversized streaming bodies and rejects invalid UTF-8", async () => {
    const fixture = setup(); await connect(fixture);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1048577)); }, cancel });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(body)).mockResolvedValueOnce(new Response(new Uint8Array([255])));
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth, fetcher });
    await expect(broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "list_invoices" })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    await expect(broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "list_invoices" })).rejects.toThrow();
  });
  it("revokes the exact company connection through General API before conditional local removal", async () => {
    const fixture = setup(); await connect(fixture);
    fixture.fetcher.mockResolvedValueOnce(Response.json({ access_token: "general", token_type: "bearer", tenant_type: "general" })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth });
    await expect(broker.disconnect("other", "server")).resolves.toBe(false);
    await expect(broker.disconnect("owner", "server")).resolves.toBe(true);
    expect(fixture.fetcher.mock.calls[2]).toEqual([`https://api.bokio.se/v1/connections/${token.connection_id}`, expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ Authorization: "Bearer general" }), redirect: "error" })]);
    expect(fixture.db.deleteCustomMcpServerIfRevision).toHaveBeenCalledWith("server", "owner", expect.any(Number));
  });
  it("preserves encrypted grants after failed revocation and retries explicit removal", async () => {
    const fixture = setup(); await connect(fixture);
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth });
    fixture.fetcher.mockRejectedValueOnce(new Error("unavailable"));
    await expect(broker.disconnect("owner", "server")).rejects.toThrow();
    expect(fixture.row().status).toBe("action_required");
    expect(fixture.credential()).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
    await expect(fixture.oauth.start("owner", "server")).rejects.toThrow();
    fixture.fetcher.mockResolvedValueOnce(Response.json({ access_token: "general", token_type: "bearer", tenant_type: "general" })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(broker.disconnect("owner", "server")).resolves.toBe(true);
    expect(fixture.row()).toBeNull();
  });
  it("claims disconnect before network and blocks reconnect, reads and duplicate revocation", async () => {
    const fixture = setup(); await connect(fixture);
    const selected = fixture.row();
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    fixture.fetcher.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return Response.json({ access_token: "general", token_type: "bearer", tenant_type: "general" });
    }).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const pending = broker.disconnect("owner", "server");
    await started;
    try {
      expect(fixture.row().status).toBe("action_required");
      expect(fixture.row().revision).toBe(selected.revision + 1);
      await expect(fixture.oauth.start("owner", "server")).rejects.toThrow();
      await expect(fixture.oauth.resolveAuthorization("owner", selected)).rejects.toThrow();
      await expect(broker.disconnect("owner", "server")).rejects.toThrow();
      expect(fixture.fetcher).toHaveBeenCalledTimes(2);
    } finally { release(); }
    await expect(pending).resolves.toBe(true);
    expect(fixture.row()).toBeNull();
    expect(fixture.db.deleteCustomMcpServerIfRevision).toHaveBeenCalledWith("server", "owner", selected.revision + 1);
  });
  it("allows explicit removal recovery after a crashed disconnect lease expires", async () => {
    const fixture = setup(); await connect(fixture);
    const row = fixture.row();
    await fixture.db.updateCustomMcpServer(row.id, row.user_id, row.revision, { status: "action_required", encryptedCredentials: credentialCrypto.encryptCustomMcpCredential({ ...fixture.credential(), removingAt: now.toISOString() }, key, { userId: "owner", serverId: "server" }) });
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth });
    await expect(broker.disconnect("owner", "server")).rejects.toThrow();
    expect(fixture.fetcher).toHaveBeenCalledOnce();
    fixture.clock.now = new Date(now.getTime() + 31000);
    fixture.fetcher.mockResolvedValueOnce(Response.json({ access_token: "general", token_type: "bearer", tenant_type: "general" })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(broker.disconnect("owner", "server")).resolves.toBe(true);
  });
  it("refuses disconnect while an already claimed callback is exchanging its code", async () => {
    const fixture = setup();
    const state = new URL(await fixture.oauth.start("owner", "server")).searchParams.get("state")!;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    fixture.fetcher.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return Response.json(token);
    });
    const pending = fixture.oauth.complete(state, "code");
    await started;
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth });
    try { await expect(broker.disconnect("owner", "server")).rejects.toThrow(); }
    finally { release(); }
    await expect(pending).resolves.toEqual({ serverId: "server" });
    expect(fixture.row().status).toBe("ready");
  });
  it("recovers an ambiguous completed revoke by accepting only exact connection DELETE not-found", async () => {
    const fixture = setup(); await connect(fixture);
    const broker = createBokioPresetBroker({ db: fixture.db, oauth: fixture.oauth });
    fixture.fetcher.mockResolvedValueOnce(Response.json({ access_token: "general", token_type: "bearer", tenant_type: "general" }))
      .mockRejectedValueOnce(new Error("response lost"));
    await expect(broker.disconnect("owner", "server")).rejects.toThrow();
    fixture.fetcher.mockResolvedValueOnce(Response.json({ access_token: "general", token_type: "bearer", tenant_type: "general" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(broker.disconnect("owner", "server")).resolves.toBe(true);
    expect(fixture.row()).toBeNull();
  });
});
