import { z } from "zod/v4";
import type { ServiceAction, DirectApi } from "./types.js";
import { type CatalogField, text, integer, optional, strictFields, UUID, CURSOR, choice } from "./catalog-fields.js";

const object = (schema: z.ZodType, description?: string): CatalogField => ({ schema, param: { type: "object", required: true, ...(description ? { description } : {}) } });
function action(description: string, risk: "read" | "write", fields: Record<string, CatalogField>, directApi: DirectApi): ServiceAction {
  return { description, risk, params: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.param])), paramsSchema: strictFields(fields), directApi };
}
const id = integer(1, Number.MAX_SAFE_INTEGER);
const limit = optional(integer(1, 100));
const projectKey = text(32, /^[A-Z][A-Z0-9_]*$/);
const issueKey = text(64, /^[A-Z][A-Z0-9_]*-[1-9]\d*$/);
// Deliberately bounded ADF subset: plain paragraph/text documents, no links,
// embedded media, arbitrary JSON or extension nodes.
const document = object(z.strictObject({ type: z.literal("doc"), version: z.literal(1), content: z.array(z.strictObject({
  type: z.literal("paragraph"), content: z.array(z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(4096) })).min(1).max(20),
})).min(1).max(20) }).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024), "Atlassian document: version 1, plain paragraphs and text only, at most 32 KiB");
const cloud = { cloudId: { ...UUID, param: { ...UUID.param, description: "Site ID from list_sites; verified against this connection before each action" } } };
const jiraBase = (p: Record<string, unknown>) => `https://api.atlassian.com/ex/jira/${encodeURIComponent(String(p.cloudId))}/rest/api/3`;
const fieldsQuery = "summary,status,issuetype,project,description,updated";

/** Contracts: Atlassian OAuth 3LO accessible-resources and Jira REST v3
 * project/search, search/jql, issue and issue/{issueIdOrKey}/comment.
 * https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
 * https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
 * Never use a caller-provided site URL; execution preflights cloudId first.
 */
export const JIRA_ACTIONS: Record<string, ServiceAction> = {
  list_sites: action("List Jira sites available to this exact connection", "read", {}, { method: "GET", url: "https://api.atlassian.com/oauth/token/accessible-resources" }),
  list_projects: action("List a page of Jira projects in an authorized site", "read", { ...cloud, maxResults: limit, startAt: optional(integer(0, 100_000)) }, {
    method: "GET", url: p => `${jiraBase(p)}/project/search`, mapParams: p => ({ maxResults: String(p.maxResults ?? 25), startAt: String(p.startAt ?? 0) }),
  }),
  search_issues: action("Search a page of Jira issues using enhanced JQL search", "read", { ...cloud, jql: text(4096), maxResults: limit, nextPageToken: CURSOR }, {
    method: "GET", url: p => `${jiraBase(p)}/search/jql`, mapParams: p => ({ jql: String(p.jql), maxResults: String(p.maxResults ?? 25), fields: fieldsQuery, ...(p.nextPageToken ? { nextPageToken: String(p.nextPageToken) } : {}) }),
  }),
  get_issue: action("Get a Jira issue in an authorized site", "read", { ...cloud, issueKey }, {
    method: "GET", url: p => `${jiraBase(p)}/issue/${encodeURIComponent(String(p.issueKey))}`, mapParams: () => ({ fields: fieldsQuery }),
  }),
  create_issue: action("Create a Jira issue in an authorized site", "write", { ...cloud, projectKey, issueType: text(100), summary: text(255), description: optional(document) }, {
    method: "POST", url: p => `${jiraBase(p)}/issue`, mapBody: p => ({ fields: { project: { key: p.projectKey }, issuetype: { name: p.issueType }, summary: p.summary, ...(p.description ? { description: p.description } : {}) } }),
  }),
  update_issue: action("Update a Jira issue's summary, plain-text description or labels", "write", { ...cloud, issueKey,
    fields: object(z.strictObject({ summary: z.string().min(1).max(255).optional(), description: document.schema.optional(), labels: z.array(z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/)).max(20).optional() }).refine(value => Object.keys(value).length > 0)),
  }, { method: "PUT", url: p => `${jiraBase(p)}/issue/${encodeURIComponent(String(p.issueKey))}`, mapBody: p => ({ fields: p.fields }) }),
  add_comment: action("Add a plain-text Jira issue comment after approval", "write", { ...cloud, issueKey, body: document }, {
    method: "POST", url: p => `${jiraBase(p)}/issue/${encodeURIComponent(String(p.issueKey))}/comment`, mapBody: p => ({ body: p.body }),
  }),
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const parsed = new Date(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; });
// Select a constrained trends query rather than accepting executable arbitrary
// query trees. This remains read-only even though the query endpoint uses POST.
const trends = z.strictObject({ kind: z.literal("TrendsQuery"), dateRange: z.strictObject({ date_from: day, date_to: day }),
  interval: z.enum(["day", "week", "month"]).optional(),
  series: z.array(z.strictObject({ kind: z.literal("EventsNode"), event: z.string().min(1).max(200), math: z.enum(["total", "dau"]).optional() })).min(1).max(5),
}).refine(value => { const elapsed = Date.parse(value.dateRange.date_to) - Date.parse(value.dateRange.date_from); return elapsed >= 0 && elapsed <= 93 * 86_400_000; });
const query = object(trends, "Bounded TrendsQuery: 1–5 event series, absolute date range of at most 93 days");
const insightQuery = object(z.strictObject({ kind: z.literal("InsightVizNode"), source: trends }),
  'InsightVizNode with source TrendsQuery; no extra fields. source.dateRange requires real YYYY-MM-DD date_from/date_to, ordered and at most 93 days apart. source.series requires 1–5 EventsNode objects, each with event of 1–200 characters and optional math total|dau. Optional source.interval is day|week|month. Example: `{"kind":"InsightVizNode","source":{"kind":"TrendsQuery","dateRange":{"date_from":"2026-10-01","date_to":"2026-10-08"},"interval":"day","series":[{"kind":"EventsNode","event":"$pageview","math":"total"}]}}`');
// Both hosts are official PostHog application API origins and allowed by the
// Pipedream app. Region selection is explicit; keys must match that region.
// No caller URL or arbitrary self-hosted origin is accepted.
const region = { region: { ...choice(["us", "eu"]), param: { type: "string" as const, required: true, description: "Cloud region: us or eu. Must match the connected personal API key." } } };
const posthogOrigin = (p: Record<string, unknown>) => p.region === "eu" ? "https://eu.posthog.com" : "https://us.posthog.com";
const posthogBase = (p: Record<string, unknown>) => `${posthogOrigin(p)}/api/projects/${p.projectId}`;
/** https://posthog.com/docs/api/projects, /insights and /query.
 * Pipedream API key connection must have a personal API key; project ingestion
 * keys cannot read projects or manage insights. No key is copied into Matrix.
 */
export const POSTHOG_ACTIONS: Record<string, ServiceAction> = {
  list_projects: action("List a page of projects using the connected personal API key", "read", { ...region, limit, offset: optional(integer(0, 100_000)) }, { method: "GET", url: p => `${posthogOrigin(p)}/api/projects/`, mapParams: p => ({ limit: String(p.limit ?? 25), offset: String(p.offset ?? 0) }) }),
  list_insights: action("List a page of PostHog insights", "read", { ...region, projectId: id, limit, offset: optional(integer(0, 100_000)) }, { method: "GET", url: p => `${posthogBase(p)}/insights/`, mapParams: p => ({ limit: String(p.limit ?? 25), offset: String(p.offset ?? 0) }) }),
  get_insight: action("Get a PostHog insight", "read", { ...region, projectId: id, insightId: id }, { method: "GET", url: p => `${posthogBase(p)}/insights/${p.insightId}/` }),
  query: action("Run a bounded read-only PostHog event trends query", "read", { ...region, projectId: id, query }, { method: "POST", url: p => `${posthogBase(p)}/query/`, mapBody: p => ({ query: p.query, refresh: "blocking" }) }),
  create_insight: action("Create a PostHog trends insight (requires insight:write)", "write", { ...region, projectId: id, name: text(255), description: optional(text(4096)), query: insightQuery }, {
    method: "POST", url: p => `${posthogBase(p)}/insights/`, mapBody: p => ({ name: p.name, query: p.query, ...(p.description ? { description: p.description } : {}) }),
  }),
  update_insight: action("Update a PostHog insight's name or description (requires insight:write)", "write", { ...region, projectId: id, insightId: id, name: optional(text(255)), description: optional(text(4096)) }, {
    method: "PATCH", url: p => `${posthogBase(p)}/insights/${p.insightId}/`, mapBody: p => ({ ...(p.name ? { name: p.name } : {}), ...(p.description ? { description: p.description } : {}) }),
  }),
};
POSTHOG_ACTIONS.update_insight.paramsSchema = POSTHOG_ACTIONS.update_insight.paramsSchema!.refine(value => {
  const p = value as Record<string, unknown>; return p.name !== undefined || p.description !== undefined;
});

/** Google Drive files.create multipart upload: UTF-8 strings only, at most
 * 8 KiB, no file-system path or remote fetch. Framing is built by executor.
 * https://developers.google.com/workspace/drive/api/guides/manage-uploads
 */
export const DRIVE_UPLOAD_ACTION = action("Upload UTF-8 text to Drive (maximum 8 KiB)", "write", {
  name: text(255, /^[^\x00-\x1f\x7f]+$/),
  content: { schema: z.string().max(8 * 1024).refine(value => Buffer.byteLength(value) <= 8 * 1024), param: { type: "string", required: true, maxLength: 8 * 1024 } },
  mimeType: optional(text(128, /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)),
  folderId: optional(text(256, /^[A-Za-z0-9_-]+$/)),
}, { method: "POST", url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,parents,webViewLink" });
