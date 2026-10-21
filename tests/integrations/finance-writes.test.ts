import { describe, expect, it, vi } from "vitest";
import { FINANCE_WRITE_ACTIONS, executeFinanceWriteAction } from "../../packages/gateway/src/integrations/finance-writes.js";
import { createBoundedFinanceAction, FinanceWriteError } from "../../packages/gateway/src/integrations/finance-write-request.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const tenantId = "11111111-2222-4333-8444-555555555555";
const contactId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const identity = { externalUserId: "owner", accountId: "account" };
const action = (service: string, id: string) => FINANCE_WRITE_ACTIONS[service][id];
const request = (fetcher: (url: string, init: RequestInit) => Promise<Response>, getAccessToken = vi.fn().mockResolvedValue("token")) =>
  createBoundedFinanceAction({ projectId: "project", environment: "production", getAccessToken, fetcher });
const decode = (url: string) => Buffer.from(new URL(url).pathname.split("/").at(-1)!, "base64url").toString();

describe("bounded finance profile writes", () => {
  it("exposes only six profile/metadata writes, with strict schemas", () => {
    expect(Object.keys(FINANCE_WRITE_ACTIONS).sort()).toEqual(["quickbooks", "stripe", "xero_accounting_api"]);
    expect(Object.values(FINANCE_WRITE_ACTIONS).flatMap(Object.values)).toHaveLength(6);
    for (const actions of Object.values(FINANCE_WRITE_ACTIONS)) for (const value of Object.values(actions)) {
      expect(value.risk).toBe("write"); expect(value.paramsSchema).toBeDefined();
    }
  });
  it.each(["create_customer", "update_customer"])("encodes Stripe %s as form data without losing literal metadata strings", async actionId => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "cus_123" }));
    const params = { ...(actionId === "update_customer" ? { customerId: "cus_123" } : {}), name: "Alex & Co", email: "alex@example.com", phone: "+46700000000", metadata: { literal: "null", decimal: "42.0", flag: "false", remove: "", quoted: '"value"' } };
    expect(await request(fetcher)({ ...identity, serviceId: "stripe", actionId, params })).toEqual({ id: "cus_123" });
    const [url, init] = fetcher.mock.calls[0];
    expect(decode(url)).toBe(`https://api.stripe.com/v1/customers${actionId === "update_customer" ? "/cus_123" : ""}`);
    expect(new URL(url).searchParams.get("account_id")).toBe("account");
    expect(new URL(url).searchParams.get("external_user_id")).toBe("owner");
    expect(init).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal), headers: { Authorization: "Bearer token", "x-pd-environment": "production", "x-pd-proxy-content-type": "application/x-www-form-urlencoded" } });
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body);
    expect(form.get("name")).toBe("Alex & Co");
    for (const [key, value] of Object.entries(params.metadata)) expect(form.get(`metadata[${key}]`)).toBe(value);
    expect(form.has("customerId")).toBe(false);
  });
  it.each(["create_customer", "update_customer"])("preflights exact QuickBooks company before %s and retains caller SyncToken", async actionId => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ CompanyInfo: { Id: "99" } })).mockResolvedValueOnce(Response.json({ Customer: { Id: "123", SyncToken: "8" } }));
    const params = { companyId: "42", ...(actionId === "update_customer" ? { customerId: "123", syncToken: "7" } : {}), displayName: "Alex", email: "alex@example.com", phone: "123", notes: "Details" };
    await request(fetcher)({ ...identity, serviceId: "quickbooks", actionId, params });
    expect(decode(fetcher.mock.calls[0][0])).toBe("https://quickbooks.api.intuit.com/v3/company/42/companyinfo/42?minorversion=75");
    expect(decode(fetcher.mock.calls[1][0])).toBe("https://quickbooks.api.intuit.com/v3/company/42/customer?minorversion=75");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ DisplayName: "Alex", PrimaryEmailAddr: { Address: "alex@example.com" }, PrimaryPhone: { FreeFormNumber: "123" }, Notes: "Details", ...(actionId === "update_customer" ? { Id: "123", SyncToken: "7", sparse: true } : {}) });
    for (const [url] of fetcher.mock.calls) expect(new URL(url).searchParams.get("account_id")).toBe("account");
  });
  it.each(["create_contact", "update_contact"])("checks current Xero tenants before %s and binds the tenant header", async actionId => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ tenantId }])).mockResolvedValueOnce(Response.json({ Contacts: [{ ContactID: contactId }] }));
    const params = { tenantId, ...(actionId === "update_contact" ? { contactId } : {}), name: "Alex", email: "alex@example.com", firstName: "Alex", lastName: "Example" };
    await request(fetcher)({ ...identity, serviceId: "xero_accounting_api", actionId, params });
    expect(decode(fetcher.mock.calls[0][0])).toBe("https://api.xero.com/connections");
    const [url, init] = fetcher.mock.calls[1];
    expect(decode(url)).toBe(`https://api.xero.com/api.xro/2.0/Contacts${actionId === "update_contact" ? `/${contactId}` : ""}`);
    expect(init.method).toBe(actionId === "create_contact" ? "PUT" : "POST");
    expect(init.headers["x-pd-proxy-xero-tenant-id"]).toBe(tenantId);
    expect(JSON.parse(init.body)).toEqual({ Contacts: [{ Name: "Alex", EmailAddress: "alex@example.com", FirstName: "Alex", LastName: "Example", ...(actionId === "update_contact" ? { ContactID: contactId } : {}) }] });
  });
  it("sparse-updates QuickBooks notes without replacing unsupplied profile values", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ CompanyInfo: { Id: "99" } })).mockResolvedValueOnce(Response.json({ Customer: { Id: "123" } }));
    await request(fetcher)({ ...identity, serviceId: "quickbooks", actionId: "update_customer", params: { companyId: "42", customerId: "123", syncToken: "7", notes: "" } });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ Id: "123", SyncToken: "7", sparse: true, Notes: "" });
  });
  it.each([
    ["stripe", "create_customer", { name: "Alex", source: "tok_card" }],
    ["stripe", "update_customer", { customerId: "cus_123", balance: 100 }],
    ["stripe", "update_customer", { customerId: "cus_123" }],
    ["stripe", "update_customer", { customerId: "../other", name: "Alex" }],
    ["stripe", "create_customer", { name: "Alex", metadata: { "key[other]": "bad" } }],
    ["stripe", "create_customer", { name: "Alex", metadata: { "": "bad" } }],
    ["stripe", "create_customer", { name: "Alex", metadata: { key: "x".repeat(501) } }],
    ["stripe", "create_customer", { name: "Alex", metadata: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`key${i}`, "value"])) }],
    ["stripe", "create_customer", { name: "x".repeat(257) }],
    ["stripe", "create_customer", { name: " " }],
    ["stripe", "create_customer", { name: "Alex", phone: "1".repeat(21) }],
    ["quickbooks", "create_customer", { companyId: "../other", displayName: "Alex" }],
    ["quickbooks", "create_customer", { companyId: "42", displayName: "Alex", balance: 100 }],
    ["quickbooks", "update_customer", { companyId: "42", customerId: "123", displayName: "Alex" }],
    ["quickbooks", "update_customer", { companyId: "42", customerId: "123", syncToken: "7" }],
    ["quickbooks", "update_customer", { companyId: "42", customerId: "123", syncToken: "7", notes: undefined }],
    ["quickbooks", "update_customer", { companyId: "42", customerId: "123", syncToken: "7;DROP", displayName: "Alex" }],
    ["xero_accounting_api", "create_contact", { tenantId, name: "Alex", BankAccountDetails: "bank" }],
    ["xero_accounting_api", "update_contact", { tenantId, contactId }],
    ["xero_accounting_api", "update_contact", { tenantId, contactId: "../other", name: "Alex" }],
    ["xero_accounting_api", "update_contact", { tenantId: "../other", contactId, name: "Alex" }],
  ])("rejects unsafe %s/%s before credentials or network: %j", async (serviceId, actionId, params) => {
    const fetcher = vi.fn(); const getAccessToken = vi.fn();
    await expect(request(fetcher, getAccessToken)({ ...identity, serviceId, actionId, params })).rejects.toThrow();
    expect(getAccessToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[], [{ tenantId: "99999999-2222-4333-8444-555555555555" }], { tenantId }, Array(101).fill({ tenantId })].map(data => [data]))("rejects Xero tenant preflight mismatch: %j", async data => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(data));
    await expect(request(fetcher)({ ...identity, serviceId: "xero_accounting_api", actionId: "create_contact", params: { tenantId, name: "Alex" } })).rejects.toBeInstanceOf(FinanceWriteError);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{}, { CompanyInfo: { Id: "invalid" } }])("rejects invalid QuickBooks company preflight: %j", async data => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(data));
    await expect(request(fetcher)({ ...identity, serviceId: "quickbooks", actionId: "create_customer", params: { companyId: "42", displayName: "Alex" } })).rejects.toBeInstanceOf(FinanceWriteError);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("never retries a failed write or upgrades the restricted Stripe key", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("provider secret", { status: 403 }));
    await expect(request(fetcher)({ ...identity, serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" } })).rejects.toThrow("The customer profile change could not be confirmed");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects oversize responses and cancels their streams", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel });
    await expect(request(vi.fn().mockResolvedValue(new Response(body)))({ ...identity, serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" } })).rejects.toBeInstanceOf(FinanceWriteError);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("stops a stalled credential resolution at the caller deadline", async () => {
    const controller = new AbortController(); const fetcher = vi.fn();
    const pending = request(fetcher, vi.fn(() => new Promise<string>(() => undefined)))({ ...identity, serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" } }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(FinanceWriteError); expect(fetcher).not.toHaveBeenCalled();
  });
  it("ignores unrelated reads but fails closed without the required bounded seam", async () => {
    const common = { pipedream: {} as PipedreamConnectClient, ...identity };
    expect(await executeFinanceWriteAction({ ...common, serviceId: "stripe", actionId: "get_customer", params: { customerId: "cus_123" } })).toBeUndefined();
    expect(await executeFinanceWriteAction({ ...common, serviceId: "other", actionId: "create_customer", params: {} })).toBeUndefined();
    await expect(executeFinanceWriteAction({ ...common, serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" } })).rejects.toBeInstanceOf(FinanceWriteError);
  });
  it("routes a finance write to the bounded seam with immutable selected identity", async () => {
    const boundedFinanceAction = vi.fn().mockResolvedValue({ id: "cus_123" });
    expect(await executeFinanceWriteAction({ pipedream: { boundedFinanceAction } as unknown as PipedreamConnectClient,
      ...identity, serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" } })).toEqual({ data: { id: "cus_123" } });
    expect(boundedFinanceAction).toHaveBeenCalledExactlyOnceWith({ ...identity, serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" } });
    await executeFinanceWriteAction({ pipedream: { boundedFinanceAction } as unknown as PipedreamConnectClient,
      ...identity, serviceId: "stripe", actionId: "create_customer" });
    expect(boundedFinanceAction).toHaveBeenLastCalledWith({ ...identity, serviceId: "stripe", actionId: "create_customer", params: {} });
  });
  it("rejects arbitrary operation names and identity overrides before token lookup", async () => {
    const fetcher = vi.fn(); const getAccessToken = vi.fn();
    for (const input of [
      { ...identity, serviceId: "stripe", actionId: "charge", params: {} },
      { ...identity, serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" }, url: "https://example.com" },
      { ...identity, accountId: "../other", serviceId: "stripe", actionId: "create_customer", params: { name: "Alex" } },
    ]) await expect(request(fetcher, getAccessToken)(input)).rejects.toBeInstanceOf(FinanceWriteError);
    expect(getAccessToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
