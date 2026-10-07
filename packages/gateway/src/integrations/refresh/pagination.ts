import { z } from "zod/v4";
import { IntegrationRefreshError, type RefreshBinding } from "./contracts.js";
const token = z.string().min(1).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/);
const record = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
function cursor(name: string, value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null || value === "") return null;
  const result = token.safeParse(value);
  if (!result.success) throw new IntegrationRefreshError("invalid");
  return { [name]: result.data };
}
function requiredCursor(name: string, value: unknown): Record<string, unknown> {
  const result = cursor(name, value);
  if (!result) throw new IntegrationRefreshError("invalid");
  return result;
}
const tokenActions: Record<string, string[]> = {
  gmail: ["list_threads", "list_messages", "search_messages"], google_drive: ["list_files"], google_calendar: ["list_events", "list_calendars"],
  google_contacts: ["list_contacts", "list_contact_groups"],
};
/** Return only reviewed cursor fields, never provider-supplied request URLs. */
export function refreshPagination(binding: RefreshBinding, data: unknown, current: Record<string, unknown>) {
  const body = record(data);
  if (tokenActions[binding.service]?.includes(binding.action)) {
    if (body.incompleteSearch === true) throw new IntegrationRefreshError("unavailable");
    return { cursor: cursor("pageToken", body.nextPageToken),
      checkpoint: !body.nextPageToken && binding.service === "google_contacts" && binding.action === "list_contacts" ? cursor("syncToken", body.nextSyncToken) : null };
  }
  if (binding.service === "notion" && ["search", "query_database", "list_block_children"].includes(binding.action)) return { cursor: body.has_more ? requiredCursor("startCursor", body.next_cursor) : null, checkpoint: null };
  if (binding.service === "todoist" && ["list_tasks", "list_projects"].includes(binding.action)) return { cursor: cursor("cursor", body.next_cursor), checkpoint: null };
  if (binding.service === "hubspot" && binding.action.startsWith("list_")) return { cursor: cursor("cursor", record(record(body.paging).next).after), checkpoint: null };
  if (binding.service === "zendesk" && ["list_tickets", "list_comments"].includes(binding.action)) return { cursor: body.meta?.has_more ? requiredCursor("cursor", body.meta.after_cursor) : null, checkpoint: null };
  if (binding.service === "intercom" && ["list_contacts", "list_conversations"].includes(binding.action)) return { cursor: cursor("cursor", record(record(body.pages).next).starting_after), checkpoint: null };
  if (binding.service === "stripe" && ["list_payouts", "list_refunds", "list_charges", "list_balance_transactions"].includes(binding.action)) {
    const items = body.data;
    if (body.has_more && (!Array.isArray(items) || !items.length)) throw new IntegrationRefreshError("invalid");
    return { cursor: body.has_more ? requiredCursor("startingAfter", items.at(-1)?.id) : null, checkpoint: null };
  }
  if (binding.service === "microsoft_outlook_calendar" && ["list_events", "list_calendars"].includes(binding.action)) {
    if (!body["@odata.nextLink"]) return { cursor: null, checkpoint: null };
    const next = new URL(token.parse(body["@odata.nextLink"]));
    const expected = binding.action === "list_events" ? `/v1.0/me/calendars/${encodeURIComponent(String(binding.params.calendarId))}/calendarView` : "/v1.0/me/calendars";
    const skip = next.searchParams.get("$skip");
    if (next.origin !== "https://graph.microsoft.com" || next.pathname !== expected || next.username || next.password || next.hash || !skip || !/^\d{1,6}$/.test(skip) || Number(skip) > 100000) throw new IntegrationRefreshError("invalid");
    return { cursor: { skip: Number(skip) }, checkpoint: null };
  }
  if (binding.service === "github" && ["list_repos", "list_issues", "get_notifications", "list_prs", "list_pr_reviews", "list_pr_review_comments", "list_pr_files", "list_pr_commits"].includes(binding.action)) {
    if (!Array.isArray(data)) {
      if (Object.keys(body).length) throw new IntegrationRefreshError("invalid");
      return { cursor: null, checkpoint: null };
    }
    return { cursor: data.length >= Number(current.perPage ?? current.per_page ?? 30) ? { page: Number(current.page ?? 1) + 1 } : null, checkpoint: null };
  }
  if (binding.service === "quickbooks" && binding.action.startsWith("list_")) {
    const result = record(body.QueryResponse);
    const count = Number(result.maxResults ?? 0);
    return { cursor: count >= Number(current.limit ?? 25) ? { startPosition: Number(current.startPosition ?? 1) + count } : null, checkpoint: null };
  }
  if (binding.service === "xero_accounting_api" && binding.action.startsWith("list_") && binding.action !== "list_organizations") {
    const pagination = record(body.pagination);
    const items = Object.values(body).find(value => Array.isArray(value));
    const hasMore = pagination.pageCount !== undefined ? Number(pagination.page) < Number(pagination.pageCount) : Array.isArray(items) && items.length >= Number(current.limit ?? 25);
    return { cursor: hasMore ? { page: Number(current.page ?? 1) + 1 } : null, checkpoint: null };
  }
  if (binding.action.startsWith("get_") || binding.action === "read_file" || binding.action === "list_organizations") return { cursor: null, checkpoint: null };
  throw new IntegrationRefreshError("invalid");
}
