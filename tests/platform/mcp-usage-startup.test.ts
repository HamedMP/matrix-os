import { readFile } from "node:fs/promises";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as coreModule from "../../packages/gateway/src/integrations/custom-mcp/core-tools.js";
import type { McpUsageDatabase } from "../../packages/platform/src/mcp-usage/database.js";
import { createPlatformCoreMcp } from "../../packages/platform/src/mcp-usage/startup.js";
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

  it("drains Core usage after the broker settles and before the feature database closes", async () => {
    const source = await readFile("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toContain("../../gateway/dist/integrations/custom-mcp/core-tools.js");
    expect(source).toMatch(/await broker\.shutdown\(\);\s*await projection\.drain\(\);[\s\S]*?await coreMcp\.shutdown\(\);\s*\} finally \{\s*await closeCustomMcpDb\(\);/);
    expect(source).toMatch(/allowToolCalls: true,\s*core: coreMcp\.core,/);
  });
});
