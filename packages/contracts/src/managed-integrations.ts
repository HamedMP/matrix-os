import { z } from "zod/v4";

const id = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const team = { teamId: id.optional() };
const project = { projectId: z.number().int().positive().optional() };
export interface ManagedAction {
  description: string;
  tools: readonly string[];
  schema: z.ZodType<Record<string, unknown>>;
  params: Record<string, { type: "string" | "number"; required?: boolean }>;
  aliases?: Record<string, readonly string[]>;
  fixed?: Record<string, unknown>;
}
export interface ManagedIntegration {
  id: string; name: string; url: string; category: string; scopes?: readonly string[];
  actions: Record<string, ManagedAction>;
}
const none = z.strictObject({});
export const MANAGED_INTEGRATIONS: Readonly<Record<string, ManagedIntegration>> = {
  posthog_oauth: { id: "posthog_oauth", name: "PostHog", category: "analytics",
    // Server-side filtering keeps the discovered catalog within the MCP client cap.
    url: "https://mcp.posthog.com/mcp?tools=projects-get,project-get,insights-list,insight-get",
    scopes: ["project:read", "organization:read", "insight:read"],
    actions: {
      list_projects: { description: "List authorized projects", tools: ["projects-get"], schema: none, params: {} },
      get_project: { description: "Read project details", tools: ["project-get"], schema: z.strictObject(project), params: { projectId: { type: "number" } }, aliases: { projectId: ["projectId", "project_id", "id"] } },
      list_insights: { description: "Read saved analytics insights", tools: ["insights-list"], schema: z.strictObject(project), params: { projectId: { type: "number" } }, aliases: { projectId: ["projectId", "project_id"] } },
      get_insight: { description: "Read a saved insight", tools: ["insight-get"], schema: z.strictObject({ insightId: id, ...project }), params: { insightId: { type: "string", required: true }, projectId: { type: "number" } }, aliases: { insightId: ["insightId", "insight_id", "id"], projectId: ["projectId", "project_id"] } },
    },
  },
  loops: { id: "loops", name: "Loops", category: "communication", url: "https://mcp.loops.so/", scopes: ["mcp"],
    actions: {
      list_teams: { description: "List email workspaces", tools: ["teams"], schema: none, params: {} },
      list_mailing_lists: { description: "Read mailing lists", tools: ["execute"], schema: z.strictObject(team), params: { teamId: { type: "string" } }, aliases: { teamId: ["team", "teamId", "team_id"] }, fixed: { method: "GET", path: "/v1/lists" } },
      list_transactional: { description: "Read transactional email templates", tools: ["execute"], schema: z.strictObject(team), params: { teamId: { type: "string" } }, aliases: { teamId: ["team", "teamId", "team_id"] }, fixed: { method: "GET", path: "/v1/transactional" } },
      find_contact: { description: "Find an email contact", tools: ["execute"], schema: z.strictObject({ email: z.email().max(254), ...team }), params: { email: { type: "string", required: true }, teamId: { type: "string" } }, aliases: { teamId: ["team", "teamId", "team_id"] }, fixed: { method: "GET", path: "/v1/contacts/find" } },
    },
  },
  lemlist: { id: "lemlist", name: "lemlist", category: "sales", url: "https://app.lemlist.com/mcp",
    actions: {
      list_campaigns: { description: "Read outreach campaigns", tools: ["get_campaigns", "list_campaigns"], schema: none, params: {} },
      get_campaign: { description: "Read campaign details", tools: ["get_campaign_details"], schema: z.strictObject({ campaignId: id }), params: { campaignId: { type: "string", required: true } }, aliases: { campaignId: ["campaignId", "campaign_id", "id"] } },
      get_sequence: { description: "Read campaign email steps", tools: ["get_campaign_sequences", "get_campaign_sequence"], schema: z.strictObject({ campaignId: id }), params: { campaignId: { type: "string", required: true } }, aliases: { campaignId: ["campaignId", "campaign_id", "id"] } },
      get_campaign_stats: { description: "Read campaign performance", tools: ["get_campaign_stats"], schema: z.strictObject({ campaignId: id }), params: { campaignId: { type: "string", required: true } }, aliases: { campaignId: ["campaignId", "campaign_id", "id"] } },
      get_settings: { description: "Read workspace settings", tools: ["get_settings"], schema: none, params: {} },
    },
  },
};
