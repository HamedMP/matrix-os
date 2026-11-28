import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { Agent } from "undici";
import { describe, expect, it, vi } from "vitest";
import { startPlatformServer, type StartPlatformServerOptions } from "../../packages/platform/src/platform-startup.js";

const fixture = vi.hoisted(() => ({
  dialect: undefined as unknown,
  scopes: [] as string[],
  tables: [] as string[],
}));

// Only replace the database connection. The canary must use the production
// migration runner against actual tables and markers before composing its app.
vi.mock("../../packages/platform/src/db.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../packages/platform/src/db.js")>();
  return {
    ...actual,
    createPlatformDb: (_url: string, migrationScope: Parameters<typeof actual.createPlatformDb>[1]) => {
      const db = actual.createPlatformDb({ dialect: fixture.dialect }, migrationScope);
      const destroy = db.destroy.bind(db);
      db.destroy = async () => {
        try {
          fixture.scopes = (await sql<{ scope: string }>`
            SELECT scope FROM platform_schema_revisions ORDER BY scope
          `.execute(db.kysely)).rows.map(row => row.scope);
          fixture.tables = (await sql<{ tablename: string }>`
            SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename
          `.execute(db.kysely)).rows.map(row => row.tablename);
        } finally {
          await destroy();
        }
      };
      return db;
    },
  };
});

describe("scoped Platform startup", () => {
  it("migrates only terminal grants and reaches app composition with inherited integrations present", async () => {
    const instance = await KyselyPGlite.create();
    fixture.dialect = instance.dialect;
    const originalEnv = process.env;
    const containerProxyDispatcher = new Agent();
    const customerVpsProxyDispatcher = new Agent();
    const exitBeforeListen = new Error("intentional test stop before listening");
    const unrelated = () => { throw new Error("unrelated release path called"); };
    const createApp: StartPlatformServerOptions["createApp"] = vi.fn(deps => {
      expect(deps.env).toBe(process.env);
      expect(deps.atsDb).toBeUndefined();
      expect(deps.integrationRoutes).toBeUndefined();
      expect(deps.orgMcpRoutes).toBeUndefined();
      expect(deps.coreRepoRoutes).toBeUndefined();
      expect(deps.previewPairs).toBeUndefined();
      throw exitBeforeListen;
    });
    const options: StartPlatformServerOptions = {
      port: 0, codeServerPort: 8080, platformSecret: "fixture-platform", platformJwtSecret: "fixture-jwt",
      containerProxyDispatcher, customerVpsProxyDispatcher, createApp,
      checkUnsafeDefaultSecrets: () => [],
      checkCustomerVpsPrimaryStorageEnv: unrelated, checkPublicSitesEnv: unrelated,
      checkHomeMirrorS3Env: unrelated, checkHostBundleStorageEnv: unrelated,
      collectTenantPublicTelemetryEnv: unrelated, stripeBillingEntitlementsEnabled: unrelated,
      resolveEffectiveBillingEntitlement: unrelated, getRuntimeEntitlementDecision: unrelated,
      getRuntimeEntitlementDecisionForUser: unrelated,
    };
    process.env = {
      NODE_ENV: "test", PLATFORM_RUNTIME_MODE: "local",
      PLATFORM_DATABASE_URL: "postgres://unused.invalid/matrix",
      ATS_DATABASE_URL: "postgres://unrelated.invalid/ats",
      PLATFORM_BACKGROUND_WORKERS_ENABLED: "true",
      CUSTOM_MCP_ENABLED: "true", PIPEDREAM_CLIENT_ID: "unused", PIPEDREAM_CLIENT_SECRET: "unused",
      MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED: "1",
      MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_V1: JSON.stringify({
        sourceHandle: "test-main", chatId: "chat_canary",
        source: { ownerId: "user_fixture", machineId: "51fc2646-b563-4d59-a587-d9f932868b1d", runtimeSlot: "primary" },
        target: { ownerId: "user_fixture", machineId: "bd0169de-a657-4b48-92fe-dcb76b9defb8", runtimeSlot: "dev" },
        expiresAt: Date.now() + 60_000,
      }),
    };
    try {
      await expect(startPlatformServer(options)).rejects.toBe(exitBeforeListen);
      expect(createApp).toHaveBeenCalledOnce();
      expect(fixture.scopes).toEqual(["managed-terminal-grants"]);
      expect(fixture.tables).toEqual(["managed_terminal_grant_claims", "platform_schema_revisions"]);
    } finally {
      process.env = originalEnv;
      await Promise.all([
        instance.client.closed ? undefined : instance.client.close(),
        containerProxyDispatcher.close(), customerVpsProxyDispatcher.close(),
      ]);
    }
  });
});
