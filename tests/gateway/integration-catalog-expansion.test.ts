import { describe, expect, it, vi } from "vitest";
import { CATALOG_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-catalog.js";
import { executeCatalogBoundAction } from "../../packages/gateway/src/integrations/catalog-bound-action.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const services = ["google_contacts", "microsoft_outlook_calendar", "google_sheets", "quickbooks", "xero_accounting_api", "zendesk", "intercom"];
const action = (service: string, name: string) => CATALOG_SERVICE_REGISTRY[service].actions[name];
const identity = { externalUserId: "owner_1", accountId: "apn_1" };
const tenantId = "12345678-1234-1234-1234-123456789abc";
const schemaAccepts = (service: string, name: string, params: Record<string, unknown>) => action(service, name).paramsSchema!.safeParse(params).success;

describe("catalog service contracts", () => {
  it("exposes seven OAuth services with executable reviewed actions", () => {
    expect(Object.keys(CATALOG_SERVICE_REGISTRY)).toEqual(services);
    for (const definition of Object.values(CATALOG_SERVICE_REGISTRY)) {
      expect(definition.authType).toBe("oauth");
      expect(definition.pipedreamApp).toBe(definition.id);
      for (const value of Object.values(definition.actions)) {
        expect(value.paramsSchema).toBeDefined();
        expect(value.directApi).toBeDefined();
      }
    }
  });

  it("reads incremental Google contacts with a fixed identity and field mask", () => {
    const api = action("google_contacts", "list_contacts").directApi!;
    expect(api.url).toBe("https://people.googleapis.com/v1/people/me/connections");
    expect(api.mapParams!({ pageToken: "next", syncToken: "sync", limit: 50 })).toEqual({
      personFields: "names,emailAddresses,phoneNumbers,organizations,birthdays,metadata",
      pageSize: "50", requestSyncToken: "true", pageToken: "next", syncToken: "sync",
    });
    expect(schemaAccepts("google_contacts", "list_contacts", { limit: 101 })).toBe(false);
    expect(schemaAccepts("google_contacts", "list_contacts", { pageToken: "x".repeat(2049) })).toBe(false);
    expect(schemaAccepts("google_contacts", "get_contact", { personId: "../me" })).toBe(false);
  });

  it("bounds Outlook calendar views and rejects ranges exceeding a year or reversed dates", () => {
    const params = { calendarId: "calendar_1=", startDateTime: "2026-10-01T00:00:00Z", endDateTime: "2026-11-01T00:00:00Z", limit: 25 };
    expect(schemaAccepts("microsoft_outlook_calendar", "list_events", params)).toBe(true);
    const api = action("microsoft_outlook_calendar", "list_events").directApi!;
    expect((api.url as Function)(params)).toContain("/me/calendars/calendar_1%3D/calendarView");
    expect(api.mapParams!(params)).toEqual({ startDateTime: params.startDateTime, endDateTime: params.endDateTime, "$top": "25" });
    expect(schemaAccepts("microsoft_outlook_calendar", "list_events", { ...params, endDateTime: "2025-10-01T00:00:00Z" })).toBe(false);
    expect(schemaAccepts("microsoft_outlook_calendar", "list_events", { ...params, endDateTime: "2028-10-01T00:00:00Z" })).toBe(false);
    expect(schemaAccepts("microsoft_outlook_calendar", "list_events", { ...params, calendarId: "../events" })).toBe(false);
  });

  it("bounds Sheets reads, encodes ranges and distinguishes reads from writes", () => {
    const api = action("google_sheets", "get_values").directApi!;
    expect((api.url as Function)({ spreadsheetId: "abc_1", range: "'Annual budget'!A1:D30" })).toContain("values/'Annual%20budget'!A1%3AD30");
    for (const range of ["A:A", "A1:ZZZ99999", "named_range", "A20:A1", "A0:A1", "A1:Z1000"]) {
      expect(schemaAccepts("google_sheets", "get_values", { spreadsheetId: "abc", range })).toBe(false);
    }
    expect(schemaAccepts("google_sheets", "get_values", { spreadsheetId: "abc", range: "A1:D100" })).toBe(true);
    expect(action("google_sheets", "get_values").risk).toBe("read");
    expect(action("google_sheets", "update_values").risk).toBe("write");
    expect(action("google_sheets", "append_values").risk).toBe("write");
    expect(action("google_sheets", "create_spreadsheet").risk).toBe("write");
    expect(schemaAccepts("google_sheets", "update_values", { spreadsheetId: "abc", range: "A1:B2", values: [[1, 2], [3, 4]] })).toBe(true);
    expect(schemaAccepts("google_sheets", "update_values", { spreadsheetId: "abc", range: "A1:B2", values: [[1, 2, 3]] })).toBe(false);
    expect(schemaAccepts("google_sheets", "update_values", { spreadsheetId: "abc", range: "A1:A1", values: [["x".repeat(4097)]] })).toBe(false);
    expect(schemaAccepts("google_sheets", "update_values", { spreadsheetId: "abc", range: "named_range", values: [[1]] })).toBe(false);
    expect(schemaAccepts("google_sheets", "update_values", { spreadsheetId: "abc", range: "A1:A1000", values: Array.from({ length: 1000 }, () => ["x".repeat(100)]) })).toBe(false);
  });

  it("uses Zendesk relative paths so only the bound account supplies its domain", () => {
    const api = action("zendesk", "list_tickets").directApi!;
    expect(api.url).toBe("/api/v2/tickets.json");
    expect(api.mapParams!({ cursor: "next", limit: 25 })).toEqual({ "page[size]": "25", "page[after]": "next" });
    expect(schemaAccepts("zendesk", "list_tickets", { subdomain: "attacker" })).toBe(false);
    expect(schemaAccepts("zendesk", "get_ticket", { ticketId: "../users" })).toBe(false);
    expect(action("zendesk", "update_ticket").risk).toBe("write");
  });

  it("pins Intercom version and one page of results", () => {
    const api = action("intercom", "list_conversations").directApi!;
    expect(api.staticHeaders).toEqual({ "Intercom-Version": "2.14" });
    expect(api.mapParams!({ cursor: "next" })).toEqual({ per_page: "25", starting_after: "next" });
    expect(schemaAccepts("intercom", "list_conversations", { limit: 100.5 })).toBe(false);
  });

  it("preserves selected owner/account through the ordinary executor and rejects credential overrides", async () => {
    const proxyGet = vi.fn().mockResolvedValue({ tickets: [] });
    await executeIntegrationAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient, externalUserId: identity.externalUserId,
      connection: { pipedream_account_id: identity.accountId }, def: CATALOG_SERVICE_REGISTRY.zendesk,
      actionDef: action("zendesk", "list_tickets"), serviceId: "zendesk", actionId: "list_tickets", params: {} });
    expect(proxyGet).toHaveBeenCalledWith({ ...identity, url: "/api/v2/tickets.json", params: { "page[size]": "25" } });
    await expect(executeIntegrationAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient, externalUserId: identity.externalUserId,
      connection: { pipedream_account_id: identity.accountId }, def: CATALOG_SERVICE_REGISTRY.zendesk,
      actionDef: action("zendesk", "list_tickets"), serviceId: "zendesk", actionId: "list_tickets", params: { accountId: "other" } })).rejects.toThrow();
    expect(proxyGet).toHaveBeenCalledTimes(1);
  });
});

describe("account-bound accounting execution", () => {
  it("verifies Xero tenant membership before forwarding its tenant header", async () => {
    const proxyGet = vi.fn().mockResolvedValueOnce([{ tenantId }]).mockResolvedValueOnce({ Invoices: [] });
    expect(await executeCatalogBoundAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient, ...identity,
      serviceId: "xero_accounting_api", actionId: "list_invoices", params: { tenantId, limit: 25, page: 2 } })).toEqual({ data: { Invoices: [] } });
    expect(proxyGet.mock.calls).toEqual([
      [{ ...identity, url: "https://api.xero.com/connections" }],
      [{ ...identity, url: "https://api.xero.com/api.xro/2.0/Invoices", params: { page: "2", pageSize: "25", summaryOnly: "true" }, headers: { "xero-tenant-id": tenantId, Accept: "application/json" } }],
    ]);
  });
  it("fails closed on another tenant, malformed/oversize discovery and provider failures", async () => {
    for (const discovery of [[], [{ tenantId: "other" }], {}, Array.from({ length: 101 }, () => ({ tenantId }))]) {
      const proxyGet = vi.fn().mockResolvedValue(discovery);
      await expect(executeCatalogBoundAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient, ...identity,
        serviceId: "xero_accounting_api", actionId: "list_invoices", params: { tenantId } })).rejects.toThrow();
      expect(proxyGet).toHaveBeenCalledTimes(1);
    }
    const proxyGet = vi.fn().mockRejectedValue(new Error("provider down"));
    await expect(executeCatalogBoundAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient, ...identity,
      serviceId: "xero_accounting_api", actionId: "list_invoices", params: { tenantId } })).rejects.toThrow("provider down");
  });
  it("checks QuickBooks company info with the exact account before its bounded fixed query", async () => {
    // CompanyInfo.Id is the resource ID (usually 1), not the OAuth realm ID.
    const proxyGet = vi.fn().mockResolvedValueOnce({ CompanyInfo: { Id: "1" } }).mockResolvedValueOnce({ QueryResponse: {} });
    await executeCatalogBoundAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient, ...identity,
      serviceId: "quickbooks", actionId: "list_invoices", params: { companyId: "123", limit: 10, startPosition: 2 } });
    expect(proxyGet.mock.calls[0][0]).toMatchObject({ ...identity, url: "https://quickbooks.api.intuit.com/v3/company/123/companyinfo/123" });
    expect(proxyGet.mock.calls[1][0]).toMatchObject({ ...identity, params: { query: "SELECT * FROM Invoice STARTPOSITION 2 MAXRESULTS 10", minorversion: "75" } });
    const mismatch = vi.fn().mockResolvedValue({ Fault: { Error: [{ code: "3100" }] } });
    await expect(executeCatalogBoundAction({ pipedream: { proxyGet: mismatch } as unknown as PipedreamConnectClient, ...identity,
      serviceId: "quickbooks", actionId: "list_invoices", params: { companyId: "123" } })).rejects.toThrow();
    expect(mismatch).toHaveBeenCalledTimes(1);
    expect(schemaAccepts("quickbooks", "list_invoices", { companyId: "123", query: "DELETE FROM Invoice" })).toBe(false);
    expect(schemaAccepts("quickbooks", "list_invoices", { companyId: "../../123" })).toBe(false);
  });
  it("does not intercept ordinary services or accept unreviewed actions", async () => {
    const proxyGet = vi.fn();
    expect(await executeCatalogBoundAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient, ...identity, serviceId: "zendesk", actionId: "list_tickets", params: {} })).toBeUndefined();
    await expect(executeCatalogBoundAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient, ...identity, serviceId: "quickbooks", actionId: "delete_invoice", params: { companyId: "123" } })).rejects.toThrow();
    expect(proxyGet).not.toHaveBeenCalled();
  });
});
