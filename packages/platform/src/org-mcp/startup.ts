/**
 * Composition for org governance of Matrix Core MCP inside the platform
 * process. The call-time policy depends only on the org-mcp tables and the
 * membership projection tables in platform Postgres, never on collaboration
 * bootstrap: without the live membership projection the policy still runs and
 * refuses governed servers (fail closed). The admin routes need the
 * organizations wiring for role checks and answer 503 without it.
 */
import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import { bootstrapPlatformOrganizationDatabase } from "../organizations/database.js";
import type { PlatformOrganizations } from "../organizations/wiring.js";
import { bootstrapOrgMcpDatabase, createOrgMcpRepository, type OrgMcpDatabase } from "./database.js";
import { createOrgMcpPolicy, type OrgMcpPolicy } from "./policy.js";
import { createOrgMcpAdminRoutes } from "./routes.js";

export async function createPlatformOrgMcp(options: {
  db: Kysely<OrgMcpDatabase>;
  organizations?: Pick<PlatformOrganizations, "repository" | "projection">;
  connectionsAvailable: boolean;
  resolveActor(c: Context): Promise<string | null>;
}): Promise<{ policy: OrgMcpPolicy; routes: Hono }> {
  // Idempotent; the org-mcp tables reference organizations.
  await bootstrapPlatformOrganizationDatabase(options.db);
  await bootstrapOrgMcpDatabase(options.db);
  const repository = createOrgMcpRepository(options.db);
  if (!options.organizations) {
    console.warn("[org-mcp] membership projection unavailable: governed MCP servers are refused until it is configured");
  }
  return {
    policy: createOrgMcpPolicy(repository, { membershipAvailable: Boolean(options.organizations) }),
    routes: createOrgMcpAdminRoutes({
      repository,
      ...(options.organizations ? { organizations: options.organizations } : {}),
      connectionsAvailable: options.connectionsAvailable,
      resolveActor: options.resolveActor,
    }),
  };
}
