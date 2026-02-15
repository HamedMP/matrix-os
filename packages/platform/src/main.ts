import { Hono } from 'hono';
import { serve } from '@hono/node-server';
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

const PORT = Number(process.env.PLATFORM_PORT ?? 9000);
const DB_PATH = process.env.PLATFORM_DB_PATH ?? '/data/platform.db';
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? '';

export function createApp(deps: { db: PlatformDB; orchestrator: Orchestrator }) {
  const { db, orchestrator } = deps;
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

  const app = createApp({ db, orchestrator });

  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Platform listening on :${PORT}`);
  });
}
