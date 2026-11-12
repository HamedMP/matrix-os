/**
 * Layer-5 integration checkpoint (spec 2691): an org admin's member block,
 * written through the real admin route, denies that member's next Core call
 * through the real Core route, real broker, and a fake upstream. The usage
 * rows carry the org id, and the admin view reports metadata and call counts
 * that match those rows without any credential or payload.
 */
import { Hono } from "hono";
import { Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreToolService } from "../../packages/gateway/src/integrations/custom-mcp/core-tools.js";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";
import { bootstrapMcpUsageDatabase, createMcpUsageRepository } from "../../packages/platform/src/mcp-usage/database.js";
import { createMcpUsageWriter, type McpUsageWriter } from "../../packages/platform/src/mcp-usage/writer.js";
import { bootstrapPlatformOrganizationDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { bootstrapOrgMcpDatabase, createOrgMcpRepository, type OrgMcpDatabase } from "../../packages/platform/src/org-mcp/database.js";
import { createOrgMcpPolicy } from "../../packages/platform/src/org-mcp/policy.js";
import { createOrgMcpAdminRoutes } from "../../packages/platform/src/org-mcp/routes.js";
import { ORG_MCP_MAX_MEMBER_BLOCKS } from "../../packages/contracts/src/organization-mcp.js";
import { createCoreFixture, type CoreFixture, type FakeUpstream } from "./core-mcp-fixture.js";

const ORG = "org_acme1";
const ADMIN = "user_org_admin";
const SOURCE_TIME = new Date("2026-11-01T00:00:00.000Z");

describe("Matrix Core MCP org governance checkpoint", () => {
  let fixture: CoreFixture;
  let db: Kysely<OrgMcpDatabase>;
  let linear: FakeUpstream;
  let writer: McpUsageWriter;
  let app: Hono;
  let connectionId: string;

  beforeEach(async () => {
    linear = { host: "mcp.linear.test", calls: [], tools: [
      { name: "list_issues", description: "List Linear issues." },
      { name: "delete_issue", description: "Delete a Linear issue." },
    ] };
    fixture = await createCoreFixture([linear]);
    db = new Kysely<OrgMcpDatabase>({ dialect: fixture.pglite.dialect });
    await bootstrapPlatformOrganizationDatabase(db);
    await bootstrapMcpUsageDatabase(db);
    await bootstrapOrgMcpDatabase(db);
    await bootstrapOrgMcpDatabase(db);
    const organizations = new PlatformOrganizationRepository(db);
    await organizations.applyOrganization({ organizationId: ORG, name: "Acme", slug: "acme", aiSubmission: "owner_only", sourceUpdatedAt: SOURCE_TIME });
    for (const [actorId, role, name] of [[ADMIN, "org:admin", "Ada Admin"], [fixture.actorId, "org:member", "Mo Member"]] as const) {
      await organizations.applyMembership({ organizationId: ORG, membershipId: `mem_${actorId}`, actorId, role, state: "active",
        sourceUpdatedAt: SOURCE_TIME, profile: { displayName: name, observedAt: SOURCE_TIME } });
    }
    connectionId = await fixture.connect("Linear", linear.host, { list_issues: "allow", delete_issue: "allow" });
    const repository = createOrgMcpRepository(db);
    writer = createMcpUsageWriter({ insert: rows => createMcpUsageRepository(db).insertEvents(rows) });
    const core = new CoreToolService({ broker: fixture.broker, approvals: fixture.db, usage: writer, orgPolicy: createOrgMcpPolicy(repository) });
    app = new Hono();
    app.route("/api/mcp-servers", createCustomMcpRoutes({ broker: fixture.broker, core, allowToolCalls: true,
      resolveUserId: async () => fixture.userId, resolveActorId: () => fixture.actorId }));
    app.route("/", createOrgMcpAdminRoutes({
      repository,
      organizations: { repository: organizations, projection: {
        isCurrentMember: async (input) => (await organizations.getMembership(input))?.state === "active",
      } },
      connectionsAvailable: true,
      resolveActor: async (c) => c.req.header("x-test-actor") ?? null,
    }));
  });
  afterEach(async () => { await writer.drain(); await fixture.close(); });

  const call = (tool: string) => app.request("/api/mcp-servers/core/call", {
    method: "POST", headers: { "content-type": "application/json", "x-matrix-mcp-entry-point": "stdio" },
    body: JSON.stringify({ service: `linear-${connectionId.slice(0, 8)}`, tool, arguments: { team: "SECRET-TEAM" }, approvalGranted: false }),
  });
  const admin = (method: string, path: string, body?: unknown, actor = ADMIN) => app.request(path, {
    method, headers: { "x-test-actor": actor, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const blockPath = `/api/orgs/${ORG}/mcp/members/${"user_core_owner"}/blocks/mcp.linear.test`;

  it("denies the member's next call after a block and restores it after the unblock", async () => {
    expect((await call("list_issues")).status).toBe(200);
    expect((await admin("PUT", blockPath, undefined, fixture.actorId)).status).toBe(403);
    expect((await admin("PUT", blockPath, undefined, "user_outsider")).status).toBe(404);
    expect((await admin("PUT", blockPath)).status).toBe(200);
    const denied = await call("list_issues");
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toMatch(/acme|block/i);
    expect(linear.calls).toHaveLength(1);
    expect((await admin("DELETE", blockPath)).status).toBe(200);
    expect((await call("list_issues")).status).toBe(200);

    // A server-wide tool allowlist: everything except list_issues is blocked in org context.
    expect((await admin("PUT", `/api/orgs/${ORG}/mcp/servers/mcp.linear.test`, {
      mode: "allow", defaultToolPolicy: "blocked", toolOverrides: { list_issues: "allow" },
    })).status).toBe(200);
    expect((await call("delete_issue")).status).toBe(403);
    expect((await call("list_issues")).status).toBe(200);
    expect((await admin("PUT", `/api/orgs/${ORG}/mcp/servers/mcp.linear.test`, { mode: "block" })).status).toBe(200);
    expect((await call("list_issues")).status).toBe(403);
    expect(linear.calls.map(entry => entry.tool)).toEqual(["list_issues", "list_issues", "list_issues"]);

    await writer.drain();
    const rows = await db.selectFrom("mcp_usage_events").select(["org_id", "tool_name", "outcome"]).orderBy("id").execute();
    expect(rows).toEqual([
      { org_id: ORG, tool_name: "list_issues", outcome: "ok" },
      { org_id: ORG, tool_name: "list_issues", outcome: "denied" },
      { org_id: ORG, tool_name: "list_issues", outcome: "ok" },
      { org_id: ORG, tool_name: "delete_issue", outcome: "denied" },
      { org_id: ORG, tool_name: "list_issues", outcome: "ok" },
      { org_id: ORG, tool_name: "list_issues", outcome: "denied" },
    ]);
  });

  // Fault: PUT with only a mode silently re-allows tools the admin had blocked.
  it("keeps a blocked tool blocked when an admin changes only the server mode", async () => {
    const path = `/api/orgs/${ORG}/mcp/servers/mcp.linear.test`;
    expect((await admin("PUT", path, { mode: "allow", toolOverrides: { delete_issue: "blocked" } })).status).toBe(200);
    expect((await call("delete_issue")).status).toBe(403);
    expect((await admin("PUT", path, { mode: "recommend" })).status).toBe(200);
    expect((await call("delete_issue")).status).toBe(403);
    expect((await call("list_issues")).status).toBe(200);
    expect((await admin("PUT", path, {})).status).toBe(422);
    expect((await admin("PUT", `/api/orgs/${ORG}/mcp/servers/other.example`, { toolOverrides: { x: "blocked" } })).status).toBe(422);
    expect(linear.calls.map(entry => entry.tool)).toEqual(["list_issues"]);
  });

  // Fault: authorization uses the role read before the freshness check, so a just-demoted admin keeps access.
  it("authorizes from the membership read after the freshness check, so a demoted admin gets 403", async () => {
    const organizations = new PlatformOrganizationRepository(db);
    const demoting = new Hono();
    demoting.route("/", createOrgMcpAdminRoutes({
      repository: createOrgMcpRepository(db),
      organizations: { repository: organizations, projection: {
        // The refresh observes Clerk's demotion and writes it to the projection.
        isCurrentMember: async (input) => {
          await organizations.applyMembership({ organizationId: input.organizationId, membershipId: `mem_${input.actorId}`, actorId: input.actorId,
            role: "org:member", state: "active", sourceUpdatedAt: new Date("2026-11-02T00:00:00.000Z") });
          return true;
        },
      } },
      connectionsAvailable: true,
      resolveActor: async () => ADMIN,
    }));
    const response = await demoting.request(blockPath, { method: "PUT" });
    expect(response.status).toBe(403);
    expect(await db.selectFrom("org_mcp_member_blocks").selectAll().execute()).toEqual([]);
  });

  // Fault: blocks beyond what the connections response accepts break the admin panel with a 503.
  it("refuses a member's 501st block with 409 cap_reached while re-blocking stays idempotent", async () => {
    await db.insertInto("org_mcp_member_blocks").values(Array.from({ length: ORG_MCP_MAX_MEMBER_BLOCKS }, (_, index) => ({
      organization_id: ORG, actor_id: fixture.actorId, server_def_id: `host-${index}.example`, created_by: ADMIN }))).execute();
    const refused = await admin("PUT", blockPath);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "cap_reached" });
    expect((await admin("PUT", `/api/orgs/${ORG}/mcp/members/${fixture.actorId}/blocks/host-7.example`)).status).toBe(200);
    expect((await admin("GET", `/api/orgs/${ORG}/mcp/connections?limit=10`)).status).toBe(200);
  });

  // Fault: usage reads only rolled-up aggregates, so calls since the last hourly rollup are missing (or counted twice).
  it("counts a call recorded before the rollup exactly once, before and after the rollup", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const totals = async () => {
      const body = await (await admin("GET", `/api/orgs/${ORG}/mcp/usage?from=${today}&to=${today}`)).json() as { rows: Array<{ calls: number }>; updatedAt: string };
      expect(Date.parse(body.updatedAt)).not.toBeNaN();
      return body.rows.map(row => row.calls);
    };
    expect((await call("list_issues")).status).toBe(200);
    await writer.flush();
    expect(await totals()).toEqual([1]);
    await createMcpUsageRepository(db).rollupDaily();
    expect(await totals()).toEqual([1]);
    expect((await call("list_issues")).status).toBe(200);
    await writer.flush();
    expect(await totals()).toEqual([2]);
    await createMcpUsageRepository(db).rollupDaily();
    expect(await totals()).toEqual([2]);
  });

  it("shows member connection metadata and call counts that match the usage rows, with no credential or payload", async () => {
    expect((await call("list_issues")).status).toBe(200);
    expect((await call("list_issues")).status).toBe(200);
    await writer.drain();
    await createMcpUsageRepository(db).rollupDaily();
    // Stored after the calls: the admin view must never echo either column.
    await sql`UPDATE custom_mcp_servers SET encrypted_credentials = 'CREDENTIAL-CIPHERTEXT', url = 'https://mcp.linear.test/mcp?token=URL-SECRET'`.execute(db);

    const connections = await admin("GET", `/api/orgs/${ORG}/mcp/connections?limit=10`);
    expect(connections.status).toBe(200);
    const page = await connections.json() as { members: Array<{ actorId: string; displayName: string; connections: Array<Record<string, unknown>> }> };
    const member = page.members.find(entry => entry.actorId === fixture.actorId)!;
    expect(member.displayName).toBe("Mo Member");
    expect(member.connections).toEqual([expect.objectContaining({
      connectionId, name: "Linear", host: "mcp.linear.test", serverDefIds: ["mcp.linear.test"], status: "ready", enabled: true,
      lastUsedAt: expect.any(String),
    })]);
    const today = new Date().toISOString().slice(0, 10);
    const usage = await admin("GET", `/api/orgs/${ORG}/mcp/usage?from=${today}&to=${today}`);
    expect(await usage.json()).toEqual({ truncated: false, updatedAt: expect.any(String), rows: [
      { day: today, actorId: fixture.actorId, serverKey: "mcp.linear.test", toolName: "list_issues", calls: 2, failures: 0 },
    ] });
    const everything = JSON.stringify(page) + JSON.stringify(await (await admin("GET", `/api/orgs/${ORG}/mcp/usage?from=${today}&to=${today}`)).json());
    expect(everything).not.toMatch(/CREDENTIAL-CIPHERTEXT|URL-SECRET|SECRET-TEAM|list_issues ok/);
  });

  it("validates params at the boundary, bounds bodies on every mutation, and never reports a missing dependency as not found", async () => {
    expect((await admin("GET", `/api/orgs/${ORG}/mcp/usage?from=2025-01-01&to=2026-11-12`)).status).toBe(422);
    expect((await admin("GET", `/api/orgs/${ORG}/mcp/usage?from=2026-02-30&to=2026-03-01`)).status).toBe(422);
    expect((await admin("GET", `/api/orgs/${ORG}/mcp/connections?cursor=${Buffer.from("not-an-actor").toString("base64url")}`)).status).toBe(422);
    expect((await admin("PUT", `/api/orgs/${ORG}/mcp/servers/..%2Fetc`, { mode: "block" })).status).toBe(422);
    expect((await admin("PUT", `/api/orgs/${ORG}/mcp/servers/mcp.linear.test`, { mode: "block", extra: true })).status).toBe(422);
    expect((await admin("DELETE", `/api/orgs/${ORG}/mcp/servers/mcp.linear.test`, { padding: "x" })).status).toBe(413);
    expect((await admin("PUT", blockPath, { padding: "x".repeat(100) })).status).toBe(413);
    expect((await admin("PUT", `/api/orgs/${ORG}/mcp/members/user_nobody/blocks/linear`)).status).toBe(404);
    expect((await app.request(blockPath, { method: "PUT" })).status).toBe(401);

    const bare = createOrgMcpAdminRoutes({ connectionsAvailable: false, resolveActor: async () => ADMIN });
    const response = await bare.request(`/api/orgs/${ORG}/mcp/connections`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Organization connections unavailable" });
  });
});
