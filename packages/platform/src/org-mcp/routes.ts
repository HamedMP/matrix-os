/**
 * Organization → Connections admin routes (spec 2691, layer 5).
 *
 * Every route needs a verified session actor who is a current member of the
 * organization with `org:mcp_admin`. Admins see member connection metadata and
 * usage aggregates and can govern servers; they never read, move, or delete a
 * member's credential. A missing dependency is a generic 503, never a 404.
 */
import {
  ORG_MCP_CONNECTIONS_PAGE_LIMIT,
  ORG_MCP_USAGE_MAX_ROWS,
  OrgMcpConnectionsPageSchema,
  OrgMcpCursorSchema,
  OrgMcpMemberIdSchema,
  OrgMcpMutationResultSchema,
  OrgMcpOrganizationIdSchema,
  OrgMcpServerDefIdSchema,
  OrgMcpServerPolicyInputSchema,
  OrgMcpUsageQuerySchema,
  OrgMcpUsageResponseSchema,
  orgMcpServerDefIdsForUrl,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { OrganizationManagementDirectory } from "../organizations/management.js";
import type { OrganizationMembershipProjection } from "../organizations/projection.js";
import type { PlatformOrganizationRepository } from "../organizations/repository.js";
import { ClerkActorIdSchema, hasOrganizationPermission } from "../organizations/roles.js";
import type { OrgMcpRepository } from "./database.js";

const JSON_BODY_LIMIT = 32 * 1024;
const BLOCK_BODY_LIMIT = 64;
const ConnectionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ORG_MCP_CONNECTIONS_PAGE_LIMIT).default(25),
  cursor: OrgMcpCursorSchema.optional(),
}).strict();
const EmptyBodySchema = z.object({}).strict();
const MAX_CONNECTIONS_PER_MEMBER = 100;

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503;

export interface OrgMcpAdminRouteOptions {
  repository?: OrgMcpRepository;
  organizations?: {
    repository: Pick<PlatformOrganizationRepository, "getMembership" | "listMembers">;
    projection: Pick<OrganizationMembershipProjection, "isCurrentMember">;
  };
  /** False when the Custom MCP connection tables are not provisioned on this platform. */
  connectionsAvailable: boolean;
  profiles?: OrganizationManagementDirectory;
  resolveActor(c: Context): Promise<string | null>;
}

function safeJson(c: Context, error: string, status: ErrorStatus) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}

function unavailable(c: Context, action: string, error?: unknown) {
  if (error !== undefined) console.warn(`[org-mcp] ${action} failed`, error instanceof Error ? error.name : "UnknownError");
  return safeJson(c, "Organization connections unavailable", 503);
}

function encodeCursor(actorId: string): string {
  return Buffer.from(actorId, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string | undefined {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  return ClerkActorIdSchema.safeParse(decoded).success ? decoded : undefined;
}

export function createOrgMcpAdminRoutes(options: OrgMcpAdminRouteOptions): Hono {
  const app = new Hono();
  const jsonLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) });
  const blockLimit = bodyLimit({ maxSize: BLOCK_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) });
  const emptyLimit = bodyLimit({ maxSize: 1, onError: (c) => safeJson(c, "Request too large", 413) });

  /** Session actor → validated org → dependencies → current membership → `org:mcp_admin`. */
  async function requireAdmin(c: Context) {
    let actor: unknown;
    try { actor = await options.resolveActor(c); }
    catch (error: unknown) {
      console.warn("[org-mcp] actor authentication failed", error instanceof Error ? error.name : "UnknownError");
      actor = null;
    }
    const actorId = ClerkActorIdSchema.safeParse(actor);
    if (!actorId.success) return safeJson(c, "Unauthorized", 401);
    const organizationId = OrgMcpOrganizationIdSchema.safeParse(c.req.param("orgId"));
    if (!organizationId.success) return safeJson(c, "Invalid request", 422);
    const { repository, organizations } = options;
    if (!repository || !organizations) return unavailable(c, "dependency check");
    try {
      const membership = await organizations.repository.getMembership({ organizationId: organizationId.data, actorId: actorId.data });
      if (!membership || membership.state !== "active"
        || !(await organizations.projection.isCurrentMember({ organizationId: organizationId.data, actorId: actorId.data }))) {
        return safeJson(c, "Organization not found", 404);
      }
      if (!hasOrganizationPermission(membership.role, "org:mcp_admin")) return safeJson(c, "Forbidden", 403);
      return { actorId: actorId.data, organizationId: organizationId.data, repository, organizations };
    } catch (error: unknown) {
      return unavailable(c, "admin authorization", error);
    }
  }

  function serverDefId(c: Context): string | null {
    const parsed = OrgMcpServerDefIdSchema.safeParse(c.req.param("serverDefId"));
    return parsed.success ? parsed.data : null;
  }

  app.get("/api/orgs/:orgId/mcp/connections", async (c) => {
    const admin = await requireAdmin(c);
    if (admin instanceof Response) return admin;
    const query = ConnectionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return safeJson(c, "Invalid request", 422);
    const afterActorId = query.data.cursor ? decodeCursor(query.data.cursor) : undefined;
    if (query.data.cursor && !afterActorId) return safeJson(c, "Invalid request", 422);
    if (!options.connectionsAvailable) return unavailable(c, "connections");
    try {
      const page = await admin.organizations.repository.listMembers(admin.organizationId, {
        limit: query.data.limit, ...(afterActorId ? { afterActorId } : {}),
      });
      const actorIds = page.members.map(member => member.actorId);
      const [connections, blocks, servers, profiles] = await Promise.all([
        admin.repository.listConnections(actorIds),
        admin.repository.listMemberBlocks(admin.organizationId, actorIds),
        admin.repository.listServerDefinitions(admin.organizationId),
        options.profiles ? options.profiles.resolveMemberProfiles(actorIds) : Promise.resolve(new Map()),
      ]);
      const lastUsed = await admin.repository.lastUsedByConnection(admin.organizationId, connections.map(row => row.connectionId));
      const body = OrgMcpConnectionsPageSchema.parse({
        members: page.members.map(member => {
          const profile = profiles.get(member.actorId);
          const email = member.email ?? profile?.emailAddress;
          return {
            actorId: member.actorId,
            displayName: (member.displayName ?? profile?.displayName ?? member.actorId).slice(0, 200),
            ...(email ? { emailAddress: email } : {}),
            connections: connections.filter(row => row.actorId === member.actorId).slice(0, MAX_CONNECTIONS_PER_MEMBER).map(row => {
              const keys = orgMcpServerDefIdsForUrl(row.url);
              return {
                connectionId: row.connectionId,
                name: row.name.slice(0, 200) || "MCP server",
                host: keys.host ?? "unknown",
                serverDefIds: keys.serverDefIds.slice(0, 8),
                status: row.status,
                enabled: row.enabled,
                connectedAt: row.connectedAt.toISOString(),
                lastUsedAt: lastUsed.get(row.connectionId)?.toISOString() ?? null,
              };
            }),
            blockedServerDefIds: blocks.get(member.actorId) ?? [],
          };
        }),
        servers: servers.map(server => ({ ...server, updatedAt: server.updatedAt.toISOString() })),
        ...(page.nextActorId ? { nextCursor: encodeCursor(page.nextActorId) } : {}),
      });
      c.header("Cache-Control", "private, no-store");
      return c.json(body);
    } catch (error: unknown) {
      return unavailable(c, "connections listing", error);
    }
  });

  app.get("/api/orgs/:orgId/mcp/usage", async (c) => {
    const admin = await requireAdmin(c);
    if (admin instanceof Response) return admin;
    const query = OrgMcpUsageQuerySchema.safeParse(c.req.query());
    if (!query.success) return safeJson(c, "Invalid request", 422);
    try {
      const rows = await admin.repository.usageAggregates({
        organizationId: admin.organizationId, from: query.data.from, to: query.data.to,
        ...(query.data.memberId ? { actorId: query.data.memberId } : {}), limit: ORG_MCP_USAGE_MAX_ROWS + 1,
      });
      c.header("Cache-Control", "private, no-store");
      return c.json(OrgMcpUsageResponseSchema.parse({
        rows: rows.slice(0, ORG_MCP_USAGE_MAX_ROWS), truncated: rows.length > ORG_MCP_USAGE_MAX_ROWS,
      }));
    } catch (error: unknown) {
      return unavailable(c, "usage listing", error);
    }
  });

  app.put("/api/orgs/:orgId/mcp/servers/:serverDefId", jsonLimit, async (c) => {
    const admin = await requireAdmin(c);
    if (admin instanceof Response) return admin;
    const id = serverDefId(c);
    const body = await parseJson(c);
    const policy = OrgMcpServerPolicyInputSchema.safeParse(body);
    if (!id || !policy.success) return safeJson(c, "Invalid request", 422);
    try {
      const saved = await admin.repository.putServerDefinition({
        organizationId: admin.organizationId, serverDefId: id, ...policy.data, updatedBy: admin.actorId,
      });
      return saved ? mutationResult(c) : safeJson(c, "Too many governed servers", 409);
    } catch (error: unknown) {
      return unavailable(c, "server policy update", error);
    }
  });

  app.delete("/api/orgs/:orgId/mcp/servers/:serverDefId", emptyLimit, async (c) => {
    const admin = await requireAdmin(c);
    if (admin instanceof Response) return admin;
    const id = serverDefId(c);
    if (!id) return safeJson(c, "Invalid request", 422);
    try {
      await admin.repository.deleteServerDefinition(admin.organizationId, id);
      return mutationResult(c);
    } catch (error: unknown) {
      return unavailable(c, "server policy removal", error);
    }
  });

  app.put("/api/orgs/:orgId/mcp/members/:memberId/blocks/:serverDefId", blockLimit, async (c) => {
    const admin = await requireAdmin(c);
    if (admin instanceof Response) return admin;
    const id = serverDefId(c);
    const memberId = OrgMcpMemberIdSchema.safeParse(c.req.param("memberId"));
    const text = await c.req.text();
    if (!id || !memberId.success || (text.trim() !== "" && !EmptyBodySchema.safeParse(safeParse(text)).success)) {
      return safeJson(c, "Invalid request", 422);
    }
    try {
      const target = await admin.organizations.repository.getMembership({ organizationId: admin.organizationId, actorId: memberId.data });
      if (!target || target.state !== "active") return safeJson(c, "Organization member not found", 404);
      await admin.repository.blockMember({ organizationId: admin.organizationId, actorId: memberId.data, serverDefId: id, createdBy: admin.actorId });
      return mutationResult(c);
    } catch (error: unknown) {
      return unavailable(c, "member block", error);
    }
  });

  app.delete("/api/orgs/:orgId/mcp/members/:memberId/blocks/:serverDefId", emptyLimit, async (c) => {
    const admin = await requireAdmin(c);
    if (admin instanceof Response) return admin;
    const id = serverDefId(c);
    const memberId = OrgMcpMemberIdSchema.safeParse(c.req.param("memberId"));
    if (!id || !memberId.success) return safeJson(c, "Invalid request", 422);
    try {
      await admin.repository.unblockMember({ organizationId: admin.organizationId, actorId: memberId.data, serverDefId: id });
      return mutationResult(c);
    } catch (error: unknown) {
      return unavailable(c, "member unblock", error);
    }
  });

  return app;
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[org-mcp] request parsing failed", error instanceof Error ? error.name : "UnknownError");
    return undefined;
  }
}

async function parseJson(c: Context): Promise<unknown> {
  try { return await c.req.json(); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[org-mcp] request parsing failed", error instanceof Error ? error.name : "UnknownError");
    return undefined;
  }
}

function mutationResult(c: Context) {
  c.header("Cache-Control", "no-store");
  return c.json(OrgMcpMutationResultSchema.parse({ ok: true }));
}
