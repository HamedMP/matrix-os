import { z } from "zod/v4";
import { CollaborationOrganizationIdSchema } from "#collaboration-identity";
import { REMOTE_MCP_CATALOG } from "#remote-mcp-catalog";

/**
 * Organization governance of Matrix Core MCP servers (spec 2691, layer 5).
 *
 * A server definition is keyed by a catalog id (`linear`) or a normalized
 * hostname (`mcp.linear.app`). The two shapes cannot collide: catalog ids
 * never contain a dot and hostnames always do. A catalog-id definition also
 * governs any connection whose host is that entry's host, so a pasted URL
 * variant cannot step around an org block.
 */
const CATALOG_ID = /^[a-z][a-z0-9_]{1,39}$/;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const OrgMcpServerDefIdSchema = z.string().min(2).max(253)
  .refine(value => CATALOG_ID.test(value) || HOSTNAME.test(value), "Invalid server definition id");
export type OrgMcpServerDefId = z.infer<typeof OrgMcpServerDefIdSchema>;

export const ORG_MCP_SERVER_MODES = ["allow", "block", "recommend"] as const;
export const OrgMcpServerModeSchema = z.enum(ORG_MCP_SERVER_MODES);
export type OrgMcpServerMode = z.infer<typeof OrgMcpServerModeSchema>;
export const OrgMcpToolPolicySchema = z.enum(["allow", "blocked"]);
export type OrgMcpToolPolicy = z.infer<typeof OrgMcpToolPolicySchema>;
export const ORG_MCP_MAX_TOOL_OVERRIDES = 200;
/** Per member and organization; enforced when a block is written and by the connections response. */
export const ORG_MCP_MAX_MEMBER_BLOCKS = 500;
const ToolNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:/-]+$/);

/**
 * Partial update: omitted fields keep their saved values, so a mode change can
 * never reset a tool policy. A new definition needs `mode`; its omitted tool
 * fields start at "allow" with no overrides (nothing was saved to keep).
 */
export const OrgMcpServerPolicyInputSchema = z.object({
  mode: OrgMcpServerModeSchema.optional(),
  /** Applies to every tool without an override. `blocked` turns the server into a tool allowlist. */
  defaultToolPolicy: OrgMcpToolPolicySchema.optional(),
  toolOverrides: z.record(ToolNameSchema, OrgMcpToolPolicySchema)
    .refine(value => Object.keys(value).length <= ORG_MCP_MAX_TOOL_OVERRIDES, "Too many tool overrides")
    .optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Nothing to update");
export type OrgMcpServerPolicyInput = z.infer<typeof OrgMcpServerPolicyInputSchema>;

export const OrgMcpServerDefinitionSchema = z.object({
  serverDefId: OrgMcpServerDefIdSchema,
  mode: OrgMcpServerModeSchema,
  defaultToolPolicy: OrgMcpToolPolicySchema,
  toolOverrides: z.record(ToolNameSchema, OrgMcpToolPolicySchema),
  updatedAt: z.iso.datetime(),
}).strict();
export type OrgMcpServerDefinition = z.infer<typeof OrgMcpServerDefinitionSchema>;

const ActorIdSchema = z.string().regex(/^user_[A-Za-z0-9_-]{1,123}$/);
export const OrgMcpMemberIdSchema = ActorIdSchema;

export const OrgMcpConnectionStatusSchema = z.enum(["pending", "auth_required", "ready", "degraded", "disabled", "action_required"]);

/** Metadata only: never a URL path or query, a credential, a tool argument, or a result. */
export const OrgMcpMemberConnectionSchema = z.object({
  connectionId: z.uuid(),
  name: z.string().min(1).max(200),
  host: z.string().min(1).max(253),
  serverDefIds: z.array(OrgMcpServerDefIdSchema).max(8),
  status: OrgMcpConnectionStatusSchema,
  enabled: z.boolean(),
  connectedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
}).strict();
export type OrgMcpMemberConnection = z.infer<typeof OrgMcpMemberConnectionSchema>;

export const OrgMcpMemberSchema = z.object({
  actorId: ActorIdSchema,
  displayName: z.string().min(1).max(200),
  emailAddress: z.email().max(320).optional(),
  connections: z.array(OrgMcpMemberConnectionSchema).max(100),
  blockedServerDefIds: z.array(OrgMcpServerDefIdSchema).max(ORG_MCP_MAX_MEMBER_BLOCKS),
}).strict();
export type OrgMcpMember = z.infer<typeof OrgMcpMemberSchema>;

export const ORG_MCP_CONNECTIONS_PAGE_LIMIT = 50;
export const OrgMcpCursorSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const OrgMcpConnectionsPageSchema = z.object({
  members: z.array(OrgMcpMemberSchema).max(ORG_MCP_CONNECTIONS_PAGE_LIMIT),
  servers: z.array(OrgMcpServerDefinitionSchema).max(500),
  nextCursor: OrgMcpCursorSchema.optional(),
}).strict();
export type OrgMcpConnectionsPage = z.infer<typeof OrgMcpConnectionsPageSchema>;

export const ORG_MCP_USAGE_MAX_DAYS = 400;
export const ORG_MCP_USAGE_MAX_ROWS = 5_000;
const IsoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid date");

export const OrgMcpUsageQuerySchema = z.object({
  from: IsoDaySchema,
  to: IsoDaySchema,
  memberId: ActorIdSchema.optional(),
}).strict().refine(value => value.from <= value.to, "from must not be after to")
  .refine(value => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 < ORG_MCP_USAGE_MAX_DAYS, "Date range too large");
export type OrgMcpUsageQuery = z.infer<typeof OrgMcpUsageQuerySchema>;

export const OrgMcpUsageRowSchema = z.object({
  day: IsoDaySchema,
  actorId: ActorIdSchema,
  serverKey: z.string().min(1).max(128),
  toolName: z.string().min(1).max(128),
  calls: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
}).strict();
export type OrgMcpUsageRow = z.infer<typeof OrgMcpUsageRowSchema>;

export const OrgMcpUsageResponseSchema = z.object({
  rows: z.array(OrgMcpUsageRowSchema).max(ORG_MCP_USAGE_MAX_ROWS),
  truncated: z.boolean(),
  /** When these totals were read; they include calls not yet in the hourly rollup. */
  updatedAt: z.iso.datetime(),
}).strict();
export type OrgMcpUsageResponse = z.infer<typeof OrgMcpUsageResponseSchema>;

export const OrgMcpMutationResultSchema = z.object({ ok: z.literal(true) }).strict();
export const OrgMcpOrganizationIdSchema = CollaborationOrganizationIdSchema;

function normalizedHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return HOSTNAME.test(host) ? host : null;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

const catalogIdsByHost = new Map<string, string[]>();
for (const entry of REMOTE_MCP_CATALOG) {
  const host = normalizedHost(entry.url);
  if (!host) continue;
  catalogIdsByHost.set(host, [...(catalogIdsByHost.get(host) ?? []), entry.id]);
}

/** Every server definition id that governs a connection to `url`: its host plus any catalog entry on that host. */
export function orgMcpServerDefIdsForUrl(url: string): { host: string | null; serverDefIds: string[] } {
  const host = normalizedHost(url);
  if (!host) return { host: null, serverDefIds: [] };
  return { host, serverDefIds: [host, ...(catalogIdsByHost.get(host) ?? [])] };
}
