import { readFile } from "node:fs/promises";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as coreModule from "../../packages/gateway/src/integrations/custom-mcp/core-tools.js";
import type { McpUsageDatabase } from "../../packages/platform/src/mcp-usage/database.js";
import { createPlatformCoreMcp } from "../../packages/platform/src/mcp-usage/startup.js";
import { bootstrapPlatformOrganizationDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import type { OrgMcpDatabase } from "../../packages/platform/src/org-mcp/database.js";
import { createPlatformOrgMcp } from "../../packages/platform/src/org-mcp/startup.js";
import { createCoreFixture, type CoreFixture, type FakeUpstream } from "../integrations/core-mcp-fixture.js";

describe("platform Matrix Core MCP composition", () => {
  let fixture: CoreFixture;
  let upstream: FakeUpstream;
  let linearId: string;

  beforeEach(async () => {
    upstream = { host: "mcp.linear.test", calls: [], tools: [{ name: "list_issues", description: "List issues." }] };
    fixture = await createCoreFixture([upstream]);
    linearId = await fixture.connect("Linear", upstream.host, { list_issues: "allow" });
  });
  afterEach(async () => { await fixture.close(); });

  it("bootstraps usage storage, serves calls through the one broker, and drains rows on shutdown", async () => {
    const db = new Kysely<McpUsageDatabase>({ dialect: fixture.pglite.dialect });
    const runtime = await createPlatformCoreMcp({ db, coreModule, broker: fixture.broker, approvals: fixture.db, maintenance: false });
    const core = runtime.core as coreModule.CoreToolService;
    await core.callTool({ userId: fixture.userId, actorId: fixture.actorId, entryPoint: "stdio" }, { service: `linear-${linearId.slice(0, 8)}`, tool: "list_issues" });
    expect(await db.selectFrom("mcp_usage_events").selectAll().execute()).toEqual([]);
    await runtime.shutdown();
    await runtime.shutdown();
    expect((await db.selectFrom("mcp_usage_events").select(["tool_name", "outcome"]).execute())).toEqual([{ tool_name: "list_issues", outcome: "ok" }]);
  });

  it("enforces the org policy composed from the organization projection and attributes usage to that org", async () => {
    const db = new Kysely<OrgMcpDatabase>({ dialect: fixture.pglite.dialect });
    await bootstrapPlatformOrganizationDatabase(db);
    const repository = new PlatformOrganizationRepository(db);
    const sourceUpdatedAt = new Date("2026-11-01T00:00:00.000Z");
    await repository.applyOrganization({ organizationId: "org_acme1", name: "Acme", slug: "acme", aiSubmission: "owner_only", sourceUpdatedAt });
    await repository.applyMembership({ organizationId: "org_acme1", membershipId: "mem_1", actorId: fixture.actorId, role: "org:member", state: "active", sourceUpdatedAt });
    const orgMcp = await createPlatformOrgMcp({ db, organizations: { repository, projection: { isCurrentMember: async () => true } as never },
      connectionsAvailable: true, resolveActor: async () => null });
    const runtime = await createPlatformCoreMcp({ db, coreModule, broker: fixture.broker, approvals: fixture.db, maintenance: false, orgPolicy: orgMcp.policy });
    const core = runtime.core as coreModule.CoreToolService;
    const caller = { userId: fixture.userId, actorId: fixture.actorId, entryPoint: "stdio" as const };
    await core.callTool(caller, { service: `linear-${linearId.slice(0, 8)}`, tool: "list_issues" });
    await db.insertInto("org_mcp_member_blocks").values({ organization_id: "org_acme1", actor_id: fixture.actorId,
      server_def_id: "mcp.linear.test", created_by: "user_admin" }).execute();
    await expect(core.callTool(caller, { service: `linear-${linearId.slice(0, 8)}`, tool: "list_issues" })).rejects.toMatchObject({ code: "forbidden" });
    await runtime.shutdown();
    expect(await db.selectFrom("mcp_usage_events").select(["org_id", "outcome"]).orderBy("id").execute())
      .toEqual([{ org_id: "org_acme1", outcome: "ok" }, { org_id: "org_acme1", outcome: "denied" }]);
    expect(upstream.calls).toHaveLength(1);

    // Without the membership projection the saved block still refuses the governed server.
    const off = await createPlatformOrgMcp({ db, connectionsAvailable: true, resolveActor: async () => null });
    await expect(off.policy.evaluate({ actorId: fixture.actorId, serverUrl: "https://mcp.linear.test/mcp", toolName: "list_issues" }))
      .resolves.toMatchObject({ allowed: false });
  });

  it("drains Core usage after the broker settles and before the feature database closes", async () => {
    const source = await readFile("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toContain("../../gateway/dist/integrations/custom-mcp/core-tools.js");
    expect(source).toMatch(/await broker\.shutdown\(\);\s*await projection\.drain\(\);[\s\S]*?await coreMcp\.shutdown\(\);\s*\} finally \{\s*await closeCustomMcpDb\(\);/);
    expect(source).toMatch(/allowToolCalls: true,\s*core: coreMcp\.core,/);
    expect(source).toMatch(/createPlatformCoreMcp\([\s\S]*?orgPolicy: orgMcp\.policy/);
    expect(source).toContain("orgMcpRoutes: orgMcp.routes");
  });
});
