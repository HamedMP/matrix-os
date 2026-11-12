/**
 * Composition for org governance of Matrix Core MCP inside the platform
 * process. Without the organization projection no actor can be in org
 * context, so there is no org policy and the admin routes answer 503.
 */
import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { PlatformOrganizations } from "../organizations/wiring.js";
import { bootstrapOrgMcpDatabase, createOrgMcpRepository, type OrgMcpDatabase } from "./database.js";
import { createOrgMcpPolicy, type OrgMcpPolicy } from "./policy.js";
import { createOrgMcpAdminRoutes } from "./routes.js";

export async function createPlatformOrgMcp(options: {
  db: Kysely<OrgMcpDatabase>;
  organizations?: Pick<PlatformOrganizations, "repository" | "projection">;
  connectionsAvailable: boolean;
  resolveActor(c: Context): Promise<string | null>;
}): Promise<{ policy?: OrgMcpPolicy; routes: Hono }> {
  if (!options.organizations) {
    console.warn("[org-mcp] organization projection unavailable: org MCP governance is off");
    return { routes: createOrgMcpAdminRoutes({ connectionsAvailable: false, resolveActor: options.resolveActor }) };
  }
  await bootstrapOrgMcpDatabase(options.db);
  const repository = createOrgMcpRepository(options.db);
  return {
    policy: createOrgMcpPolicy(repository),
    routes: createOrgMcpAdminRoutes({
      repository,
      organizations: options.organizations,
      connectionsAvailable: options.connectionsAvailable,
      resolveActor: options.resolveActor,
    }),
  };
}
