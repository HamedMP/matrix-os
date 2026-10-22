import { describe, expect, it, vi } from "vitest";
import { BOKIO_ACTIONS, BOKIO_WRITE_SCOPES } from "../../packages/contracts/src/bokio-integration.js";
import { BokioOAuthManager } from "../../packages/platform/src/bokio-oauth.js";
import { createBokioPresetBroker } from "../../packages/platform/src/bokio-preset-broker.js";
import { BokioIntegrationError, planBokioWrite } from "../../packages/platform/src/bokio-integration.js";
import { createManagedPresetRouter } from "../../packages/platform/src/managed-preset-router.js";
import * as credentialCrypto from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import type { BokioCredentialRow, BokioCredentialStore } from "../../packages/platform/src/bokio-oauth.js";

const companyId = "11111111-2222-4333-8444-555555555555";
const customerId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const invoiceId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const key = Buffer.alloc(32, 19);
const now = new Date("2026-10-18T12:00:00Z");
const token = { tenant_id: companyId, tenant_type: "company", access_token: "access", refresh_token: "refresh", token_type: "bearer", connection_id: customerId, expires_in: 3600 };
const lineItem = { description: "Consulting", productType: "services", unitType: "hour", quantity: 1, unitPrice: 500, taxRate: 25 };
function setup(scope?: string) {
  let row: BokioCredentialRow = { id: "server", user_id: "owner", preset_id: "bokio", url: "https://api.bokio.se/v1", auth_mode: "oauth", status: "auth_required", revision: 1, encrypted_credentials: null, created_at: now };
  const db: BokioCredentialStore = {
    getCustomMcpServerForBroker: vi.fn(async (id, owner) => id === row.id && owner === row.user_id ? { ...row } : null),
    getCustomMcpPresetForBroker: vi.fn(async (preset, owner) => preset === row.preset_id && owner === row.user_id ? { ...row } : null),
    updateCustomMcpServer: vi.fn(async (_id, _owner, revision, update) => {
      if (revision !== row.revision) return null;
      row = { ...row, revision: row.revision + 1, ...(update.encryptedCredentials ? { encrypted_credentials: update.encryptedCredentials } : {}), ...(update.status ? { status: update.status } : {}) };
      return { id: row.id, revision: row.revision };
    }),
    createCustomMcpServer: vi.fn(), deleteCustomMcpServer: vi.fn(),
  };
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ ...token, ...(scope !== undefined ? { scope } : {}) }));
  const clock = { now };
  const oauth = new BokioOAuthManager({ db, encryptionKey: key, credentialCrypto, clientId: invoiceId, clientSecret: "secret", redirectUri: "https://matrix.example/oauth/callback", fetcher, now: () => clock.now });
  const broker = createBokioPresetBroker({ db, oauth, fetcher });
  const credential = () => credentialCrypto.decryptCustomMcpCredential<Record<string, unknown>>(row.encrypted_credentials!, key, { userId: "owner", serverId: "server" });
  const connect = async () => { const url = new URL(await oauth.start("owner", "server")); await oauth.complete(url.searchParams.get("state")!, "code"); return url; };
  return { db, oauth, broker, fetcher, clock, credential, connect, row: () => row };
}

describe("Bokio explicitly scoped writes", () => {
  it("isolates unreadable Bokio credentials from unrelated managed connections", async () => {
    const fixture = setup("customers:read customers:write"); await fixture.connect();
    const row = fixture.row();
    await fixture.db.updateCustomMcpServer(row.id, row.user_id, row.revision, { encryptedCredentials: "unreadable" });
    const otherConnection = { id: "other", service: "granola", account_label: "Granola", account_email: null,
      scopes: [], status: "active", connected_at: now, last_used_at: null } as const;
    const other = { ...fixture.broker, listConnections: vi.fn(async () => [{ ...otherConnection, scopes: [] }]),
      call: vi.fn(async () => ({ ok: true })) };
    const router = createManagedPresetRouter({ bokio: fixture.broker, granola: other });
    await expect(router.listConnections("owner")).resolves.toEqual([
      expect.objectContaining({ service: "bokio", status: "action_required", scopes: [] }), otherConnection,
    ]);
    await expect(fixture.broker.listAvailableActions!("owner", "bokio")).resolves.toEqual([]);
    await expect(fixture.broker.listAvailableActionParams!("owner", "bokio")).resolves.toEqual({});
    await expect(router.call({ userId: "owner", service: { id: "granola" }, actionId: "get_account" })).resolves.toEqual({ ok: true });
    await expect(fixture.broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "create_customer",
      params: { name: "Example", type: "company" } })).rejects.toMatchObject({ code: "action_required" });
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([new Error("database unavailable"), new BokioIntegrationError("upstream")])("propagates unexpected grant lookup failures", async error => {
    const fixture = setup(); await fixture.connect();
    vi.spyOn(fixture.oauth, "grantedScopes").mockRejectedValue(error);
    await expect(fixture.broker.listConnections("owner")).rejects.toBe(error);
    await expect(fixture.broker.listAvailableActions!("owner", "bokio")).rejects.toBe(error);
  });
  it.each(["disabled", "auth_required", "action_required"])("does not inspect grants for a passive %s connection", async status => {
    const fixture = setup(); await fixture.connect();
    const row = fixture.row(); Object.assign(row, { status, encrypted_credentials: "unreadable" });
    const scopes = vi.spyOn(fixture.oauth, "grantedScopes");
    await expect(fixture.broker.listConnections("owner")).resolves.toEqual([expect.objectContaining({ status, scopes: [] })]);
    await expect(fixture.broker.listAvailableActions!("owner", "bokio")).resolves.toEqual([]);
    expect(scopes).not.toHaveBeenCalled();
  });
  it("requests reviewed customer/draft scopes only on a new explicit sign-in", async () => {
    const fixture = setup();
    expect(fixture.fetcher).not.toHaveBeenCalled();
    const url = new URL(await fixture.oauth.start("owner", "server"));
    for (const scope of BOKIO_WRITE_SCOPES) expect(url.searchParams.get("scope")?.split(" ")).toContain(scope);
    expect(url.searchParams.get("scope")).not.toContain("journal-entries:write");
    expect(fixture.credential()).toHaveProperty("requestedScopes");
  });
  it("does not infer write grants from requested scopes when the token omits scope", async () => {
    const fixture = setup(); await fixture.connect();
    expect(await fixture.oauth.grantedScopes("owner", fixture.row())).not.toContain("customers:write");
    expect(await fixture.broker.listAvailableActions!("owner", "bokio")).not.toContain("create_customer");
    const before = fixture.fetcher.mock.calls.length;
    await expect(fixture.broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "create_customer", params: { name: "Example", type: "company" } } as never)).rejects.toThrow("Connection action unavailable");
    expect(fixture.fetcher).toHaveBeenCalledTimes(before);
  });
  it("projects and executes only writes proven by the exact token grant", async () => {
    const fixture = setup("company-information:read customers:read customers:write"); await fixture.connect();
    const available = await fixture.broker.listAvailableActions!("owner", "bokio");
    expect(available).toContain("create_customer"); expect(available).not.toContain("create_draft_invoice");
    expect(available).not.toContain("list_journal_entries");
    const connections = await fixture.broker.listConnections("owner");
    expect(connections[0].scopes).toEqual(["company-information:read", "customers:read", "customers:write"]);
    fixture.fetcher.mockResolvedValueOnce(Response.json({ id: customerId }));
    await fixture.broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "create_customer", params: { name: "Example", type: "company", contactsDetails: [{ email: "owner@example.com" }] } } as never);
    const [url, init] = fixture.fetcher.mock.calls.at(-1)!;
    expect(url).toBe(`https://api.bokio.se/v1/companies/${companyId}/customers`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal), headers: { Authorization: "Bearer access", "Content-Type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ name: "Example", type: "company", contactsDetails: [{ email: "owner@example.com" }] });
    expect(JSON.stringify(connections)).not.toContain("access");
  });
  it("keeps legacy grants read-only through refresh, even if refresh unexpectedly reports write scopes", async () => {
    const fixture = setup(); await fixture.connect();
    const { scopes: _scopes, ...legacy } = fixture.credential();
    const row = fixture.row();
    await fixture.db.updateCustomMcpServer(row.id, row.user_id, row.revision, { encryptedCredentials: credentialCrypto.encryptCustomMcpCredential(legacy, key, { userId: "owner", serverId: "server" }) });
    fixture.clock.now = new Date(now.getTime() + 3600_000);
    fixture.fetcher.mockResolvedValueOnce(Response.json({ ...token, scope: "customers:read customers:write invoices:write" }));
    await fixture.oauth.resolveAuthorization("owner", fixture.row());
    expect(await fixture.oauth.grantedScopes("owner", fixture.row())).not.toContain("customers:write");
  });
  it("removes write scope when a rotating refresh narrows the grant", async () => {
    const fixture = setup("customers:read customers:write"); await fixture.connect();
    fixture.clock.now = new Date(now.getTime() + 3600_000);
    fixture.fetcher.mockResolvedValueOnce(Response.json({ ...token, scope: "customers:read" }));
    await fixture.oauth.resolveAuthorization("owner", fixture.row());
    expect(await fixture.oauth.grantedScopes("owner", fixture.row())).toEqual(["customers:read"]);
  });
  it("retains previously proven write scope if refresh omits unchanged scopes", async () => {
    const fixture = setup("customers:read customers:write"); await fixture.connect();
    fixture.clock.now = new Date(now.getTime() + 3600_000);
    fixture.fetcher.mockResolvedValueOnce(Response.json(token));
    await fixture.oauth.resolveAuthorization("owner", fixture.row());
    expect(await fixture.oauth.grantedScopes("owner", fixture.row())).toEqual(["customers:read", "customers:write"]);
  });
  it("uses the latest authorization scopes after refresh before permitting a write", async () => {
    const fixture = setup("customers:read customers:write"); await fixture.connect();
    fixture.clock.now = new Date(now.getTime() + 3600_000);
    fixture.fetcher.mockResolvedValueOnce(Response.json({ ...token, scope: "customers:read" }));
    await expect(fixture.broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "create_customer", params: { name: "Example", type: "company" } } as never)).rejects.toThrow();
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
  });
  it("creates a draft invoice and appends an item without exposing issuance or full replacement", async () => {
    const fixture = setup("invoices:read invoices:write"); await fixture.connect();
    fixture.fetcher.mockImplementation(async () => Response.json({ id: invoiceId, status: "draft" }));
    await fixture.broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "create_draft_invoice", params: { customerId, invoiceDate: "2026-10-18", dueDate: "2026-11-18", lineItems: [lineItem] } } as never);
    const [url, init] = fixture.fetcher.mock.calls.at(-1)!;
    expect(url).toBe(`https://api.bokio.se/v1/companies/${companyId}/invoices`);
    expect(JSON.parse(init.body)).toEqual({ type: "invoice", currency: "SEK", currencyRate: 1, customerRef: { id: customerId }, invoiceDate: "2026-10-18", dueDate: "2026-11-18", lineItems: [{ ...lineItem, itemType: "salesItem" }] });
    await fixture.broker.call({ userId: "owner", service: { id: "bokio" }, actionId: "append_draft_line_item", params: { invoiceId, lineItem } } as never);
    expect(fixture.fetcher.mock.calls.at(-1)![0]).toBe(`https://api.bokio.se/v1/companies/${companyId}/invoices/${invoiceId}/line-items`);
    expect(BOKIO_ACTIONS).not.toHaveProperty("publish_invoice"); expect(BOKIO_ACTIONS).not.toHaveProperty("record_payment"); expect(BOKIO_ACTIONS).not.toHaveProperty("update_invoice");
  });
  it.each(["create_draft_invoice", "append_draft_line_item"])("accepts the line amount boundary for %s", actionId => {
    const boundedLine = { ...lineItem, quantity: 1000, unitPrice: 1000000 };
    const params = actionId === "create_draft_invoice"
      ? { customerId, invoiceDate: "2026-10-18", lineItems: [boundedLine] }
      : { invoiceId, lineItem: boundedLine };
    expect(BOKIO_ACTIONS[actionId].paramsSchema.safeParse(params).success).toBe(true);
    expect(() => planBokioWrite(actionId, params, companyId)).not.toThrow();
  });
  it.each(["create_draft_invoice", "append_draft_line_item"])("rejects oversized line amounts for %s before authorization", async actionId => {
    const fixture = setup(); const resolve = vi.spyOn(fixture.oauth, "resolveAuthorization");
    for (const oversizedLine of [
      { ...lineItem, quantity: 1000, unitPrice: 1000000.001 },
      { ...lineItem, quantity: 1000000, unitPrice: 10000000 },
    ]) {
      const params = actionId === "create_draft_invoice"
        ? { customerId, invoiceDate: "2026-10-18", lineItems: [oversizedLine] }
        : { invoiceId, lineItem: oversizedLine };
      expect(BOKIO_ACTIONS[actionId].paramsSchema.safeParse(params).success).toBe(false);
      expect(() => planBokioWrite(actionId, params, companyId)).toThrow();
      await expect(fixture.broker.call({ userId: "owner", service: { id: "bokio" }, actionId, params } as never)).rejects.toThrow();
    }
    expect(resolve).not.toHaveBeenCalled(); expect(fixture.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ["create_customer", { name: "Example", type: "company", companyId }],
    ["create_customer", { name: " ", type: "company" }],
    ["create_customer", { name: "Example", type: "company", contactsDetails: [{ email: "invalid" }] }],
    ["create_customer", { name: "Example", type: "company", contactsDetails: Array(11).fill({ email: "owner@example.com" }) }],
    ["create_draft_invoice", { customerId, invoiceDate: "2026-10-18", lineItems: [] }],
    ["create_draft_invoice", { customerId, invoiceDate: "2026-10-18", dueDate: "2026-10-17", lineItems: [lineItem] }],
    ["create_draft_invoice", { customerId, invoiceDate: "2026-10-18", publishedDateTime: "2026-10-18T12:00:00Z", lineItems: [lineItem] }],
    ["create_draft_invoice", { customerId, invoiceDate: "2026-10-18", lineItems: Array(51).fill(lineItem) }],
    ["create_draft_invoice", { customerId, invoiceDate: "2026-10-18", lineItems: [{ ...lineItem, quantity: 1000000, unitPrice: 10000000 }] }],
    ["create_draft_invoice", { customerId, invoiceDate: "2026-10-18", lineItems: Array(50).fill({ ...lineItem, description: "漢".repeat(500) }) }],
    ["append_draft_line_item", { invoiceId: "../other", lineItem }],
    ["append_draft_line_item", { invoiceId, lineItem: { ...lineItem, unitPrice: -1 } }],
    ["append_draft_line_item", { invoiceId, lineItem: { ...lineItem, quantity: 0 } }],
    ["append_draft_line_item", { invoiceId, lineItem: { ...lineItem, taxRate: 200 } }],
    ["append_draft_line_item", { invoiceId, lineItem: { ...lineItem, bookkeepingAccountNumber: 1930 } }],
  ])("rejects invalid %s before authorization or upstream", async (actionId, params) => {
    const fixture = setup(); const resolve = vi.spyOn(fixture.oauth, "resolveAuthorization");
    await expect(fixture.broker.call({ userId: "owner", service: { id: "bokio" }, actionId, params } as never)).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled(); expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(() => planBokioWrite(actionId as string, params, companyId)).toThrow();
  });
});
