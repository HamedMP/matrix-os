import { z } from "zod/v4";

/**
 * Curated vendor-hosted remote MCP servers that a user can connect to Matrix in
 * one click. A catalog entry only pre-fills the Custom MCP create flow; tools
 * are always discovered live and governed by the saved tool policy. Any other
 * HTTPS MCP URL remains connectable without an entry. See spec 2691.
 *
 * Ranking: `demandRank` orders the top twenty by monthly search demand
 * (Ahrefs, March 2026, via mcpmanager.ai), after removing local-only servers
 * (Playwright, Serena, filesystem, Docker, databases) that Matrix covers
 * natively. Endpoints and auth were probed on `verifiedAt`; re-run
 * `bun run mcp-catalog:verify` to detect drift.
 */

export const REMOTE_MCP_DEPARTMENTS = [
  "engineering", "product", "design", "sales", "marketing", "support", "operations", "finance",
] as const;
export type RemoteMcpDepartment = typeof REMOTE_MCP_DEPARTMENTS[number];

/**
 * - `oauth_dcr`: the vendor supports OAuth Dynamic Client Registration, so any
 *   Matrix instance can connect without vendor-side setup.
 * - `oauth_registered_client`: the vendor requires a pre-registered OAuth app
 *   (Matrix-owned or organization-provided client id/secret).
 * - `none`: no authentication is required; an optional API key may raise limits.
 */
export type RemoteMcpAuth = "oauth_dcr" | "oauth_registered_client" | "none";

/**
 * Pinned OAuth endpoints for a Matrix-owned vendor app. The broker never reads
 * vendor-advertised metadata for these entries, so a hostile
 * `resource_metadata` cannot redirect the code exchange or the client secret.
 * Values were checked against the vendor's live metadata on `verifiedAt`.
 */
export interface RemoteMcpRegisteredOAuth {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  /** RFC 8707 resource the token is requested for (the live protected-resource id). */
  resource: string;
  /** Minimum scopes Matrix requests; the vendor app may grant fewer. */
  scopes: readonly string[];
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
}

export interface RemoteMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  departments: readonly RemoteMcpDepartment[];
  url: string;
  auth: RemoteMcpAuth;
  /** 1-20 for the top tier; absent for the extended tier. */
  demandRank?: number;
  verifiedAt: string;
  notes?: string;
  /** Required for connectable `oauth_registered_client` entries; absent otherwise. */
  registeredOAuth?: RemoteMcpRegisteredOAuth;
  /** Kept in the contract but hidden from the connect flow (spec 2691: Google Workspace). */
  deferred?: true;
}

const SAFE_ID = /^[a-z][a-z0-9_]{1,39}$/;

export const RemoteMcpCatalogEntrySchema = z.strictObject({
  id: z.string().regex(SAFE_ID),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(120),
  category: z.string().regex(/^[a-z][a-z_]{1,29}$/),
  departments: z.array(z.enum(REMOTE_MCP_DEPARTMENTS)).min(1).max(REMOTE_MCP_DEPARTMENTS.length),
  url: z.url({ protocol: /^https$/ }).max(512),
  auth: z.enum(["oauth_dcr", "oauth_registered_client", "none"]),
  demandRank: z.number().int().min(1).max(20).optional(),
  verifiedAt: z.iso.date(),
  notes: z.string().max(240).optional(),
  registeredOAuth: z.strictObject({
    authorizationEndpoint: z.url({ protocol: /^https$/ }).max(512),
    tokenEndpoint: z.url({ protocol: /^https$/ }).max(512),
    revocationEndpoint: z.url({ protocol: /^https$/ }).max(512).optional(),
    resource: z.url({ protocol: /^https$/ }).max(512),
    scopes: z.array(z.string().regex(/^[\x21-\x7e]{1,128}$/)).max(20),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]),
  }).optional(),
  deferred: z.literal(true).optional(),
});

const VERIFIED = "2026-11-11";

const entries: RemoteMcpCatalogEntry[] = [
  // Top 20, ordered by search demand.
  { id: "figma", name: "Figma", description: "Read design files, components, and variables", category: "design", departments: ["design", "engineering", "product"], url: "https://mcp.figma.com/mcp", auth: "oauth_dcr", demandRank: 1, verifiedAt: VERIFIED },
  { id: "github", name: "GitHub", description: "Manage repos, issues, pull requests, and Actions", category: "developer", departments: ["engineering"], url: "https://api.githubcopilot.com/mcp/", auth: "oauth_registered_client", demandRank: 2, verifiedAt: VERIFIED, notes: "GitHub OAuth has no dynamic client registration; uses the Matrix-owned GitHub OAuth app.", registeredOAuth: { authorizationEndpoint: "https://github.com/login/oauth/authorize", tokenEndpoint: "https://github.com/login/oauth/access_token", resource: "https://api.githubcopilot.com/mcp/", scopes: ["repo", "read:org", "read:user"], tokenEndpointAuthMethod: "client_secret_post" } },
  { id: "atlassian", name: "Atlassian (Jira, Confluence)", description: "Search and update Jira issues and Confluence pages", category: "project_management", departments: ["engineering", "product", "operations"], url: "https://mcp.atlassian.com/v1/mcp", auth: "oauth_dcr", demandRank: 3, verifiedAt: VERIFIED },
  { id: "context7", name: "Context7", description: "Look up current library and API documentation", category: "developer", departments: ["engineering"], url: "https://mcp.context7.com/mcp", auth: "none", demandRank: 4, verifiedAt: VERIFIED, notes: "An optional API key header raises rate limits." },
  { id: "supabase", name: "Supabase", description: "Manage Supabase projects, databases, and functions", category: "developer", departments: ["engineering"], url: "https://mcp.supabase.com/mcp", auth: "oauth_dcr", demandRank: 5, verifiedAt: VERIFIED },
  { id: "notion", name: "Notion", description: "Search, read, and update workspace pages and databases", category: "knowledge", departments: ["product", "operations", "marketing", "engineering"], url: "https://mcp.notion.com/mcp", auth: "oauth_dcr", demandRank: 6, verifiedAt: VERIFIED },
  { id: "slack", name: "Slack", description: "Search messages and channels, and post replies", category: "communication", departments: ["engineering", "sales", "marketing", "support", "operations"], url: "https://mcp.slack.com/mcp", auth: "oauth_registered_client", demandRank: 7, verifiedAt: VERIFIED, notes: "Slack requires a registered Slack app client.", registeredOAuth: { authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize", tokenEndpoint: "https://slack.com/api/oauth.v2.user.access", resource: "https://mcp.slack.com", scopes: ["search:read.public", "channels:read", "channels:history", "users:read", "chat:write"], tokenEndpointAuthMethod: "client_secret_post" } },
  { id: "zapier", name: "Zapier", description: "Run actions across thousands of connected apps", category: "automation", departments: ["operations", "marketing", "sales"], url: "https://mcp.zapier.com/api/mcp/mcp", auth: "oauth_dcr", demandRank: 8, verifiedAt: VERIFIED, notes: "Long-tail fallback for apps without their own MCP." },
  { id: "linear", name: "Linear", description: "Manage issues, projects, and team workflows", category: "project_management", departments: ["engineering", "product"], url: "https://mcp.linear.app/mcp", auth: "oauth_dcr", demandRank: 9, verifiedAt: VERIFIED },
  { id: "gitlab", name: "GitLab", description: "Manage GitLab projects, issues, and merge requests", category: "developer", departments: ["engineering"], url: "https://gitlab.com/api/v4/mcp", auth: "oauth_dcr", demandRank: 10, verifiedAt: VERIFIED, notes: "Self-managed GitLab uses its own instance URL." },
  { id: "datadog", name: "Datadog", description: "Query logs, metrics, monitors, and incidents", category: "observability", departments: ["engineering"], url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp", auth: "oauth_dcr", demandRank: 11, verifiedAt: VERIFIED, notes: "US1 site; other Datadog sites use their own host." },
  { id: "google_drive", name: "Google Drive", description: "Search, read, and organize Drive files", category: "knowledge", departments: ["operations", "sales", "marketing", "finance", "product"], url: "https://drivemcp.googleapis.com/mcp/v1", auth: "oauth_registered_client", demandRank: 12, verifiedAt: VERIFIED, notes: "Tool listing is anonymous; calls need a Google OAuth token from a registered Google Cloud client.", deferred: true },
  { id: "stripe", name: "Stripe", description: "Read customers, payments, and subscriptions", category: "finance", departments: ["finance", "operations", "engineering"], url: "https://mcp.stripe.com", auth: "oauth_dcr", demandRank: 13, verifiedAt: VERIFIED },
  { id: "gmail", name: "Gmail", description: "Search, read, and draft email", category: "communication", departments: ["sales", "marketing", "support", "operations"], url: "https://gmailmcp.googleapis.com/mcp/v1", auth: "oauth_registered_client", demandRank: 14, verifiedAt: VERIFIED, notes: "Calls need a Google OAuth token from a registered Google Cloud client.", deferred: true },
  { id: "sentry", name: "Sentry", description: "Investigate errors, issues, and releases", category: "observability", departments: ["engineering"], url: "https://mcp.sentry.dev/mcp", auth: "oauth_dcr", demandRank: 15, verifiedAt: VERIFIED },
  { id: "hubspot", name: "HubSpot", description: "Read and update contacts, companies, and deals", category: "crm", departments: ["sales", "marketing", "support"], url: "https://mcp.hubspot.com/", auth: "oauth_registered_client", demandRank: 16, verifiedAt: VERIFIED, notes: "HubSpot requires a registered MCP auth app.", registeredOAuth: { authorizationEndpoint: "https://mcp.hubspot.com/oauth/authorize/user", tokenEndpoint: "https://mcp.hubspot.com/oauth/v3/token", resource: "https://mcp.hubspot.com", scopes: [], tokenEndpointAuthMethod: "client_secret_post" } },
  { id: "google_calendar", name: "Google Calendar", description: "Read calendars and schedule events", category: "productivity", departments: ["sales", "operations", "support", "product"], url: "https://calendarmcp.googleapis.com/mcp/v1", auth: "oauth_registered_client", demandRank: 17, verifiedAt: VERIFIED, notes: "Calls need a Google OAuth token from a registered Google Cloud client.", deferred: true },
  { id: "vercel", name: "Vercel", description: "Inspect projects, deployments, and logs", category: "developer", departments: ["engineering"], url: "https://mcp.vercel.com", auth: "oauth_dcr", demandRank: 18, verifiedAt: VERIFIED },
  { id: "asana", name: "Asana", description: "Read and update projects and tasks", category: "project_management", departments: ["operations", "marketing", "product"], url: "https://mcp.asana.com/v2/mcp", auth: "oauth_registered_client", demandRank: 19, verifiedAt: VERIFIED, notes: "Asana MCP v2 requires a registered Asana OAuth app.", registeredOAuth: { authorizationEndpoint: "https://app.asana.com/-/oauth_authorize", tokenEndpoint: "https://app.asana.com/-/oauth_token", revocationEndpoint: "https://app.asana.com/-/oauth_revoke", resource: "https://mcp.asana.com/v2/mcp", scopes: ["default"], tokenEndpointAuthMethod: "client_secret_basic" } },
  { id: "cloudflare", name: "Cloudflare", description: "Manage Workers, storage, and account bindings", category: "developer", departments: ["engineering"], url: "https://bindings.mcp.cloudflare.com/mcp", auth: "oauth_dcr", demandRank: 20, verifiedAt: VERIFIED },

  // Extended tier: requested by the team, already used by Matrix, or strong department fit.
  { id: "lemlist", name: "lemlist", description: "Manage outreach campaigns, leads, and performance", category: "sales", departments: ["sales", "marketing"], url: "https://app.lemlist.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "posthog", name: "PostHog", description: "Explore product analytics, insights, and flags", category: "analytics", departments: ["product", "engineering", "marketing"], url: "https://mcp.posthog.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "granola", name: "Granola", description: "Read meeting notes and transcripts", category: "productivity", departments: ["sales", "product", "operations"], url: "https://mcp.granola.ai/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "intercom", name: "Intercom", description: "Read conversations, contacts, and help articles", category: "support", departments: ["support", "sales"], url: "https://mcp.intercom.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "apollo", name: "Apollo.io", description: "Search prospects and enrich contacts and companies", category: "sales", departments: ["sales", "marketing"], url: "https://mcp.apollo.io/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "attio", name: "Attio", description: "Read and update CRM records and lists", category: "crm", departments: ["sales", "operations"], url: "https://mcp.attio.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "canva", name: "Canva", description: "Create and edit designs and brand assets", category: "design", departments: ["marketing", "design"], url: "https://mcp.canva.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "webflow", name: "Webflow", description: "Manage sites, pages, and CMS collections", category: "marketing", departments: ["marketing", "design"], url: "https://mcp.webflow.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "airtable", name: "Airtable", description: "Read and update bases, tables, and records", category: "knowledge", departments: ["operations", "marketing"], url: "https://mcp.airtable.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "clickup", name: "ClickUp", description: "Read and update workspaces and tasks", category: "project_management", departments: ["operations", "product"], url: "https://mcp.clickup.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "monday", name: "monday.com", description: "Read and update boards and items", category: "project_management", departments: ["operations", "marketing"], url: "https://mcp.monday.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
  { id: "box", name: "Box", description: "Search and read files and folders", category: "knowledge", departments: ["operations", "finance"], url: "https://mcp.box.com", auth: "oauth_registered_client", verifiedAt: VERIFIED, registeredOAuth: { authorizationEndpoint: "https://account.box.com/api/oauth2/authorize", tokenEndpoint: "https://api.box.com/oauth2/token", revocationEndpoint: "https://api.box.com/oauth2/revoke", resource: "https://mcp.box.com/", scopes: [], tokenEndpointAuthMethod: "client_secret_basic" } },
  { id: "paypal", name: "PayPal", description: "Read invoices, orders, and transactions", category: "finance", departments: ["finance"], url: "https://mcp.paypal.com/mcp", auth: "oauth_dcr", verifiedAt: VERIFIED },
];

export const REMOTE_MCP_CATALOG: readonly Readonly<RemoteMcpCatalogEntry>[] = Object.freeze(
  entries.map(entry => Object.freeze({
    ...entry,
    departments: Object.freeze([...entry.departments]),
    ...(entry.registeredOAuth ? { registeredOAuth: Object.freeze({ ...entry.registeredOAuth, scopes: Object.freeze([...entry.registeredOAuth.scopes]) }) } : {}),
  })),
);

const byId = new Map(REMOTE_MCP_CATALOG.map(entry => [entry.id, entry]));
const byUrl = new Map(REMOTE_MCP_CATALOG.map(entry => [new URL(entry.url).href, entry]));

export function remoteMcpCatalogEntry(id: string): Readonly<RemoteMcpCatalogEntry> | undefined {
  return byId.get(id);
}

export function remoteMcpCatalogTop(): readonly Readonly<RemoteMcpCatalogEntry>[] {
  return REMOTE_MCP_CATALOG
    .filter(entry => entry.demandRank !== undefined)
    .sort((a, b) => a.demandRank! - b.demandRank!);
}

export function needsRegisteredOAuthClient(entry: Pick<RemoteMcpCatalogEntry, "auth">): boolean {
  return entry.auth === "oauth_registered_client";
}

/** Exact (normalized) endpoint match; used to apply a preset's pinned OAuth to a pasted URL. */
export function remoteMcpCatalogEntryForUrl(url: string): Readonly<RemoteMcpCatalogEntry> | undefined {
  try {
    return byUrl.get(new URL(url).href);
  } catch (error: unknown) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/**
 * Whether the connect flow may offer an entry: deferred entries never, and a
 * registered-client entry only when its Matrix-owned OAuth app is configured.
 */
export function isRemoteMcpCatalogEntryConnectable(
  entry: Pick<RemoteMcpCatalogEntry, "id" | "auth" | "deferred" | "registeredOAuth">,
  hasRegisteredClient: (id: string) => boolean,
): boolean {
  if (entry.deferred) return false;
  if (entry.auth !== "oauth_registered_client") return true;
  return entry.registeredOAuth !== undefined && hasRegisteredClient(entry.id);
}
