import { serve } from '@hono/node-server';
import {
  createPostHogErrorTracker,
  installPostHogProcessErrorTracking,
  type MatrixTelemetryEvent,
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
import { buildCustomMcpProjectionUrl } from './custom-mcp-projection.js';
import { backfillFirstRunRecords } from './journey.js';
import { logPlatformRouteError } from './platform-route-utils.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { dispatchBillingRuntimeActions } from './billing-runtime-actions.js';
import { registerPlatformWebSocketUpgradeHandler } from './platform-websocket-upgrade.js';
import {
  createR2CapabilityGate,
  createStorageGatedHetznerClient,
  type R2CapabilityGate,
} from './r2-capability.js';

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
  destroy(): Promise<void>;
  getUserByClerkId(clerkId: string): Promise<GatewayPlatformUser | null>;
  getUserById(id: string): Promise<GatewayPlatformUser | null>;
  ensureUser(input: {
    clerkId: string;
    handle: string;
    displayName: string;
    email: string;
    containerId: string;
    pipedreamExternalId?: string;
  }): Promise<GatewayPlatformUser>;
}

interface GatewayCustomMcpModules {
  broker: {
    CustomMcpBroker: new (options: Record<string, unknown>) => {
      sweepPending(): Promise<number>;
      shutdown(): Promise<void>;
      getPreset(userId: string, presetId: string): Promise<any>;
      ensurePreset(input: { userId: string; presetId: string; name: string; url: string }): Promise<any>;
      activatePreset(input: { userId: string; presetId: string; allowedTools: readonly string[]; requiredTools?: readonly string[] }): Promise<any>;
      callSelectedTool(input: { userId: string; serverId: string; toolName: string; arguments?: Record<string, unknown>; approvalGranted: boolean }): Promise<unknown>;
      remove(userId: string, serverId: string): Promise<void>;
    };
  };
  oauth: {
    CustomMcpOAuthManager: new (options: Record<string, unknown>) => {
      start(userId: string, serverId: string): Promise<string>;
      complete(userId: string, state: string, code: string): Promise<{ serverId: string }>;
      resolveAuthorization(userId: string, row: unknown): Promise<string | undefined>;
      revoke(credential: unknown): Promise<void>;
    };
  };
  crypto: { parseCustomMcpEncryptionKey(value?: string): Buffer };
  routes: {
    createCustomMcpRoutes(options: Record<string, unknown>): Hono;
  };
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
    mcpPresetBroker?: unknown;
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
  headObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ exists: boolean; etag?: string }>;
  deleteObject(key: string, options?: { signal?: AbortSignal }): Promise<void>;
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
  customMcpRoutes?: Hono<any>;
  internalCustomMcpRoutes?: Hono<any>;
  internalSyncRoutes?: Hono<any>;
  customerVpsService?: CustomerVpsService;
  goldenSnapshotService?: GoldenSnapshotService;
  goldenSnapshotConfig?: GoldenSnapshotRuntimeConfig;
  customerVpsObjectStore?: CustomerVpsObjectStore;
  hostBundleObjectStore?: CustomerVpsObjectStore;
  assertPrimaryStorageReady?: (options?: { force?: boolean }) => Promise<void>;
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
  checkCustomerVpsPrimaryStorageEnv(): string[];
  checkHomeMirrorS3Env(): string[];
  checkHostBundleStorageEnv(): string[];
  collectTenantPublicTelemetryEnv(): string[];
  stripeBillingEntitlementsEnabled(env: NodeJS.ProcessEnv): boolean;
  resolveEffectiveBillingEntitlement(
    db: PlatformDB,
    clerkUserId: string,
    now?: Date,
    runtimeSlot?: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<BillingEntitlement | null>;
  getRuntimeEntitlementDecision(env?: NodeJS.ProcessEnv): EntitlementAccessDecision;
  getRuntimeEntitlementDecisionForUser(
    db: PlatformDB,
    clerkUserId: string,
    env: NodeJS.ProcessEnv,
    runtimeSlot?: string,
    provisioningClass?: string,
  ): Promise<EntitlementAccessDecision>;
}

async function importRuntimeModule<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

async function startPlatformServerWithCleanup(
  opts: StartPlatformServerOptions,
  registerCustomMcpStartupCleanup: (cleanup: () => Promise<void>) => void,
): Promise<void> {
  const {
    port,
    platformSecret,
    platformJwtSecret,
    codeServerPort,
    containerProxyDispatcher,
    customerVpsProxyDispatcher,
    createApp: createPlatformApp,
    checkUnsafeDefaultSecrets,
    checkCustomerVpsPrimaryStorageEnv,
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
  if (checkCustomerVpsPrimaryStorageEnv().length > 0) {
    process.exit(1);
  }
  const backgroundWorkersEnabled = process.env.PLATFORM_BACKGROUND_WORKERS_ENABLED !== 'false';
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
    if (backgroundWorkersEnabled) lifecycle.start();

    const statsCollector = createStatsCollector({
      docker,
      listRunning: () => listContainers(db, 'running'),
      onResolvedContainerId: async (handle, containerId) => {
        await updateContainerStatus(db, handle, 'running', containerId);
      },
    });
    if (backgroundWorkersEnabled) statsCollector.start();
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
  const homeserverUrl = process.env.MATRIX_HOMESERVER_URL;
  const registrationToken = process.env.MATRIX_REGISTRATION_TOKEN;
  if (homeserverUrl && !registrationToken) {
    console.error('[platform] MATRIX_REGISTRATION_TOKEN is required when MATRIX_HOMESERVER_URL is set');
    process.exit(1);
  }
  if (homeserverUrl) {
    const { createMatrixProvisioner } = await import('./matrix-provisioning.js');
    matrixProvisioner = createMatrixProvisioner({
      db,
      homeserverUrl,
      registrationToken: registrationToken!,
    });
    console.log(`[matrix] Provisioner enabled (${homeserverUrl})`);
  }

  let integrationRoutes: Hono | undefined;
  let internalIntegrationRoutes: Hono | undefined;
  let customMcpRoutes: Hono | undefined;
  let internalCustomMcpRoutes: Hono | undefined;
  let customMcpSweepInterval: NodeJS.Timeout | undefined;
  let customMcpShutdown: (() => Promise<void>) | undefined;
  let managedMcpPresetBroker: {
    listConnections(userId: string): Promise<any[]>;
    connect(userId: string, service: any): Promise<{ url: string }>;
    call(input: { userId: string; service: any; actionId: string; params?: Record<string, unknown> }): Promise<unknown>;
    disconnect(userId: string, connectionId: string): Promise<boolean>;
  } | undefined;
  const managedMcpPresetProxy = {
    listConnections: (userId: string) => managedMcpPresetBroker?.listConnections(userId) ?? Promise.resolve([]),
    connect: (userId: string, service: any) => {
      if (!managedMcpPresetBroker) throw new Error('Managed MCP preset broker unavailable');
      return managedMcpPresetBroker.connect(userId, service);
    },
    call: (input: { userId: string; service: any; actionId: string; params?: Record<string, unknown> }) => {
      if (!managedMcpPresetBroker) throw new Error('Managed MCP preset broker unavailable');
      return managedMcpPresetBroker.call(input);
    },
    disconnect: (userId: string, connectionId: string) => managedMcpPresetBroker?.disconnect(userId, connectionId) ?? Promise.resolve(false),
  };
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
      ...(process.env.CUSTOM_MCP_ENABLED === 'true' ? { mcpPresetBroker: managedMcpPresetProxy } : {}),
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
      ...(process.env.CUSTOM_MCP_ENABLED === 'true' ? { mcpPresetBroker: managedMcpPresetProxy } : {}),
    });
  }

  if (process.env.CUSTOM_MCP_ENABLED === 'true') {
    const oauthClientId = process.env.MCP_OAUTH_CLIENT_ID;
    const oauthRedirectUri = process.env.MCP_OAUTH_CALLBACK_URL;
    const encryptionKeyRaw = process.env.MCP_CREDENTIAL_ENCRYPTION_KEY;
    if (!oauthClientId || !oauthRedirectUri || !platformSecret) {
      throw new Error(
        'Custom MCP requires MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CALLBACK_URL, and PLATFORM_SECRET',
      );
    }
    if (!encryptionKeyRaw || [
      platformSecret,
      process.env.PIPEDREAM_CLIENT_SECRET,
      process.env.STRIPE_SECRET_KEY,
      process.env.UPGRADE_TOKEN,
      process.env.PLATFORM_JWT_SECRET,
    ].some((secret) => Boolean(secret) && secret === encryptionKeyRaw)) {
      throw new Error('MCP_CREDENTIAL_ENCRYPTION_KEY is required and must not reuse another platform secret');
    }
    const [brokerModule, oauthModule, cryptoModule, routesModule, dbModule] = await Promise.all([
      importRuntimeModule<GatewayCustomMcpModules['broker']>('../../gateway/dist/integrations/custom-mcp/broker.js'),
      importRuntimeModule<GatewayCustomMcpModules['oauth']>('../../gateway/dist/integrations/custom-mcp/oauth.js'),
      importRuntimeModule<GatewayCustomMcpModules['crypto']>('../../gateway/dist/integrations/custom-mcp/crypto.js'),
      importRuntimeModule<GatewayCustomMcpModules['routes']>('../../gateway/dist/integrations/custom-mcp/routes.js'),
      importRuntimeModule<GatewayPlatformDbModule>('../../gateway/dist/platform-db.js'),
    ]);
    const encryptionKey = cryptoModule.parseCustomMcpEncryptionKey(encryptionKeyRaw);
    const customDb = dbModule.createPlatformDb(runtimeConfig.platformDatabaseUrl);
    let customDbClosed = false;
    const closeCustomMcpDb = async () => {
      if (customDbClosed) return;
      customDbClosed = true;
      await customDb.destroy();
    };
    // Register the owned pool before the first fallible operation so the
    // outer startup guard can release it even when migration fails.
    customMcpShutdown = closeCustomMcpDb;
    registerCustomMcpStartupCleanup(closeCustomMcpDb);
    await customDb.migrate();

    const resolveCustomMcpUserId = async (clerkUserId: string | undefined, handle: string | undefined) => {
      if (!clerkUserId || !handle) return null;
      const existing = await customDb.getUserByClerkId(clerkUserId);
      if (existing) return existing.id;
      const owner = (await getRunningUserMachineByHandle(db, handle)) ?? (await getContainer(db, handle));
      if (!owner || owner.clerkUserId !== clerkUserId) return null;
      return (await customDb.ensureUser({
        clerkId: clerkUserId,
        handle,
        displayName: handle,
        email: `${handle}@matrix-os.local`,
        containerId: `platform:${clerkUserId}`,
      })).id;
    };
    const projectionRequest = async (
      userId: string,
      method: 'GET' | 'POST' | 'DELETE',
      serverId?: string,
      body?: unknown,
    ): Promise<unknown> => {
      const user = await customDb.getUserById(userId);
      if (!user) throw new Error('Custom MCP owner is unavailable');
      const machine = await getRunningUserMachineByHandle(db, user.handle);
      if (!machine || machine.clerkUserId !== user.clerkId) {
        throw new Error('Custom MCP owner runtime is unavailable');
      }
      const target = buildCustomMcpProjectionUrl(machine, serverId);
      const response = await fetch(target, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${buildPlatformVerificationToken(user.handle, platformSecret)}`,
          'x-matrix-clerk-user-id': user.clerkId,
          host: 'app.matrix-os.com',
          'x-forwarded-host': 'app.matrix-os.com',
          'x-forwarded-proto': 'https',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher: customerVpsProxyDispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (!response.ok) throw new Error(`Custom MCP projection failed (${response.status})`);
      return response.status === 204 ? undefined : response.json();
    };
    const projection = {
      upsert: (userId: string, server: unknown) => projectionRequest(userId, 'POST', undefined, server).then(() => undefined),
      remove: (userId: string, serverId: string) => projectionRequest(userId, 'DELETE', serverId).then(() => undefined),
      read: (userId: string, serverId: string) => projectionRequest(userId, 'GET', serverId),
    };
    let oauthManager: InstanceType<GatewayCustomMcpModules['oauth']['CustomMcpOAuthManager']>;
    const broker = new brokerModule.CustomMcpBroker({
      db: customDb,
      encryptionKey,
      projection,
      resolveOAuthAuthorization: (userId: string, row: unknown) => oauthManager.resolveAuthorization(userId, row),
      revokeOAuth: (credential: unknown) => oauthManager.revoke(credential),
    });
    let customMcpClosed = false;
    customMcpShutdown = async () => {
      if (customMcpClosed) return;
      customMcpClosed = true;
      try {
        await broker.shutdown();
      } finally {
        await closeCustomMcpDb();
      }
    };
    registerCustomMcpStartupCleanup(customMcpShutdown);
    oauthManager = new oauthModule.CustomMcpOAuthManager({
      db: customDb,
      encryptionKey,
      clientId: oauthClientId,
      redirectUri: oauthRedirectUri,
    });
    const GRANOLA_PRESET = {
      id: 'granola',
      name: 'Granola',
      url: 'https://mcp.granola.ai/mcp',
      tools: ['list_meetings', 'get_meetings', 'get_meeting_transcript'] as const,
    };
    managedMcpPresetBroker = {
      listConnections: async (userId) => {
        let row = await broker.getPreset(userId, GRANOLA_PRESET.id);
        if (!row) return [];
        if (row.status === 'disabled') {
          try {
            row = await broker.activatePreset({
              userId,
              presetId: GRANOLA_PRESET.id,
              allowedTools: GRANOLA_PRESET.tools,
              requiredTools: ['list_meetings', 'get_meetings'],
            });
          } catch (error: unknown) {
            console.warn('[granola] preset activation pending:', error instanceof Error ? error.message : String(error));
          }
        }
        return [{
          id: row.id,
          service: GRANOLA_PRESET.id,
          account_label: GRANOLA_PRESET.name,
          account_email: null,
          scopes: [],
          status: row.status === 'ready' ? 'active' : row.status,
          connected_at: row.created_at,
          last_used_at: null,
        }];
      },
      connect: async (userId) => {
        const row = await broker.ensurePreset({
          userId,
          presetId: GRANOLA_PRESET.id,
          name: GRANOLA_PRESET.name,
          url: GRANOLA_PRESET.url,
        });
        return { url: await oauthManager.start(userId, row.id) };
      },
      call: async ({ userId, actionId, params }) => {
        const row = await broker.activatePreset({
          userId,
          presetId: GRANOLA_PRESET.id,
          allowedTools: GRANOLA_PRESET.tools,
          requiredTools: ['list_meetings', 'get_meetings'],
        });
        if (actionId === 'list_notes') {
          return broker.callSelectedTool({
            userId,
            serverId: row.id,
            toolName: 'list_meetings',
            arguments: params,
            approvalGranted: true,
          });
        }
        if (actionId !== 'get_note' || typeof params?.noteId !== 'string') {
          throw new Error('Unknown Granola action');
        }
        const argumentsFor = (toolName: string) => {
          const tool = row.tools.find((candidate: any) => candidate.name === toolName);
          const properties = tool?.inputSchema?.properties as Record<string, unknown> | undefined;
          const single = ['meeting_id', 'meetingId', 'id'].find((key) => properties?.[key]);
          if (single) return { [single]: params.noteId };
          const plural = ['meeting_ids', 'meetingIds', 'ids'].find((key) => properties?.[key]);
          if (plural) return { [plural]: [params.noteId] };
          throw new Error(`Granola ${toolName} schema has no supported meeting identifier`);
        };
        const note = await broker.callSelectedTool({
          userId,
          serverId: row.id,
          toolName: 'get_meetings',
          arguments: argumentsFor('get_meetings'),
          approvalGranted: true,
        });
        if (params.includeTranscript !== true) return note;
        const transcript = await broker.callSelectedTool({
          userId,
          serverId: row.id,
          toolName: 'get_meeting_transcript',
          arguments: argumentsFor('get_meeting_transcript'),
          approvalGranted: true,
        });
        return { note, transcript };
      },
      disconnect: async (userId, connectionId) => {
        const row = await broker.getPreset(userId, GRANOLA_PRESET.id);
        if (!row || row.id !== connectionId) return false;
        await broker.remove(userId, connectionId);
        return true;
      },
    };
    customMcpRoutes = routesModule.createCustomMcpRoutes({
      broker,
      oauth: oauthManager,
      resolveUserId: async (c: Context) => resolveCustomMcpUserId(
        c.get('platformUserId') as string | undefined,
        c.get('platformHandle') as string | undefined,
      ),
    });
    internalCustomMcpRoutes = routesModule.createCustomMcpRoutes({
      broker,
      oauth: oauthManager,
      allowToolCalls: true,
      resolveUserId: async (c: Context) => resolveCustomMcpUserId(
        c.get('internalContainerClerkUserId') as string | undefined,
        c.get('internalContainerHandle') as string | undefined,
      ),
    });
    const sweepPending = () => broker.sweepPending().catch((error: unknown) => {
      console.error('[custom-mcp] pending sweep failed:', error instanceof Error ? error.message : String(error));
    });
    void sweepPending();
    customMcpSweepInterval = setInterval(sweepPending, 60 * 60 * 1_000);
    customMcpSweepInterval.unref();
  }

  let internalSyncRoutes: Hono | undefined;
  let customerVpsObjectStore: CustomerVpsObjectStore | undefined;
  let hostBundleObjectStore: CustomerVpsObjectStore | undefined;
  let primaryStorageGate: R2CapabilityGate | undefined;
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
      r2PrefixRoot: process.env.R2_PREFIX_ROOT ?? 'matrixos-sync',
    });
    customerVpsObjectStore = r2;
    hostBundleObjectStore = r2;
    primaryStorageGate = createR2CapabilityGate({ storage: r2 });
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
  let billingRuntimeCaptureEvent: ((
    event: 'matrix_vps_suspended' | 'matrix_vps_resumed',
    options: { properties: Record<string, string | number | boolean | undefined> },
  ) => void) | undefined;
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
    const baseHetzner = createHetznerClient(customerVpsConfig);
    const hetzner = createStorageGatedHetznerClient(baseHetzner, async () => {
      if (!primaryStorageGate) throw new Error('Primary storage unavailable');
      await primaryStorageGate.assertReady();
    });
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
        ? (billingDb, clerkUserId, runtimeSlot) => resolveEffectiveBillingEntitlement(
            billingDb,
            clerkUserId,
            new Date(),
            runtimeSlot,
            process.env,
          )
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
          listRevokedGoldenSnapshotBaseGenerations,
          listRunnableGoldenSnapshotBuildIds,
          listUnresolvedGoldenSnapshotBuildIds,
          reconcileRevokedGoldenSnapshotBaseGeneration,
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
            let revocationBudget = goldenSnapshotConfig.reconciliationBatchSize;
            const revokedBaseGenerations = await listRevokedGoldenSnapshotBaseGenerations(
              db, goldenSnapshotConfig.reconciliationBatchSize,
            );
            for (const baseGeneration of revokedBaseGenerations) {
              if (revocationBudget <= 0) break;
              try {
                const reconciled = await reconcileRevokedGoldenSnapshotBaseGeneration(
                  db, baseGeneration, workerNow, revocationBudget,
                );
                revocationBudget -= reconciled.processed;
              } catch (err: unknown) {
                console.error(`[golden-snapshot] revoked generation reconciliation failed: ${err instanceof Error ? err.name : typeof err}`);
              }
            }
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
              testModeTtlMs: goldenSnapshotConfig.testModeTtlMs,
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
      if (backgroundWorkersEnabled && intervalMs !== undefined) {
        void runGoldenSnapshotWorker();
        goldenSnapshotInterval = setInterval(runGoldenSnapshotWorker, intervalMs);
        goldenSnapshotInterval.unref();
      }
    }
    const reconciliationIntervalMs = Number(process.env.CUSTOMER_VPS_RECONCILIATION_INTERVAL_MS ?? 60_000);
    if (backgroundWorkersEnabled && reconciliationIntervalMs > 0) {
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
              const result = await dispatchBillingRuntimeActions({
                db,
                customerVpsService: customerVpsService!,
                captureEvent: billingRuntimeCaptureEvent,
              });
              if (result.checked > 0) {
                console.log(
                  `[platform] billing runtime actions checked=${result.checked} completed=${result.completed} retried=${result.retried} failed=${result.failed}`,
                );
              }
            } catch (err: unknown) {
              logPlatformRouteError('billing runtime action reconciliation', err);
            }
            try {
              const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
              await sweepStaleCheckoutAttempts(
                db,
                thirtyDaysAgoIso,
                new Date().toISOString(),
                200,
              );
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
    customMcpRoutes,
    internalCustomMcpRoutes,
    internalSyncRoutes,
    customerVpsService,
    goldenSnapshotService,
    goldenSnapshotConfig,
    customerVpsObjectStore,
    hostBundleObjectStore,
    assertPrimaryStorageReady: primaryStorageGate?.assertReady,
    env: appEnv,
  });
  const processPosthogErrorTracker = createPostHogErrorTracker({
    service: 'matrix-platform',
  });
  billingRuntimeCaptureEvent = (event, options) => {
    app.capturePlatformEvent(event as MatrixTelemetryEvent, options.properties);
  };
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
    if (customMcpSweepInterval) clearInterval(customMcpSweepInterval);
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
          customMcpShutdown?.(),
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

export async function startPlatformServer(opts: StartPlatformServerOptions): Promise<void> {
  let customMcpStartupCleanup: (() => Promise<void>) | undefined;
  try {
    await startPlatformServerWithCleanup(opts, (cleanup) => {
      customMcpStartupCleanup = cleanup;
    });
  } catch (startupError: unknown) {
    try {
      await customMcpStartupCleanup?.();
    } catch (cleanupError: unknown) {
      console.error(
        '[platform] Custom MCP startup cleanup failed:',
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
    }
    throw startupError;
  }
}
