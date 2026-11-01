import { parseIsolatedChatEnvelope } from "@matrix-os/contracts";
import { z } from 'zod/v4';
import { createAccountDeletionMutationGuard } from './account-deletion/integration-admission.js';
import { createConfiguredAccountDeletionRuntime } from './account-deletion/wiring.js';
import type { AccountDeletionAdapterOptions } from './account-deletion/adapters.js';
import { serve } from '@hono/node-server';
import {
  createPostHogErrorTracker,
  installPostHogProcessErrorTracking,
  type MatrixTelemetryEvent,
} from '@matrix-os/observability';
import { Hono, type Context } from 'hono';
import type { Server } from 'node:http';
import type Dockerode from 'dockerode';
import type { Agent } from 'undici';
import { shouldEnablePlatformBackgroundWorkers } from './platform-worker-mode.js';
import { resolvePlatformObjectStorage } from './object-storage-config.js';
import { resolveSitesObjectStorage } from './sites/storage-config.js';
import { runPlatformStartupWithCleanup } from './platform-startup-cleanup.js';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createPlatformDb,
  getContainer,
  getRunningUserMachineByHandle,
  listContainers,
  updateContainerStatus,
  type PlatformDB,
} from './db.js';
import { createAtsDb, resolveAtsDatabaseUrl, type AtsDB } from './ats-db.js';
import { startAtsBackgroundWorker } from './ats-background-worker.js';
import { startGooglePurchaseWorker } from './billing/google-purchases.js';
import type { Orchestrator } from './orchestrator.js';
import type { ClerkAuth } from './clerk-auth.js';
import {
  createClerkAuth,
  createClerkSessionRevoker,
  resolveClerkVerificationConfig,
} from './clerk-auth.js';
import type { MatrixProvisioner } from './matrix-provisioning.js';
import type { CustomerVpsService } from './customer-vps.js';
import type { GoldenSnapshotService } from './golden-snapshot-service.js';
import type { GoldenSnapshotRuntimeConfig } from './golden-snapshot-schema.js';
import type { CustomerVpsObjectStore } from './customer-vps-r2.js';
import type { EntitlementAccessDecision } from './profile-routing.js';
import type { BillingEntitlement } from './billing.js';
import type { PlatformApp } from './platform-app-types.js';
import { shutdownPlatformApp } from './shutdown-platform-app.js';
import {
  PlatformStartupConfigError,
  loadPlatformRuntimeConfig,
} from './runtime-mode.js';
import { resolvePlatformIntegrationConfig } from './integration-config.js';
import { createInternalCustomMcpApprovalRouteOptions } from './custom-mcp-approval-route-options.js';
import { createPreviewDriveIntegration } from './preview-drive-integration.js';
import { createPreviewDriveStore } from './preview-drive-store.js';
import type { PreviewDriveIntegration } from './preview-drive-routes.js';
import { createCustomMcpProjection } from './custom-mcp-projection.js';
import { listActivePrivatePreviewsForOwner } from './database/private-previews.js';
import { createPrivatePreviewAccess } from './private-preview-wiring.js';
import {
  createGranolaPresetBroker,
  type ManagedMcpPresetBroker,
} from './granola-preset-broker.js';
import { MATRIX_OAUTH_CLIENT_METADATA, MATRIX_OAUTH_CLIENT_METADATA_URL } from './oauth-client-metadata.js';
import { createManagedOAuthPresetBroker } from './managed-oauth-preset-broker.js';
import { createManagedPresetRouter } from './managed-preset-router.js';
import { BokioOAuthManager, type BokioCredentialStore, type BokioCredentialCrypto } from './bokio-oauth.js';
import { createBokioPresetBroker } from './bokio-preset-broker.js';
import { createManagedPresetLifecycle } from './managed-preset-lifecycle.js';
import { logPlatformRouteError } from './platform-route-utils.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import {
  runCustomerVpsReconciliationPass,
  startCustomerVpsReconciliationWorker,
  type CustomerVpsReconciliationWorker,
} from './customer-vps-reconciliation-worker.js';
import { createPrivatePreviewSweep } from './private-preview-sweep.js';
import { createFundedHostActivationRoutes } from './funded-host-activation.js';
import { createManagedFeatureActivator, createManagedFeatureReconciliationPass, type ManagedFeatureActivator } from './managed-feature-activation.js';
import { registerPlatformWebSocketUpgradeHandler } from './platform-websocket-upgrade.js';
import { createAiFundedPolicyRepository, type AiFundedPolicyRepository } from './ai-funded-policy-repository.js';
import { cleanupExpiredReservations } from './ai-funded-reservation-cleanup.js';
import { createAiFundedReservationCleanupWorker } from './ai-funded-reservation-cleanup-worker.js';
import {
  createAiFundedOperatorRoutes,
  createAiFundedRelayRoutes,
  createAiFundedRuntimeRoutes,
  loadAiFundedControlPlaneConfig,
} from './ai-funded-policy-routes.js';
import { loadAiCreditCheckoutConfig } from './ai-credit-checkout.js';
import { createFundedModelProbeService, loadFundedModelProbeLimits, type FundedModelProbeService } from './ai-funded-model-probes.js';
import {
  createR2CapabilityGate,
  createStorageGatedHetznerClient,
  type R2CapabilityGate,
} from './r2-capability.js';
import { bootstrapPlatformCollaboration } from './collaboration/bootstrap.js';
import { bootstrapPlatformSlack } from './slack-startup.js';
import type { PlatformCollaborationComposition } from './collaboration/wiring.js';
import { getCustomMcpProjectionMachine, resolveCustomMcpUserIdForMachine } from './custom-mcp-route-registration.js';
import { createSpeechRuntimeRoutes } from './speech/routes.js';
import {
  PlatformSpeechConfigError,
  loadPlatformSpeechConfig,
} from './speech/config.js';
import { createConfiguredPlatformSpeechService } from './speech/wiring.js';
import { loadPreviewRuntimeAccessConfig } from './preview-runtime-access.js';
import { createPreviewRuntimeAccessActivator, type PreviewRuntimeAccessActivator } from './preview-runtime-activation.js';
import { createConfiguredWhatsAppRuntime } from './whatsapp/startup.js';
import { createAccountDeletionIntegrationWebhookAdmission } from './account-deletion/integration-webhook.js';
import { appOrigin } from './origins.js';

interface GatewayPlatformUser {
  id: string;
  clerk_id: string;
  handle: string;
  pipedream_external_id?: string | null;
}

interface GatewayConnectedService {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
  pipedream_account_id: string;
}

export function parseGoldenSnapshotReconciliationInterval(raw: string | undefined): number | undefined {
  const value = Number(raw ?? 15_000);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) return undefined;
  return value;
}

interface GatewayPlatformDb extends BokioCredentialStore {
  migrate(): Promise<void>;
  destroy(): Promise<void>;
  sweepCustomMcpApprovals(now: Date): Promise<number>;
  getUserByClerkId(clerkId: string): Promise<GatewayPlatformUser | null>;
  getUserById(id: string): Promise<GatewayPlatformUser | null>;
  listConnectedServices(userId: string): Promise<GatewayConnectedService[]>;
  touchServiceUsage(connectionId: string): Promise<void>;
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
      activatePreset(input: { userId: string; presetId: string; allowedTools: readonly string[]; requiredTools?: readonly string[]; expectedRevision?: number }): Promise<any>;
      callSelectedTool(input: { userId: string; serverId: string; toolName: string; arguments?: Record<string, unknown>; approvalGranted: boolean }): Promise<unknown>;
      callManagedPresetTool(input: { userId: string; serverId: string; presetId: string; toolName: string; arguments?: Record<string, unknown> }): Promise<unknown>;
      remove(userId: string, serverId: string): Promise<void>;
      removeForAccountDeletion(userId: string, serverId: string): Promise<void>;
    };
  };
  oauth: {
    CustomMcpOAuthManager: new (options: Record<string, unknown>) => {
      start(userId: string, serverId: string, options?: { scopes?: readonly string[] }): Promise<string>;
      complete(state: string, code: string): Promise<{ serverId: string }>;
      resolveAuthorization(userId: string, row: unknown): Promise<string | undefined>;
      revoke(credential: unknown): Promise<void>;
    };
  };
  crypto: BokioCredentialCrypto & { parseCustomMcpEncryptionKey(value?: string): Buffer };
  routes: {
    createCustomMcpRoutes(options: Record<string, unknown>): Hono;
  };
  approvalRoutes: {
    createCustomMcpApprovalRoutes(options: Record<string, unknown>): Hono;
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
  createPipedreamClient(config: GatewayPipedreamConfig): Promise<NonNullable<AccountDeletionAdapterOptions['pipedream']>>;
}

interface GatewayIntegrationRoutesModule {
  authorizeInternalJevLabels(c: Context): Promise<boolean>;
  createIntegrationRoutes(opts: {
    db: GatewayPlatformDb;
    pipedream: unknown;
    webhookSecret: string;
    resolveUserId: (c: Context) => Promise<string | null>;
    authorizeJevLabelCall?: (c: Context) => Promise<boolean>;
    mcpPresetBroker?: unknown;
    verifiedConnectedWebhook?: ReturnType<typeof createAccountDeletionIntegrationWebhookAdmission>;
  }): Hono;
  executeIntegrationAction(opts: {
    pipedream: unknown; externalUserId: string;
    connection: { pipedream_account_id: string };
    def: any; actionDef: any; serviceId: string; actionId: string;
    params: Record<string, unknown>;
  }): Promise<{ data: unknown; summary?: string }>;
}

interface GatewayIntegrationRegistryModule {
  getService(serviceId: string): any;
  getAction(serviceId: string, actionId: string): any;
}

type GatewayR2Client = import("./r2-client.js").R2Client;

interface GatewayR2ClientModule {
  createR2Client(config: import('./r2-client.js').R2ClientConfig): Promise<GatewayR2Client>;
}

type CreatePlatformApp = (deps: {
  accountDeletion?: import('./account-deletion/wiring.js').AccountDeletionRuntime;
  db: PlatformDB;
  atsDb?: AtsDB;
  docker?: Dockerode;
  orchestrator: Orchestrator;
  clerkAuth?: ClerkAuth;
  matrixProvisioner?: MatrixProvisioner;
  integrationRoutes?: Hono<any>;
  internalIntegrationRoutes?: Hono<any>;
  previewDriveIntegration?: PreviewDriveIntegration;
  customMcpRoutes?: Hono<any>;
  internalCustomMcpRoutes?: Hono<any>;
  internalCustomMcpApprovalRoutes?: Hono<any>;
  internalSyncRoutes?: Hono<any>;
  internalFundedAiRuntimeRoutes?: Hono<any>;
  internalFundedAiRelayRoutes?: Hono<any>;
  internalFundedAiOperatorRoutes?: Hono<any>;
  internalSpeechRuntimeRoutes?: Hono<any>;
  whatsappRoutes?: Hono<any>;
  fundedAiRepository?: AiFundedPolicyRepository;
  fundedModelProbes?: FundedModelProbeService;
  collaboration?: PlatformCollaborationComposition;
  slackRoutes?: Hono<any>;
  customerVpsService?: CustomerVpsService;
  activateManagedFeatures?: ManagedFeatureActivator;
  activatePreviewRuntimeAccess?: PreviewRuntimeAccessActivator;
  goldenSnapshotService?: GoldenSnapshotService;
  goldenSnapshotConfig?: GoldenSnapshotRuntimeConfig;
  customerVpsObjectStore?: CustomerVpsObjectStore;
  hostBundleObjectStore?: CustomerVpsObjectStore;
  sitesObjectStore?: CustomerVpsObjectStore;
  assertPrimaryStorageReady?: (options?: { force?: boolean }) => Promise<void>;
  assertSitesStorageReady?: (options?: { force?: boolean }) => Promise<void>;
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
  checkPublicSitesEnv(): string[];
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
    checkPublicSitesEnv,
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
  if (checkPublicSitesEnv().length > 0) {
    process.exit(1);
  }
  const backgroundWorkersEnabled = shouldEnablePlatformBackgroundWorkers(process.env);
  let runtimeConfig;
  let speechConfig;
  try {
    runtimeConfig = loadPlatformRuntimeConfig();
    speechConfig = loadPlatformSpeechConfig(process.env);
    if (speechConfig.enabled && platformSecret.length < 32) throw new PlatformSpeechConfigError();
  } catch (err: unknown) {
    if (err instanceof PlatformStartupConfigError || err instanceof PlatformSpeechConfigError) {
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
  const fundedAiConfig = loadAiFundedControlPlaneConfig({
    ...process.env,
    PLATFORM_SECRET: platformSecret,
  });
  const previewRuntimeAccess = loadPreviewRuntimeAccessConfig({ ...process.env, PLATFORM_SECRET: platformSecret });
  let internalFundedAiRuntimeRoutes: Hono | undefined;
  let internalFundedAiRelayRoutes: Hono | undefined;
  let internalFundedAiOperatorRoutes: Hono | undefined;
  const speechService = createConfiguredPlatformSpeechService({ db, config: speechConfig, previewRuntimeAccess });
  const internalSpeechRuntimeRoutes = platformSecret.length >= 32
    ? createSpeechRuntimeRoutes({ db, platformSecret,
      ...(previewRuntimeAccess.enabled ? { previewRuntimeSecret: previewRuntimeAccess.runtimeSecret } : {}),
      service: speechService })
    : undefined;
  let fundedAiRepository: AiFundedPolicyRepository | undefined;
  let fundedModelProbes: FundedModelProbeService | undefined;
  if (fundedAiConfig.enabled) {
    fundedAiRepository = createAiFundedPolicyRepository({
      db,
      credentialHashSecret: fundedAiConfig.credentialHashSecret,
      credentialTtlMs: fundedAiConfig.credentialTtlMs,
      issueCooldownMs: fundedAiConfig.issueCooldownMs,
      policyFreshnessMs: fundedAiConfig.policyFreshnessMs,
    });
    const probeLimits = loadFundedModelProbeLimits(process.env);
    fundedModelProbes = createFundedModelProbeService({
      db,
      credentials: fundedAiRepository,
      relayBaseUrl: process.env.MATRIX_FUNDED_AI_RELAY_URL,
      relayControlToken: fundedAiConfig.relayControlToken,
      ...probeLimits,
    });
    internalFundedAiRuntimeRoutes = createAiFundedRuntimeRoutes({
      db,
      platformSecret: fundedAiConfig.platformSecret,
      ...(previewRuntimeAccess.enabled ? { previewRuntimeSecret: previewRuntimeAccess.runtimeSecret } : {}),
      repository: fundedAiRepository,
      topUpEnabled: loadAiCreditCheckoutConfig(process.env).enabled,
      promotionalGrant: fundedAiConfig.promotionalGrant,
      routeProbes: fundedModelProbes,
      isolatedChat: parseIsolatedChatEnvelope(process.env.MATRIX_ISOLATED_CHAT_ENVELOPE),
    });
    internalFundedAiRelayRoutes = createAiFundedRelayRoutes({
      relayControlToken: fundedAiConfig.relayControlToken,
      repository: fundedAiRepository,
    });
    internalFundedAiOperatorRoutes = createAiFundedOperatorRoutes({
      db,
      operatorSecret: fundedAiConfig.platformSecret,
      repository: fundedAiRepository,
      promotionalGrant: fundedAiConfig.promotionalGrant,
    });
    console.log('[platform] Funded AI control plane enabled; relay activation remains disabled');
  }
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
  const clerkVerificationConfig = resolveClerkVerificationConfig(process.env);
  if (clerkVerificationConfig) {
    const { verifyToken } = await import('@clerk/backend');
    clerkAuth = createClerkAuth({
      verifyToken: async (token: string) => {
        const payload = await verifyToken(token, clerkVerificationConfig.verifyTokenOptions);
        return payload as { sub: string; [key: string]: unknown };
      },
      ...(clerkVerificationConfig.sessionRevocationSecret
        ? {
            revokeSession: createClerkSessionRevoker({
              secretKey: clerkVerificationConfig.sessionRevocationSecret,
            }),
          }
        : {}),
    });
  }

  const collaboration = await bootstrapPlatformCollaboration({
    env: process.env,
    db,
    platformSecret,
    platformJwtSecret,
    clerkAuth,
    customerVpsProxyDispatcher,
  });
  const privatePreviewAccess = createPrivatePreviewAccess({
    env: process.env, collaboration, logError: logPlatformRouteError,
  });
  const slack = await bootstrapPlatformSlack({
    env: process.env, db, platformSecret, platformJwtSecret,
    clerkAuth, collaboration, customerVpsProxyDispatcher,
    startCleanup: backgroundWorkersEnabled,
  });

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

  let deletionPipedream: AccountDeletionAdapterOptions['pipedream'];
  let deletionCustomMcp: AccountDeletionAdapterOptions['customMcp'];
  let integrationRoutes: Hono | undefined;
  let internalIntegrationRoutes: Hono | undefined;
  let previewDriveIntegration: PreviewDriveIntegration | undefined;
  let previewDriveSweepInterval: NodeJS.Timeout | undefined;
  let customMcpRoutes: Hono | undefined;
  let internalCustomMcpRoutes: Hono | undefined;
  let internalCustomMcpApprovalRoutes: Hono | undefined;
  let customMcpSweepInterval: NodeJS.Timeout | undefined;
  let customMcpShutdown: (() => Promise<void>) | undefined;
  let managedMcpPresetBroker: ManagedMcpPresetBroker | undefined;
  const managedMcpPresetProxy = {
    listConnections: (userId: string) => managedMcpPresetBroker?.listConnections(userId) ?? Promise.resolve([]),
    listAvailableActions: (userId: string, serviceId: string) =>
      managedMcpPresetBroker?.listAvailableActions(userId, serviceId) ?? Promise.resolve(null),
    listAvailableActionParams: (userId: string, serviceId: string) =>
      managedMcpPresetBroker?.listAvailableActionParams(userId, serviceId) ?? Promise.resolve(null),
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
      { createIntegrationRoutes, executeIntegrationAction, authorizeInternalJevLabels },
      { createPipedreamClient },
      { createPlatformDb: createGatewayPlatformDb },
      { getService, getAction },
    ] = await Promise.all([
      importRuntimeModule<GatewayIntegrationRoutesModule>('../../gateway/dist/integrations/routes.js'),
      importRuntimeModule<GatewayPipedreamModule>('../../gateway/dist/integrations/pipedream.js'),
      importRuntimeModule<GatewayPlatformDbModule>('../../gateway/dist/platform-db.js'),
      importRuntimeModule<GatewayIntegrationRegistryModule>('../../gateway/dist/integrations/registry.js'),
    ]);

    const trustedPlatformDb = createGatewayPlatformDb(integrationConfig.platformDatabaseUrl);
    await trustedPlatformDb.migrate();
    const pipedream = await createPipedreamClient({
      clientId: integrationConfig.pipedreamClientId,
      clientSecret: integrationConfig.pipedreamClientSecret,
      projectId: integrationConfig.pipedreamProjectId,
      environment: integrationConfig.pipedreamEnvironment,
    });
    deletionPipedream = pipedream;
    const verifiedConnectedWebhook=process.env.ACCOUNT_DELETION_SECRET===undefined?undefined:
      createAccountDeletionIntegrationWebhookAdmission({db,pipedream,env:process.env});
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
      verifiedConnectedWebhook,
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
      verifiedConnectedWebhook,
      authorizeJevLabelCall: authorizeInternalJevLabels,
      resolveUserId: async (c) => {
        const clerkUserId = c.get('internalContainerClerkUserId') as string | undefined;
        const handle = c.get('internalContainerHandle') as string | undefined;
        return await resolveIntegrationUserId(clerkUserId, handle);
      },
      ...(process.env.CUSTOM_MCP_ENABLED === 'true' ? { mcpPresetBroker: managedMcpPresetProxy } : {}),
    });
    previewDriveIntegration = createPreviewDriveIntegration({
      db: trustedPlatformDb, pipedream,
      resolveUserId: actorId => resolveIntegrationUserId(actorId, undefined),
      getService, getAction, executeAction: executeIntegrationAction,
    });
  }

  // Authorizations are durable across Cloud Run instances; recurring cleanup
  // keeps the control-plane table bounded even after a Preview disappears.
  const previewDriveStore = createPreviewDriveStore(db);
  previewDriveSweepInterval = setInterval(() => {
    void previewDriveStore.sweep().catch(error => {
      console.warn('[preview-drive] Grant cleanup failed', error instanceof Error ? error.name : typeof error);
    });
  }, 5 * 60_000);
  previewDriveSweepInterval.unref();

  if (process.env.CUSTOM_MCP_ENABLED === 'true') {
    const oauthClientId = process.env.MCP_OAUTH_CLIENT_ID;
    const oauthRedirectUri = process.env.MCP_OAUTH_CALLBACK_URL;
    const encryptionKeyRaw = process.env.MCP_CREDENTIAL_ENCRYPTION_KEY;
    if (!oauthRedirectUri || !platformSecret) {
      throw new Error(
        'Custom MCP requires MCP_OAUTH_CALLBACK_URL and PLATFORM_SECRET',
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
    const [brokerModule, oauthModule, cryptoModule, routesModule, approvalRoutesModule, dbModule] = await Promise.all([
      importRuntimeModule<GatewayCustomMcpModules['broker']>('../../gateway/dist/integrations/custom-mcp/broker.js'),
      importRuntimeModule<GatewayCustomMcpModules['oauth']>('../../gateway/dist/integrations/custom-mcp/oauth.js'),
      importRuntimeModule<GatewayCustomMcpModules['crypto']>('../../gateway/dist/integrations/custom-mcp/crypto.js'),
      importRuntimeModule<GatewayCustomMcpModules['routes']>('../../gateway/dist/integrations/custom-mcp/routes.js'),
      importRuntimeModule<GatewayCustomMcpModules['approvalRoutes']>('../../gateway/dist/integrations/custom-mcp/approval-routes.js'),
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

    const resolveCustomMcpUserId = (clerkUserId: string | undefined, handle: string | undefined) =>
      resolveCustomMcpUserIdForMachine(db, customDb, clerkUserId, handle);
    const projection = createCustomMcpProjection({
      getUser: (userId) => customDb.getUserById(userId),
      getMachine: (user) => getCustomMcpProjectionMachine(db, user),
      listPrivatePreviews: (clerkUserId) => listActivePrivatePreviewsForOwner(db, clerkUserId),
      isEligible: privatePreviewAccess.eligibility,
      platformSecret,
      dispatcher: customerVpsProxyDispatcher,
      logError: logPlatformRouteError,
    });
    const oauthManager = new oauthModule.CustomMcpOAuthManager({
      db: customDb,
      encryptionKey,
      clientId: oauthClientId,
      redirectUri: oauthRedirectUri,
      ...(MATRIX_OAUTH_CLIENT_METADATA.redirect_uris.includes(oauthRedirectUri) ? { clientMetadataUrl: MATRIX_OAUTH_CLIENT_METADATA_URL } : {}),
    });
    const bokioOAuth = new BokioOAuthManager({ db: customDb, encryptionKey, credentialCrypto: cryptoModule,
      clientId: process.env.BOKIO_CLIENT_ID, clientSecret: process.env.BOKIO_CLIENT_SECRET,
      redirectUri: process.env.BOKIO_OAUTH_REDIRECT_URI ?? oauthRedirectUri });
    const bokioBroker = createBokioPresetBroker({ db: customDb, oauth: bokioOAuth });
    const managedLifecycle = createManagedPresetLifecycle({ db: customDb, oauth: oauthManager,
      bokioOAuth, bokioBroker, activatePreset: input => broker.activatePreset(input), decodeState: state => cryptoModule.decryptCustomMcpOAuthState<{ kind?: unknown; userId?: unknown }>(state, encryptionKey) });
    const broker = new brokerModule.CustomMcpBroker({
      db: customDb,
      encryptionKey,
      projection,
      resolveOAuthAuthorization: (userId: string, row: unknown) => oauthManager.resolveAuthorization(userId, row),
      revokeOAuth: (credential: unknown) => oauthManager.revoke(credential),
      removeManagedPreset: managedLifecycle.removeManagedPreset,
    });
    let customMcpClosed = false;
    customMcpShutdown = async () => {
      if (customMcpClosed) return;
      customMcpClosed = true;
      try {
        await broker.shutdown();
        await projection.drain();
      } finally {
        await closeCustomMcpDb();
      }
    };
    registerCustomMcpStartupCleanup(customMcpShutdown);
    deletionCustomMcp = { remove: (userId,serverId) => broker.removeForAccountDeletion(userId,serverId) };
    const granolaBroker = createGranolaPresetBroker({ broker, oauth: oauthManager });
    const managedOAuthBroker = createManagedOAuthPresetBroker({ broker, oauth: oauthManager });
    managedMcpPresetBroker = createManagedPresetRouter({
      granola: granolaBroker, posthog_oauth: managedOAuthBroker, loops: managedOAuthBroker, lemlist: managedOAuthBroker,
      bokio: bokioBroker,
    });
    const managedOAuthFlow = managedLifecycle.oauth;
    const publicCustomMcpRoutes = routesModule.createCustomMcpRoutes({
      broker,
      oauth: managedOAuthFlow,
      resolveUserId: async (c: Context) => resolveCustomMcpUserId(
        c.get('platformUserId') as string | undefined,
        c.get('platformHandle') as string | undefined,
      ),
    });
    customMcpRoutes=new Hono();
    customMcpRoutes.use('/oauth/callback',createAccountDeletionMutationGuard({db,env:process.env,isMutation:()=>true,
      resolveOwner:async c=>{
        const state=z.string().min(32).max(512).parse(c.req.query('state'));
        const decoded=z.object({userId:z.string().min(1).max(128)}).parse(cryptoModule.decryptCustomMcpOAuthState(state,encryptionKey));
        return (await customDb.getUserById(decoded.userId))?.clerk_id;
      }}));
    customMcpRoutes.route('/',publicCustomMcpRoutes);
    internalCustomMcpRoutes = routesModule.createCustomMcpRoutes({
      broker,
      oauth: managedOAuthFlow,
      allowToolCalls: true,
      resolveActorId: (c: Context) => c.get('internalContainerClerkUserId') as string | null,
      resolveUserId: async (c: Context) => resolveCustomMcpUserId(
        c.get('internalContainerClerkUserId') as string | undefined,
        c.get('internalContainerHandle') as string | undefined,
      ),
    });
    internalCustomMcpApprovalRoutes = approvalRoutesModule.createCustomMcpApprovalRoutes(createInternalCustomMcpApprovalRouteOptions({
      db: customDb,
      broker,
      platformSecret,
      resolveUserId: resolveCustomMcpUserId,
    }));
    const sweepPending = () => Promise.all([
      broker.sweepPending(), customDb.sweepCustomMcpApprovals(new Date()),
    ]).catch((error: unknown) => {
      console.error('[custom-mcp] pending sweep failed:', error instanceof Error ? error.message : String(error));
    });
    void sweepPending();
    customMcpSweepInterval = setInterval(sweepPending, 60 * 60 * 1_000);
    customMcpSweepInterval.unref();
  }

  let internalSyncRoutes: Hono | undefined;
  let customerVpsObjectStore: CustomerVpsObjectStore | undefined;
  let hostBundleObjectStore: CustomerVpsObjectStore | undefined;
  let sitesObjectStore: GatewayR2Client | undefined;
  let primaryStorageGate: R2CapabilityGate | undefined;
  let sitesStorageGate: R2CapabilityGate | undefined;
  const storageConfig = resolvePlatformObjectStorage(process.env);
  let createR2Client: GatewayR2ClientModule['createR2Client'] | undefined;
  if (storageConfig.primary && platformSecret) {
    const [r2ClientModule, { createInternalSyncRoutes }] = await Promise.all([
      importRuntimeModule<GatewayR2ClientModule>('./r2-client.js'),
      import('./internal-sync-routes.js'),
    ]);
    createR2Client = r2ClientModule.createR2Client;
    const r2 = await createR2Client(storageConfig.primary);
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

  if (storageConfig.bundles) {
    createR2Client ??= (
      await importRuntimeModule<GatewayR2ClientModule>('./r2-client.js')
    ).createR2Client;
    hostBundleObjectStore = await createR2Client(storageConfig.bundles);
  }

  // Dedicated public asset credentials never fall back to the owner sync store.
  const sitesStorageConfig = resolveSitesObjectStorage(process.env);
  if (sitesStorageConfig) {
    createR2Client ??= (await importRuntimeModule<GatewayR2ClientModule>('./r2-client.js')).createR2Client;
    sitesObjectStore = await createR2Client(sitesStorageConfig);
    sitesStorageGate = createR2CapabilityGate({ storage: sitesObjectStore });
    registerCustomMcpStartupCleanup(async () => { sitesObjectStore?.destroy(); });
  }

  let customerVpsService: CustomerVpsService | undefined;
  let activateManagedFeatures: ManagedFeatureActivator | undefined;
  let activatePreviewRuntimeAccess: PreviewRuntimeAccessActivator | undefined;
  let goldenSnapshotService: GoldenSnapshotService | undefined;
  let goldenSnapshotConfig: GoldenSnapshotRuntimeConfig | undefined;
  let customerVpsReconciliationWorker: CustomerVpsReconciliationWorker | undefined;
  let managedFeatureReconciliationWorker: CustomerVpsReconciliationWorker | undefined;
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
    if (previewRuntimeAccess.enabled && fundedAiRepository && speechConfig.enabled) {
      activatePreviewRuntimeAccess = createPreviewRuntimeAccessActivator({
        db, repository: fundedAiRepository, config: previewRuntimeAccess,
        hostControlSecret: customerVpsConfig.platformSecret,
        platformOrigin: appOrigin(),
        speechPlatformOrigin: new URL(customerVpsConfig.platformRegisterUrl).origin,
        relayOrigin: customerVpsConfig.fundedAiRelayUrl,
        fetchDispatcher: customerVpsProxyDispatcher,
      });
    }
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
      ...(activatePreviewRuntimeAccess ? { activatePreviewRuntimeAccess } : {}),
    });
    activateManagedFeatures = createManagedFeatureActivator({ db, platformSecret: customerVpsConfig.platformSecret,
      relayOrigin: customerVpsConfig.fundedAiRelayUrl, fundedAiEnabled: customerVpsConfig.fundedAiEnabled,
      speechEnabled: customerVpsConfig.platformSpeechEnabled, activateSpeech: target => customerVpsService!.activateSpeech(target),
      fetchDispatcher: customerVpsProxyDispatcher });
    if ((customerVpsConfig.fundedAiEnabled || previewRuntimeAccess.enabled) && internalFundedAiRuntimeRoutes) {
      internalFundedAiRuntimeRoutes.route('/', createFundedHostActivationRoutes({ db,
        platformSecret: customerVpsConfig.platformSecret,
        ...(previewRuntimeAccess.enabled ? { previewRuntimeSecret: previewRuntimeAccess.runtimeSecret } : {}),
        relayOrigin: customerVpsConfig.fundedAiRelayUrl }));
    }
    const reconcileManagedFeatures = createManagedFeatureReconciliationPass(activateManagedFeatures);
    if (backgroundWorkersEnabled) {
      managedFeatureReconciliationWorker = startCustomerVpsReconciliationWorker({ intervalMs: 60_000, runPass: reconcileManagedFeatures });
      registerCustomMcpStartupCleanup(async () => {
        managedFeatureReconciliationWorker?.stop();
        await managedFeatureReconciliationWorker?.drain();
      });
    }
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
      const service = customerVpsService;
      const sweepPrivatePreviews = createPrivatePreviewSweep({
        db,
        service,
        internalOrganizationId: privatePreviewAccess.internalOrganizationId,
        lookupMembership: privatePreviewAccess.lookupMembership,
        logError: logPlatformRouteError,
      });
      customerVpsReconciliationWorker = startCustomerVpsReconciliationWorker({
        intervalMs: reconciliationIntervalMs,
        runPass: () => runCustomerVpsReconciliationPass({
          db,
          customerVpsService: service,
          platformSecret: customerVpsConfig.platformSecret,
          customerVpsProxyDispatcher,
          getBillingRuntimeCaptureEvent: () => billingRuntimeCaptureEvent,
          sweepPrivatePreviews,
        }),
      });
    }
  }

  const fundedReservationCleanupWorker = backgroundWorkersEnabled
    ? createAiFundedReservationCleanupWorker({
        cleanupExpiredReservations: (input) => cleanupExpiredReservations({
          db,
          now: () => new Date(),
        }, input),
      })
    : undefined;
  registerCustomMcpStartupCleanup(async () => {
    await fundedReservationCleanupWorker?.shutdown();
    await customMcpShutdown?.();
  });

  const appEnv = process.env;
  const stopGooglePurchaseWorker = startGooglePurchaseWorker(db, appEnv, backgroundWorkersEnabled);
  registerCustomMcpStartupCleanup(stopGooglePurchaseWorker);
  const whatsappRuntime = createConfiguredWhatsAppRuntime({ db, env: appEnv, clerkAuth });
  registerCustomMcpStartupCleanup(async () => { await whatsappRuntime?.shutdown(); });
  const legacyContainerRoutingEnabled =
    appEnv.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED === 'true' && !customerVpsService;
  const accountDeletion = await createConfiguredAccountDeletionRuntime({
    db, env: appEnv, customerVpsService, backgroundWorkersEnabled, pipedream: deletionPipedream, customMcp: deletionCustomMcp,
  });
  registerCustomMcpStartupCleanup(async () => {
    accountDeletion?.stop();
    await accountDeletion?.drain();
    accountDeletion?.close();
  });
  const atsBackgroundWorker = atsDb && backgroundWorkersEnabled ? startAtsBackgroundWorker(atsDb, appEnv) : undefined;
  registerCustomMcpStartupCleanup(async () => { await atsBackgroundWorker?.shutdown(); });
  const app = createPlatformApp({
    accountDeletion,
    db,
    atsDb,
    docker,
    orchestrator,
    clerkAuth,
    matrixProvisioner,
    integrationRoutes,
    internalIntegrationRoutes,
    previewDriveIntegration,
    customMcpRoutes,
    internalCustomMcpRoutes,
    internalCustomMcpApprovalRoutes,
    internalSyncRoutes,
    internalFundedAiRuntimeRoutes,
    internalFundedAiRelayRoutes,
    internalFundedAiOperatorRoutes,
    internalSpeechRuntimeRoutes,
    whatsappRoutes: whatsappRuntime?.routes,
    fundedAiRepository,
    fundedModelProbes,
    collaboration,
    slackRoutes: slack.routes,
    customerVpsService,
    activateManagedFeatures,
    activatePreviewRuntimeAccess,
    goldenSnapshotService,
    goldenSnapshotConfig,
    customerVpsObjectStore,
    hostBundleObjectStore,
    sitesObjectStore,
    assertPrimaryStorageReady: primaryStorageGate?.assertReady,
    assertSitesStorageReady: sitesStorageGate?.assertReady,
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

  const server = serve({ fetch: app.fetch, hostname: process.env.MATRIX_BIND_HOST, port }, () => {
    console.log(`Platform listening on :${port}`);
  });
  if (backgroundWorkersEnabled) whatsappRuntime?.start();

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[platform] Received ${signal}, shutting down`);
    accountDeletion?.stop();
    customerVpsReconciliationWorker?.stop();
    managedFeatureReconciliationWorker?.stop();
    if (goldenSnapshotInterval) clearInterval(goldenSnapshotInterval);
    if (customMcpSweepInterval) clearInterval(customMcpSweepInterval);
    if (previewDriveSweepInterval) clearInterval(previewDriveSweepInterval);
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
        await accountDeletion?.drain();
        accountDeletion?.close();
        await atsBackgroundWorker?.shutdown();
        await customerVpsReconciliationWorker?.drain();
        await managedFeatureReconciliationWorker?.drain();
        if (goldenSnapshotPromise) await goldenSnapshotPromise;
        await Promise.allSettled([
          stopGooglePurchaseWorker(),
          collaboration?.shutdown(),
          slack.close(),
          whatsappRuntime?.shutdown(),
          fundedReservationCleanupWorker?.shutdown(),
          Promise.resolve(speechService.shutdown()),
          containerProxyDispatcher.close(),
          customerVpsProxyDispatcher.close(),
          customMcpShutdown?.(),
        ]);
        posthogProcessErrors.dispose();
        await shutdownPlatformApp(app);
        await processPosthogErrorTracker.shutdown();
        sitesObjectStore?.destroy();
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
    collaborationDirect: collaboration?.direct,
  });
}

export async function startPlatformServer(opts: StartPlatformServerOptions): Promise<void> {
  await runPlatformStartupWithCleanup(registerCleanup =>
    startPlatformServerWithCleanup(opts, registerCleanup));
}
