import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
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

const PORT = Number(process.env.PLATFORM_PORT ?? 9000);
const DB_PATH = process.env.PLATFORM_DB_PATH ?? '/data/platform.db';
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? '';

export function createApp(deps: { db: PlatformDB; orchestrator: Orchestrator; clerkAuth?: ClerkAuth; matrixProvisioner?: MatrixProvisioner }) {
  const { db, orchestrator, clerkAuth, matrixProvisioner } = deps;
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

  // Session-based routing: app.matrix-os.com -> Clerk session -> container
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    const isAppDomain = /^app\.matrix-os\.com$/i.test(host) || /^app\.localhost/i.test(host);
    if (!isAppDomain) return next();

    if (!clerkAuth) {
      return c.redirect('https://matrix-os.com/login');
    }

    // Accept Clerk JWT from query param (passed by dashboard), cookie, or Authorization header
    const url = new URL(c.req.url, 'https://app.matrix-os.com');
    const queryToken = url.searchParams.get('__clerk_token');

    const token = queryToken ?? clerkAuth.extractToken(
      c.req.header('authorization'),
      c.req.header('cookie'),
    );

    // Strip token from URL and redirect to clean URL
    if (queryToken && token) {
      url.searchParams.delete('__clerk_token');
      const cleanPath = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
      // Set a short-lived platform session cookie so subsequent requests don't need the query param
      const res = c.redirect(`https://app.matrix-os.com${cleanPath}`);
      res.headers.set('set-cookie', `__platform_token=${queryToken}; Domain=.matrix-os.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`);
      return res;
    }

    // Also check platform session cookie
    const platformToken = c.req.header('cookie')?.match(/(?:^|;\s*)__platform_token=([^\s;]+)/)?.[1];
    const effectiveToken = token ?? platformToken;

    if (!effectiveToken) {
      return c.redirect(`https://matrix-os.com/login?redirect=${encodeURIComponent(c.req.url)}`);
    }

    const result = await clerkAuth.verify(effectiveToken);
    if (!result.authenticated || !result.userId) {
      return c.redirect('https://matrix-os.com/login');
    }

    const record = getContainerByClerkId(db, result.userId);
    if (!record) {
      return c.redirect('https://matrix-os.com/dashboard');
    }

    if (record.status === 'stopped') {
      try {
        await orchestrator.start(record.handle);
      } catch {
        return c.json({ error: 'Failed to wake container' }, 503);
      }
    }

    updateLastActive(db, record.handle);

    const path = c.req.path;
    const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
    const isGatewayPath = path.startsWith('/api/') || path.startsWith('/ws') || path.startsWith('/files/') || path.startsWith('/modules/') || path === '/health';
    const targetPort = isGatewayPath ? 4000 : 3000;
    const targetUrl = `http://matrixos-${record.handle}:${targetPort}${path}${qs}`;

    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key !== 'host' && value) headers.set(key, value);
      }
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');

      const upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers,
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

  // Subdomain proxy: {handle}.matrix-os.com -> user container (before auth)
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    const match = host.match(/^([a-z0-9][a-z0-9-]*)\.matrix-os\.com$/i);
    if (!match || match[1] === 'api' || match[1] === 'www' || match[1] === 'app') return next();

    const handle = match[1];
    const record = getContainer(db, handle);
    if (!record) return c.json({ error: 'Unknown instance' }, 404);

    // Clerk JWT verification -- disabled until Clerk cookie domain is configured
    // to share sessions across subdomains (.matrix-os.com).
    // TODO: re-enable once Clerk Dashboard -> Domains has matrix-os.com as primary
    // and cookies are set with Domain=.matrix-os.com
    // if (clerkAuth && !clerkAuth.isPublicPath(c.req.path) && record.clerkUserId) {
    //   const token = clerkAuth.extractToken(
    //     c.req.header('authorization'),
    //     c.req.header('cookie'),
    //   );
    //   if (!token) {
    //     return c.redirect(`https://matrix-os.com/login?redirect=${encodeURIComponent(c.req.url)}`);
    //   }
    //   const result = await clerkAuth.verifyAndMatchOwner(token, record.clerkUserId);
    //   if (!result.authenticated) {
    //     return c.redirect(`https://matrix-os.com/login?redirect=${encodeURIComponent(c.req.url)}`);
    //   }
    // }

    if (record.status === 'stopped') {
      try {
        await orchestrator.start(handle);
      } catch {
        return c.json({ error: 'Failed to wake container' }, 503);
      }
    }

    updateLastActive(db, handle);

    const path = c.req.path;
    const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
    const isGatewayPath = path.startsWith('/api/') || path.startsWith('/ws') || path.startsWith('/files/') || path.startsWith('/modules/') || path === '/health';
    const targetPort = isGatewayPath ? 4000 : 3000;
    const targetUrl = `http://matrixos-${handle}:${targetPort}${path}${qs}`;

    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key !== 'host' && value) headers.set(key, value);
      }
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');

      const upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers,
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

  // Auth middleware for admin API routes below
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    if (c.req.path === '/metrics') return next();
    if (c.req.path.endsWith('/self-upgrade') && c.req.method === 'POST') return next();
    if (!PLATFORM_SECRET) return next();
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${PLATFORM_SECRET}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  // --- Container management ---

  app.post('/containers/provision', async (c) => {
    const { handle, clerkUserId, displayName } = await c.req.json<{ handle: string; clerkUserId: string; displayName?: string }>();
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
    } catch (e: any) {
      return c.json({ error: e.message }, 409);
    }
  });

  app.post('/containers/:handle/start', async (c) => {
    try {
      await orchestrator.start(c.req.param('handle'));
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    }
  });

  app.post('/containers/:handle/stop', async (c) => {
    try {
      await orchestrator.stop(c.req.param('handle'));
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    }
  });

  app.post('/containers/:handle/upgrade', async (c) => {
    try {
      const record = await orchestrator.upgrade(c.req.param('handle'));
      return c.json(record);
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    }
  });

  app.post('/containers/:handle/self-upgrade', async (c) => {
    if (!PLATFORM_SECRET) {
      return c.json({ error: 'Self-upgrade not configured' }, 503);
    }
    const handle = c.req.param('handle');
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

    const expected = createHmac('sha256', PLATFORM_SECRET).update(handle).digest('hex');
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);

    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const record = await orchestrator.upgrade(handle);
      return c.json(record);
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/containers/rolling-restart', async (c) => {
    const result = await orchestrator.rollingRestart();
    return c.json(result);
  });

  app.delete('/containers/:handle', async (c) => {
    try {
      await orchestrator.destroy(c.req.param('handle'));
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
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

  app.post('/social/send/:handle', async (c) => {
    const { text, from } = await c.req.json<{ text: string; from: { handle: string; displayName?: string } }>();
    try {
      const result = await social.sendMessage(c.req.param('handle'), text, from);
      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
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

  const orchestrator = createOrchestrator({
    db,
    docker,
    image: process.env.PLATFORM_IMAGE,
    dataDir: process.env.PLATFORM_DATA_DIR,
    platformSecret: PLATFORM_SECRET,
    extraEnv,
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
    const { createClerkClient } = await import('@clerk/backend');
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    clerkAuth = createClerkAuth({
      verifyToken: async (token: string) => {
        const payload = await (clerk as unknown as { verifyToken(t: string): Promise<unknown> }).verifyToken(token);
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

  const app = createApp({ db, orchestrator, clerkAuth, matrixProvisioner });

  const server = serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Platform listening on :${PORT}`);
  });

  // WebSocket upgrade handler
  (server as import('node:http').Server).on('upgrade', async (req: IncomingMessage, socket, head) => {
    const host = req.headers.host ?? '';

    // Session-based WebSocket routing for app.matrix-os.com
    const isAppDomain = /^app\.matrix-os\.com$/i.test(host) || /^app\.localhost/i.test(host);
    if (isAppDomain && clerkAuth) {
      const token = clerkAuth.extractToken(
        req.headers.authorization as string | undefined,
        req.headers.cookie,
      );
      if (!token) { socket.destroy(); return; }

      const result = await clerkAuth.verify(token);
      if (!result.authenticated || !result.userId) { socket.destroy(); return; }

      const record = getContainerByClerkId(db, result.userId);
      if (!record) { socket.destroy(); return; }

      const upstream = createConnection({ host: `matrixos-${record.handle}`, port: 4000 }, () => {
        const path = req.url ?? '/';
        const headers = Object.entries(req.headers)
          .filter(([k]) => k !== 'host')
          .map(([k, v]) => `${k}: ${v}`)
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

    // Subdomain-based WebSocket routing
    const match = host.match(/^([a-z0-9][a-z0-9-]*)\.matrix-os\.com$/i);
    if (!match || match[1] === 'api' || match[1] === 'www' || match[1] === 'app') {
      socket.destroy();
      return;
    }

    const handle = match[1];
    const record = getContainer(db, handle);
    if (!record) {
      socket.destroy();
      return;
    }

    // Verify Clerk JWT for WebSocket connections -- disabled until cookie domain configured
    // TODO: re-enable with subdomain cookie sharing
    // if (clerkAuth && record.clerkUserId) {
    //   const token = clerkAuth.extractToken(
    //     req.headers.authorization,
    //     req.headers.cookie,
    //   );
    //   if (!token) {
    //     socket.destroy();
    //     return;
    //   }
    //   const result = await clerkAuth.verifyAndMatchOwner(token, record.clerkUserId);
    //   if (!result.authenticated) {
    //     socket.destroy();
    //     return;
    //   }
    // }

    // Proxy WebSocket upgrade to the user container's gateway (port 4000)
    const upstream = createConnection({ host: `matrixos-${handle}`, port: 4000 }, () => {
      const path = req.url ?? '/';
      const headers = Object.entries(req.headers)
        .filter(([k]) => k !== 'host')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');

      upstream.write(
        `${req.method} ${path} HTTP/1.1\r\nHost: matrixos-${handle}:4000\r\n${headers}\r\n\r\n`
      );
      if (head.length > 0) upstream.write(head);

      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
}
