import { createHmac, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { createConnection, type Socket } from 'node:net';
import { connect as createTlsConnection } from 'node:tls';
import type { IncomingMessage, Server } from 'node:http';
import Dockerode from 'dockerode';
import { Agent } from 'undici';
import { z } from 'zod/v4';
import {
  createPlatformDb,
  type ContainerRecord,
  type PlatformDB,
  getContainer,
  getContainerByClerkId,
  getRunningUserMachineByClerkId,
  getRunningUserMachineByHandle,
  updateLastActive,
  updateContainerStatus,
  listContainers,
} from './db.js';
import type { Orchestrator } from './orchestrator.js';
import { createSocialApi } from './social.js';
import { createStoreApi } from './store-api.js';
import { createSocialFeedApi } from './social-api.js';
import { createClerkAuth, type ClerkAuth } from './clerk-auth.js';
import type { MatrixProvisioner } from './matrix-provisioning.js';
import { createAuthRoutes } from './auth-routes.js';
import { issueSyncJwt, verifySyncJwt } from './sync-jwt.js';
import {
  getWebSocketUpgradeHost,
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
import { buildCustomerVpsProxyUrl } from './profile-routing.js';

const PORT = Number(process.env.PLATFORM_PORT ?? 9000);
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? '';
const PLATFORM_JWT_SECRET = process.env.PLATFORM_JWT_SECRET ?? '';
const DEV_PLATFORM_SECRET = 'dev-secret';
const DEV_PLATFORM_JWT_SECRET = 'dev-platform-jwt-secret-please-change-32';
const HANDLE_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;
const ADMIN_BODY_LIMIT = 64 * 1024;
const PROXY_BODY_LIMIT = 10 * 1024 * 1024;
const CLERK_SCRIPT_ORIGIN = 'https://clerk.matrix-os.com';
const PROXY_TIMEOUT_MS = 30_000;
const DOCKER_INSPECT_TIMEOUT_MS = 10_000;
const CODE_SERVER_PORT = Number(process.env.MATRIX_CODE_SERVER_PORT ?? 8787);
const CODE_SESSION_COOKIE = 'matrix_code_session';
const CODE_SESSION_EXPIRES_IN_SEC = 12 * 60 * 60;

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
    rejectUnauthorized: process.env.CUSTOMER_VPS_TLS_VERIFY !== 'false',
  },
});
const WS_TOKEN_EXPIRES_IN_SEC = 5 * 60;
const SENSITIVE_PROXY_HEADERS = new Set(['authorization', 'cookie']);

const ProvisionBodySchema = z.object({
  handle: z.string().regex(HANDLE_PATTERN),
  clerkUserId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(100).optional(),
});

const SocialSendBodySchema = z.object({
  text: z.string().min(1).max(10_000),
  from: z.object({
    handle: z.string().regex(HANDLE_PATTERN),
    displayName: z.string().min(1).max(100).optional(),
  }),
});

function isMissingContainerError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('No container for handle:');
}

function logPlatformRouteError(route: string, err: unknown): void {
  console.error(
    `[platform] ${route} failed:`,
    err instanceof Error ? err.message : String(err),
  );
}

function bearerTokenEquals(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }
  return timingSafeTokenEquals(authHeader.slice(7), expected);
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]+)`));
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch (err: unknown) {
    if (err instanceof URIError) {
      return null;
    }
    console.warn('[platform] Failed to decode cookie value:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function buildCodeSessionCookie(token: string): string {
  return [
    `${CODE_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${CODE_SESSION_EXPIRES_IN_SEC}`,
  ].join('; ');
}

function applyNoStoreHeaders(c: import('hono').Context): void {
  c.header('Cache-Control', 'no-store, private');
  c.header('CDN-Cache-Control', 'no-store');
  c.header('Cloudflare-CDN-Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
}

function applyCodeDomainStaticAssetHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.set('Cache-Control', 'no-store, private');
  next.set('CDN-Cache-Control', 'no-store');
  next.set('Cloudflare-CDN-Cache-Control', 'no-store');
  next.set('Pragma', 'no-cache');
  next.set('Expires', '0');
  return next;
}

function isCodeDomainStaticAssetPath(path: string): boolean {
  return (
    path === '/favicon.ico' ||
    path.startsWith('/_static/') ||
    /^\/stable-[^/]+\/static\//.test(path)
  );
}

function buildCodeDomainProxyHeaders(
  requestHeaders: Record<string, string | undefined>,
  host: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (key !== 'host' && key !== 'cookie' && key !== 'authorization' && value) {
      headers.set(key, value);
    }
  }
  headers.set('host', host);
  headers.set('x-forwarded-host', host);
  headers.set('x-forwarded-proto', 'https');
  headers.set('connection', 'close');
  return headers;
}

async function pickCodeDomainStaticAssetContainer(db: PlatformDB): Promise<ContainerRecord | null> {
  return (await listContainers(db, 'running'))[0] ?? null;
}

function buildPlatformUserProof(handle: string, userId: string, platformSecret: string): string {
  const handleToken = buildPlatformVerificationToken(handle, platformSecret);
  return createHmac('sha256', handleToken).update(userId).digest('hex');
}

function requireValidHandle(handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error('Invalid handle');
  }
  return handle;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

function applyAuthPageHeaders(
  c: import('hono').Context,
  scriptNonce: string,
): void {
  applyNoStoreHeaders(c);
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    `frame-ancestors 'none'; script-src 'self' 'nonce-${scriptNonce}' ${CLERK_SCRIPT_ORIGIN}; object-src 'none'; base-uri 'none'`,
  );
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

interface AppDomainIdentity {
  handle: string;
  userId: string;
}

interface ResolvedContainerEndpoint {
  containerId: string | null;
  host: string;
  source: 'record' | 'docker-id' | 'docker-name';
}

function isDockerNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('No such container') || message.includes('404');
}

async function inspectLiveContainer(
  docker: Dockerode,
  handle: string,
  containerId?: string | null,
): Promise<{ info: Dockerode.ContainerInspectInfo; source: 'docker-id' | 'docker-name' } | null> {
  const candidates: Array<{ target: string; source: 'docker-id' | 'docker-name' }> = [];
  if (containerId) {
    candidates.push({ target: containerId, source: 'docker-id' });
  }
  candidates.push({ target: `matrixos-${handle}`, source: 'docker-name' });

  for (const candidate of candidates) {
    try {
      const info = await Promise.race([
        docker.getContainer(candidate.target).inspect(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Docker inspect timeout after ${DOCKER_INSPECT_TIMEOUT_MS}ms`)), DOCKER_INSPECT_TIMEOUT_MS);
        }),
      ]);
      return { info, source: candidate.source };
    } catch (err: unknown) {
      if (!isDockerNotFoundError(err)) {
        throw err;
      }
    }
  }

  return null;
}

function getContainerHostFromInspect(
  info: Dockerode.ContainerInspectInfo,
  handle: string,
): string {
  const networks = info.NetworkSettings?.Networks
    ? Object.values(info.NetworkSettings.Networks)
    : [];
  const ip = networks.find(
    (network) => typeof network?.IPAddress === 'string' && network.IPAddress.length > 0,
  )?.IPAddress;
  return ip || `matrixos-${handle}`;
}

async function resolveContainerEndpoint(
  docker: Dockerode | undefined,
  db: PlatformDB,
  handle: string,
  containerId?: string | null,
): Promise<ResolvedContainerEndpoint | null> {
  if (!docker) {
    return {
      containerId: containerId ?? null,
      host: `matrixos-${handle}`,
      source: 'record',
    };
  }

  const inspected = await inspectLiveContainer(docker, handle, containerId);
  if (!inspected) {
    return null;
  }

  const { info, source } = inspected;
  if (info.Id && info.Id !== containerId) {
    await updateContainerStatus(db, handle, info.State?.Running ? 'running' : 'stopped', info.Id);
  }

  return {
    containerId: info.Id ?? containerId ?? null,
    host: getContainerHostFromInspect(info, handle),
    source,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
function isSyncJwtAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name.startsWith("JWT") ||
    err.name.startsWith("JWS") ||
    err.message === "Invalid sync JWT claims" ||
    err.message.startsWith("JWT handle ")
  );
}

async function resolveAppDomainIdentity(opts: {
  authHeader: string | undefined;
  cookieHeader: string | undefined;
  clerkAuth?: ClerkAuth;
  db: PlatformDB;
  platformJwtSecret: string;
  wsToken?: string | null;
}): Promise<AppDomainIdentity | null> {
  const codeSessionToken = readCookie(opts.cookieHeader, CODE_SESSION_COOKIE);
  const bearerToken =
    opts.authHeader?.startsWith('Bearer ')
      ? opts.authHeader.slice(7)
      : opts.wsToken ?? codeSessionToken;

  if (bearerToken && opts.platformJwtSecret) {
    try {
      const claims = await verifySyncJwt(bearerToken, { secret: opts.platformJwtSecret });
      const record = await getContainer(opts.db, claims.handle);
      if (record?.clerkUserId === claims.sub) {
        return {
          handle: record.handle,
          userId: record.clerkUserId,
        };
      }
      const machine = await getRunningUserMachineByHandle(opts.db, claims.handle);
      if (machine?.clerkUserId !== claims.sub) {
        return null;
      }
      return {
        handle: machine.handle,
        userId: machine.clerkUserId,
      };
    } catch (err: unknown) {
      if (!isSyncJwtAuthError(err)) {
        throw err;
      }
      // Fall through to Clerk session auth.
    }
  }

  if (!opts.clerkAuth) {
    return null;
  }

  const token = opts.clerkAuth.extractToken(opts.authHeader, opts.cookieHeader);
  if (!token) {
    return null;
  }

  const result = await opts.clerkAuth.verify(token);
  if (!result.authenticated || !result.userId) {
    return null;
  }

  const record = await getContainerByClerkId(opts.db, result.userId);
  if (record) {
    return {
      handle: record.handle,
      userId: result.userId,
    };
  }
  const machine = await getRunningUserMachineByClerkId(opts.db, result.userId);
  if (!machine) {
    return null;
  }

  return {
    handle: machine.handle,
    userId: result.userId,
  };
}

function getGatewayUrlForHandle(handle: string): string {
  const safeHandle = requireValidHandle(handle);
  const tmpl = process.env.GATEWAY_URL_TEMPLATE;
  if (tmpl) {
    return tmpl.replace('{handle}', safeHandle);
  }
  return 'https://app.matrix-os.com';
}

function getAuthPage(
  publishableKey: string,
  mode: 'sign-in' | 'sign-up',
  scriptNonce: string,
) {
  const escapedPublishableKey = escapeHtmlAttr(publishableKey);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix OS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    #auth { min-height: 400px; display: flex; align-items: center; justify-content: center; }
    .loading { color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div id="auth"><span class="loading">Loading...</span></div>
  <script
    id="clerk-script"
    nonce="${scriptNonce}"
    async
    crossorigin="anonymous"
    data-clerk-publishable-key="${escapedPublishableKey}"
    src="${CLERK_SCRIPT_ORIGIN}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
    type="text/javascript"
  ></script>
  <script nonce="${scriptNonce}">
    function initClerk() {
      window.Clerk.load({ signInUrl: '/sign-in', signUpUrl: '/sign-up' }).then(function() {
        if (window.Clerk.user) {
          window.location.replace('/');
          return;
        }
        var el = document.getElementById('auth');
        el.innerHTML = '';
        if ('${mode}' === 'sign-up') {
          window.Clerk.mountSignUp(el, { signInUrl: '/sign-in', afterSignUpUrl: '/' });
        } else {
          window.Clerk.mountSignIn(el, { signUpUrl: '/sign-up', afterSignInUrl: '/' });
        }
      });
    }
    if (window.Clerk) {
      initClerk();
    } else {
      document.getElementById('clerk-script').addEventListener('load', initClerk);
    }
  </script>
</body>
</html>`;
}

async function proxyToShell(c: import('hono').Context, host: string, port: number) {
  const path = c.req.path;
  const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
  const targetUrl = `http://${host}:${port}${path}${qs}`;
  const originalHost = c.req.header('host') ?? 'app.matrix-os.com';

  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      if (key !== 'host' && value) headers.set(key, String(value));
    }
    headers.set('host', originalHost);
    headers.set('x-forwarded-host', originalHost);
    headers.set('x-forwarded-proto', 'https');

    const upstream = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (err: unknown) {
    logPlatformRouteError('proxyToShell', err);
    return new Response('Auth service unavailable', { status: 502 });
  }
}

function getNoContainerPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix OS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a0a0a; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .card { text-align: center; max-width: 400px; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: #999; margin-bottom: 1.5rem; line-height: 1.6; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>No instance yet</h1>
    <p>Your account doesn't have a Matrix OS instance provisioned. Visit the <a href="https://matrix-os.com/dashboard">dashboard</a> to set one up.</p>
  </div>
</body>
</html>`;
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
}) {
  const { db, docker, orchestrator, clerkAuth, matrixProvisioner } = deps;
  const platformSecret = deps.platformSecret ?? process.env.PLATFORM_SECRET ?? '';
  const app = new Hono<{
    Variables: {
      platformUserId: string;
      platformHandle: string;
      internalContainerHandle: string;
      internalContainerClerkUserId: string;
    };
  }>();

  // Health check (unauthenticated)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Matrix well-known endpoints (unauthenticated, required for federation)
  const CONDUIT_SERVER = process.env.CONDUIT_SERVER ?? 'matrix-os.com:6167';
  const CONDUIT_BASE_URL = process.env.CONDUIT_BASE_URL ?? 'https://matrix-os.com';

  app.get('/.well-known/matrix/server', (c) =>
    c.json({ 'm.server': CONDUIT_SERVER }),
  );
  app.get('/.well-known/matrix/client', (c) =>
    c.json({ 'm.homeserver': { base_url: CONDUIT_BASE_URL } }),
  );

  // Prometheus metrics (unauthenticated for scraping)
  app.get('/metrics', async (c) => {
    const { metricsRegistry } = await import('./metrics.js');
    const metrics = await metricsRegistry.metrics();
    return c.text(metrics, 200, {
      'Content-Type': metricsRegistry.contentType,
    });
  });

  // OAuth 2.0 Device Flow (RFC 8628) -- mounted before any host-based routing
  // so the CLI's poll/code endpoints work regardless of which subdomain hits
  // the platform. Public endpoints; admin Bearer middleware below skips them.
  const platformJwtSecret = process.env.PLATFORM_JWT_SECRET ?? '';
  if (platformJwtSecret) {
    const platformPublicUrl =
      process.env.PLATFORM_PUBLIC_URL ?? `http://localhost:${process.env.PLATFORM_PORT ?? 9000}`;
    app.route(
      '/',
      createAuthRoutes({
        db,
        clerkAuth,
        jwtSecret: platformJwtSecret,
        platformUrl: platformPublicUrl,
        gatewayUrlForHandle: getGatewayUrlForHandle,
      }),
    );
  }

  // Session-based routing:
  // - app.matrix-os.com -> Clerk session -> Matrix OS shell/gateway
  // - code.matrix-os.com -> Clerk session -> code-server on the user's VPS
  app.use('*', bodyLimit({ maxSize: PROXY_BODY_LIMIT }), async (c, next) => {
    const host = c.req.header('host') ?? '';
    const isAppDomain = isAppDomainHost(host);
    const isCodeDomain = isCodeDomainHost(host);
    if (!isAppDomain && !isCodeDomain) return next();

    // Device-flow paths are served directly by the platform's auth-routes.ts
    // (registered above). In normal dispatch they never reach this middleware,
    // but we short-circuit explicitly so a misconfigured PLATFORM_JWT_SECRET or
    // a future refactor can't accidentally proxy them into a user container.
    const reqPath = c.req.path;
    if (isAppDomain && (
      reqPath === '/auth/device' ||
      reqPath.startsWith('/auth/device/') ||
      reqPath.startsWith('/api/auth/device/')
    )) {
      return next();
    }
    const isPublicIntegrationPath =
      reqPath === '/api/integrations/available' ||
      reqPath.startsWith('/api/integrations/webhook/');
    const isIntegrationPath =
      reqPath === '/api/integrations' || reqPath.startsWith('/api/integrations/');
    if (isAppDomain && isPublicIntegrationPath) {
      return next();
    }

    const authHeader = c.req.header('authorization');
    const cookieHeader = c.req.header('cookie');

    const path = c.req.path;
    const isGatewayPath = isAppDomain && (
      path.startsWith('/api/') ||
      path.startsWith('/ws') ||
      path.startsWith('/files/') ||
      path.startsWith('/modules/') ||
      path === '/health'
    );
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    const authMode = path.startsWith('/sign-up') ? 'sign-up' : 'sign-in';

    const identity = await resolveAppDomainIdentity({
      authHeader,
      cookieHeader,
      clerkAuth,
      db,
      platformJwtSecret,
    });

    // No session/JWT -- serve Clerk auth directly from the platform.
    if (!identity) {
      if (isCodeDomain && isCodeDomainStaticAssetPath(path)) {
        const staticRecord = await pickCodeDomainStaticAssetContainer(db);
        if (!staticRecord) {
          applyNoStoreHeaders(c);
          return c.text('Editor assets unavailable', 503);
        }
        const endpoint = await resolveContainerEndpoint(docker, db, staticRecord.handle, staticRecord.containerId);
        if (!endpoint) {
          applyNoStoreHeaders(c);
          return c.text('Editor assets unavailable', 503);
        }
        const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
        const targetUrl = `http://${endpoint.host}:${CODE_SERVER_PORT}${path}${qs}`;
        try {
          const upstream = await fetch(targetUrl, {
            method: c.req.method,
            headers: buildCodeDomainProxyHeaders(c.req.header(), host),
            redirect: 'manual',
            signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
            body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
            dispatcher: containerProxyDispatcher,
          } as RequestInit & { dispatcher: Agent });

          return new Response(upstream.body, {
            status: upstream.status,
            headers: applyCodeDomainStaticAssetHeaders(upstream.headers),
          });
        } catch (err: unknown) {
          logPlatformRouteError('code-domain static asset proxy', err);
          applyNoStoreHeaders(c);
          return c.text('Editor assets unavailable', 502);
        }
      }
      console.log(`[${isCodeDomain ? 'code' : 'app'}] no token path=${path}`);
      if (isGatewayPath) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!publishableKey || !clerkAuth) {
        return c.text('Clerk publishable key not configured', 500);
      }
      const scriptNonce = randomBytes(16).toString('base64');
      applyAuthPageHeaders(c, scriptNonce);
      return c.html(getAuthPage(publishableKey, authMode, scriptNonce));
    }

    console.log(`[${isCodeDomain ? 'code' : 'app'}] verified request path=${path}`);
    const runningMachine = await getRunningUserMachineByHandle(db, identity.handle);
    if (runningMachine) {
      const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
      const targetUrl = buildCustomerVpsProxyUrl(runningMachine, path, qs);
      if (!targetUrl) {
        return c.json({ error: 'VPS unreachable' }, 502);
      }
      const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob();
      const headers = isCodeDomain ? buildCodeDomainProxyHeaders(c.req.header(), host) : new Headers();
      if (!isCodeDomain) {
        for (const [key, value] of Object.entries(c.req.header())) {
          if (key !== 'host' && key !== 'cookie' && key !== 'authorization' && value) {
            headers.set(key, value);
          }
        }
        const rawCookie = c.req.header('cookie');
        if (rawCookie) {
          const forwarded = rawCookie
            .split(';')
            .map((p) => p.trim())
            .filter((p) => p.startsWith('matrix_app_session__'))
            .join('; ');
          if (forwarded) headers.set('cookie', forwarded);
        }
        headers.set('host', `${runningMachine.handle}.matrix-os.com`);
        headers.set('x-forwarded-host', host);
        headers.set('x-forwarded-proto', 'https');
        headers.set('connection', 'close');
      }
      if (platformSecret) {
        headers.set('authorization', `Bearer ${buildPlatformVerificationToken(runningMachine.handle, platformSecret)}`);
        headers.set('x-platform-verified', buildPlatformUserProof(runningMachine.handle, identity.userId, platformSecret));
        headers.set('x-platform-user-id', identity.userId);
      }

      try {
        const upstream = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
          body,
          dispatcher: customerVpsProxyDispatcher,
        } as RequestInit & { dispatcher: Agent });

        const responseHeaders = new Headers(upstream.headers);
        if (isCodeDomain && platformJwtSecret) {
          const issued = await issueSyncJwt({
            secret: platformJwtSecret,
            clerkUserId: identity.userId,
            handle: runningMachine.handle,
            gatewayUrl: 'https://code.matrix-os.com',
            expiresInSec: CODE_SESSION_EXPIRES_IN_SEC,
          });
          responseHeaders.append('set-cookie', buildCodeSessionCookie(issued.token));
        }

        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch (err: unknown) {
        logPlatformRouteError(isCodeDomain ? 'code-domain vps proxy' : 'app-domain vps proxy', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
    }

    const record = await getContainer(db, identity.handle);
    if (!record) {
      return c.html(getNoContainerPage());
    }

    if (isAppDomain && isIntegrationPath) {
      c.set('platformUserId', identity.userId);
      c.set('platformHandle', record.handle);
      return next();
    }

    if (isAppDomain && path === '/api/auth/ws-token') {
      if (!platformJwtSecret) {
        return c.json({ error: 'WebSocket auth unavailable' }, 503);
      }
      const issued = await issueSyncJwt({
        secret: platformJwtSecret,
        clerkUserId: identity.userId,
        handle: record.handle,
        gatewayUrl: getGatewayUrlForHandle(record.handle),
        expiresInSec: WS_TOKEN_EXPIRES_IN_SEC,
      });
      return c.json({
        token: issued.token,
        expiresAt: issued.expiresAt,
      });
    }

    if (record.status === 'stopped') {
      try {
        await orchestrator.start(record.handle);
      } catch (err: unknown) {
        logPlatformRouteError('app-domain container start', err);
        return c.json({ error: 'Failed to wake container' }, 503);
      }
    }

    await updateLastActive(db, record.handle);

    const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
    const targetPort = isCodeDomain ? CODE_SERVER_PORT : isGatewayPath ? 4000 : 3000;
    const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob();
    const headers = isCodeDomain ? buildCodeDomainProxyHeaders(c.req.header(), host) : new Headers();
    if (!isCodeDomain) {
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key !== 'host' && key !== 'cookie' && key !== 'authorization' && value) {
          headers.set(key, value);
        }
      }
    }
    // Forward only the app-session cookies (spec 063). Clerk and other
    // cookies are stripped because gateway auth goes via the bearer token
    // set below; forwarding them would leak the user's Clerk session into
    // the container process.
    if (!isCodeDomain) {
      const rawCookie = c.req.header('cookie');
      if (rawCookie) {
        const forwarded = rawCookie
          .split(';')
          .map((p) => p.trim())
          .filter((p) => p.startsWith('matrix_app_session__'))
          .join('; ');
        if (forwarded) headers.set('cookie', forwarded);
      }
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');
      headers.set('connection', 'close');
    }
    if (platformSecret && isAppDomain) {
      headers.set('authorization', `Bearer ${buildPlatformVerificationToken(record.handle, platformSecret)}`);
      headers.set('x-platform-verified', buildPlatformUserProof(record.handle, identity.userId, platformSecret));
      headers.set('x-platform-user-id', identity.userId);
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const endpoint = await resolveContainerEndpoint(docker, db, record.handle, record.containerId);
      if (!endpoint) {
        console.warn(
          `[platform] app-domain proxy unresolved handle=${record.handle} attempt=${attempt + 1} path=${path} targetPort=${targetPort}`,
        );
        return c.json({ error: 'Container unreachable' }, 502);
      }

      const targetUrl = `http://${endpoint.host}:${targetPort}${path}${qs}`;
      try {
        const upstream = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
          body,
          dispatcher: containerProxyDispatcher,
        } as RequestInit & { dispatcher: Agent });

        const responseHeaders = new Headers(upstream.headers);
        if (isCodeDomain && platformJwtSecret) {
          const issued = await issueSyncJwt({
            secret: platformJwtSecret,
            clerkUserId: identity.userId,
            handle: record.handle,
            gatewayUrl: 'https://code.matrix-os.com',
            expiresInSec: CODE_SESSION_EXPIRES_IN_SEC,
          });
          responseHeaders.append('set-cookie', buildCodeSessionCookie(issued.token));
        }

        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch (err: unknown) {
        lastErr = err;
        const routeName = isCodeDomain ? 'code-domain' : 'app-domain';
        console.warn(
          `[platform] ${routeName} proxy retry attempt=${attempt + 1} handle=${record.handle} target=${targetUrl} source=${endpoint.source} containerId=${endpoint.containerId ?? 'null'} error=${describeError(err)}`,
        );
      }
    }

    logPlatformRouteError(isCodeDomain ? 'code-domain proxy' : 'app-domain proxy', lastErr);
    return c.json({ error: 'Container unreachable' }, 502);
  });

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
  if (deps.customerVpsService) {
    app.route('/vps', createCustomerVpsRoutes({
      service: deps.customerVpsService,
      platformSecret,
    }));
  }

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

  // --- Container management ---

  app.post('/containers/provision', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e: unknown) {
      logPlatformRouteError('/containers/provision parse', e);
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const parsed = ProvisionBodySchema.safeParse(body);
    if (!parsed.success) {
      const data = body as { handle?: unknown; clerkUserId?: unknown } | null;
      if (!data || typeof data !== 'object' || data.handle === undefined || data.clerkUserId === undefined) {
        return c.json({ error: 'handle and clerkUserId required' }, 400);
      }
      if (typeof data.handle !== 'string' || !HANDLE_PATTERN.test(data.handle)) {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      return c.json({ error: 'Validation error' }, 400);
    }

    const { handle, clerkUserId, displayName } = parsed.data;
    if (!handle || !clerkUserId) {
      return c.json({ error: 'handle and clerkUserId required' }, 400);
    }
    try {
      const record = await orchestrator.provision(handle, clerkUserId, displayName);

      // Provision Matrix accounts (non-blocking: log error but don't fail container provision)
      if (matrixProvisioner) {
        try {
          await matrixProvisioner.provisionUser(handle);
        } catch (matrixErr) {
          console.error(`[matrix] Failed to provision Matrix accounts for ${handle}:`, matrixErr instanceof Error ? matrixErr.message : String(matrixErr));
        }
      }

      return c.json(record, 201);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.startsWith('Container already exists for handle:')) {
        return c.json({ error: 'Container already exists' }, 409);
      }
      logPlatformRouteError('/containers/provision', e);
      return c.json({ error: 'Provision failed' }, 500);
    }
  });

  app.post('/containers/:handle/start', async (c) => {
    try {
      await orchestrator.start(requireValidHandle(c.req.param('handle')));
      return c.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logPlatformRouteError('/containers/:handle/start', e);
      return c.json({ error: 'Failed to start container' }, 500);
    }
  });

  app.post('/containers/:handle/stop', async (c) => {
    try {
      await orchestrator.stop(requireValidHandle(c.req.param('handle')));
      return c.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logPlatformRouteError('/containers/:handle/stop', e);
      return c.json({ error: 'Failed to stop container' }, 500);
    }
  });

  app.post('/containers/:handle/upgrade', async (c) => {
    try {
      const record = await orchestrator.upgrade(requireValidHandle(c.req.param('handle')));
      return c.json(record);
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logPlatformRouteError('/containers/:handle/upgrade', e);
      return c.json({ error: 'Upgrade failed' }, 500);
    }
  });

  app.post('/containers/:handle/self-upgrade', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    if (!platformSecret) {
      return c.json({ error: 'Self-upgrade not configured' }, 503);
    }
    let handle: string;
    try {
      handle = requireValidHandle(c.req.param('handle'));
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message === 'Invalid handle')) {
        console.error('[platform] Unexpected self-upgrade handle validation failure:', err);
      }
      return c.json({ error: 'Invalid handle' }, 400);
    }
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

    const expected = buildPlatformVerificationToken(handle, platformSecret);
    if (!timingSafeTokenEquals(token, expected)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const record = await orchestrator.upgrade(handle);
      return c.json(record);
    } catch (e: unknown) {
      logPlatformRouteError('/containers/:handle/self-upgrade', e);
      return c.json({ error: 'Upgrade failed' }, 500);
    }
  });

  app.post('/containers/rolling-restart', async (c) => {
    const result = await orchestrator.rollingRestart();
    return c.json(result);
  });

  app.delete('/containers/:handle', async (c) => {
    try {
      await orchestrator.destroy(requireValidHandle(c.req.param('handle')));
      return c.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logPlatformRouteError('/containers/:handle', e);
      return c.json({ error: 'Failed to destroy container' }, 500);
    }
  });

  app.get('/containers', async (c) => {
    await orchestrator.syncStates();
    const status = c.req.query('status');
    return c.json(await orchestrator.listAll(status));
  });

  app.get('/containers/:handle', async (c) => {
    const info = await orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json({ ...info, image: orchestrator.getImage() });
  });

  app.get('/containers/check-handle/:handle', async (c) => {
    const info = await orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json({ exists: true, status: info.status });
  });

  // --- Admin dashboard ---

  app.get('/admin/dashboard', async (c) => {
    await orchestrator.syncStates();
    const all = await orchestrator.listAll();
    const running = all.filter((r) => r.status === 'running');
    const stopped = all.filter((r) => r.status !== 'running');

    const containerResults = await Promise.all(
      running.map(async (r) => {
        const base = `http://matrixos-${r.handle}:4000`;
        const timeout = 3000;

        const fetchJson = async (url: string, label: string) => {
          try {
            const res = await fetch(url, {
              signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok) {
              console.warn(`[platform] ${label} returned ${res.status}`);
              return null;
            }
            return await res.json();
          } catch (err: unknown) {
            console.warn(
              `[platform] ${label} failed:`,
              err instanceof Error ? err.message : String(err),
            );
            return null;
          }
        };

        const [health, systemInfo, conversations] = await Promise.all([
          fetchJson(`${base}/health`, `${r.handle} health check`),
          fetchJson(`${base}/api/system/info`, `${r.handle} system info`),
          fetchJson(`${base}/api/conversations`, `${r.handle} conversations`),
        ]);

        return {
          handle: r.handle,
          status: r.status,
          lastActive: r.lastActive,
          health,
          systemInfo,
          conversationCount: Array.isArray(conversations) ? conversations.length : null,
        };
      }),
    );

    let usageSummary = null;
    try {
      const res = await fetch('http://proxy:8080/usage/summary', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) usageSummary = await res.json();
      else console.warn(`[platform] usage summary returned ${res.status}`);
    } catch (err: unknown) {
      console.warn(
        '[platform] usage summary fetch failed:',
        err instanceof Error ? err.message : String(err),
      );
    }

    return c.json({
      timestamp: new Date().toISOString(),
      summary: {
        total: all.length,
        running: running.length,
        stopped: stopped.length,
      },
      containers: containerResults,
      stoppedContainers: stopped.map((r) => ({
        handle: r.handle,
        status: r.status,
        lastActive: r.lastActive,
      })),
      usageSummary,
    });
  });

  // --- Store API (public, no auth) ---

  app.route('/api/store', createStoreApi(db));

  // --- Social Feed API (public) ---

  app.route('/api/social', createSocialFeedApi(db));

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
    const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
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
          const lowerKey = key.toLowerCase();
          if (lowerKey !== 'host' && !SENSITIVE_PROXY_HEADERS.has(lowerKey) && value) headers.set(key, value);
        }
        headers.set('host', `${handle}.matrix-os.com`);
        headers.set('x-forwarded-host', originalHost);
        headers.set('x-forwarded-proto', 'https');

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
          headers: upstream.headers,
        });
      } catch (err: unknown) {
        logPlatformRouteError('/proxy/:handle/* vps', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
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
        const lowerKey = key.toLowerCase();
        if (lowerKey !== 'host' && !SENSITIVE_PROXY_HEADERS.has(lowerKey) && value) headers.set(key, value);
      }
      headers.set('x-forwarded-host', originalHost);
      headers.set('x-forwarded-proto', 'https');

      const upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
      });

      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    } catch (err: unknown) {
      logPlatformRouteError('/proxy/:handle/*', err);
      return c.json({ error: 'Container unreachable' }, 502);
    }
  });

  return app;
}

// Start server when run directly
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  if (checkUnsafeDefaultSecrets().length > 0) {
    process.exit(1);
  }
  const platformDatabaseUrl = process.env.PLATFORM_DATABASE_URL ??
    (process.env.POSTGRES_URL ? `${process.env.POSTGRES_URL}/matrixos_platform` : undefined);
  const db = platformDatabaseUrl ? createPlatformDb(platformDatabaseUrl) : createPlatformDb();
  await db.ready;
  const docker = new Dockerode();
  const extraEnv: string[] = [];
  if (process.env.CLERK_SECRET_KEY) {
    extraEnv.push(`CLERK_SECRET_KEY=${process.env.CLERK_SECRET_KEY}`);
  }
  if (process.env.GEMINI_API_KEY) {
    extraEnv.push(`GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`);
  }
  for (const key of [
    'MATRIX_HOME_MIRROR',
  ]) {
    if (process.env[key]) extraEnv.push(`${key}=${process.env[key]}`);
  }

  checkHomeMirrorS3Env();

  const [{ createOrchestrator }, { createLifecycleManager }] = await Promise.all([
    import('./orchestrator.js'),
    import('./lifecycle.js'),
  ]);
  const orchestrator = createOrchestrator({
    db,
    docker,
    image: process.env.PLATFORM_IMAGE,
    dataDir: process.env.PLATFORM_DATA_DIR,
    platformSecret: PLATFORM_SECRET,
    extraEnv,
    postgresUrl: process.env.POSTGRES_URL,
  });

  const maxRunning = Number(process.env.MAX_RUNNING_CONTAINERS) || 20;
  const lifecycle = createLifecycleManager({ db, orchestrator, maxRunning });
  lifecycle.start();

  const { createStatsCollector } = await import('./stats-collector.js');
  const statsCollector = createStatsCollector({
    docker,
    listRunning: () => listContainers(db, 'running'),
    onResolvedContainerId: async (handle, containerId) => {
      await updateContainerStatus(db, handle, 'running', containerId);
    },
  });
  statsCollector.start();

  // Clerk JWT verification (optional -- only active when CLERK_SECRET_KEY is set)
  let clerkAuth: ClerkAuth | undefined;
  if (process.env.CLERK_SECRET_KEY) {
    const { verifyToken } = await import('@clerk/backend');
    clerkAuth = createClerkAuth({
      verifyToken: async (token: string) => {
        const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
        return payload as { sub: string; [key: string]: unknown };
      },
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
  if (
    process.env.POSTGRES_URL &&
    process.env.PIPEDREAM_CLIENT_ID &&
    process.env.PIPEDREAM_CLIENT_SECRET &&
    process.env.PIPEDREAM_PROJECT_ID
  ) {
    const [
      { createIntegrationRoutes },
      { createPipedreamClient },
      { createPlatformDb: createGatewayPlatformDb },
    ] = await Promise.all([
      import('../../gateway/src/integrations/routes.js'),
      import('../../gateway/src/integrations/pipedream.js'),
      import('../../gateway/src/platform-db.js'),
    ]);

    const trustedPlatformDb = createGatewayPlatformDb(`${process.env.POSTGRES_URL}/matrixos_platform`);
    await trustedPlatformDb.migrate();
    const pipedream = createPipedreamClient({
      clientId: process.env.PIPEDREAM_CLIENT_ID,
      clientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
      projectId: process.env.PIPEDREAM_PROJECT_ID,
      environment: process.env.PIPEDREAM_ENVIRONMENT ?? 'production',
    });
    const webhookSecret = process.env.PIPEDREAM_WEBHOOK_SECRET ?? '';
    integrationRoutes = createIntegrationRoutes({
      db: trustedPlatformDb,
      pipedream,
      webhookSecret,
      resolveUserId: async (c) => {
        const clerkUserId = c.get('platformUserId') as string | undefined;
        if (!clerkUserId) return null;
        const user = await trustedPlatformDb!.getUserByClerkId(clerkUserId);
        return user?.id ?? null;
      },
    });
    internalIntegrationRoutes = createIntegrationRoutes({
      db: trustedPlatformDb,
      pipedream,
      webhookSecret,
      resolveUserId: async (c) => {
        const clerkUserId = c.get('internalContainerClerkUserId') as string | undefined;
        if (!clerkUserId) return null;
        const user = await trustedPlatformDb!.getUserByClerkId(clerkUserId);
        return user?.id ?? null;
      },
    });
  }

  let internalSyncRoutes: Hono | undefined;
  let customerVpsObjectStore:
    | {
        putObject(
          key: string,
          body: string | Uint8Array | ReadableStream<Uint8Array>,
          options?: { signal?: AbortSignal },
        ): Promise<{ etag?: string }>;
        getObject(
          key: string,
          options?: { signal?: AbortSignal },
        ): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }>;
      }
    | undefined;
  const s3Endpoint = process.env.S3_ENDPOINT ?? process.env.R2_ENDPOINT;
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
  const s3Bucket = process.env.S3_BUCKET ?? process.env.R2_BUCKET ?? 'matrixos-sync';
  const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  if (s3AccessKey && s3SecretKey && PLATFORM_SECRET) {
    const [{ createR2Client }, { createInternalSyncRoutes }] = await Promise.all([
      import('../../gateway/src/sync/r2-client.js'),
      import('./internal-sync-routes.js'),
    ]);
    const r2 = createR2Client({
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
  }

  let customerVpsService: CustomerVpsService | undefined;
  let customerVpsReconciliationInterval: ReturnType<typeof setInterval> | undefined;
  let customerVpsReconciliationPromise: Promise<void> | undefined;
  if (process.env.CUSTOMER_VPS_ENABLED === 'true') {
    const [
      { createCustomerVpsService },
      { loadCustomerVpsConfig },
      { createHetznerClient },
      { createCustomerVpsSystemStore, createNoopCustomerVpsSystemStore },
    ] = await Promise.all([
      import('./customer-vps.js'),
      import('./customer-vps-config.js'),
      import('./customer-vps-hetzner.js'),
      import('./customer-vps-r2.js'),
    ]);
    const customerVpsConfig = loadCustomerVpsConfig();
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
            const result = await customerVpsService!.reconcileProvisioning();
            if (result.checked > 0) {
              console.log(
                `[platform] customer VPS reconciliation checked=${result.checked} running=${result.running} failed=${result.failed}`,
              );
            }
          } catch (err: unknown) {
            logPlatformRouteError('customer VPS reconciliation', err);
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
    const host = getWebSocketUpgradeHost(req.headers.host, req.headers['x-forwarded-host']);
    if (!isSessionRoutedHost(host)) {
      socket.destroy();
      return;
    }
    const isCodeDomain = isCodeDomainHost(host);

    const path = req.url ?? '/';
    const wsToken = getWebSocketUpgradeToken(path);
    const identity = await resolveAppDomainIdentity({
      authHeader: req.headers.authorization as string | undefined,
      cookieHeader: req.headers.cookie,
      clerkAuth,
      db,
      platformJwtSecret: PLATFORM_JWT_SECRET,
      wsToken,
    });
    if (!identity) { socket.destroy(); return; }

    const runningMachine = await getRunningUserMachineByHandle(db, identity.handle);
    const record = await getContainer(db, identity.handle);
    if (!runningMachine && !record) { socket.destroy(); return; }
    let activeUpstream: Socket | null = null;
    const onSocketError = () => activeUpstream?.destroy();
    socket.on('error', onSocketError);

    const buildUpgradeHeaders = (handle: string, includePlatformProof: boolean): string => {
      return Object.entries(req.headers)
        .filter(([k]) => (
          k !== 'host' &&
          k !== 'authorization' &&
          k !== 'cookie' &&
          k !== 'x-forwarded-host' &&
          k !== 'x-forwarded-proto'
        ))
        .flatMap(([k, v]) => {
          if (v === undefined) return [];
          return `${k}: ${Array.isArray(v) ? v.join(', ') : v}`;
        })
        .concat([
          `x-forwarded-host: ${host}`,
          'x-forwarded-proto: https',
        ])
        .concat(
          PLATFORM_SECRET && includePlatformProof
            ? [
                `authorization: Bearer ${buildPlatformVerificationToken(handle, PLATFORM_SECRET)}`,
                `x-platform-verified: ${buildPlatformUserProof(handle, identity.userId, PLATFORM_SECRET)}`,
                `x-platform-user-id: ${identity.userId}`,
              ]
            : [],
        )
        .join('\r\n');
    };

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

    if (runningMachine?.publicIPv4) {
      const upstreamHostHeader = isCodeDomain ? host : `${runningMachine.handle}.matrix-os.com`;
      const headers = buildUpgradeHeaders(runningMachine.handle, true);
      const upstreamServerName = upstreamHostHeader.split(':')[0] ?? upstreamHostHeader;
      const upstream = createTlsConnection({
        host: runningMachine.publicIPv4,
        port: 443,
        servername: upstreamServerName,
        rejectUnauthorized: process.env.CUSTOMER_VPS_TLS_VERIFY === 'false' ? false : undefined,
      }, () => {
        activeUpstream = upstream;
        writeUpgradeRequest(upstream, upstreamHostHeader, headers);
      });
      upstream.on('error', (err) => {
        upstream.destroy();
        console.warn(
          `[platform] websocket vps upstream failed handle=${runningMachine.handle} host=${runningMachine.publicIPv4} path=${path} error=${describeError(err)}`,
        );
        socket.destroy();
      });
      return;
    }

    if (!record) { socket.destroy(); return; }
    const connectUpstream = async (attempt: number): Promise<void> => {
      const endpoint = await resolveContainerEndpoint(docker, db, record.handle, record.containerId);
      if (!endpoint) {
        console.warn(
          `[platform] websocket upstream unresolved handle=${record.handle} attempt=${attempt + 1} path=${path}`,
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
          `[platform] websocket upstream failed handle=${record.handle} attempt=${attempt + 1} host=${endpoint.host} source=${endpoint.source} containerId=${endpoint.containerId ?? 'null'} error=${describeError(err)}`,
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
