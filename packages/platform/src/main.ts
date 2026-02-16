import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createConnection } from 'node:net';
import type { IncomingMessage } from 'node:http';
import Dockerode from 'dockerode';
import {
  createPlatformDb,
  type PlatformDB,
  getContainer,
  updateLastActive,
  listContainers,
} from './db.js';
import { createOrchestrator, type Orchestrator } from './orchestrator.js';
import { createLifecycleManager, type LifecycleManager } from './lifecycle.js';
import { createSocialApi } from './social.js';
import { createClerkAuth, type ClerkAuth } from './clerk-auth.js';

const PORT = Number(process.env.PLATFORM_PORT ?? 9000);
const DB_PATH = process.env.PLATFORM_DB_PATH ?? '/data/platform.db';
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? '';

export function createApp(deps: { db: PlatformDB; orchestrator: Orchestrator; clerkAuth?: ClerkAuth }) {
  const { db, orchestrator, clerkAuth } = deps;
  const app = new Hono();

  // Health check (unauthenticated)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Subdomain proxy: {handle}.matrix-os.com -> user container (before auth)
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    const match = host.match(/^([a-z0-9][a-z0-9-]*)\.matrix-os\.com$/i);
    if (!match || match[1] === 'api' || match[1] === 'www') return next();

    const handle = match[1];
    const record = getContainer(db, handle);
    if (!record) return c.json({ error: 'Unknown instance' }, 404);

    // Clerk JWT verification (skip for public paths and when auth not configured)
    if (clerkAuth && !clerkAuth.isPublicPath(c.req.path) && record.clerkUserId) {
      const token = clerkAuth.extractToken(
        c.req.header('authorization'),
        c.req.header('cookie'),
      );
      if (!token) {
        return c.redirect(`https://matrix-os.com/login?redirect=${encodeURIComponent(c.req.url)}`);
      }
      const result = await clerkAuth.verifyAndMatchOwner(token, record.clerkUserId);
      if (!result.authenticated) {
        return c.redirect(`https://matrix-os.com/login?redirect=${encodeURIComponent(c.req.url)}`);
      }
    }

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
    const targetUrl = `http://matrixos-${handle}:3000${path}${qs}`;

    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key !== 'host' && value) headers.set(key, value);
      }

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
    if (!PLATFORM_SECRET) return next();
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${PLATFORM_SECRET}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  // --- Container management ---

  app.post('/containers/provision', async (c) => {
    const { handle, clerkUserId } = await c.req.json<{ handle: string; clerkUserId: string }>();
    if (!handle || !clerkUserId) {
      return c.json({ error: 'handle and clerkUserId required' }, 400);
    }
    try {
      const record = await orchestrator.provision(handle, clerkUserId);
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

  app.delete('/containers/:handle', async (c) => {
    try {
      await orchestrator.destroy(c.req.param('handle'));
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    }
  });

  app.get('/containers', (c) => {
    const status = c.req.query('status');
    return c.json(orchestrator.listAll(status));
  });

  app.get('/containers/:handle', (c) => {
    const info = orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json(info);
  });

  app.get('/containers/check-handle/:handle', (c) => {
    const info = orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json({ exists: true, status: info.status });
  });

  // --- Social API ---

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
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key !== 'host' && value) headers.set(key, value);
      }

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
  const orchestrator = createOrchestrator({
    db,
    docker,
    image: process.env.PLATFORM_IMAGE,
    dataDir: process.env.PLATFORM_DATA_DIR,
  });

  const lifecycle = createLifecycleManager({ db, orchestrator });
  lifecycle.start();

  // Clerk JWT verification (optional -- only active when CLERK_SECRET_KEY is set)
  let clerkAuth: ClerkAuth | undefined;
  if (process.env.CLERK_SECRET_KEY) {
    const { createClerkClient } = await import('@clerk/backend');
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    clerkAuth = createClerkAuth({
      verifyToken: async (token: string) => {
        const payload = await clerk.verifyToken(token);
        return payload as { sub: string; [key: string]: unknown };
      },
    });
  }

  const app = createApp({ db, orchestrator, clerkAuth });

  const server = serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Platform listening on :${PORT}`);
  });

  // WebSocket upgrade handler for subdomain proxy
  (server as import('node:http').Server).on('upgrade', async (req: IncomingMessage, socket, head) => {
    const host = req.headers.host ?? '';
    const match = host.match(/^([a-z0-9][a-z0-9-]*)\.matrix-os\.com$/i);
    if (!match || match[1] === 'api' || match[1] === 'www') {
      socket.destroy();
      return;
    }

    const handle = match[1];
    const record = getContainer(db, handle);
    if (!record) {
      socket.destroy();
      return;
    }

    // Verify Clerk JWT for WebSocket connections
    if (clerkAuth && record.clerkUserId) {
      const token = clerkAuth.extractToken(
        req.headers.authorization,
        req.headers.cookie,
      );
      if (!token) {
        socket.destroy();
        return;
      }
      const result = await clerkAuth.verifyAndMatchOwner(token, record.clerkUserId);
      if (!result.authenticated) {
        socket.destroy();
        return;
      }
    }

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
