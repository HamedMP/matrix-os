import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  createPostHogErrorTracker,
  installPostHogHonoErrorTracking,
  isMatrixTelemetryEvent,
  MATRIX_TELEMETRY_EVENTS,
  type MatrixTelemetryEvent,
} from '@matrix-os/observability';
import type Dockerode from 'dockerode';
import { Agent } from 'undici';
import { z } from 'zod/v4';
import {
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
  type UserMachineRecord,
} from './db.js';
import type { Orchestrator } from './orchestrator.js';
import { createSocialApi } from './social.js';
import { createStoreApi } from './store-api.js';
import { createSocialFeedApi } from './social-api.js';
import type { ClerkAuth } from './clerk-auth.js';
import type { MatrixProvisioner } from './matrix-provisioning.js';
import { createAuthRoutes } from './auth-routes.js';
import { issueSyncJwt, verifySyncJwt } from './sync-jwt.js';
import {
  isAppDomainHost,
  isCodeDomainHost,
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
import {
  sanitizeProxyResponseHeaders,
} from './proxy-headers.js';
import { appOrigin } from './origins.js';
import {
  createStripeBillingClient,
  createUnavailableStripeBillingClient,
} from './stripe-billing.js';
import type { CustomerVpsObjectStore } from './customer-vps-r2.js';
import { recordPlatformHttpRequest } from './metrics.js';
import {
  createLaunchReadinessService,
  createPlatformLaunchEvidenceLoader,
} from './launch-readiness.js';
import { createLaunchReadinessRoutes } from './launch-readiness-routes.js';
import { createHostBundleRoutes } from './host-bundle-routes.js';
import { createLegacyContainerRoutes } from './legacy-container-routes.js';
import { createAppSessionRoutes } from './app-session-routes.js';
import { createComputerRoutes } from './computer-routes.js';
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
import { createAtsRoutes } from './ats-routes.js';
import type { AtsDB } from './ats-db.js';
import { shouldVerifyCustomerVpsTls } from './customer-vps-tls.js';
import {
  APP_SESSION_COOKIE,
  readCookie,
} from './session-cookies.js';
import {
  buildForwardedQueryString,
} from './request-routing.js';
import {
  APP_ASSET_ROUTE_OMITTED_QUERY_PARAMS,
  shouldForwardProxyHeader,
} from './session-routing-proxy.js';
import {
  resolveAppDomainIdentity,
} from './session-routing-identity.js';
import { createSessionRoutingMiddleware } from './session-routing-middleware.js';
import {
  resolveContainerEndpoint,
} from './container-endpoint.js';
import { startPlatformServer } from './platform-startup.js';
import {
  checkHomeMirrorS3Env,
  checkHostBundleStorageEnv,
  checkUnsafeDefaultSecrets,
  collectTenantPublicTelemetryEnv,
} from './platform-startup-env.js';
import type { PlatformApp } from './platform-app-types.js';
export { escapeInlineScriptJson } from './auth-pages.js';
export { buildPostAuthRedirectPath } from './request-routing.js';
export type { PlatformApp } from './platform-app-types.js';
export {
  checkHomeMirrorS3Env,
  checkHostBundleStorageEnv,
  checkUnsafeDefaultSecrets,
} from './platform-startup-env.js';
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
const ADMIN_BODY_LIMIT = 64 * 1024;
const PROXY_BODY_LIMIT = 10 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30_000;
const AUTH_SHELL_PROXY_TIMEOUT_MS = 5_000;
const CODE_SERVER_PORT = Number(process.env.MATRIX_CODE_SERVER_PORT ?? 8787);

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

const SocialSendBodySchema = z.object({
  text: z.string().min(1).max(10_000),
  from: z.object({
    handle: z.string().regex(HANDLE_PATTERN),
    displayName: z.string().min(1).max(100).optional(),
  }),
});

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

function getGatewayUrlForHandle(handle: string): string {
  const safeHandle = requireValidHandle(handle);
  const tmpl = process.env.GATEWAY_URL_TEMPLATE;
  if (tmpl) {
    return tmpl.replace('{handle}', safeHandle);
  }
  return 'https://app.matrix-os.com';
}

export function createApp(deps: {
  db: PlatformDB;
  atsDb?: AtsDB;
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

  app.route('/', createComputerRoutes({
    db,
    clerkAuth,
    appEnv,
    platformJwtSecret,
    legacyContainerRoutingEnabled,
    applyNoStoreHeaders,
    logRouteError: logPlatformRouteError,
    getGatewayUrlForHandle,
  }));

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

  if (deps.atsDb) {
    app.route('/', createAtsRoutes({
      db: deps.atsDb,
      ingestSecret: appEnv.ATS_INGEST_SECRET ?? '',
      adminSecret: appEnv.ATS_ADMIN_SECRET ?? '',
      allowedRoleSlugs: [
        'founders-associate-gtm-operations',
        'founding-engineer',
      ],
      bookingBaseUrl: appEnv.ATS_BOOKING_BASE_URL,
      publicSiteUrl: appEnv.MATRIX_PUBLIC_SITE_URL ?? 'https://matrix-os.com',
    }));
  }

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

      const machine = await getRunningUserMachineByHandle(db, handle);
      const legacyContainer = await getContainer(db, handle);
      if (
        machine?.clerkUserId &&
        legacyContainer?.clerkUserId &&
        machine.clerkUserId !== legacyContainer.clerkUserId
      ) {
        return c.json({ error: 'Handle owner mismatch' }, 409);
      }

      const record = machine ?? legacyContainer;
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
  await startPlatformServer({
    port: PORT,
    platformSecret: PLATFORM_SECRET,
    platformJwtSecret: PLATFORM_JWT_SECRET,
    codeServerPort: CODE_SERVER_PORT,
    containerProxyDispatcher,
    customerVpsProxyDispatcher,
    createApp,
    checkUnsafeDefaultSecrets,
    checkHomeMirrorS3Env,
    checkHostBundleStorageEnv,
    collectTenantPublicTelemetryEnv,
    stripeBillingEntitlementsEnabled,
    resolveEffectiveBillingEntitlement,
    getRuntimeEntitlementDecision,
    getRuntimeEntitlementDecisionForUser,
  });
}
