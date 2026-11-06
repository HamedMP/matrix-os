import { Agent } from "undici";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewPairPostgresFixture } from "./preview-pair-postgres-support.js";
import { createIsolatedPreviewPairDatabase } from "./preview-pair-isolated-postgres.js";
import { createPreviewPairSourceFixture } from "./preview-pair-source-fixture.js";
import { candidateRuntimeEnvironment } from "./preview-pair-candidate-env.js";
import { startPlatformServer, type StartPlatformServerOptions } from "../../packages/platform/src/platform-startup.js";

const captured = vi.hoisted(() => ({ databases: [] as Array<{ destroy: ReturnType<typeof vi.fn> }>, sourcePorts: {} as Record<string, unknown> }));
vi.mock("../../packages/platform/src/db.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../packages/platform/src/db.js")>();
  return { ...actual, createPlatformDb: (...args: Parameters<typeof actual.createPlatformDb>) => {
    const database = actual.createPlatformDb(...args), destroy = database.destroy.bind(database);
    database.destroy = vi.fn(destroy); captured.databases.push(database);
    return database;
  } };
});

vi.mock("../../packages/platform/src/preview-pair/startup.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../packages/platform/src/preview-pair/startup.js")>();
  return { ...actual, createConfiguredPreviewPairRuntime: (options: Parameters<typeof actual.createConfiguredPreviewPairRuntime>[0]) =>
    actual.createConfiguredPreviewPairRuntime({ ...options, ...captured.sourcePorts }) };
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("real Platform startup owns its primary database on failure", () => {
  afterEach(async () => { for (const database of captured.databases.splice(0)) await database.destroy(); });
  it.each(["dormant", "source"] as const)("drains the actual primary pool and wires %s mode before app composition fails", async mode => {
    const fixture = await createPreviewPairPostgresFixture(), previous = process.env;
    const dispatcher = new Agent(), proxy = new Agent(), marker = new Error("intentional app-composition failure");
    let target: Awaited<ReturnType<typeof createIsolatedPreviewPairDatabase>> | undefined;
    try {
      const source = new URL(previous.MATRIX_TEST_POSTGRES_URL!);
      const schema = (await sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(fixture.db.executor)).rows[0].schema;
      source.searchParams.set("options", `-c search_path=${schema}`);
      if (mode === "source") target = await createIsolatedPreviewPairDatabase();
      const sourceFixture = createPreviewPairSourceFixture(target?.databaseUrl);
      captured.sourcePorts = mode === "source" ? { google: sourceFixture.google,
        objectStore: { getObject: vi.fn(async () => ({ body: null })), putObject: vi.fn(async () => ({})) } } : {};
      const env = { ...(mode === "source" ? { ...sourceFixture.env, CUSTOMER_VPS_ENABLED: "true", HETZNER_API_TOKEN: "fixture-disabled-provider",
        MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false", MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "false" } : candidateRuntimeEnvironment()), NODE_ENV: "test", PLATFORM_RUNTIME_MODE: "local",
        PLATFORM_DATABASE_URL: source.toString(), PLATFORM_BACKGROUND_WORKERS_ENABLED: "false",
        HOME: previous.HOME, PATH: previous.PATH };
      const unexpected = () => { throw new Error("Unexpected startup fixture dependency"); };
      const options: StartPlatformServerOptions = { port: 0, platformSecret: env.PLATFORM_SECRET!, platformJwtSecret: env.PLATFORM_JWT_SECRET!, codeServerPort: 8080,
        containerProxyDispatcher: proxy, customerVpsProxyDispatcher: dispatcher, createApp: deps => {
          expect(deps.previewPairs?.enabled).toBe(mode === "source" ? true : undefined);
          if (mode === "source") expect(typeof deps.previewPairs?.service?.report).toBe("function");
          throw marker;
        },
        checkUnsafeDefaultSecrets: () => [], checkCustomerVpsPrimaryStorageEnv: () => [], checkPublicSitesEnv: () => [],
        checkHomeMirrorS3Env: () => [], checkHostBundleStorageEnv: () => [], collectTenantPublicTelemetryEnv: () => [],
        stripeBillingEntitlementsEnabled: () => false, resolveEffectiveBillingEntitlement: async () => unexpected(),
        getRuntimeEntitlementDecision: unexpected, getRuntimeEntitlementDecisionForUser: unexpected };
      process.env = env;
      await expect(startPlatformServer(options)).rejects.toBe(marker);
      expect(captured.databases).toHaveLength(1);
      expect(captured.databases[0].destroy).toHaveBeenCalledOnce();
      expect((await sql<{ n: number }>`SELECT 1 AS n`.execute(fixture.db.executor)).rows[0].n).toBe(1);
    } finally {
      process.env = previous;
      for (const database of captured.databases.splice(0)) await database.destroy();
      captured.sourcePorts = {};
      await dispatcher.close(); await proxy.close(); await target?.destroy(); await fixture.destroy();
    }
  }, 30_000);
});
