import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { createConnection } from 'node:net';
import type { IncomingMessage } from 'node:http';
import Dockerode from 'dockerode';
import {
  createPlatformDb,
  type PlatformDB,
  getContainer,
  getContainerByClerkId,
  updateLastActive,
  listContainers,
} from './db.js';
import { createOrchestrator, type Orchestrator } from './orchestrator.js';
import { createLifecycleManager, type LifecycleManager } from './lifecycle.js';
import { createSocialApi } from './social.js';
import { createStoreApi } from './store-api.js';
import { createSocialFeedApi } from './social-api.js';
import { createClerkAuth, type ClerkAuth } from './clerk-auth.js';
import { createMatrixProvisioner, type MatrixProvisioner } from './matrix-provisioning.js';
import { metricsRegistry } from './metrics.js';
import { createStatsCollector } from './stats-collector.js';
import { createAuthRoutes } from './auth-routes.js';
import { verifySyncJwt } from './sync-jwt.js';

const PORT = Number(process.env.PLATFORM_PORT ?? 9000);
const DB_PATH = process.env.PLATFORM_DB_PATH ?? '/data/platform.db';
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? '';
const HANDLE_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;
const ADMIN_BODY_LIMIT = 64 * 1024;

function isMissingContainerError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('No container for handle:');
}

function logPlatformRouteError(route: string, err: unknown): void {
  console.error(
    `[platform] ${route} failed:`,
    err instanceof Error ? err.message : String(err),
  );
}

function timingSafeTokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  const maxLen = Math.max(actualBuf.length, expectedBuf.length);
  if (maxLen === 0) return false;
  const paddedActual = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  actualBuf.copy(paddedActual);
  expectedBuf.copy(paddedExpected);
  const lengthMatch = actualBuf.length === expectedBuf.length;
  const contentMatch = timingSafeEqual(paddedActual, paddedExpected);
  return lengthMatch && contentMatch;
}

function bearerTokenEquals(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }
  return timingSafeTokenEquals(authHeader.slice(7), expected);
}

function buildPlatformVerificationToken(handle: string, platformSecret: string): string {
  return createHmac('sha256', platformSecret).update(handle).digest('hex');
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

interface AppDomainIdentity {
  handle: string;
  userId: string;
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
}): Promise<AppDomainIdentity | null> {
  const bearerToken = opts.authHeader?.startsWith('Bearer ')
    ? opts.authHeader.slice(7)
    : null;

  if (bearerToken && opts.platformJwtSecret) {
    try {
      const claims = await verifySyncJwt(bearerToken, { secret: opts.platformJwtSecret });
      const record = getContainer(opts.db, claims.handle);
      if (record?.clerkUserId !== claims.sub) {
        return null;
      }
      return {
        handle: record.handle,
        userId: record.clerkUserId,
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

  const record = getContainerByClerkId(opts.db, result.userId);
  if (!record) {
    return null;
  }

  return {
    handle: record.handle,
    userId: result.userId,
  };
}

function getAuthPage(publishableKey: string, mode: 'sign-in' | 'sign-up') {
  const otherMode = mode === 'sign-in' ? 'sign-up' : 'sign-in';
  const otherLabel = mode === 'sign-in' ? 'Sign up' : 'Sign in';
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
    async
    crossorigin="anonymous"
    data-clerk-publishable-key="${publishableKey}"
    src="https://clerk.matrix-os.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
    type="text/javascript"
    onload="initClerk()"
  ></script>
  <script>
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
  } catch {
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
  orchestrator: Orchestrator;
  clerkAuth?: ClerkAuth;
  matrixProvisioner?: MatrixProvisioner;
  platformSecret?: string;
  integrationRoutes?: Hono;
  internalIntegrationRoutes?: Hono;
  internalSyncRoutes?: Hono;
}) {
  const { db, orchestrator, clerkAuth, matrixProvisioner } = deps;
  const platformSecret = deps.platformSecret ?? process.env.PLATFORM_SECRET ?? '';
  const app = new Hono();

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
        gatewayUrlForHandle: (handle) => {
          // Single-domain production: every handle hits https://app.matrix-os.com,
          // where the platform middleware resolves the Clerk session and proxies
          // to the right container. Per-handle subdomains are deprecated.
          // Dev override via GATEWAY_URL_TEMPLATE='http://localhost:4000' (single-tenant)
          // or 'http://matrixos-{handle}:4000' for in-cluster Docker routing.
          const tmpl = process.env.GATEWAY_URL_TEMPLATE;
          if (tmpl) return tmpl.replace('{handle}', handle);
          return 'https://app.matrix-os.com';
        },
      }),
    );
  }

  // Session-based routing: app.matrix-os.com -> Clerk session -> container
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    const isAppDomain = /^app\.matrix-os\.com$/i.test(host) || /^app\.localhost/i.test(host);
    if (!isAppDomain) return next();

    // Device-flow paths are served directly by the platform's auth-routes.ts
    // (registered above). In normal dispatch they never reach this middleware,
    // but we short-circuit explicitly so a misconfigured PLATFORM_JWT_SECRET or
    // a future refactor can't accidentally proxy them into a user container.
    const reqPath = c.req.path;
    if (
      reqPath === '/auth/device' ||
      reqPath.startsWith('/auth/device/') ||
      reqPath.startsWith('/api/auth/device/')
    ) {
      return next();
    }
    const isPublicIntegrationPath =
      reqPath === '/api/integrations/available' ||
      reqPath.startsWith('/api/integrations/webhook/');
    const isIntegrationPath =
      reqPath === '/api/integrations' || reqPath.startsWith('/api/integrations/');
    if (isPublicIntegrationPath) {
      return next();
    }

    const authHeader = c.req.header('authorization');
    const cookieHeader = c.req.header('cookie');

    const path = c.req.path;
    const isGatewayPath =
      path.startsWith('/api/') ||
      path.startsWith('/ws') ||
      path.startsWith('/files/') ||
      path.startsWith('/modules/') ||
      path === '/health';
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
      console.log(`[app] no token path=${path}`);
      if (isGatewayPath) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!publishableKey || !clerkAuth) {
        return c.text('Clerk publishable key not configured', 500);
      }
      return c.html(getAuthPage(publishableKey, authMode));
    }

    console.log(`[app] verified request path=${path}`);
    const record = getContainer(db, identity.handle);
    if (!record) {
      return c.html(getNoContainerPage());
    }

    if (isIntegrationPath) {
      c.set('platformUserId', identity.userId);
      c.set('platformHandle', record.handle);
      return next();
    }

    if (record.status === 'stopped') {
      try {
        await orchestrator.start(record.handle);
      } catch {
        return c.json({ error: 'Failed to wake container' }, 503);
      }
    }

    updateLastActive(db, record.handle);

    const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
    const targetPort = isGatewayPath ? 4000 : 3000;
    const targetUrl = `http://matrixos-${record.handle}:${targetPort}${path}${qs}`;

    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key !== 'host' && key !== 'cookie' && key !== 'authorization' && value) {
          headers.set(key, value);
        }
      }
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');
      if (platformSecret) {
        headers.set('authorization', `Bearer ${buildPlatformVerificationToken(record.handle, platformSecret)}`);
        headers.set('x-platform-verified', buildPlatformUserProof(record.handle, identity.userId, platformSecret));
      }
      headers.set('x-platform-user-id', identity.userId);

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
    } catch {
      return c.json({ error: 'Container unreachable' }, 502);
    }
  });

  if (deps.integrationRoutes) {
    app.route('/api/integrations', deps.integrationRoutes);
  }
  if (deps.internalIntegrationRoutes) {
    app.route('/internal/containers/:handle/integrations', deps.internalIntegrationRoutes);
  }
  if (deps.internalSyncRoutes) {
    app.route('/internal/containers/:handle/sync', deps.internalSyncRoutes);
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
    const { handle, clerkUserId, displayName } = await c.req.json<{ handle: string; clerkUserId: string; displayName?: string }>();
    if (!handle || !clerkUserId) {
      return c.json({ error: 'handle and clerkUserId required' }, 400);
    }
    if (!HANDLE_PATTERN.test(handle)) {
      return c.json({ error: 'Invalid handle' }, 400);
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
    } catch {
      return c.json({ error: 'Invalid handle' }, 400);
    }
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

    const expected = buildPlatformVerificationToken(handle, platformSecret);
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);

    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
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
    return c.json(orchestrator.listAll(status));
  });

  app.get('/containers/:handle', (c) => {
    const info = orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json({ ...info, image: orchestrator.getImage() });
  });

  app.get('/containers/check-handle/:handle', (c) => {
    const info = orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json({ exists: true, status: info.status });
  });

  // --- Admin dashboard ---

  app.get('/admin/dashboard', async (c) => {
    await orchestrator.syncStates();
    const all = orchestrator.listAll();
    const running = all.filter((r) => r.status === 'running');
    const stopped = all.filter((r) => r.status !== 'running');

    const containerResults = await Promise.all(
      running.map(async (r) => {
        const base = `http://matrixos-${r.handle}:4000`;
        const timeout = 3000;

        const fetchJson = async (url: string) => {
          try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), timeout);
            const res = await fetch(url, { signal: ac.signal });
            clearTimeout(timer);
            if (!res.ok) return null;
            return await res.json();
          } catch {
            return null;
          }
        };

        const [health, systemInfo, conversations] = await Promise.all([
          fetchJson(`${base}/health`),
          fetchJson(`${base}/api/system/info`),
          fetchJson(`${base}/api/conversations`),
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
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      const res = await fetch('http://proxy:8080/usage/summary', { signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) usageSummary = await res.json();
    } catch { /* proxy may not be reachable */ }

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

  app.get('/social/users', (c) => {
    return c.json(social.listUsers());
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
    const { text, from } = await c.req.json<{ text: string; from: { handle: string; displayName?: string } }>();
    try {
      const result = await social.sendMessage(c.req.param('handle'), text, from);
      return c.json(result);
    } catch (e: unknown) {
      logPlatformRouteError('/social/send/:handle', e);
      return c.json({ error: 'Message delivery failed' }, 404);
    }
  });

  // --- Subdomain proxy ---

  app.all('/proxy/:handle/*', async (c) => {
    const handle = c.req.param('handle');
    const record = getContainer(db, handle);
    if (!record) return c.json({ error: 'Unknown handle' }, 404);

    if (record.status === 'stopped') {
      try {
        await orchestrator.start(handle);
      } catch {
        return c.json({ error: 'Failed to wake container' }, 503);
      }
    }

    updateLastActive(db, handle);

    const path = c.req.path.replace(`/proxy/${handle}`, '') || '/';
    const targetUrl = `http://matrixos-${handle}:3000${path}`;

    try {
      const headers = new Headers();
      const originalHost = c.req.header('host') ?? '';
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key !== 'host' && value) headers.set(key, value);
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
    } catch {
      return c.json({ error: 'Container unreachable' }, 502);
    }
  });

  return app;
}

// Start server when run directly
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  const db = createPlatformDb(DB_PATH);
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

  const statsCollector = createStatsCollector({
    docker,
    listRunning: () => listContainers(db, 'running'),
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
        const handle = c.req.param('handle');
        const record = getContainer(db, handle);
        if (!record?.clerkUserId) return null;
        const user = await trustedPlatformDb!.getUserByClerkId(record.clerkUserId);
        return user?.id ?? null;
      },
    });
  }

  let internalSyncRoutes: Hono | undefined;
  const s3Endpoint = process.env.S3_ENDPOINT ?? process.env.R2_ENDPOINT;
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
  const s3Bucket = process.env.S3_BUCKET ?? process.env.R2_BUCKET ?? 'matrixos-sync';
  const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  if (s3AccessKey && s3SecretKey && platformSecret) {
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
      platformSecret,
    });
  }

  const app = createApp({
    db,
    orchestrator,
    clerkAuth,
    matrixProvisioner,
    integrationRoutes,
    internalIntegrationRoutes,
    internalSyncRoutes,
  });

  const server = serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Platform listening on :${PORT}`);
  });

  // WebSocket upgrade handler
  (server as import('node:http').Server).on('upgrade', async (req: IncomingMessage, socket, head) => {
    const host = req.headers.host ?? '';

    // Session-based WebSocket routing for app.matrix-os.com
    const isAppDomain = /^app\.matrix-os\.com$/i.test(host) || /^app\.localhost/i.test(host);
    if (isAppDomain) {
      const identity = await resolveAppDomainIdentity({
        authHeader: req.headers.authorization as string | undefined,
        cookieHeader: req.headers.cookie,
        clerkAuth,
        db,
        platformJwtSecret,
      });
      if (!identity) { socket.destroy(); return; }

      const record = getContainer(db, identity.handle);
      if (!record) { socket.destroy(); return; }

      const upstream = createConnection({ host: `matrixos-${record.handle}`, port: 4000 }, () => {
        const path = req.url ?? '/';
        const headers = Object.entries(req.headers)
          .filter(([k]) => k !== 'host' && k !== 'authorization' && k !== 'cookie')
          .map(([k, v]) => `${k}: ${v}`)
          .concat(
            platformSecret
              ? [
                  `authorization: Bearer ${buildPlatformVerificationToken(record.handle, platformSecret)}`,
                  `x-platform-verified: ${buildPlatformUserProof(record.handle, identity.userId, platformSecret)}`,
                  `x-platform-user-id: ${identity.userId}`,
                ]
              : [],
          )
          .join('\r\n');

        upstream.write(
          `${req.method} ${path} HTTP/1.1\r\nHost: matrixos-${record.handle}:4000\r\n${headers}\r\n\r\n`
        );
        if (head.length > 0) upstream.write(head);

        upstream.pipe(socket);
        socket.pipe(upstream);
      });

      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      return;
    }

    // Unknown host -- legacy {handle}.matrix-os.com subdomain routing retired;
    // only app.matrix-os.com is supported for WebSocket upgrades.
    socket.destroy();
  });
}
