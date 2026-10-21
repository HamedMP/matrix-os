import { z } from "zod/v4";

const id = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const team = { teamId: id.optional() };
const project = { projectId: z.number().int().positive().optional() };
export interface ManagedAction {
  description: string;
  risk: "read" | "write";
  requiredScopes?: readonly string[];
  bodyFields?: readonly string[];
  witness?: Record<string, unknown>;
  tools: readonly string[];
  schema: z.ZodType<Record<string, unknown>>;
  params: Record<string, { type: "string" | "number"; required?: boolean }>;
  aliases?: Record<string, readonly string[]>;
  fixed?: Record<string, unknown>;
}
export interface ManagedIntegration {
  id: string; name: string; url: string; category: string; scopes?: readonly string[]; writeScopes?: readonly string[];
  actions: Record<string, ManagedAction>;
}
const none = z.strictObject({});
export const MANAGED_INTEGRATIONS: Readonly<Record<string, ManagedIntegration>> = {
  posthog_oauth: { id: "posthog_oauth", name: "PostHog", category: "analytics",
    // Server-side filtering keeps the discovered catalog within the MCP client cap.
    url: "https://mcp.posthog.com/mcp?tools=projects-get,project-get,insights-list,insight-get,insight-update",
    scopes: ["project:read", "organization:read", "insight:read"], writeScopes: ["insight:write"],
    actions: {
      // Exact flat id/name/description contract: official generated/product_analytics.ts.
      update_insight_metadata: { description: "Update a saved insight's name or description after approval", risk: "write", requiredScopes: ["insight:write"], tools: ["insight-update"],
        schema: z.strictObject({ insightId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/), name: z.string().min(1).max(200).refine(value => value.trim().length > 0).optional(), description: z.string().max(400).optional() }).refine(value => value.name !== undefined || value.description !== undefined),
        params: { insightId: { type: "string", required: true }, name: { type: "string" }, description: { type: "string" } }, aliases: { insightId: ["id"] } },
      list_projects: { description: "List authorized projects", risk: "read", tools: ["projects-get"], schema: none, params: {} },
      get_project: { description: "Read project details", risk: "read", tools: ["project-get"], schema: z.strictObject(project), params: { projectId: { type: "number" } }, aliases: { projectId: ["projectId", "project_id", "id"] } },
      list_insights: { description: "Read saved analytics insights", risk: "read", tools: ["insights-list"], schema: z.strictObject(project), params: { projectId: { type: "number" } }, aliases: { projectId: ["projectId", "project_id"] } },
      get_insight: { description: "Read a saved insight", risk: "read", tools: ["insight-get"], schema: z.strictObject({ insightId: id, ...project }), params: { insightId: { type: "string", required: true }, projectId: { type: "number" } }, aliases: { insightId: ["insightId", "insight_id", "id"], projectId: ["projectId", "project_id"] } },
    },
  },
  loops: { id: "loops", name: "Loops", category: "communication", url: "https://mcp.loops.so/", scopes: ["mcp"],
    actions: {
      // https://loops.so/docs/api-reference/create-contact-property
      create_contact_property: { description: "Create one custom contact property after approval", risk: "write", requiredScopes: ["mcp"], tools: ["execute"],
        schema: z.strictObject({ name: z.string().min(1).max(100).regex(/^[a-z][A-Za-z0-9]*$/), type: z.enum(["string", "number", "boolean", "date"]), ...team }),
        params: { name: { type: "string", required: true }, type: { type: "string", required: true }, teamId: { type: "string" } },
        aliases: { teamId: ["team", "teamId", "team_id"] }, bodyFields: ["name", "type"], witness: { name: "integrationSource", type: "string" }, fixed: { method: "POST", path: "/v1/contacts/properties" } },
      list_teams: { description: "List email workspaces", risk: "read", tools: ["teams"], schema: none, params: {} },
      list_mailing_lists: { description: "Read mailing lists", risk: "read", tools: ["execute"], schema: z.strictObject(team), params: { teamId: { type: "string" } }, aliases: { teamId: ["team", "teamId", "team_id"] }, fixed: { method: "GET", path: "/v1/lists" } },
      list_transactional: { description: "Read transactional email templates", risk: "read", tools: ["execute"], schema: z.strictObject(team), params: { teamId: { type: "string" } }, aliases: { teamId: ["team", "teamId", "team_id"] }, fixed: { method: "GET", path: "/v1/transactional" } },
      find_contact: { description: "Find an email contact", risk: "read", tools: ["execute"], schema: z.strictObject({ email: z.email().max(254), ...team }), params: { email: { type: "string", required: true }, teamId: { type: "string" } }, aliases: { teamId: ["team", "teamId", "team_id"] }, fixed: { method: "GET", path: "/v1/contacts/find" } },
    },
  },
  lemlist: { id: "lemlist", name: "lemlist", category: "sales", url: "https://app.lemlist.com/mcp",
    actions: {
      // Official lemlist MCP create_campaign_with_sequence: omitting subject/body
      // creates an empty sequence. No lead import, sender assignment or launch.
      create_draft_campaign: { description: "Create an empty draft outreach campaign after approval", risk: "write", tools: ["create_campaign_with_sequence"],
        schema: z.strictObject({ name: z.string().min(1).max(200).refine(value => value.trim().length > 0) }), params: { name: { type: "string", required: true } } },
      list_campaigns: { description: "Read outreach campaigns", risk: "read", tools: ["get_campaigns", "list_campaigns"], schema: none, params: {} },
      get_campaign: { description: "Read campaign details", risk: "read", tools: ["get_campaign_details"], schema: z.strictObject({ campaignId: id }), params: { campaignId: { type: "string", required: true } }, aliases: { campaignId: ["campaignId", "campaign_id", "id"] } },
      get_sequence: { description: "Read campaign email steps", risk: "read", tools: ["get_campaign_sequences", "get_campaign_sequence"], schema: z.strictObject({ campaignId: id }), params: { campaignId: { type: "string", required: true } }, aliases: { campaignId: ["campaignId", "campaign_id", "id"] } },
      get_campaign_stats: { description: "Read campaign performance", risk: "read", tools: ["get_campaign_stats"], schema: z.strictObject({ campaignId: id }), params: { campaignId: { type: "string", required: true } }, aliases: { campaignId: ["campaignId", "campaign_id", "id"] } },
      get_settings: { description: "Read workspace settings", risk: "read", tools: ["get_settings"], schema: none, params: {} },
    },
  },
};

/** The encrypted owner grant, never inferred from discovered tools or requested scopes. */
export interface ManagedWriteAuthorization { enabled: boolean; scopes: readonly string[] }
export function canUseManagedAction(action: ManagedAction, authorization?: ManagedWriteAuthorization): boolean {
  return action.risk === "read" || (authorization?.enabled === true
    && (action.requiredScopes ?? []).every(scope => authorization.scopes.includes(scope)));
}
/** Independent dispatch guard, including shared meta-tools that can perform writes. */
export function managedToolWriteRequirements(presetId: string, toolName: string, args?: Record<string, unknown>): { write: boolean; requiredScopes: readonly string[] } {
  const preset = Object.hasOwn(MANAGED_INTEGRATIONS, presetId) ? MANAGED_INTEGRATIONS[presetId] : undefined;
  if (!preset) return { write: false, requiredScopes: [] };
  if (presetId === "loops" && toolName === "execute") return args?.method === "GET"
    ? { write: false, requiredScopes: [] } : { write: true, requiredScopes: ["mcp"] };
  const actions = Object.values(preset.actions).filter(action => action.tools.includes(toolName));
  const writes = actions.filter(action => action.risk === "write");
  return { write: writes.length > 0 || actions.length === 0, requiredScopes: [...new Set(writes.flatMap(action => [...(action.requiredScopes ?? [])]))] };
}
