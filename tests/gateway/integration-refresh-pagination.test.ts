import { describe, expect, it } from "vitest";
import { refreshPagination } from "../../packages/gateway/src/integrations/refresh/pagination.js";
import type { RefreshBinding } from "../../packages/gateway/src/integrations/refresh/contracts.js";

const binding = (service: string, action: string, params: Record<string, unknown> = {}): RefreshBinding => ({
  appId: "research", sourceId: "report", connectionId: "connection_1", label: "main", service, action, params,
});
describe("reviewed source pagination", () => {
  it.each([
    ["gmail", "list_threads", { nextPageToken: "next" }, {}, { pageToken: "next" }],
    ["google_drive", "list_files", { nextPageToken: "next" }, {}, { pageToken: "next" }],
    ["google_calendar", "list_events", { nextPageToken: "next" }, {}, { pageToken: "next" }],
    ["notion", "search", { has_more: true, next_cursor: "next" }, {}, { startCursor: "next" }],
    ["todoist", "list_tasks", { next_cursor: "next" }, {}, { cursor: "next" }],
    ["hubspot", "list_contacts", { paging: { next: { after: "next" } } }, {}, { cursor: "next" }],
    ["zendesk", "list_tickets", { meta: { has_more: true, after_cursor: "next" } }, {}, { cursor: "next" }],
    ["intercom", "list_conversations", { pages: { next: { starting_after: "next" } } }, {}, { cursor: "next" }],
    ["stripe", "list_charges", { has_more: true, data: [{ id: "ch_a" }] }, {}, { startingAfter: "ch_a" }],
    ["quickbooks", "list_invoices", { QueryResponse: { maxResults: 25 } }, { limit: 25 }, { startPosition: 26 }],
    ["xero_accounting_api", "list_invoices", { pagination: { page: 1, pageCount: 3 }, Invoices: [{}] }, {}, { page: 2 }],
    ["github", "list_prs", [{ id: 1 }], { perPage: 1, page: 2 }, { page: 3 }],
  ] as const)("extracts a bounded cursor for %s/%s", (service, action, data, params, cursor) => {
    expect(refreshPagination(binding(service, action, params), data, params)).toEqual({ cursor, checkpoint: null });
  });
  it("restricts Outlook paging links to the selected calendar and extracts only numeric skip", () => {
    const source = binding("microsoft_outlook_calendar", "list_events", { calendarId: "calendar_a" });
    const next = "https://graph.microsoft.com/v1.0/me/calendars/calendar_a/calendarView?$skip=25";
    expect(refreshPagination(source, { "@odata.nextLink": next }, {})).toEqual({ cursor: { skip: 25 }, checkpoint: null });
    for (const link of [next.replace("graph.microsoft.com", "evil.com"), next.replace("calendar_a", "calendar_b"), `${next}#fragment`, next.replace("25", "200000")]) {
      expect(() => refreshPagination(source, { "@odata.nextLink": link }, {})).toThrow();
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
