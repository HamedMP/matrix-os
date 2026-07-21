import { serve } from '@hono/node-server';
import {
  createPostHogErrorTracker,
  installPostHogProcessErrorTracking,
} from '@matrix-os/observability';
import type { Hono, Context } from 'hono';
import type { Server } from 'node:http';
import type Dockerode from 'dockerode';
import type { Agent } from 'undici';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createPlatformDb,
  getContainer,
  getRunningUserMachineByHandle,
  listContainers,
  sweepStaleCheckoutAttempts,
  updateContainerStatus,
  type PlatformDB,
} from './db.js';
import { createAtsDb, resolveAtsDatabaseUrl, type AtsDB } from './ats-db.js';
import type { Orchestrator } from './orchestrator.js';
import type { ClerkAuth } from './clerk-auth.js';
import { createClerkAuth, createClerkSessionRevoker } from './clerk-auth.js';
import type { MatrixProvisioner } from './matrix-provisioning.js';
import type { CustomerVpsService } from './customer-vps.js';
import type { GoldenSnapshotService } from './golden-snapshot-service.js';
import type { GoldenSnapshotRuntimeConfig } from './golden-snapshot-schema.js';
import type { CustomerVpsObjectStore } from './customer-vps-r2.js';
import type { EntitlementAccessDecision } from './profile-routing.js';
import type { BillingEntitlement } from './billing.js';
import type { PlatformApp } from './platform-app-types.js';
import {
  PlatformStartupConfigError,
  loadPlatformRuntimeConfig,
} from './runtime-mode.js';
import { resolvePlatformIntegrationConfig } from './integration-config.js';
import { buildPlatformVerificationToken } from './platform-token.js';
import { backfillFirstRunRecords } from './journey.js';
import { logPlatformRouteError } from './platform-route-utils.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { registerPlatformWebSocketUpgradeHandler } from './platform-websocket-upgrade.js';

interface GatewayPlatformUser {
  id: string;
  clerkId: string;
  handle: string;
  displayName: string;
  email: string;
  containerId: string;
  pipedreamExternalId?: string;
}

export function parseGoldenSnapshotReconciliationInterval(raw: string | undefined): number | undefined {
  const value = Number(raw ?? 15_000);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) return undefined;
  return value;
}

interface GatewayPlatformDb {
  migrate(): Promise<void>;
  getUserByClerkId(clerkId: string): Promise<GatewayPlatformUser | null>;
  ensureUser(input: {
    clerkId: string;
    handle: string;
    displayName: string;
    email: string;
    containerId: string;
    pipedreamExternalId?: string;
  }): Promise<GatewayPlatformUser>;
}

interface GatewayPlatformDbModule {
  createPlatformDb(databaseUrl: string): GatewayPlatformDb;
}

interface GatewayPipedreamConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment?: string;
}

interface GatewayPipedreamModule {
  createPipedreamClient(config: GatewayPipedreamConfig): unknown;
}

interface GatewayIntegrationRoutesModule {
  createIntegrationRoutes(opts: {
    db: GatewayPlatformDb;
    pipedream: unknown;
    webhookSecret: string;
    resolveUserId: (c: Context) => Promise<string | null>;
  }): Hono;
}

interface GatewayR2Client {
  getPresignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  getPresignedPutUrl(key: string, size: number, expiresIn?: number): Promise<string>;
  createMultipartUpload(key: string): Promise<string>;
  getPresignedPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<{ etag?: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  getObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }>;
  putObject(
    key: string,
    body: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<{ etag?: string }>;
  deleteObject(key: string): Promise<void>;
  destroy(): void;
}

interface GatewayR2ClientModule {
  createR2Client(config: {
    accountId?: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    endpoint?: string;
    publicEndpoint?: string;
    forcePathStyle?: boolean;
  }): Promise<GatewayR2Client>;
}

type CreatePlatformApp = (deps: {
  db: PlatformDB;
  atsDb?: AtsDB;
  docker?: Dockerode;
  orchestrator: Orchestrator;
  clerkAuth?: ClerkAuth;
  matrixProvisioner?: MatrixProvisioner;
  integrationRoutes?: Hono<any>;
  internalIntegrationRoutes?: Hono<any>;
  internalSyncRoutes?: Hono<any>;
  customerVpsService?: CustomerVpsService;
  goldenSnapshotService?: GoldenSnapshotService;
  goldenSnapshotConfig?: GoldenSnapshotRuntimeConfig;
  customerVpsObjectStore?: CustomerVpsObjectStore;
  hostBundleObjectStore?: CustomerVpsObjectStore;
  env?: NodeJS.ProcessEnv;
}) => PlatformApp;

export interface StartPlatformServerOptions {
  port: number;
  platformSecret: string;
  platformJwtSecret: string;
  codeServerPort: number;
  containerProxyDispatcher: Agent;
  customerVpsProxyDispatcher: Agent;
  createApp: CreatePlatformApp;
  checkUnsafeDefaultSecrets(): string[];
  checkHomeMirrorS3Env(): string[];
  checkHostBundleStorageEnv(): string[];
  collectTenantPublicTelemetryEnv(): string[];
  stripeBillingEntitlementsEnabled(env: NodeJS.ProcessEnv): boolean;
  resolveEffectiveBillingEntitlement(
    db: PlatformDB,
    clerkUserId: string,
  ): Promise<BillingEntitlement | null>;
  getRuntimeEntitlementDecision(env?: NodeJS.ProcessEnv): EntitlementAccessDecision;
  getRuntimeEntitlementDecisionForUser(
    db: PlatformDB,
    clerkUserId: string,
    env: NodeJS.ProcessEnv,
  ): Promise<EntitlementAccessDecision>;
}

async function importRuntimeModule<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

export async function startPlatformServer(opts: StartPlatformServerOptions): Promise<void> {
  const {
    port,
    platformSecret,
    platformJwtSecret,
    codeServerPort,
    containerProxyDispatcher,
    customerVpsProxyDispatcher,
    createApp: createPlatformApp,
    checkUnsafeDefaultSecrets,
    checkHomeMirrorS3Env,
    checkHostBundleStorageEnv,
    collectTenantPublicTelemetryEnv,
    stripeBillingEntitlementsEnabled,
    resolveEffectiveBillingEntitlement,
    getRuntimeEntitlementDecision,
    getRuntimeEntitlementDecisionForUser,
  } = opts;

  if (checkUnsafeDefaultSecrets().length > 0) {
    process.exit(1);
  }
  let runtimeConfig;
  try {
    runtimeConfig = loadPlatformRuntimeConfig();
  } catch (err: unknown) {
    if (err instanceof PlatformStartupConfigError) {
      console.error(`[platform] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  checkHomeMirrorS3Env();
  const hostBundleStorageProblems = checkHostBundleStorageEnv();
  if (hostBundleStorageProblems.length > 0) {
    process.exit(1);
  }

  const atsDatabaseUrl = resolveAtsDatabaseUrl(process.env);
  const db = createPlatformDb(runtimeConfig.platformDatabaseUrl);
  await db.ready;
  const atsDb = atsDatabaseUrl ? createAtsDb(atsDatabaseUrl) : undefined;
  await atsDb?.ready;

  let docker: Dockerode | undefined;
  let orchestrator: Orchestrator;
  if (runtimeConfig.legacyContainerOrchestrationEnabled) {
    const [
      { default: DockerodeCtor },
      { createOrchestrator },
      { createLifecycleManager },
      { createStatsCollector },
    ] = await Promise.all([
      import('dockerode'),
      import('./orchestrator.js'),
      import('./lifecycle.js'),
      import('./stats-collector.js'),
    ]);
    docker = new DockerodeCtor();
    orchestrator = createOrchestrator({
      db,
      docker,
      image: process.env.PLATFORM_IMAGE,
      dataDir: process.env.PLATFORM_DATA_DIR,
      platformSecret,
      publicTelemetryEnv: collectTenantPublicTelemetryEnv(),
      postgresUrl: process.env.POSTGRES_URL,
    });

    const maxRunning = Number(process.env.MAX_RUNNING_CONTAINERS) || 20;
    const lifecycle = createLifecycleManager({ db, orchestrator, maxRunning });
    lifecycle.start();

    const statsCollector = createStatsCollector({
      docker,
      listRunning: () => listContainers(db, 'running'),
      onResolvedContainerId: async (handle, containerId) => {
        await updateContainerStatus(db, handle, 'running', containerId);
      },
    });
    statsCollector.start();
  } else {
    const { createDisabledOrchestrator } = await import('./orchestrator.js');
    orchestrator = createDisabledOrchestrator({
      db,
      image: process.env.PLATFORM_IMAGE ?? 'customer-vps',
    });
    console.log('[platform] Cloud Run mode enabled; legacy Docker container orchestration is disabled');
  }

  let clerkAuth: ClerkAuth | undefined;
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (clerkSecretKey) {
    const { verifyToken } = await import('@clerk/backend');
    clerkAuth = createClerkAuth({
      verifyToken: async (token: string) => {
        const payload = await verifyToken(token, { secretKey: clerkSecretKey });
        return payload as { sub: string; [key: string]: unknown };
      },
      revokeSession: createClerkSessionRevoker({ secretKey: clerkSecretKey }),
    });
  }

  let matrixProvisioner: MatrixProvisioner | undefined;
  const conduitUrl = process.env.MATRIX_CONDUIT_URL;
  const conduitToken = process.env.CONDUIT_REGISTRATION_TOKEN;
  if (conduitUrl && !conduitToken) {
    console.error('[platform] CONDUIT_REGISTRATION_TOKEN is required when MATRIX_CONDUIT_URL is set');
    process.exit(1);
  }
  if (conduitUrl) {
    const { createMatrixProvisioner } = await import('./matrix-provisioning.js');
    matrixProvisioner = createMatrixProvisioner({
      db,
      homeserverUrl: conduitUrl,
      registrationToken: conduitToken!,
    });
    console.log(`[matrix] Provisioner enabled (${conduitUrl})`);
  }

  let integrationRoutes: Hono | undefined;
  let internalIntegrationRoutes: Hono | undefined;
  const integrationConfig = resolvePlatformIntegrationConfig(process.env, runtimeConfig.platformDatabaseUrl);
  if (integrationConfig) {
    const [
      { createIntegrationRoutes },
      { createPipedreamClient },
      { createPlatformDb: createGatewayPlatformDb },
    ] = await Promise.all([
      importRuntimeModule<GatewayIntegrationRoutesModule>('../../gateway/dist/integrations/routes.js'),
      importRuntimeModule<GatewayPipedreamModule>('../../gateway/dist/integrations/pipedream.js'),
      importRuntimeModule<GatewayPlatformDbModule>('../../gateway/dist/platform-db.js'),
    ]);

    const trustedPlatformDb = createGatewayPlatformDb(integrationConfig.platformDatabaseUrl);
    await trustedPlatformDb.migrate();
    const pipedream = await createPipedreamClient({
      clientId: integrationConfig.pipedreamClientId,
      clientSecret: integrationConfig.pipedreamClientSecret,
      projectId: integrationConfig.pipedreamProjectId,
      environment: integrationConfig.pipedreamEnvironment,
    });
    const webhookSecret = integrationConfig.pipedreamWebhookSecret;
    const resolveIntegrationUserId = async (clerkUserId: string | undefined, handle: string | undefined) => {
      if (!clerkUserId) return null;
      const existing = await trustedPlatformDb!.getUserByClerkId(clerkUserId);
      if (existing) return existing.id;
      if (!handle) return null;

      const owner =
        (await getRunningUserMachineByHandle(db, handle)) ??
        (await getContainer(db, handle));
      if (!owner || owner.clerkUserId !== clerkUserId) {
        return null;
      }

      const user = await trustedPlatformDb!.ensureUser({
        clerkId: clerkUserId,
        handle,
        displayName: handle,
        email: `${handle}@matrix-os.local`,
        containerId: `platform:${clerkUserId}`,
      });
      return user.id;
    };

    integrationRoutes = createIntegrationRoutes({
      db: trustedPlatformDb,
      pipedream,
      webhookSecret,
      resolveUserId: async (c) => {
        const clerkUserId = c.get('platformUserId') as string | undefined;
        const handle = c.get('platformHandle') as string | undefined;
        return await resolveIntegrationUserId(clerkUserId, handle);
      },
    });
    internalIntegrationRoutes = createIntegrationRoutes({
      db: trustedPlatformDb,
      pipedream,
      webhookSecret,
      resolveUserId: async (c) => {
        const clerkUserId = c.get('internalContainerClerkUserId') as string | undefined;
        const handle = c.get('internalContainerHandle') as string | undefined;
        return await resolveIntegrationUserId(clerkUserId, handle);
      },
    });
  }

  let internalSyncRoutes: Hono | undefined;
  let customerVpsObjectStore: CustomerVpsObjectStore | undefined;
  let hostBundleObjectStore: CustomerVpsObjectStore | undefined;
  const s3Endpoint = process.env.S3_ENDPOINT ?? process.env.R2_ENDPOINT;
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
  const s3Bucket = process.env.S3_BUCKET ?? process.env.R2_BUCKET ?? 'matrixos-sync';
  const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  let createR2Client: GatewayR2ClientModule['createR2Client'] | undefined;
  if (s3AccessKey && s3SecretKey && platformSecret) {
    const [r2ClientModule, { createInternalSyncRoutes }] = await Promise.all([
      importRuntimeModule<GatewayR2ClientModule>('./r2-client.js'),
      import('./internal-sync-routes.js'),
    ]);
    createR2Client = r2ClientModule.createR2Client;
    const r2 = await createR2Client({
      accessKeyId: s3AccessKey,
      secretAccessKey: s3SecretKey,
      bucket: s3Bucket,
      endpoint: s3Endpoint,
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.R2_PUBLIC_ENDPOINT,
      accountId: process.env.R2_ACCOUNT_ID,
      forcePathStyle: s3ForcePathStyle,
    });
    internalSyncRoutes = createInternalSyncRoutes({
      db,
      r2,
      platformSecret,
    });
    customerVpsObjectStore = r2;
    hostBundleObjectStore = r2;
  }

  const bundleS3Bucket = process.env.S3_BUNDLES_BUCKET ?? process.env.R2_BUNDLES_BUCKET;
  const bundleS3AccessKey = process.env.S3_BUNDLES_ACCESS_KEY_ID ?? process.env.R2_BUNDLES_ACCESS_KEY_ID;
  const bundleS3SecretKey = process.env.S3_BUNDLES_SECRET_ACCESS_KEY ?? process.env.R2_BUNDLES_SECRET_ACCESS_KEY;
  if (bundleS3Bucket && bundleS3AccessKey && bundleS3SecretKey) {
    createR2Client ??= (
      await importRuntimeModule<GatewayR2ClientModule>('./r2-client.js')
    ).createR2Client;
    hostBundleObjectStore = await createR2Client({
      accessKeyId: bundleS3AccessKey,
      secretAccessKey: bundleS3SecretKey,
      bucket: bundleS3Bucket,
      endpoint: process.env.S3_BUNDLES_ENDPOINT ?? process.env.R2_BUNDLES_ENDPOINT,
      publicEndpoint: process.env.S3_BUNDLES_PUBLIC_ENDPOINT ?? process.env.R2_BUNDLES_PUBLIC_ENDPOINT,
      accountId: process.env.S3_BUNDLES_ACCOUNT_ID ?? process.env.R2_BUNDLES_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID,
      forcePathStyle: process.env.S3_BUNDLES_FORCE_PATH_STYLE === 'true',
    });
  }

  let customerVpsService: CustomerVpsService | undefined;
  let goldenSnapshotService: GoldenSnapshotService | undefined;
  let goldenSnapshotConfig: GoldenSnapshotRuntimeConfig | undefined;
  let customerVpsReconciliationInterval: ReturnType<typeof setInterval> | undefined;
  let customerVpsReconciliationPromise: Promise<void> | undefined;
  let goldenSnapshotInterval: ReturnType<typeof setInterval> | undefined;
  let goldenSnapshotPromise: Promise<void> | undefined;
  if (runtimeConfig.customerVpsEnabled) {
    const [
      { createCustomerVpsService },
      { loadCustomerVpsConfig },
      { createHetznerClient },
      { createCustomerVpsSystemStore, createNoopCustomerVpsSystemStore },
      { loadCustomerVpsCloudInitTemplate },
    ] = await Promise.all([
      import('./customer-vps.js'),
      import('./customer-vps-config.js'),
      import('./customer-vps-hetzner.js'),
      import('./customer-vps-r2.js'),
      import('./customer-vps-cloud-init.js'),
    ]);
    const customerVpsConfig = loadCustomerVpsConfig();
    const cloudInitTemplate = await loadCustomerVpsCloudInitTemplate();
    const hetzner = createHetznerClient(customerVpsConfig);
    customerVpsService = createCustomerVpsService({
      db,
      config: customerVpsConfig,
      hetzner,
      systemStore: customerVpsObjectStore
        ? createCustomerVpsSystemStore({
            r2: customerVpsObjectStore,
            r2PrefixRoot: customerVpsConfig.r2PrefixRoot,
          })
        : createNoopCustomerVpsSystemStore(),
      cloudInitTemplate,
      fetchDispatcher: customerVpsProxyDispatcher,
      resolveBillingEntitlement: stripeBillingEntitlementsEnabled(process.env)
        ? (clerkUserId) => resolveEffectiveBillingEntitlement(db, clerkUserId)
        : undefined,
    });
    goldenSnapshotConfig = customerVpsConfig.goldenSnapshots;
    {
      const [
        { createGoldenSnapshotService },
        {
          claimGoldenSnapshotBuildBatch,
          listCallbackWaitGoldenSnapshotBuildIds,
          enforceGoldenSnapshotRetention,
          listPendingGoldenSnapshotCleanup,
          listRunnableGoldenSnapshotBuildIds,
          listUnresolvedGoldenSnapshotBuildIds,
        },
      ] = await Promise.all([
        import('./golden-snapshot-service.js'),
        import('./golden-snapshot-repository.js'),
      ]);
      const builderTemplate = await readFile(
        process.env.GOLDEN_SNAPSHOT_BUILDER_CLOUD_INIT_PATH
          ?? 'distro/customer-vps/golden-snapshot-builder-cloud-init.yaml',
        'utf8',
      );
      goldenSnapshotService = createGoldenSnapshotService({
        db,
        config: goldenSnapshotConfig,
        hetzner,
        builderCloudInitTemplate: builderTemplate,
        bundleBaseUrl: process.env.MATRIX_HOST_BUNDLE_BASE_URL ?? process.env.PLATFORM_PUBLIC_URL ?? `http://localhost:${port}`,
        callbackBaseUrl: process.env.PLATFORM_PUBLIC_URL ?? `http://localhost:${port}`,
        tokenFactory: () => randomBytes(32).toString('base64url'),
      });
      const runGoldenSnapshotWorker = async () => {
        if (goldenSnapshotPromise || !goldenSnapshotService || !goldenSnapshotConfig) return;
        goldenSnapshotPromise = (async () => {
          try {
            const workerNow = new Date().toISOString();
            let quotaPressure = false;
            if (goldenSnapshotConfig.buildsEnabled) {
              await claimGoldenSnapshotBuildBatch(
                db,
                workerNow,
                new Date(new Date(workerNow).getTime() + goldenSnapshotConfig.buildLeaseMs).toISOString(),
                goldenSnapshotConfig.maxBuildAttempts,
                goldenSnapshotConfig.reconciliationBatchSize,
                goldenSnapshotConfig.maxConcurrentBuilds,
              );
              const runnable = await listRunnableGoldenSnapshotBuildIds(
                db, new Date().toISOString(), goldenSnapshotConfig.reconciliationBatchSize,
              );
              for (const buildId of runnable) {
                try {
                  await goldenSnapshotService!.runBuildStep(buildId);
                } catch (err: unknown) {
                  if (err instanceof CustomerVpsError && err.code === 'snapshot_quota_exceeded') {
                    quotaPressure = true;
                  }
                  console.error(`[golden-snapshot] worker step failed: ${err instanceof Error ? err.name : typeof err}`);
                }
              }
              const callbackWaits = await listCallbackWaitGoldenSnapshotBuildIds(
                db, goldenSnapshotConfig.reconciliationBatchSize,
              );
              for (const buildId of callbackWaits) {
                try {
                  await goldenSnapshotService!.runBuildStep(buildId);
                } catch (err: unknown) {
                  console.error(`[golden-snapshot] callback wait failed: ${err instanceof Error ? err.name : typeof err}`);
                }
              }
            }
            const unresolvedBuilds = await listUnresolvedGoldenSnapshotBuildIds(
              db, goldenSnapshotConfig.reconciliationBatchSize,
            );
            for (const buildId of unresolvedBuilds) {
              try {
                await goldenSnapshotService!.runOrphanReconciliationStep(buildId);
              } catch (err: unknown) {
                console.error(`[golden-snapshot] orphan reconciliation failed: ${err instanceof Error ? err.name : typeof err}`);
              }
            }
            const cleanup = await listPendingGoldenSnapshotCleanup(
              db, new Date().toISOString(), goldenSnapshotConfig.reconciliationBatchSize,
            );
            for (const item of cleanup) {
              try {
                await goldenSnapshotService!.runCleanupStep(item.cleanupId);
              } catch (err: unknown) {
                console.error(`[golden-snapshot] cleanup step failed: ${err instanceof Error ? err.name : typeof err}`);
              }
            }
            const retention = await enforceGoldenSnapshotRetention(db, {
              retentionLimit: goldenSnapshotConfig.retentionLimit,
              rollbackVersionsPerChannel: 2,
              freshnessMaxAgeMs: goldenSnapshotConfig.freshnessMaxAgeMs,
              now: new Date().toISOString(),
              quotaPressure,
            });
            if (retention.retiredSnapshotIds.length > 0 || retention.blocked) {
              console.log(
                `[golden-snapshot] retention retired=${retention.retiredSnapshotIds.length} blocked=${retention.blocked}`,
              );
            }
          } catch (err: unknown) {
            logPlatformRouteError('golden snapshot reconciliation', err);
          }
        })().finally(() => {
          goldenSnapshotPromise = undefined;
        });
        await goldenSnapshotPromise;
      };
      const intervalMs = parseGoldenSnapshotReconciliationInterval(
        process.env.GOLDEN_SNAPSHOT_RECONCILIATION_INTERVAL_MS,
      );
      if (intervalMs !== undefined) {
        void runGoldenSnapshotWorker();
        goldenSnapshotInterval = setInterval(runGoldenSnapshotWorker, intervalMs);
        goldenSnapshotInterval.unref();
      }
    }
    const reconciliationIntervalMs = Number(process.env.CUSTOMER_VPS_RECONCILIATION_INTERVAL_MS ?? 60_000);
    if (reconciliationIntervalMs > 0) {
      let reconciliationRunning = false;
      const runCustomerVpsReconciliation = async () => {
        if (reconciliationRunning || !customerVpsService) return;
        reconciliationRunning = true;
        customerVpsReconciliationPromise = (async () => {
          try {
            try {
              const result = await customerVpsService!.reconcileProvisioning();
              if (result.checked > 0) {
                console.log(
                  `[platform] customer VPS reconciliation checked=${result.checked} running=${result.running} failed=${result.failed}`,
                );
              }
            } catch (err: unknown) {
              logPlatformRouteError('customer VPS reconciliation', err);
            }
            try {
              const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
              await sweepStaleCheckoutAttempts(db, thirtyDaysAgoIso, new Date().toISOString(), 200);
            } catch (err: unknown) {
              logPlatformRouteError('checkout attempt sweep', err);
            }
            try {
              await backfillFirstRunRecords(db, {
                limit: 25,
                probe: async (machine) => {
                  if (!machine.publicIPv4 || !customerVpsConfig.platformSecret) return null;
                  const token = buildPlatformVerificationToken(machine.handle, customerVpsConfig.platformSecret);
                  const res = await fetch(`https://${machine.publicIPv4}:443/api/settings/onboarding-status`, {
                    headers: { authorization: `Bearer ${token}` },
                    signal: AbortSignal.timeout(3000),
                    redirect: 'error',
                    ...(customerVpsProxyDispatcher ? { dispatcher: customerVpsProxyDispatcher } : {}),
                  } as RequestInit & { dispatcher?: import('undici').Dispatcher });
                  if (!res.ok) return null;
                  let body: { complete?: unknown } | null = null;
                  try {
                    body = (await res.json()) as { complete?: unknown };
                  } catch (parseErr: unknown) {
                    console.warn(
                      `[platform] backfill onboarding-status parse failed machine=${machine.machineId}`,
                      parseErr instanceof Error ? parseErr.name : typeof parseErr,
                    );
                    return null;
                  }
                  return body?.complete === true ? { completedAt: new Date().toISOString() } : null;
                },
              });
            } catch (err: unknown) {
              logPlatformRouteError('first-run backfill', err);
            }
          } finally {
            reconciliationRunning = false;
            customerVpsReconciliationPromise = undefined;
          }
        })();
        await customerVpsReconciliationPromise;
      };
      void runCustomerVpsReconciliation();
      customerVpsReconciliationInterval = setInterval(runCustomerVpsReconciliation, reconciliationIntervalMs);
      customerVpsReconciliationInterval.unref();
    }
  }

  const appEnv = process.env;
  const legacyContainerRoutingEnabled =
    appEnv.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED === 'true' && !customerVpsService;
  const app = createPlatformApp({
    db,
    atsDb,
    docker,
    orchestrator,
    clerkAuth,
    matrixProvisioner,
    integrationRoutes,
    internalIntegrationRoutes,
    internalSyncRoutes,
    customerVpsService,
    goldenSnapshotService,
    goldenSnapshotConfig,
    customerVpsObjectStore,
    hostBundleObjectStore,
    env: appEnv,
  });
  const processPosthogErrorTracker = createPostHogErrorTracker({
    service: 'matrix-platform',
  });
  const posthogProcessErrors = installPostHogProcessErrorTracking({
    tracker: processPosthogErrorTracker,
    service: 'matrix-platform',
  });

  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`Platform listening on :${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[platform] Received ${signal}, shutting down`);
    if (customerVpsReconciliationInterval) {
      clearInterval(customerVpsReconciliationInterval);
    }
    if (goldenSnapshotInterval) clearInterval(goldenSnapshotInterval);
    const shutdownTimer = setTimeout(() => {
      console.error('[platform] Graceful shutdown timed out');
      process.exit(1);
    }, 10_000);
    shutdownTimer.unref();

    (server as Server).close((err?: Error) => {
      let exitCode = 0;
      if (err) {
        exitCode = 1;
        console.error('[platform] HTTP server close failed:', err.message);
      }
      (async () => {
        if (customerVpsReconciliationPromise) {
          await customerVpsReconciliationPromise;
        }
        if (goldenSnapshotPromise) await goldenSnapshotPromise;
        await Promise.allSettled([
          containerProxyDispatcher.close(),
          customerVpsProxyDispatcher.close(),
        ]);
        posthogProcessErrors.dispose();
        await app.shutdownPostHog();
        await processPosthogErrorTracker.shutdown();
        await Promise.all([db.destroy(), atsDb?.destroy()]);
      })()
        .catch((destroyErr: unknown) => {
          exitCode = 1;
          console.error(
            '[platform] Shutdown cleanup failed:',
            destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
          );
        })
        .finally(() => {
          clearTimeout(shutdownTimer);
          process.exit(exitCode);
        });
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  registerPlatformWebSocketUpgradeHandler({
    server: server as Server,
    app,
    db,
    docker,
    clerkAuth,
    env: appEnv,
    platformSecret,
    platformJwtSecret,
    legacyContainerRoutingEnabled,
    codeServerPort,
    getRuntimeEntitlementDecision,
    getRuntimeEntitlementDecisionForUser,
  });
}
