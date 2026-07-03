import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import {
  createPostHogErrorTracker,
  installPostHogHonoErrorTracking,
  installPostHogProcessErrorTracking,
  isMatrixTelemetryEvent,
  MATRIX_TELEMETRY_EVENTS,
  type MatrixTelemetryEvent,
} from '@matrix-os/observability';
import { createConnection, type Socket } from 'node:net';
import { connect as createTlsConnection } from 'node:tls';
import type { IncomingMessage, Server } from 'node:http';
import type Dockerode from 'dockerode';
import { Agent } from 'undici';
import { z } from 'zod/v4';
import {
  createPlatformDb,
  type PlatformDB,
  getContainer,
  getContainerByClerkId,
  getActiveUserMachineByClerkId,
  getActiveUserMachineByHandle,
  getBillingEntitlementState,
  getRunningUserMachineByClerkId,
  getRunningUserMachineByHandle,
  listActiveUserMachinesByClerkId,
  listUserMachines,
  listAllUserMachines,
  updateLastActive,
  updateContainerStatus,
  listContainers,
  sweepStaleCheckoutAttempts,
  type UserMachineRecord,
} from './db.js';
import type { Orchestrator } from './orchestrator.js';
import { createSocialApi } from './social.js';
import { createStoreApi } from './store-api.js';
import { createSocialFeedApi } from './social-api.js';
import { createClerkAuth, createClerkSessionRevoker, type ClerkAuth } from './clerk-auth.js';
import type { MatrixProvisioner } from './matrix-provisioning.js';
import { createAuthRoutes } from './auth-routes.js';
import { issueSyncJwt, verifySyncJwt } from './sync-jwt.js';
import {
  getWebSocketUpgradeToken,
  isAppDomainHost,
  isCodeDomainHost,
  isSessionRoutedHost,
  isSafeWebSocketUpgradePath,
  stripWebSocketUpgradeToken,
} from './ws-upgrade.js';
import {
  buildPlatformVerificationToken,
  timingSafeTokenEquals,
} from './platform-token.js';
import type { CustomerVpsService } from './customer-vps.js';
import { createCustomerVpsRoutes } from './customer-vps-routes.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import {
  buildCustomerVpsProxyUrl,
  deriveEntitlementAccess,
  EntitlementStatusSchema,
  type EntitlementAccessDecision,
} from './profile-routing.js';
import {
  computeEffectiveEntitlement,
  getRuntimeAccessDecision,
  parseBillingEntitlementRecord,
  parseBillingOverrideRecord,
  type BillingEntitlement,
  type RuntimeAccessDecision,
} from './billing.js';
import { createBillingRoutes } from './billing-routes.js';
import { createJourneyRoutes, createJourneyUserResolver } from './journey-routes.js';
import { backfillFirstRunRecords } from './journey.js';
import {
  sanitizeProxyResponseHeaders,
} from './proxy-headers.js';
import { appOrigin } from './origins.js';
import {
  createStripeBillingClient,
  createUnavailableStripeBillingClient,
} from './stripe-billing.js';
import type { CustomerVpsObjectStore } from './customer-vps-r2.js';
import { handleInternalGeminiLiveProxyUpgrade } from './gemini-live-proxy.js';
import { recordPlatformHttpRequest } from './metrics.js';
import {
  createLaunchReadinessService,
  createPlatformLaunchEvidenceLoader,
} from './launch-readiness.js';
import { createLaunchReadinessRoutes } from './launch-readiness-routes.js';
import { createHostBundleRoutes } from './host-bundle-routes.js';
import { createLegacyContainerRoutes } from './legacy-container-routes.js';
import { createAppSessionRoutes } from './app-session-routes.js';
import {
  HANDLE_PATTERN,
  describeError,
  ensureProvisionedPlatformUser,
  isPostgresUniqueViolation,
  logPlatformRouteError,
  requireValidHandle,
} from './platform-route-utils.js';
import {
  fetchDeviceDisplayProfile,
  selectProvisionIdentityForClerkUser,
} from './provisioning-identity.js';
import {
  probeCustomerVpsRelease,
  probeCustomerVpsRuntime,
  releaseVersionFromProbe,
} from './runtime-probes.js';
import { createPlatformMetricsRoutes } from './platform-metrics-routes.js';
import { shouldVerifyCustomerVpsTls } from './customer-vps-tls.js';
import {
  PlatformStartupConfigError,
  loadPlatformRuntimeConfig,
} from './runtime-mode.js';
import { resolvePlatformIntegrationConfig } from './integration-config.js';
import {
  APP_SESSION_COOKIE,
  readCookie,
} from './session-cookies.js';
import {
  buildForwardedQueryString,
  readRuntimeSlot,
} from './request-routing.js';
import {
  APP_ASSET_ROUTE_OMITTED_QUERY_PARAMS,
  EDGE_SECRET_HEADER,
  shouldForwardProxyHeader,
} from './session-routing-proxy.js';
import {
  resolveAppDomainIdentity,
  type AppDomainIdentity,
} from './session-routing-identity.js';
import {
  buildPlatformWebSocketUpgradeHeaders,
  classifySessionRoutedHost,
  classifyWebSocketPath,
  getTrustedSessionRoutedWebSocketHost,
} from './session-routing-websocket.js';
import { createSessionRoutingMiddleware } from './session-routing-middleware.js';
import {
  resolveContainerEndpoint,
} from './container-endpoint.js';
export { escapeInlineScriptJson } from './auth-pages.js';
export { buildPostAuthRedirectPath } from './request-routing.js';
export {
  buildPlatformWebSocketUpgradeHeaders,
  classifySessionRoutedHost,
  classifyWebSocketPath,
  getTrustedSessionRouteHost,
  getTrustedSessionRoutedWebSocketHost,
} from './session-routing-websocket.js';

const PORT = Number(process.env.PLATFORM_PORT ?? 9000);
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? '';
const PLATFORM_JWT_SECRET = process.env.PLATFORM_JWT_SECRET ?? '';
const DEV_PLATFORM_SECRET = 'dev-secret';
const DEV_PLATFORM_JWT_SECRET = 'dev-platform-jwt-secret-please-change-32';
const DEFAULT_SYNC_BUCKET = 'matrixos-sync';
const ADMIN_BODY_LIMIT = 64 * 1024;
const PROXY_BODY_LIMIT = 10 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30_000;
const AUTH_SHELL_PROXY_TIMEOUT_MS = 5_000;
const CODE_SERVER_PORT = Number(process.env.MATRIX_CODE_SERVER_PORT ?? 8787);
const TENANT_PUBLIC_TELEMETRY_ENV_KEYS = [
  'POSTHOG_TOKEN',
  'POSTHOG_PROJECT_TOKEN',
  'POSTHOG_HOST',
  'NEXT_PUBLIC_POSTHOG_KEY',
  'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN',
  'NEXT_PUBLIC_POSTHOG_HOST',
  'NEXT_PUBLIC_POSTHOG_API_HOST',
] as const;

// User containers churn frequently, so keep proxy connections short-lived
// instead of letting long-lived pooled upstream state go stale.
const containerProxyDispatcher = new Agent({
  pipelining: 0,
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
  connections: 64,
});

const customerVpsProxyDispatcher = new Agent({
  pipelining: 0,
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
  connections: 64,
  connect: {
    rejectUnauthorized: shouldVerifyCustomerVpsTls(),
  },
});
const WS_TOKEN_EXPIRES_IN_SEC = 5 * 60;
function collectTenantPublicTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return TENANT_PUBLIC_TELEMETRY_ENV_KEYS
    .map((key) => {
      const value = env[key];
      if (!value) return null;
      if (/[\r\n\0]/.test(value)) {
        throw new Error(`Invalid public telemetry env value for ${key}`);
      }
      return `${key}=${value}`;
    })
    .filter((value): value is string => value !== null);
}

const SocialSendBodySchema = z.object({
  text: z.string().min(1).max(10_000),
  from: z.object({
    handle: z.string().regex(HANDLE_PATTERN),
    displayName: z.string().min(1).max(100).optional(),
  }),
});

interface GatewayPlatformUser {
  id: string;
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
    containerVersion?: string;
    plan?: string;
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

async function importRuntimeModule<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

function logCodeDomainUpstreamFailure(opts: {
  handle: string;
  runtimeSlot?: string | null;
  publicIPv4?: string | null;
  path: string;
  status: number;
}): void {
  console.warn(
    `[platform] code-domain vps upstream 5xx handle=${opts.handle} runtimeSlot=${opts.runtimeSlot ?? 'unknown'} publicIPv4=${opts.publicIPv4 ?? 'unknown'} path=${JSON.stringify(opts.path)} status=${opts.status}`,
  );
}

function bearerTokenEquals(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }
  return timingSafeTokenEquals(authHeader.slice(7), expected);
}

function getRuntimeEntitlementDecision(env: NodeJS.ProcessEnv = process.env): EntitlementAccessDecision {
  const rawStatus = env.MATRIX_PAID_BETA_ENTITLEMENT_STATUS?.trim();
  if (!rawStatus) {
    return deriveEntitlementAccess({ status: 'active' });
  }
  const parsed = EntitlementStatusSchema.safeParse(rawStatus);
  if (!parsed.success) {
    console.warn('[platform] Invalid MATRIX_PAID_BETA_ENTITLEMENT_STATUS; denying paid runtime access.');
    return deriveEntitlementAccess({ status: 'changed' });
  }
  return deriveEntitlementAccess({ status: parsed.data });
}

function stripeBillingEntitlementsEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.MATRIX_STRIPE_BILLING_ENABLED === 'true' ||
    env.MATRIX_BILLING_PROVIDER === 'stripe' ||
    Boolean(env.STRIPE_SECRET_KEY?.trim())
  );
}

async function resolveEffectiveBillingEntitlement(
  db: PlatformDB,
  clerkUserId: string,
  now = new Date(),
): Promise<BillingEntitlement | null> {
  const { entitlement, override } = await getBillingEntitlementState(db, clerkUserId, now.toISOString());
  return computeEffectiveEntitlement({
    stripeEntitlement: parseBillingEntitlementRecord(entitlement),
    override: parseBillingOverrideRecord(override),
    now,
  });
}

async function getRuntimeEntitlementDecisionForUser(
  db: PlatformDB,
  clerkUserId: string,
  env: NodeJS.ProcessEnv,
  now = new Date(),
): Promise<EntitlementAccessDecision> {
  if (!stripeBillingEntitlementsEnabled(env)) {
    return getRuntimeEntitlementDecision(env);
  }
  return billingAccessToProfileDecision(
    getRuntimeAccessDecision(await resolveEffectiveBillingEntitlement(db, clerkUserId, now), now),
  );
}

function billingAccessToProfileDecision(decision: RuntimeAccessDecision): EntitlementAccessDecision {
  if (decision.runtimeProxyAllowed) {
    return {
      status: 'active',
      runtimeProxyAllowed: true,
      ownerDataPreserved: true,
      ownerDataExportable: true,
      remediation: null,
    };
  }
  return {
    status: decision.reason === 'no_entitlement' ? 'missing' : 'expired',
    runtimeProxyAllowed: false,
    ownerDataPreserved: true,
    ownerDataExportable: true,
    remediation: 'Renew paid runtime access or ask an operator to grant access.',
  };
}

function applyNoStoreHeaders(c: import('hono').Context): void {
  c.header('Cache-Control', 'no-store, private');
  c.header('CDN-Cache-Control', 'no-store');
  c.header('Cloudflare-CDN-Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
}

function jsonCustomerVpsError(c: import('hono').Context, err: unknown, context: string) {
  if (err instanceof CustomerVpsError) {
    const status = err.status === 402 ? 402 : err.status === 409 ? 409 : 503;
    const code = err.status === 402
      ? 'billing_required'
      : err.status === 409
        ? 'provisioning_conflict'
        : 'provisioning_failed';
    return c.json({ error: err.publicMessage, code }, status as never);
  }
  if (isPostgresUniqueViolation(err)) {
    return c.json({ error: 'Handle unavailable', code: 'handle_unavailable' }, 409);
  }
  logPlatformRouteError(context, err);
  return c.json({ error: 'Provisioning failed', code: 'provisioning_failed' }, 503);
}

export function checkUnsafeDefaultSecrets(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.error,
): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  if (!env.PLATFORM_SECRET || env.PLATFORM_SECRET === DEV_PLATFORM_SECRET) {
    problems.push('PLATFORM_SECRET');
  }

  if (
    !env.PLATFORM_JWT_SECRET ||
    env.PLATFORM_JWT_SECRET === DEV_PLATFORM_JWT_SECRET
  ) {
    problems.push('PLATFORM_JWT_SECRET');
  }

  if (problems.length > 0) {
    log(
      `[platform] Refusing to start in production with missing or unsafe default secrets: ${problems.join(', ')}.`,
    );
  }

  return problems;
}

export function checkHostBundleStorageEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.warn,
): string[] {
  if (env.CUSTOMER_VPS_ENABLED !== 'true') return [];
  const problems: string[] = [];
  if (!(env.S3_BUNDLES_ENDPOINT || env.R2_BUNDLES_ENDPOINT || env.S3_BUNDLES_ACCOUNT_ID || env.R2_BUNDLES_ACCOUNT_ID)) {
    problems.push('S3_BUNDLES_ENDPOINT/R2_BUNDLES_ENDPOINT or S3_BUNDLES_ACCOUNT_ID/R2_BUNDLES_ACCOUNT_ID');
  }
  if (!(env.S3_BUNDLES_ACCESS_KEY_ID || env.R2_BUNDLES_ACCESS_KEY_ID)) {
    problems.push('S3_BUNDLES_ACCESS_KEY_ID/R2_BUNDLES_ACCESS_KEY_ID');
  }
  if (!(env.S3_BUNDLES_SECRET_ACCESS_KEY || env.R2_BUNDLES_SECRET_ACCESS_KEY)) {
    problems.push('S3_BUNDLES_SECRET_ACCESS_KEY/R2_BUNDLES_SECRET_ACCESS_KEY');
  }
  const bundleBucket = env.S3_BUNDLES_BUCKET ?? env.R2_BUNDLES_BUCKET;
  if (!bundleBucket) {
    problems.push('S3_BUNDLES_BUCKET/R2_BUNDLES_BUCKET');
  } else {
    const syncBucket = env.S3_BUCKET ?? env.R2_BUCKET ?? DEFAULT_SYNC_BUCKET;
    if (bundleBucket === syncBucket) {
      problems.push('S3_BUNDLES_BUCKET/R2_BUNDLES_BUCKET must not equal S3_BUCKET/R2_BUCKET');
    }
  }
  if (problems.length > 0) {
    log(
      `[platform] CUSTOMER_VPS_ENABLED=true but dedicated host bundle storage is incomplete; refusing to fall back to the sync bucket for signed host bundle URLs. Problems: ${problems.join(', ')}.`,
    );
  }
  return problems;
}

function getGatewayUrlForHandle(handle: string): string {
  const safeHandle = requireValidHandle(handle);
  const tmpl = process.env.GATEWAY_URL_TEMPLATE;
  if (tmpl) {
    return tmpl.replace('{handle}', safeHandle);
  }
  return 'https://app.matrix-os.com';
}

/**
 * Startup assertion for the trusted-sync architecture: user containers no
 * longer receive raw S3 credentials. When MATRIX_HOME_MIRROR=true, the
 * container gateway reaches storage through the platform's internal sync API,
 * so the platform itself must hold the trusted storage config plus the
 * PLATFORM_SECRET used for per-container HMAC auth. Warn loudly at startup
 * instead of discovering silent sync failure after deploy.
 *
 * Returns the list of missing logical requirements (empty if all is well or
 * home-mirror is disabled). Exposed for tests; callers typically just discard
 * the return value after logging.
 */
export function checkHomeMirrorS3Env(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.warn,
): string[] {
  if (env.MATRIX_HOME_MIRROR !== 'true') return [];
  const missing: string[] = [];
  if (!(env.S3_ENDPOINT || env.R2_ENDPOINT || env.R2_ACCOUNT_ID)) {
    missing.push('S3_ENDPOINT/R2_ENDPOINT or R2_ACCOUNT_ID');
  }
  if (!(env.S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID)) {
    missing.push('S3_ACCESS_KEY_ID/R2_ACCESS_KEY_ID');
  }
  if (!(env.S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY)) {
    missing.push('S3_SECRET_ACCESS_KEY/R2_SECRET_ACCESS_KEY');
  }
  if (!(env.S3_BUCKET || env.R2_BUCKET)) {
    missing.push('S3_BUCKET/R2_BUCKET');
  }
  if (!env.PLATFORM_SECRET) {
    missing.push('PLATFORM_SECRET');
  }
  if (missing.length > 0) {
    log(
      `[platform] MATRIX_HOME_MIRROR=true but trusted sync storage is incomplete; user containers no longer receive raw S3 credentials and must proxy sync storage through the platform. Missing: ${missing.join(', ')}.`,
    );
  }
  return missing;
}

export type PlatformApp = Hono<{
  Variables: {
    platformUserId: string;
    platformHandle: string;
    internalContainerHandle: string;
    internalContainerClerkUserId: string;
  };
}> & {
  capturePlatformEvent(
    event: MatrixTelemetryEvent,
    properties: Record<string, string | number | boolean | null | undefined>,
    options?: { distinctId?: string },
  ): void;
  shutdownPostHog(): Promise<void>;
};

export function createApp(deps: {
  db: PlatformDB;
  docker?: Dockerode;
  orchestrator: Orchestrator;
  clerkAuth?: ClerkAuth;
  matrixProvisioner?: MatrixProvisioner;
  platformSecret?: string;
  integrationRoutes?: Hono<any>;
  internalIntegrationRoutes?: Hono<any>;
  internalSyncRoutes?: Hono<any>;
  customerVpsService?: CustomerVpsService;
  customerVpsObjectStore?: CustomerVpsObjectStore;
  hostBundleObjectStore?: CustomerVpsObjectStore;
  env?: NodeJS.ProcessEnv;
}) {
  const { db, docker, orchestrator, clerkAuth, matrixProvisioner } = deps;
  const appEnv = deps.env ?? process.env;
  const legacyContainerRoutingEnabled =
    appEnv.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED === 'true' && !deps.customerVpsService;
  const platformSecret = deps.platformSecret ?? appEnv.PLATFORM_SECRET ?? '';
  const allowHostBundleSyncStoreFallback = appEnv.CUSTOMER_VPS_ENABLED !== 'true';
  const app = new Hono<{
    Variables: {
      platformUserId: string;
      platformHandle: string;
      internalContainerHandle: string;
      internalContainerClerkUserId: string;
    };
  }>() as PlatformApp;
  const posthogErrorTracker = installPostHogHonoErrorTracking(app, {
    service: 'matrix-platform',
  });
  const posthogShutdowns: Array<() => Promise<void>> = [() => posthogErrorTracker.shutdown()];
  function capturePlatformEvent(
    event: MatrixTelemetryEvent,
    properties: Record<string, string | number | boolean | null | undefined>,
    options?: { distinctId?: string },
  ): void {
    void posthogErrorTracker.captureEvent(event, {
      distinctId: options?.distinctId ?? 'matrix-platform',
      properties,
    }).catch((err: unknown) => {
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[posthog] Failed to queue platform event ${event}: ${kind}`);
    });
  }
  app.capturePlatformEvent = capturePlatformEvent;
  function captureFunnelEvent(
    event: string,
    options?: { distinctId?: string; properties?: Record<string, string | number | boolean | undefined> },
  ): void {
    if (!isMatrixTelemetryEvent(event)) {
      console.warn(`[posthog] Dropping unknown platform funnel event: ${event}`);
      return;
    }
    capturePlatformEvent(event, options?.properties ?? {}, { distinctId: options?.distinctId });
  }

  const BILLING_AUTH_FAILURE_HEADER = 'X-Auth-Failure';
  const BILLING_APP_SESSION_STALE_FAILURE = 'app-session-stale';

  async function resolveBillingClerkUserId(c: Context): Promise<string | null> {
    const authorization = c.req.header('authorization');
    const cookie = c.req.header('cookie');
    const clerkToken = clerkAuth?.extractToken(authorization, cookie);
    const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    const appSessionToken = readCookie(cookie, APP_SESSION_COOKIE);
    if (!clerkToken && !bearerToken && !appSessionToken) return null;

    try {
      if (clerkAuth && clerkToken) {
        const result = await clerkAuth.verify(clerkToken);
        if (result.authenticated && result.userId) return result.userId;
        console.warn('[billing] Clerk verification returned unauthenticated');
      }
    } catch (err: unknown) {
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[billing] Clerk verification failed: ${kind}`);
    }

    const syncJwtToken = bearerToken ?? appSessionToken;
    if (!platformJwtSecret || !syncJwtToken) return null;
    try {
      const claims = await verifySyncJwt(syncJwtToken, { secret: platformJwtSecret });
      return claims.sub;
    } catch (err: unknown) {
      const kind = err instanceof Error ? err.name : typeof err;
      const source = bearerToken ? 'native token' : 'app session token';
      console.warn(`[billing] ${source} verification failed: ${kind}`);
      if (!bearerToken && appSessionToken) {
        c.header(BILLING_AUTH_FAILURE_HEADER, BILLING_APP_SESSION_STALE_FAILURE);
      }
      return null;
    }
  }

  app.use('*', async (c, next) => {
    const started = performance.now();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      if (c.req.path !== '/metrics') {
        recordPlatformHttpRequest({
          method: c.req.method,
          path: c.req.path,
          status,
          durationSeconds: (performance.now() - started) / 1000,
        });
      }
    }
  });

  // Health check (unauthenticated)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  const platformMetricsRoutes = createPlatformMetricsRoutes({
    db,
    customerVpsEnabled: Boolean(deps.customerVpsService),
    probeRuntime: (machine) => probeCustomerVpsRuntime(machine, platformSecret, customerVpsProxyDispatcher),
    logRouteError: logPlatformRouteError,
  });

  // Matrix well-known endpoints (unauthenticated, required for federation)
  const CONDUIT_SERVER = process.env.CONDUIT_SERVER ?? 'matrix-os.com:6167';
  const CONDUIT_BASE_URL = process.env.CONDUIT_BASE_URL ?? 'https://matrix-os.com';

  app.get('/.well-known/matrix/server', (c) =>
    c.json({ 'm.server': CONDUIT_SERVER }),
  );
  app.get('/.well-known/matrix/client', (c) =>
    c.json({ 'm.homeserver': { base_url: CONDUIT_BASE_URL } }),
  );

  app.route('/', platformMetricsRoutes.routes);

  app.route('/system-bundles', createHostBundleRoutes({
    db,
    platformSecret,
    adminBodyLimit: ADMIN_BODY_LIMIT,
    getHostBundleObjectStore: () => deps.hostBundleObjectStore ?? (allowHostBundleSyncStoreFallback ? deps.customerVpsObjectStore : undefined),
    capturePlatformEvent,
    logRouteError: logPlatformRouteError,
  }));

  // OAuth 2.0 Device Flow (RFC 8628) -- mounted before any host-based routing
  // so the CLI's poll/code endpoints work regardless of which subdomain hits
  // the platform. Public endpoints; admin Bearer middleware below skips them.
  const platformJwtSecret = process.env.PLATFORM_JWT_SECRET ?? '';
  if (platformJwtSecret) {
    const deviceAuthPublicUrl =
      appEnv.NEXT_PUBLIC_MATRIX_APP_URL ??
      appEnv.PLATFORM_PUBLIC_URL ??
      `http://localhost:${appEnv.PLATFORM_PORT ?? 9000}`;
    app.route(
      '/',
      createAuthRoutes({
        db,
        clerkAuth,
        jwtSecret: platformJwtSecret,
        platformUrl: deviceAuthPublicUrl,
        gatewayUrlForHandle: getGatewayUrlForHandle,
        ignoreLegacyContainers: Boolean(deps.customerVpsService),
        fetchUserProfile: (clerkUserId) => fetchDeviceDisplayProfile(clerkUserId, process.env),
        captureEvent: (event, properties) => {
          capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.CLI_COMMAND_RUN, {
            auth_event: event,
            ...properties,
          });
        },
      }),
    );
  }

  app.route('/', createAppSessionRoutes({
    db,
    clerkAuth,
    customerVpsService: deps.customerVpsService,
    matrixProvisioner,
    appEnv,
    platformJwtSecret,
    legacyContainerRoutingEnabled,
    logRouteError: logPlatformRouteError,
    applyNoStoreHeaders,
    jsonCustomerVpsError,
    stripeBillingEntitlementsEnabled,
    resolveEffectiveBillingEntitlement,
    selectProvisionIdentityForClerkUser,
    ensureProvisionedPlatformUser,
    resolveAppDomainIdentity,
    getGatewayUrlForHandle,
  }));

  app.route('/billing', createBillingRoutes({
    db,
    stripe: appEnv.STRIPE_SECRET_KEY
      ? createStripeBillingClient({ secretKey: appEnv.STRIPE_SECRET_KEY })
      : createUnavailableStripeBillingClient(),
    env: appEnv,
    resolveClerkUserId: resolveBillingClerkUserId,
    captureEvent: captureFunnelEvent,
  }));

  // Onboarding journey (spec 092): one server-owned signup-to-ready state every
  // surface renders from. Triggers provisioning through the same building blocks
  // as /api/auth/provision-runtime so billing and identity checks stay identical.
  async function provisionRuntimeForJourney(clerkUserId: string, runtimeSlot: string): Promise<void> {
    if (!deps.customerVpsService) {
      throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
    }
    if (stripeBillingEntitlementsEnabled(appEnv)) {
      const checkedAt = new Date();
      const entitlement = await resolveEffectiveBillingEntitlement(db, clerkUserId, checkedAt);
      if (!getRuntimeAccessDecision(entitlement, checkedAt).runtimeProxyAllowed) {
        throw new CustomerVpsError(402, 'billing_required', 'Billing upgrade required');
      }
    }
    const identity = await selectProvisionIdentityForClerkUser(db, clerkUserId, appEnv);
    if (!identity) {
      throw new CustomerVpsError(409, 'invalid_state', 'Handle unavailable');
    }
    const existingMachine = await getActiveUserMachineByClerkId(db, clerkUserId, runtimeSlot);
    const provisioned = await deps.customerVpsService.provision({
      handle: identity.handle,
      clerkUserId,
      runtimeSlot,
      ...(existingMachine?.status === 'failed' ? { developerTools: existingMachine.developerTools } : {}),
    });
    await ensureProvisionedPlatformUser(db, {
      clerkUserId,
      handle: identity.handle,
      displayName: identity.displayName,
      email: identity.email,
      runtimeId: `vps:${provisioned.machineId}`,
    });
    if (matrixProvisioner) {
      try {
        await matrixProvisioner.provisionUser(identity.handle);
      } catch (matrixErr: unknown) {
        console.error(
          `[matrix] Failed to provision Matrix accounts for ${identity.handle}:`,
          matrixErr instanceof Error ? matrixErr.message : String(matrixErr),
        );
      }
    }
  }

  const journeyAppOrigin = appOrigin(appEnv);
  app.route('/', createJourneyRoutes({
    db,
    resolveUserId: createJourneyUserResolver({
      clerkAuth: clerkAuth ?? undefined,
      syncJwtSecret: platformJwtSecret ?? undefined,
    }),
    provisionRuntime: deps.customerVpsService ? provisionRuntimeForJourney : undefined,
    verifyInternalToken: platformSecret
      ? (handle, token) => timingSafeTokenEquals(token, buildPlatformVerificationToken(handle, platformSecret))
      : undefined,
    resolveHandleOwner: async (handle) => {
      const machine = await getActiveUserMachineByHandle(db, handle);
      return machine?.clerkUserId ?? null;
    },
    appOrigin: journeyAppOrigin,
    maxProvisionAttempts: Number(appEnv.CUSTOMER_VPS_MAX_PROVISION_ATTEMPTS) || 3,
    settlingWindowMs: Number(appEnv.BILLING_SETTLING_WINDOW_MS) || undefined,
  }));

  // Session-based routing:
  // - app.matrix-os.com -> Clerk session -> Matrix OS shell/gateway
  // - code.matrix-os.com -> Clerk session -> code-server on the user's VPS
  app.use('*', bodyLimit({ maxSize: PROXY_BODY_LIMIT }), createSessionRoutingMiddleware({
    db,
    docker,
    orchestrator,
    clerkAuth,
    appEnv,
    platformSecret,
    platformJwtSecret,
    legacyContainerRoutingEnabled,
    proxyTimeoutMs: PROXY_TIMEOUT_MS,
    authShellProxyTimeoutMs: AUTH_SHELL_PROXY_TIMEOUT_MS,
    codeServerPort: CODE_SERVER_PORT,
    wsTokenExpiresInSec: WS_TOKEN_EXPIRES_IN_SEC,
    containerProxyDispatcher,
    customerVpsProxyDispatcher,
    applyNoStoreHeaders,
    getRuntimeEntitlementDecision,
    getRuntimeEntitlementDecisionForUser,
    getGatewayUrlForHandle,
    logRouteError: logPlatformRouteError,
  }));

  if (deps.integrationRoutes) {
    app.route('/api/integrations', deps.integrationRoutes);
  }
  if (deps.internalIntegrationRoutes) {
    const internalIntegrationApp = new Hono<{
      Variables: {
        internalContainerHandle: string;
        internalContainerClerkUserId: string;
      };
    }>();
    internalIntegrationApp.use('*', async (c, next) => {
      const handle = c.req.param('handle');
      if (!handle) {
        return c.json({ error: 'Missing handle' }, 400);
      }
      if (!platformSecret) {
        return c.json({ error: 'Internal integrations not configured' }, 503);
      }
      const auth = c.req.header('authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const expected = buildPlatformVerificationToken(handle, platformSecret);
      if (!timingSafeTokenEquals(token, expected)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const record = await getContainer(db, handle);
      if (!record?.clerkUserId) {
        return c.json({ error: 'Unknown handle' }, 404);
      }

      c.set('internalContainerHandle', handle);
      c.set('internalContainerClerkUserId', record.clerkUserId);
      return next();
    });
    internalIntegrationApp.route('/', deps.internalIntegrationRoutes);
    app.route('/internal/containers/:handle/integrations', internalIntegrationApp);
  }
  if (deps.internalSyncRoutes) {
    app.route('/internal/containers/:handle/sync', deps.internalSyncRoutes);
  }
  app.get('/vps/releases', async (c) => {
    if (!platformSecret) {
      return c.json({ error: 'VPS tracking not configured' }, 503);
    }
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!timingSafeTokenEquals(token, platformSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const machines = await listUserMachines(db);
    const rows = await Promise.all(machines.map(async (machine) => {
      const probe = machine.status === 'running'
        ? await probeCustomerVpsRelease(machine, platformSecret, { dispatcher: customerVpsProxyDispatcher })
        : { reachable: false, error: 'VPS not running' };
      return {
        machineId: machine.machineId,
        handle: machine.handle,
        status: machine.status,
        publicIPv4: machine.publicIPv4,
        imageVersion: machine.imageVersion,
        lastSeenAt: machine.lastSeenAt,
        provisionedAt: machine.provisionedAt,
        release: probe,
      };
    }));
    return c.json({
      generatedAt: new Date().toISOString(),
      machines: rows,
    });
  });
  if (deps.customerVpsService) {
    async function probeMachineRuntime(machine: { machineId: string; handle: string; publicIPv4: string | null }) {
      return probeCustomerVpsRuntime(machine, platformSecret, customerVpsProxyDispatcher);
    }

    async function probeMachineHealth(machine: { machineId: string; handle: string; publicIPv4: string | null }): Promise<boolean> {
      if (!machine.publicIPv4) return false;
      const token = buildPlatformVerificationToken(machine.handle, platformSecret);
      try {
        const res = await fetch(`https://${machine.publicIPv4}:443/health`, {
          headers: { authorization: `Bearer ${token}` },
          dispatcher: customerVpsProxyDispatcher,
          signal: AbortSignal.timeout(8_000),
        } as RequestInit & { dispatcher: Agent });
        return res.ok;
      } catch (err: unknown) {
        console.warn(`[fleet-probe] health check failed for ${machine.handle}:`, err instanceof Error ? err.message : String(err));
        return false;
      }
    }

    app.route('/vps', createCustomerVpsRoutes({
      service: deps.customerVpsService,
      platformSecret,
      probeMachineHealth,
      probeMachineRuntime,
      recordRuntimeMetrics: platformMetricsRoutes.recordRuntimeMetrics,
      captureEvent: captureFunnelEvent,
    }));
  }

  app.route('/api/operator', createLaunchReadinessRoutes({
    service: createLaunchReadinessService({
      loadEvidence: createPlatformLaunchEvidenceLoader({ db, env: appEnv }),
    }),
    platformSecret,
  }));

  // Auth middleware for admin API routes below
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    if (c.req.path === '/metrics') return next();
    if (c.req.path.endsWith('/self-upgrade') && c.req.method === 'POST') return next();
    if (!platformSecret) {
      return c.json({ error: 'Platform admin not configured' }, 503);
    }
    const auth = c.req.header('authorization');
    if (!bearerTokenEquals(auth, platformSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  app.route('/', createLegacyContainerRoutes({
    db,
    orchestrator,
    customerVpsService: deps.customerVpsService,
    matrixProvisioner,
    platformSecret,
    adminBodyLimit: ADMIN_BODY_LIMIT,
    logRouteError: logPlatformRouteError,
  }));

  // --- Store API (public, no auth) ---

  app.route('/api/store', createStoreApi(db));

  // --- Social Feed API (public) ---

  const socialFeedApi = createSocialFeedApi(db);
  posthogShutdowns.push(() => socialFeedApi.shutdownPostHog());
  app.route('/api/social', socialFeedApi);

  // --- Social API (legacy: container-level profiles/messaging) ---

  const social = createSocialApi(db);

  app.get('/social/users', async (c) => {
    return c.json(await social.listUsers());
  });

  app.get('/social/profiles/:handle', async (c) => {
    const profile = await social.getProfile(c.req.param('handle'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(profile);
  });

  app.get('/social/profiles/:handle/ai', async (c) => {
    const profile = await social.getAiProfile(c.req.param('handle'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(profile);
  });

  app.post('/social/send/:handle', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e: unknown) {
      logPlatformRouteError('/social/send/:handle parse', e);
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const parsed = SocialSendBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation error' }, 400);
    }

    const { text, from } = parsed.data;
    try {
      const result = await social.sendMessage(c.req.param('handle'), text, from);
      return c.json(result);
    } catch (e: unknown) {
      logPlatformRouteError('/social/send/:handle', e);
      return c.json({ error: 'Message delivery failed' }, 404);
    }
  });

  // --- Subdomain proxy ---

  app.all('/proxy/:handle/*', bodyLimit({ maxSize: PROXY_BODY_LIMIT }), async (c) => {
    const handle = c.req.param('handle');
    if (!HANDLE_PATTERN.test(handle)) {
      return c.json({ error: 'Invalid handle' }, 400);
    }
    const path = c.req.path.replace(`/proxy/${handle}`, '') || '/';
    const qs = buildForwardedQueryString(c.req.url, APP_ASSET_ROUTE_OMITTED_QUERY_PARAMS);
    const runningMachine = await getRunningUserMachineByHandle(db, handle);
    if (runningMachine) {
      const targetUrl = buildCustomerVpsProxyUrl(runningMachine, path, qs);
      if (!targetUrl) {
        return c.json({ error: 'VPS unreachable' }, 502);
      }
      try {
        const headers = new Headers();
        const originalHost = c.req.header('host') ?? `${handle}.matrix-os.com`;
        for (const [key, value] of Object.entries(c.req.header())) {
          if (shouldForwardProxyHeader(key, value)) headers.set(key, value);
        }
        headers.set('host', `${handle}.matrix-os.com`);
        headers.set('x-forwarded-host', originalHost);
        headers.set('x-forwarded-proto', 'https');
        headers.set('accept-encoding', 'identity');

        const upstream = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
          dispatcher: customerVpsProxyDispatcher,
        } as RequestInit & { dispatcher: Agent });

        return new Response(upstream.body, {
          status: upstream.status,
          headers: sanitizeProxyResponseHeaders(upstream.headers),
        });
      } catch (err: unknown) {
        logPlatformRouteError('/proxy/:handle/* vps', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
    }

    if (!legacyContainerRoutingEnabled) {
      return c.json({ error: 'Matrix computer unavailable' }, 404);
    }

    const record = await getContainer(db, handle);
    if (!record) return c.json({ error: 'Unknown handle' }, 404);

    if (record.status === 'stopped') {
      try {
        await orchestrator.start(handle);
      } catch (err: unknown) {
        logPlatformRouteError('/proxy/:handle/* start', err);
        return c.json({ error: 'Failed to wake container' }, 503);
      }
    }

    await updateLastActive(db, handle);

    const targetUrl = `http://matrixos-${handle}:3000${path}`;

    try {
      const headers = new Headers();
      const originalHost = c.req.header('host') ?? '';
      for (const [key, value] of Object.entries(c.req.header())) {
        if (shouldForwardProxyHeader(key, value)) headers.set(key, value);
      }
      headers.set('x-forwarded-host', originalHost);
      headers.set('x-forwarded-proto', 'https');
      headers.set('accept-encoding', 'identity');

      const upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
      });

      return new Response(upstream.body, {
        status: upstream.status,
        headers: sanitizeProxyResponseHeaders(upstream.headers),
      });
    } catch (err: unknown) {
      logPlatformRouteError('/proxy/:handle/*', err);
      return c.json({ error: 'Container unreachable' }, 502);
    }
  });

  app.shutdownPostHog = async () => {
    await Promise.allSettled(posthogShutdowns.map((shutdownPostHog) => shutdownPostHog()));
  };

  return app;
}

// Start server when run directly
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
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

  const db = createPlatformDb(runtimeConfig.platformDatabaseUrl);
  await db.ready;

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
      platformSecret: PLATFORM_SECRET,
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

  // Clerk JWT verification (optional -- only active when CLERK_SECRET_KEY is set)
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

  // Matrix provisioner (optional: only if Conduit URL is configured)
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
  if (s3AccessKey && s3SecretKey && PLATFORM_SECRET) {
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
      platformSecret: PLATFORM_SECRET,
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
  let customerVpsReconciliationInterval: ReturnType<typeof setInterval> | undefined;
  let customerVpsReconciliationPromise: Promise<void> | undefined;
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
    customerVpsService = createCustomerVpsService({
      db,
      config: customerVpsConfig,
      hetzner: createHetznerClient(customerVpsConfig),
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
    const reconciliationIntervalMs = Number(process.env.CUSTOMER_VPS_RECONCILIATION_INTERVAL_MS ?? 60_000);
    if (reconciliationIntervalMs > 0) {
      // Customer VPS reconciliation currently assumes one active platform
      // process. If the platform is horizontally scaled, replace this
      // in-process guard with a DB advisory lock before enabling the interval
      // on multiple instances.
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
            // Onboarding journey maintenance, off the read path (spec 092):
            // sweep stale open checkout attempts and backfill legacy first-run records.
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
                    // Never follow a redirect: a compromised VPS must not be able
                    // to capture the platform bearer token by redirecting elsewhere.
                    redirect: 'error',
                    ...(customerVpsProxyDispatcher ? { dispatcher: customerVpsProxyDispatcher } : {}),
                  } as RequestInit & { dispatcher?: import('undici').Dispatcher });
                  if (!res.ok) return null;
                  let body: { complete?: unknown } | null = null;
                  try {
                    body = (await res.json()) as { complete?: unknown };
                  } catch (parseErr: unknown) {
                    // Malformed status body → log and treat as not-yet-complete.
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
  const app = createApp({
    db,
    docker,
    orchestrator,
    clerkAuth,
    matrixProvisioner,
    integrationRoutes,
    internalIntegrationRoutes,
    internalSyncRoutes,
    customerVpsService,
    customerVpsObjectStore,
    hostBundleObjectStore,
  });
  const processPosthogErrorTracker = createPostHogErrorTracker({
    service: 'matrix-platform',
  });
  const posthogProcessErrors = installPostHogProcessErrorTracking({
    tracker: processPosthogErrorTracker,
    service: 'matrix-platform',
  });

  const server = serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Platform listening on :${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[platform] Received ${signal}, shutting down`);
    if (customerVpsReconciliationInterval) {
      clearInterval(customerVpsReconciliationInterval);
    }
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
        await Promise.allSettled([
          containerProxyDispatcher.close(),
          customerVpsProxyDispatcher.close(),
        ]);
        posthogProcessErrors.dispose();
        await app.shutdownPostHog();
        await processPosthogErrorTracker.shutdown();
        await db.destroy();
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

  // WebSocket upgrade handler
  (server as import('node:http').Server).on('upgrade', async (req: IncomingMessage, socket, head) => {
    try {
      const handledInternalGeminiLive = await handleInternalGeminiLiveProxyUpgrade({
        req,
        socket: socket as Socket,
        head,
        db,
        platformSecret: PLATFORM_SECRET,
        geminiApiKey: process.env.GEMINI_API_KEY ?? '',
      });
      if (handledInternalGeminiLive) return;
    } catch (err: unknown) {
      console.warn('[platform] internal Gemini Live proxy failed:', describeError(err));
      app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_UPSTREAM_FAILED, {
        pathClass: 'internal-gemini-live',
        errorKind: err instanceof Error ? err.name : typeof err,
      });
      socket.destroy();
      return;
    }

    const path = req.url ?? '/';
    const pathClass = classifyWebSocketPath(path);
    const host = getTrustedSessionRoutedWebSocketHost(
      req.headers.host,
      req.headers['x-forwarded-host'],
      req.headers[EDGE_SECRET_HEADER],
      appEnv.EDGE_ROUTER_SECRET,
      path,
    );
    if (!isSessionRoutedHost(host)) {
      socket.destroy();
      return;
    }
    const isCodeDomain = isCodeDomainHost(host);
    const hostClass = classifySessionRoutedHost(host);

    const requestRuntimeSlot = readRuntimeSlot(path);
    const wsToken = getWebSocketUpgradeToken(path);
    let identity: AppDomainIdentity | null;
    try {
      identity = await resolveAppDomainIdentity({
        authHeader: req.headers.authorization as string | undefined,
        cookieHeader: req.headers.cookie,
        clerkAuth,
        db,
        platformJwtSecret: PLATFORM_JWT_SECRET,
        legacyContainerRoutingEnabled,
        runtimeSlot: requestRuntimeSlot,
        wsToken,
      });
    } catch (err: unknown) {
      console.warn(
        `[platform] websocket auth failed host=${host} pathClass=${pathClass} error=${describeError(err)}`,
      );
      app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_AUTH_FAILED, {
        hostClass,
        pathClass,
        runtimeSlot: requestRuntimeSlot,
        hasToken: Boolean(wsToken),
        hasCookie: Boolean(req.headers.cookie),
        errorKind: err instanceof Error ? err.name : typeof err,
      });
      socket.destroy();
      return;
    }
    if (!identity) {
      console.warn(`[platform] websocket unauthenticated host=${host} pathClass=${pathClass} hasCookie=${Boolean(req.headers.cookie)} hasToken=${Boolean(wsToken)}`);
      app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_UNAUTHENTICATED, {
        hostClass,
        pathClass,
        runtimeSlot: requestRuntimeSlot,
        hasToken: Boolean(wsToken),
        hasCookie: Boolean(req.headers.cookie),
      });
      socket.destroy();
      return;
    }

    let runtimeSlot = identity.runtimeSlot ?? requestRuntimeSlot;
    let requestedActiveMachine: UserMachineRecord | undefined;
    let runningMachine = identity.userId
      ? await getRunningUserMachineByClerkId(db, identity.userId, runtimeSlot)
      : await getRunningUserMachineByHandle(db, identity.handle);
    if (!runningMachine && identity.userId) {
      requestedActiveMachine = await getActiveUserMachineByClerkId(db, identity.userId, runtimeSlot);
      if (!requestedActiveMachine) {
        const handleMachine = await getRunningUserMachineByHandle(db, identity.handle);
        if (handleMachine?.clerkUserId === identity.userId) {
          runningMachine = handleMachine;
        }
      }
    }
    if (runningMachine) {
      runtimeSlot = runningMachine.runtimeSlot;
    }
    const record = legacyContainerRoutingEnabled
      ? await getContainer(db, identity.handle)
      : undefined;
    if (!runningMachine && !record) { socket.destroy(); return; }
    const entitlement = runningMachine
      ? await getRuntimeEntitlementDecisionForUser(db, runningMachine.clerkUserId, appEnv)
      : requestedActiveMachine
        ? await getRuntimeEntitlementDecisionForUser(db, requestedActiveMachine.clerkUserId, appEnv)
      : getRuntimeEntitlementDecision(appEnv);
    let activeUpstream: Socket | null = null;
    const onSocketError = () => activeUpstream?.destroy();
    socket.on('error', onSocketError);

    const buildUpgradeHeaders = (handle: string, includePlatformProof: boolean): string => (
      buildPlatformWebSocketUpgradeHeaders({
        incomingHeaders: req.headers,
        externalHost: host,
        handle,
        userId: identity.userId,
        platformSecret: PLATFORM_SECRET,
        includePlatformProof,
        isCodeDomain,
      })
    );

    const writeUpgradeRequest = (
      upstream: Socket,
      upstreamHostHeader: string,
      headers: string,
    ): void => {
      if (!isSafeWebSocketUpgradePath(path)) {
        socket.destroy();
        upstream.destroy();
        return;
      }
      const upstreamPath = stripWebSocketUpgradeToken(path);
      upstream.write(
        `${req.method} ${upstreamPath} HTTP/1.1\r\nHost: ${upstreamHostHeader}\r\n${headers}\r\n\r\n`
      );
      if (head.length > 0) upstream.write(head);

      upstream.pipe(socket);
      socket.pipe(upstream);
    };

    if (runningMachine) {
      if (!entitlement.runtimeProxyAllowed) {
        console.warn(
          `[platform] websocket runtime proxy denied by entitlement handle=${runningMachine.handle} pathClass=${pathClass}`,
        );
        app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_ENTITLEMENT_DENIED, {
          handle: runningMachine.handle,
          runtimeSlot,
          pathClass,
        });
        socket.destroy();
        return;
      }
      if (!runningMachine.publicIPv4) {
        console.warn(
          `[platform] websocket runtime proxy missing upstream address handle=${runningMachine.handle} pathClass=${pathClass}`,
        );
        socket.destroy();
        return;
      }
      const upstreamHostHeader = isCodeDomain ? host : 'app.matrix-os.com';
      const headers = buildUpgradeHeaders(runningMachine.handle, true);
      const upstreamServerName = upstreamHostHeader.split(':')[0] ?? upstreamHostHeader;
      const upstream = createTlsConnection({
        host: runningMachine.publicIPv4,
        port: 443,
        servername: upstreamServerName,
        rejectUnauthorized: shouldVerifyCustomerVpsTls(),
      }, () => {
        activeUpstream = upstream;
        writeUpgradeRequest(upstream, upstreamHostHeader, headers);
      });
      upstream.on('error', (err) => {
        upstream.destroy();
        console.warn(
          `[platform] websocket vps upstream failed handle=${runningMachine.handle} host=${runningMachine.publicIPv4} pathClass=${pathClass} error=${describeError(err)}`,
        );
        app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_UPSTREAM_FAILED, {
          handle: runningMachine.handle,
          runtimeSlot,
          pathClass,
          errorKind: err instanceof Error ? err.name : typeof err,
        });
        socket.destroy();
      });
      return;
    }

    if (!record) { socket.destroy(); return; }
    if (!entitlement.runtimeProxyAllowed) {
      console.warn(
        `[platform] websocket legacy container proxy denied by entitlement handle=${record.handle} pathClass=${pathClass}`,
      );
      socket.destroy();
      return;
    }
    const connectUpstream = async (attempt: number): Promise<void> => {
      const endpoint = await resolveContainerEndpoint(docker, db, record.handle, record.containerId);
      if (!endpoint) {
        console.warn(
          `[platform] websocket upstream unresolved handle=${record.handle} attempt=${attempt + 1} pathClass=${pathClass}`,
        );
        socket.destroy();
        return;
      }

      let connected = false;
      const targetPort = isCodeDomain ? CODE_SERVER_PORT : 4000;
      const upstream = createConnection({ host: endpoint.host, port: targetPort }, () => {
        connected = true;
        activeUpstream = upstream;
        const upstreamHostHeader = isCodeDomain ? host : `${endpoint.host}:${targetPort}`;
        writeUpgradeRequest(
          upstream,
          upstreamHostHeader,
          buildUpgradeHeaders(record.handle, !isCodeDomain),
        );
      });

      upstream.on('error', (err) => {
        upstream.destroy();
        console.warn(
          `[platform] websocket upstream failed handle=${record.handle} attempt=${attempt + 1} host=${endpoint.host} source=${endpoint.source} containerId=${endpoint.containerId ?? 'null'} pathClass=${pathClass} error=${describeError(err)}`,
        );
        if (!connected && attempt === 0 && !socket.destroyed) {
          void connectUpstream(attempt + 1).catch((retryErr) => {
            console.error('[platform] websocket upstream retry fatal error:', describeError(retryErr));
            socket.destroy();
          });
          return;
        }
        socket.destroy();
      });
    };

    void connectUpstream(0).catch((err) => {
      console.error('[platform] websocket upstream fatal error:', describeError(err));
      socket.destroy();
    });
  });
}
