/**
 * Org context and usage attribution for Matrix Core MCP (spec 2691 layer 5),
 * against the real governance repository on Postgres (PGlite).
 */
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orgMcpServerDefIdsForUrl } from "../../packages/contracts/src/organization-mcp.js";
import { bootstrapPlatformOrganizationDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { hasOrganizationPermission } from "../../packages/platform/src/organizations/roles.js";
import { bootstrapOrgMcpDatabase, createOrgMcpRepository, type OrgMcpDatabase } from "../../packages/platform/src/org-mcp/database.js";
import { createOrgMcpPolicy } from "../../packages/platform/src/org-mcp/policy.js";

const T = new Date("2026-11-01T00:00:00.000Z");
const ACTOR = "user_multi";
const LINEAR = "https://mcp.linear.app/sse?workspace=acme";

describe("org MCP policy", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<OrgMcpDatabase>;
  let organizations: PlatformOrganizationRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = new Kysely<OrgMcpDatabase>({ dialect: pglite.dialect });
    await bootstrapPlatformOrganizationDatabase(db);
    await bootstrapOrgMcpDatabase(db);
    organizations = new PlatformOrganizationRepository(db);
  });
  afterEach(async () => { await db.destroy(); });

  async function join(organizationId: string, actorId = ACTOR, state: "active" | "removed" = "active") {
    await organizations.applyOrganization({ organizationId, name: organizationId, slug: organizationId, aiSubmission: "owner_only", sourceUpdatedAt: T });
    await organizations.applyMembership({ organizationId, membershipId: `m_${organizationId}_${actorId}`, actorId, role: "org:member", state, sourceUpdatedAt: T });
  }
  const policy = () => createOrgMcpPolicy(createOrgMcpRepository(db));
  const evaluate = (toolName = "list_issues", actorId = ACTOR) => policy().evaluate({ actorId, serverUrl: LINEAR, toolName });

  it("maps a pasted URL variant to both its host and the catalog id on that host", () => {
    expect(orgMcpServerDefIdsForUrl(LINEAR)).toEqual({ host: "mcp.linear.app", serverDefIds: ["mcp.linear.app", "linear"] });
    expect(orgMcpServerDefIdsForUrl("not a url")).toEqual({ host: null, serverDefIds: [] });
  });

  it("grants org:mcp_admin to org:admin only", () => {
    expect(hasOrganizationPermission("org:admin", "org:mcp_admin")).toBe(true);
    expect(hasOrganizationPermission("org:member", "org:mcp_admin")).toBe(false);
    expect(hasOrganizationPermission("constructor", "org:mcp_admin")).toBe(false);
  });

  it("attributes usage to the only org, then the governing org, and to none when ambiguous", async () => {
    expect(await evaluate()).toEqual({ orgId: null, allowed: true });
    await join("org_alpha");
    expect(await evaluate()).toEqual({ orgId: "org_alpha", allowed: true });
    await join("org_beta");
    expect(await evaluate()).toEqual({ orgId: null, allowed: true });
    const repository = createOrgMcpRepository(db);
    await repository.putServerDefinition({ organizationId: "org_beta", serverDefId: "linear", mode: "recommend",
      defaultToolPolicy: "allow", toolOverrides: {}, updatedBy: "user_admin" });
    expect(await evaluate()).toEqual({ orgId: "org_beta", allowed: true });
  });

  it("denies when any org in context blocks, by catalog id, tool allowlist, or member block", async () => {
    await join("org_alpha");
    await join("org_beta");
    const repository = createOrgMcpRepository(db);
    await repository.putServerDefinition({ organizationId: "org_beta", serverDefId: "linear", mode: "allow",
      defaultToolPolicy: "blocked", toolOverrides: { list_issues: "allow", constructor: "allow" }, updatedBy: "user_admin" });
    expect(await evaluate("list_issues")).toEqual({ orgId: "org_beta", allowed: true });
    expect(await evaluate("delete_issue")).toEqual({ orgId: "org_beta", allowed: false });
    expect(await evaluate("toString")).toEqual({ orgId: "org_beta", allowed: false });

    await repository.blockMember({ organizationId: "org_alpha", actorId: ACTOR, serverDefId: "mcp.linear.app", createdBy: "user_admin" });
    expect(await evaluate("list_issues")).toEqual({ orgId: "org_alpha", allowed: false });
    await repository.unblockMember({ organizationId: "org_alpha", actorId: ACTOR, serverDefId: "mcp.linear.app" });
    expect((await evaluate("list_issues")).allowed).toBe(true);
  });

  it("ignores removed memberships, deleted orgs, and non-Clerk actors", async () => {
    await join("org_alpha", ACTOR, "removed");
    const repository = createOrgMcpRepository(db);
    await repository.putServerDefinition({ organizationId: "org_alpha", serverDefId: "linear", mode: "block",
      defaultToolPolicy: "allow", toolOverrides: {}, updatedBy: "user_admin" });
    expect(await evaluate()).toEqual({ orgId: null, allowed: true });
    expect(await evaluate("list_issues", "3f1c0f8e-6a52-4c39-9d3e-0b8bb9c3f1aa")).toEqual({ orgId: null, allowed: true });
  });
});
