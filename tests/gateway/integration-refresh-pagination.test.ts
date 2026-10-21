import { describe, expect, it } from "vitest";
import { refreshPagination } from "../../packages/gateway/src/integrations/refresh/pagination.js";
import type { RefreshBinding } from "../../packages/gateway/src/integrations/refresh/contracts.js";

const binding = (service: string, action: string, params: Record<string, unknown> = {}): RefreshBinding => ({
  appId: "research", sourceId: "report", connectionId: "connection_1", label: "main", service, action, params,
});
describe("reviewed source pagination", () => {
  it.each([
    ["google_drive", "list_files", {}],
    ["google_contacts", "list_contacts", { connections: [] }],
    ["notion", "search", { results: [], has_more: false, next_cursor: null }],
    ["todoist", "list_tasks", { results: [], next_cursor: null }],
    ["hubspot", "list_contacts", { results: [] }],
    ["zendesk", "list_tickets", { tickets: [], meta: { has_more: false } }],
    ["intercom", "list_contacts", { data: [], pages: { next: null } }],
    ["stripe", "list_charges", { data: [], has_more: false }],
    ["microsoft_outlook_calendar", "list_calendars", { value: [] }],
    ["github", "list_prs", []],
    ["quickbooks", "list_invoices", { QueryResponse: {} }],
    ["xero_accounting_api", "list_invoices", { Invoices: [], Pagination: { page: 1, pageCount: 0 } }],
    ["xero_accounting_api", "list_organizations", []],
  ])("accepts a legitimate empty final %s/%s page", (service, action, data) => {
    expect(refreshPagination(binding(service!, action!), data, {})).toEqual({ cursor: null, checkpoint: null });
  });
  it.each([
    ["notion", "search", { results: "invalid", has_more: true, next_cursor: "next" }],
    ["notion", "search", null],
    ["todoist", "list_tasks", { results: "invalid", next_cursor: "next" }],
    ["hubspot", "list_contacts", { results: "invalid", paging: { next: { after: "next" } } }],
    ["google_drive", "list_files", { files: "invalid", nextPageToken: "next" }],
    ["gmail", "search", { messages: [null], nextPageToken: "next" }],
    ["google_contacts", "list_contacts", null],
    ["zendesk", "list_tickets", { tickets: "invalid", meta: { has_more: false } }],
    ["intercom", "list_conversations", { conversations: "invalid" }],
    ["stripe", "list_charges", { data: "invalid", has_more: false }],
    ["microsoft_outlook_calendar", "list_calendars", { value: "invalid" }],
    ["github", "list_prs", null],
    ["quickbooks", "list_invoices", { QueryResponse: { Invoice: "invalid", maxResults: 25 } }],
    ["quickbooks", "list_invoices", { QueryResponse: { Invoice: [{ Id: "1" }], maxResults: 25 } }],
    ["xero_accounting_api", "list_invoices", { Invoices: "invalid" }],
    ["xero_accounting_api", "list_organizations", null],
  ])("rejects malformed %s/%s record pages before deriving any cursor", (service, action, data) => {
    expect(() => refreshPagination(binding(service!, action!), data, {})).toThrow();
  });
  it.each([
    ["gmail", "list_threads", { nextPageToken: "next" }, {}, { pageToken: "next" }],
    ["google_drive", "list_files", { nextPageToken: "next" }, {}, { pageToken: "next" }],
    ["google_calendar", "list_events", { nextPageToken: "next" }, {}, { pageToken: "next" }],
    ["notion", "search", { results: [], has_more: true, next_cursor: "next" }, {}, { startCursor: "next" }],
    ["todoist", "list_tasks", { results: [], next_cursor: "next" }, {}, { cursor: "next" }],
    ["hubspot", "list_contacts", { results: [], paging: { next: { after: "next" } } }, {}, { cursor: "next" }],
    ["zendesk", "list_tickets", { tickets: [], meta: { has_more: true, after_cursor: "next" } }, {}, { cursor: "next" }],
    ["intercom", "list_conversations", { conversations: [], pages: { next: { starting_after: "next" } } }, {}, { cursor: "next" }],
    ["stripe", "list_charges", { has_more: true, data: [{ id: "ch_a" }] }, {}, { startingAfter: "ch_a" }],
    ["quickbooks", "list_invoices", { QueryResponse: { Invoice: Array.from({ length: 25 }, (_, i) => ({ Id: String(i + 1) })), maxResults: 25 } }, { limit: 25 }, { startPosition: 26 }],
    ["xero_accounting_api", "list_invoices", { pagination: { page: 1, pageCount: 3 }, Invoices: [{}] }, {}, { page: 2 }],
    ["xero_accounting_api", "list_invoices", { Pagination: { page: 1, pageCount: 3 }, Invoices: [{}] }, {}, { page: 2 }],
    ["github", "list_prs", [{ id: 1 }], { perPage: 1, page: 2 }, { page: 3 }],
  ] as const)("extracts a bounded cursor for %s/%s", (service, action, data, params, cursor) => {
    expect(refreshPagination(binding(service, action, params), data, params)).toEqual({ cursor, checkpoint: null });
  });
  it("restricts Outlook paging links to the selected calendar and extracts only numeric skip", () => {
    const source = binding("microsoft_outlook_calendar", "list_events", { calendarId: "calendar_a" });
    const next = "https://graph.microsoft.com/v1.0/me/calendars/calendar_a/calendarView?$skip=25";
    expect(refreshPagination(source, { value: [], "@odata.nextLink": next }, {})).toEqual({ cursor: { skip: 25 }, checkpoint: null });
    for (const link of [next.replace("graph.microsoft.com", "evil.com"), next.replace("calendar_a", "calendar_b"), `${next}#fragment`, next.replace("25", "200000")]) {
      expect(() => refreshPagination(source, { value: [], "@odata.nextLink": link }, {})).toThrow();
    }
  });
  it.each([["granola", "get_note"], ["posthog", "get_insight"], ["lemlist", "get_campaign"]])("rejects failed MCP envelopes for %s/%s", (service, action) => {
    const success = { isError: false, content: [{ type: "text", text: "saved record" }] };
    expect(refreshPagination(binding(service!, action!), success, {})).toEqual({ cursor: null, checkpoint: null });
    for (const isError of [true, "true", 1, null]) {
      expect(() => refreshPagination(binding(service!, action!), { ...success, isError }, {})).toThrow();
    }
  });
  it("permits explicit MCP record imports and refuses to claim unknown paginated lists are complete", () => {
    for (const [service, action] of [["granola", "get_note"], ["granola", "get_transcript"], ["posthog", "get_insight"], ["lemlist", "get_campaign"]]) {
      expect(refreshPagination(binding(service!, action!), { data: { id: "record" } }, {})).toEqual({ cursor: null, checkpoint: null });
    }
    for (const [service, action] of [["granola", "list_notes"], ["posthog", "list_insights"], ["loops", "list_teams"]]) {
      expect(() => refreshPagination(binding(service!, action!), { records: [] }, {})).toThrow();
    }
  });
  it("refuses malformed/incomplete provider pages and never stores an arbitrary URL cursor", () => {
    expect(() => refreshPagination(binding("google_drive", "list_files"), { incompleteSearch: true }, {})).toThrow();
    expect(() => refreshPagination(binding("stripe", "list_charges"), { has_more: true, data: [] }, {})).toThrow();
    expect(() => refreshPagination(binding("notion", "search"), { has_more: true, next_cursor: null }, {})).toThrow();
    expect(() => refreshPagination(binding("zendesk", "list_tickets"), { meta: { has_more: true, after_cursor: "line\nbreak" } }, {})).toThrow();
  });
});
