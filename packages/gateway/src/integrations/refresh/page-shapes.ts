import { z } from "zod/v4";
import { IntegrationRefreshError, REFRESH_LIMITS, type RefreshBinding } from "./contracts.js";

const item = z.record(z.string(), z.unknown());
const items = z.array(item).max(REFRESH_LIMITS.maxPageRecords);
const object = (shape: z.ZodRawShape) => z.object(shape).passthrough();
const optionalToken = z.string().max(2048).nullable().optional();
const next = (shape: z.ZodRawShape) => object({ next: object(shape).nullable().optional() });
const googleFields: Record<string, Record<string, string>> = {
  gmail: { list_threads: "threads", list_messages: "messages", search: "messages" },
  google_drive: { list_files: "files" },
  google_calendar: { list_events: "items", list_calendars: "items" },
  google_contacts: { list_contacts: "connections", list_contact_groups: "contactGroups" },
};
const quickbooksFields: Record<string, string> = {
  list_invoices: "Invoice", list_customers: "Customer", list_bills: "Bill",
  list_payments: "Payment", list_purchases: "Purchase", list_accounts: "Account",
};
const xeroFields: Record<string, string> = {
  list_invoices: "Invoices", list_contacts: "Contacts", list_bank_transactions: "BankTransactions", list_payments: "Payments",
};

/** Envelope validation is independent of cursor extraction and never treats null as an empty page. */
function pageSchema(binding: RefreshBinding): z.ZodType | undefined {
  const { service, action } = binding;
  const googleField = googleFields[service]?.[action];
  // Google omits empty repeated fields in valid list responses. If supplied,
  // records must still be an array of objects, including on the final page.
  if (googleField) return object({ [googleField]: items.optional(), nextPageToken: optionalToken,
    nextSyncToken: optionalToken, incompleteSearch: z.boolean().optional() });
  if (service === "notion" && ["search", "query_database", "list_block_children"].includes(action)) {
    return object({ results: items, has_more: z.boolean(), next_cursor: optionalToken });
  }
  if (service === "todoist" && ["list_tasks", "list_projects"].includes(action)) return object({ results: items, next_cursor: optionalToken });
  if (service === "hubspot" && action.startsWith("list_")) return object({ results: items, paging: next({ after: optionalToken }).optional() });
  if (service === "zendesk" && ["list_tickets", "list_comments"].includes(action)) {
    return object({ [action === "list_tickets" ? "tickets" : "comments"]: items,
      meta: object({ has_more: z.boolean(), after_cursor: optionalToken }) });
  }
  if (service === "intercom" && ["list_contacts", "list_conversations"].includes(action)) {
    return object({ [action === "list_contacts" ? "data" : "conversations"]: items,
      pages: next({ starting_after: optionalToken }).optional() });
  }
  if (service === "stripe" && ["list_payouts", "list_refunds", "list_charges", "list_balance_transactions"].includes(action)) {
    return object({ data: items, has_more: z.boolean() });
  }
  if (service === "microsoft_outlook_calendar" && ["list_events", "list_calendars"].includes(action)) {
    return object({ value: items, "@odata.nextLink": optionalToken });
  }
  if (service === "github" && ["list_repos", "list_issues", "get_notifications", "list_prs", "list_pr_reviews", "list_pr_review_comments", "list_pr_files", "list_pr_commits"].includes(action)) return items;
  const quickbooksField = service === "quickbooks" ? quickbooksFields[action] : undefined;
  if (quickbooksField) return object({ QueryResponse: object({ [quickbooksField]: items.optional(),
    maxResults: z.number().int().min(0).max(1000).optional() }).refine(response =>
    response.maxResults === undefined
      ? response[quickbooksField] === undefined && Object.keys(response).length === 0
      : response.maxResults === (Array.isArray(response[quickbooksField]) ? response[quickbooksField].length : 0)) });
  if (service === "xero_accounting_api" && action === "list_organizations") return items;
  const xeroField = service === "xero_accounting_api" ? xeroFields[action] : undefined;
  const xeroPagination = object({
    page: z.number().int().min(1).max(100000), pageCount: z.number().int().min(0).max(100000),
  });
  if (xeroField) return object({ [xeroField]: items, Pagination: xeroPagination.optional(), pagination: xeroPagination.optional() });
  if (action.startsWith("get_") || action === "read_file") return z.union([item.refine(value => Object.keys(value).length > 0), items]);
  return undefined;
}

export function assertRefreshSupported(binding: RefreshBinding): void {
  if (!pageSchema(binding)) throw new IntegrationRefreshError("invalid");
}

export function assertRefreshPage(binding: RefreshBinding, data: unknown): void {
  // HTTP success can still contain a failed MCP tool result. Never publish
  // an error envelope as a record, including malformed truthy error flags.
  if (data && typeof data === "object" && !Array.isArray(data) && "isError" in data && data.isError !== false) {
    throw new IntegrationRefreshError("invalid");
  }
  const schema = pageSchema(binding);
  if (!schema || !schema.safeParse(data).success) throw new IntegrationRefreshError("invalid");
}
