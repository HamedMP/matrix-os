import { z } from "zod/v4";
import type { DirectApi, ServiceAction, ServiceDefinition } from "./types.js";
import { type CatalogField, CURSOR, GRAPH_ID, ID, LIMIT, NUMERIC_ID, SHEET_RANGE, SHEET_VALUES, UUID,
  choice, integer, optional, pageFields, segment, sheetRectangle, strictFields, text } from "./catalog-fields.js";

function action(description: string, fields: Record<string, CatalogField>, directApi: DirectApi,
  risk: ServiceAction["risk"] = "read", schema?: z.ZodType): ServiceAction {
  return { description, risk, params: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.param])),
    paramsSchema: schema ?? strictFields(fields), directApi };
}
const get = (description: string, url: DirectApi["url"], fields: Record<string, CatalogField> = {}, mapParams?: DirectApi["mapParams"], headers?: Record<string, string>) =>
  action(description, fields, { method: "GET", url, ...(mapParams ? { mapParams } : {}), ...(headers ? { staticHeaders: headers } : {}) });
function service(id: string, name: string, category: string, actions: Record<string, ServiceAction>): ServiceDefinition {
  return { id, name, category, connectorKind: "pipedream", pipedreamApp: id, authType: "oauth", icon: "puzzle",
    logoUrl: `https://pipedream.com/s.v0/${id}/logo/48`, actions };
}
const page = (limitKey: string, cursorKey: string) => (p: Record<string, unknown>) => ({
  [limitKey]: String(p.limit ?? 25), ...(p.cursor ? { [cursorKey]: String(p.cursor) } : {}),
});
const graph = "https://graph.microsoft.com/v1.0/me";
const dateTime: CatalogField = { schema: z.iso.datetime({ offset: true }).max(40), param: { type: "string", required: true, maxLength: 40 } };
const calendarFields = { calendarId: GRAPH_ID, startDateTime: dateTime, endDateTime: dateTime, limit: LIMIT, skip: optional(integer(0, 100000)) };
const calendarSchema = strictFields(calendarFields).refine(p => {
  const duration = Date.parse(String(p.endDateTime)) - Date.parse(String(p.startDateTime));
  return duration > 0 && duration <= 366 * 24 * 60 * 60 * 1000;
});
const sheets = "https://sheets.googleapis.com/v4/spreadsheets";
const sheetReadFields = { spreadsheetId: ID, range: SHEET_RANGE };
const sheetWriteFields = { ...sheetReadFields, values: SHEET_VALUES };
const sheetWriteSchema = strictFields(sheetWriteFields).refine(p => {
  const rectangle = sheetRectangle(String(p.range));
  const values = p.values as unknown[][];
  return rectangle !== null && values.length <= rectangle.rows && values.every(row => row.length <= rectangle.columns);
});
const literalValues = (p: Record<string, unknown>) => ({ range: p.range, majorDimension: "ROWS", values: p.values });
const xero = "https://api.xero.com/api.xro/2.0";
const accountingPage = { page: optional(integer(1, 100000)), limit: LIMIT };
const companyPage = { companyId: NUMERIC_ID, startPosition: optional(integer(1, 1000000)), limit: LIMIT };
const quickbooks = "https://quickbooks.api.intuit.com/v3/company";
const qbQuery = (entity: string) => get(`Read one page of ${entity.toLowerCase()} records from the selected company`,
  p => `${quickbooks}/${segment(p, "companyId", NUMERIC_ID)}/query`, companyPage,
  p => ({ query: `SELECT * FROM ${entity} STARTPOSITION ${p.startPosition ?? 1} MAXRESULTS ${p.limit ?? 25}`, minorversion: "75" }));
const xeroList = (resource: string) => get(`Read one page of ${resource.toLowerCase()} in an authorized organization`, `${xero}/${resource}`,
  { tenantId: UUID, ...accountingPage }, p => ({ page: String(p.page ?? 1), pageSize: String(p.limit ?? 25), ...(resource === "Invoices" ? { summaryOnly: "true" } : {}) }));
// The Pipedream SDK prefixes provider headers; registry values are provider names.
const intercomHeaders = { "Intercom-Version": "2.14" };
const intercom = "https://api.intercom.io";

// OAuth slugs verified against PipedreamHQ's public app sources on 2026-10-07.
// Accounting actions additionally require executeCatalogBoundAction tenant/company preflight.
export const CATALOG_SERVICE_REGISTRY: Record<string, ServiceDefinition> = {
  google_contacts: service("google_contacts", "Google Contacts", "productivity", {
    list_contacts: get("Read one page of contacts, optionally continuing incremental sync", "https://people.googleapis.com/v1/people/me/connections",
      { limit: LIMIT, pageToken: CURSOR, syncToken: CURSOR }, p => ({
        personFields: "names,emailAddresses,phoneNumbers,organizations,birthdays,metadata", pageSize: String(p.limit ?? 25), requestSyncToken: "true",
        ...(p.pageToken ? { pageToken: String(p.pageToken) } : {}), ...(p.syncToken ? { syncToken: String(p.syncToken) } : {}),
      })),
    get_contact: get("Read contact details", p => `https://people.googleapis.com/v1/people/${segment(p, "personId")}`,
      { personId: ID }, () => ({ personFields: "names,emailAddresses,phoneNumbers,organizations,birthdays,metadata" })),
    list_contact_groups: get("Read one page of contact groups", "https://people.googleapis.com/v1/contactGroups",
      { limit: LIMIT, pageToken: CURSOR }, p => ({ pageSize: String(p.limit ?? 25), ...(p.pageToken ? { pageToken: String(p.pageToken) } : {}) })),
  }),
  microsoft_outlook_calendar: service("microsoft_outlook_calendar", "Outlook Calendar", "productivity", {
    list_calendars: get("Read one page of available calendars", `${graph}/calendars`, { limit: LIMIT, skip: optional(integer(0, 100000)) },
      p => ({ "$top": String(p.limit ?? 25), ...(p.skip !== undefined ? { "$skip": String(p.skip) } : {}) })),
    list_events: action("Read one calendar's events in a bounded date range", calendarFields,
      { method: "GET", url: p => `${graph}/calendars/${segment(p, "calendarId", GRAPH_ID)}/calendarView`,
        mapParams: p => ({ startDateTime: String(p.startDateTime), endDateTime: String(p.endDateTime), "$top": String(p.limit ?? 25),
          ...(p.skip !== undefined ? { "$skip": String(p.skip) } : {}) }) }, "read", calendarSchema),
    get_event: get("Read one event", p => `${graph}/events/${segment(p, "eventId", GRAPH_ID)}`, { eventId: GRAPH_ID }),
  }),
  google_sheets: service("google_sheets", "Google Sheets", "productivity", {
    get_spreadsheet: get("Read spreadsheet and sheet metadata without cell grids", p => `${sheets}/${segment(p, "spreadsheetId")}`, { spreadsheetId: ID },
      () => ({ includeGridData: "false", fields: "spreadsheetId,spreadsheetUrl,properties,sheets.properties" })),
    get_values: get("Read a bounded explicit cell rectangle", p => `${sheets}/${segment(p, "spreadsheetId")}/values/${segment(p, "range", SHEET_RANGE)}`, sheetReadFields,
      () => ({ majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" })),
    update_values: action("Update a bounded rectangle with literal values after approval", sheetWriteFields,
      { method: "PUT", url: p => `${sheets}/${segment(p, "spreadsheetId")}/values/${segment(p, "range", SHEET_RANGE)}?valueInputOption=RAW`, mapBody: literalValues }, "write", sheetWriteSchema),
    append_values: action("Append bounded literal values after approval", sheetWriteFields,
      { method: "POST", url: p => `${sheets}/${segment(p, "spreadsheetId")}/values/${segment(p, "range", SHEET_RANGE)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, mapBody: literalValues }, "write", sheetWriteSchema),
    create_spreadsheet: action("Create a named spreadsheet after approval", { title: text(200) },
      { method: "POST", url: sheets, mapBody: p => ({ properties: { title: p.title } }) }, "write"),
    add_sheet: action("Add a named sheet after approval", { spreadsheetId: ID, title: text(100) },
      { method: "POST", url: p => `${sheets}/${segment(p, "spreadsheetId")}:batchUpdate`, mapBody: p => ({ requests: [{ addSheet: { properties: { title: p.title } } }] }) }, "write"),
  }),
  quickbooks: service("quickbooks", "QuickBooks", "finance", {
    get_company: get("Verify and read the authorized company", p => `${quickbooks}/${segment(p, "companyId", NUMERIC_ID)}/companyinfo/${segment(p, "companyId", NUMERIC_ID)}`,
      { companyId: NUMERIC_ID }, () => ({ minorversion: "75" })),
    list_invoices: qbQuery("Invoice"), list_customers: qbQuery("Customer"), list_bills: qbQuery("Bill"),
    list_payments: qbQuery("Payment"), list_purchases: qbQuery("Purchase"), list_accounts: qbQuery("Account"),
    get_invoice: get("Read one authorized company invoice", p => `${quickbooks}/${segment(p, "companyId", NUMERIC_ID)}/invoice/${segment(p, "invoiceId", NUMERIC_ID)}`,
      { companyId: NUMERIC_ID, invoiceId: NUMERIC_ID }, () => ({ minorversion: "75" })),
  }),
  xero_accounting_api: service("xero_accounting_api", "Xero", "finance", {
    list_organizations: get("Discover the organizations authorized by this connection", "https://api.xero.com/connections"),
    list_invoices: xeroList("Invoices"), list_contacts: xeroList("Contacts"), list_bank_transactions: xeroList("BankTransactions"), list_payments: xeroList("Payments"),
    get_invoice: get("Read one invoice in an authorized organization", p => `${xero}/Invoices/${segment(p, "invoiceId", UUID)}`, { tenantId: UUID, invoiceId: UUID }),
  }),
  zendesk: service("zendesk", "Zendesk", "communication", {
    list_tickets: get("Read one page of tickets from the connected account", "/api/v2/tickets.json", pageFields, page("page[size]", "page[after]")),
    get_ticket: get("Read one ticket", p => `/api/v2/tickets/${segment(p, "ticketId", NUMERIC_ID)}.json`, { ticketId: NUMERIC_ID }),
    list_comments: get("Read one page of ticket comments", p => `/api/v2/tickets/${segment(p, "ticketId", NUMERIC_ID)}/comments.json`,
      { ticketId: NUMERIC_ID, ...pageFields }, page("page[size]", "page[after]")),
    update_ticket: action("Update a ticket's status or priority after approval", { ticketId: NUMERIC_ID, status: optional(choice(["new", "open", "pending", "hold", "solved"])), priority: optional(choice(["low", "normal", "high", "urgent"])) },
      { method: "PUT", url: p => `/api/v2/tickets/${segment(p, "ticketId", NUMERIC_ID)}.json`, mapBody: p => ({ ticket: { ...(p.status ? { status: p.status } : {}), ...(p.priority ? { priority: p.priority } : {}) } }) }, "write",
      strictFields({ ticketId: NUMERIC_ID, status: optional(choice(["new", "open", "pending", "hold", "solved"])), priority: optional(choice(["low", "normal", "high", "urgent"])) }).refine(p => p.status !== undefined || p.priority !== undefined)),
  }),
  intercom: service("intercom", "Intercom", "communication", {
    list_contacts: get("Read one page of contacts", `${intercom}/contacts`, pageFields, page("per_page", "starting_after"), intercomHeaders),
    get_contact: get("Read one contact", p => `${intercom}/contacts/${segment(p, "contactId")}`, { contactId: ID }, undefined, intercomHeaders),
    list_conversations: get("Read one page of conversations", `${intercom}/conversations`, pageFields, page("per_page", "starting_after"), intercomHeaders),
    get_conversation: get("Read a conversation including its available messages", p => `${intercom}/conversations/${segment(p, "conversationId", NUMERIC_ID)}`, { conversationId: NUMERIC_ID }, undefined, intercomHeaders),
  }),
};
