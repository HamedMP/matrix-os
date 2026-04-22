import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { PlatformDB } from './db.js';
import {
  insertApp,
  getApp,
  getAppBySlug,
  listApps,
  searchApps,
  updateApp,
  deleteApp,
  incrementInstalls,
  submitRating,
  recordInstall,
  listCategories,
} from './app-registry.js';

export function createStoreApi(db: PlatformDB): Hono {
  const api = new Hono();

  api.get('/apps', (c) => {
    const category = c.req.query('category');
    const authorId = c.req.query('author');
    const sort = c.req.query('sort') as 'new' | 'popular' | 'rated' | undefined;
    const limit = Number(c.req.query('limit')) || 50;
    const offset = Number(c.req.query('offset')) || 0;

    const result = listApps(db, {
      category,
      authorId,
      publicOnly: true,
      sort: sort ?? 'new',
      limit,
      offset,
    });

    return c.json(result);
  });

  api.get('/apps/search', (c) => {
    const q = c.req.query('q');
    if (!q) {
      return c.json({ error: 'Query parameter "q" is required' }, 400);
    }

    const results = searchApps(db, q);
    return c.json({ results });
  });

  api.get('/apps/:author/:slug', (c) => {
    const author = c.req.param('author');
    const slug = c.req.param('slug');

    const app = getAppBySlug(db, author, slug);
    if (!app) {
      return c.json({ error: 'App not found' }, 404);
    }

    return c.json(app);
  });

  api.post('/apps', async (c) => {
    const body = await c.req.json<{
      name?: string;
      slug?: string;
      authorId?: string;
      description?: string;
      category?: string;
      tags?: string[];
      version?: string;
      manifest?: unknown;
      isPublic?: boolean;
    }>();

    if (!body.name || !body.authorId) {
      return c.json({ error: 'name and authorId are required' }, 400);
    }

    const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `app_${randomUUID().slice(0, 12)}`;

    insertApp(db, {
      id,
      name: body.name,
      slug,
      authorId: body.authorId,
      description: body.description,
      category: body.category ?? 'utility',
      tags: body.tags ? JSON.stringify(body.tags) : undefined,
      version: body.version ?? '1.0.0',
      manifest: body.manifest ? JSON.stringify(body.manifest) : undefined,
      isPublic: body.isPublic ?? false,
    });

    return c.json({ id, slug }, 201);
  });

  api.post('/apps/:id/rate', async (c) => {
    const appId = c.req.param('id');
    const body = await c.req.json<{ userId: string; rating: number; review?: string }>();

    if (!body.userId || typeof body.rating !== 'number') {
      return c.json({ error: 'userId and rating are required' }, 400);
    }

    if (body.rating < 1 || body.rating > 5) {
      return c.json({ error: 'Rating must be between 1 and 5' }, 400);
    }

    submitRating(db, {
      appId,
      userId: body.userId,
      rating: body.rating,
      review: body.review,
    });

    const app = getApp(db, appId);
    return c.json({ rating: app?.rating ?? 0, ratingsCount: app?.ratingsCount ?? 0 });
  });

  api.post('/apps/:id/install', async (c) => {
    const appId = c.req.param('id');
    let body: { userId?: string } = {};
    try {
      body = await c.req.json<{ userId?: string }>();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.warn('[platform/store] Failed to parse install body:', err);
      }
    }

    if (body.userId) {
      recordInstall(db, appId, body.userId);
    } else {
      incrementInstalls(db, appId);
    }

    const app = getApp(db, appId);
    return c.json({ installs: app?.installs ?? 0 });
  });

  api.get('/categories', (c) => {
    const categories = listCategories(db);
    return c.json(categories);
  });

  return api;
}
