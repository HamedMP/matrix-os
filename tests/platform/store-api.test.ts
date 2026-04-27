import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { Hono } from 'hono';
import { type PlatformDB } from '../../packages/platform/src/db.js';
import { insertApp } from '../../packages/platform/src/app-registry.js';
import { createStoreApi } from '../../packages/platform/src/store-api.js';

describe('platform/store-api', () => {
  let db: PlatformDB;
  let app: Hono;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    app = new Hono();
    app.route('/api/store', createStoreApi(db));
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function req(path: string, init?: RequestInit) {
    return app.request(`http://localhost/api/store${path}`, init);
  }

  describe('GET /apps', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Snake', slug: 'snake', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_002', name: 'Chess', slug: 'chess', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_003', name: 'Calculator', slug: 'calc', authorId: '@alice', category: 'utility', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_004', name: 'Private', slug: 'private', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: false });
    });

    it('lists public apps', async () => {
      const res = await req('/apps');
      expect(res.status).toBe(200);
      const body = await res.json() as { apps: unknown[]; total: number };
      expect(body.apps).toHaveLength(3);
      expect(body.total).toBe(3);
    });

    it('filters by category', async () => {
      const res = await req('/apps?category=game');
      const body = await res.json() as { apps: unknown[] };
      expect(body.apps).toHaveLength(2);
    });

    it('supports pagination', async () => {
      const res = await req('/apps?limit=2&offset=0');
      const body = await res.json() as { apps: unknown[]; hasMore: boolean };
      expect(body.apps).toHaveLength(2);
      expect(body.hasMore).toBe(true);
    });

    it('supports sort parameter', async () => {
      const res = await req('/apps?sort=popular');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /apps/:author/:slug', () => {
    it('returns app detail', async () => {
      await insertApp(db, { id: 'app_001', name: 'Snake', slug: 'snake', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true, description: 'Classic snake' });

      const res = await req('/apps/@hamed/snake');
      expect(res.status).toBe(200);
      const body = await res.json() as { name: string; description: string };
      expect(body.name).toBe('Snake');
      expect(body.description).toBe('Classic snake');
    });

    it('returns 404 for unknown app', async () => {
      const res = await req('/apps/@nobody/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /apps/search', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Snake Game', slug: 'snake', authorId: '@hamed', description: 'Classic arcade snake', category: 'game', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_002', name: 'Chess', slug: 'chess', authorId: '@alice', description: 'Strategic board game', category: 'game', version: '1.0.0', isPublic: true });
    });

    it('searches apps by query', async () => {
      const res = await req('/apps/search?q=snake');
      expect(res.status).toBe(200);
      const body = await res.json() as { results: unknown[] };
      expect(body.results).toHaveLength(1);
    });

    it('returns 400 without query', async () => {
      const res = await req('/apps/search');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /apps', () => {
    it('creates a new app entry', async () => {
      const res = await req('/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New App',
          slug: 'new-app',
          authorId: '@hamed',
          category: 'utility',
          description: 'A new app',
          version: '1.0.0',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { id: string; slug: string };
      expect(body.id).toBeTruthy();
      expect(body.slug).toBe('new-app');
    });

    it('rejects missing name', async () => {
      const res = await req('/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'test', authorId: '@hamed' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects missing authorId', async () => {
      const res = await req('/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test', slug: 'test' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /apps/:id/rate', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Chess', slug: 'chess', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
    });

    it('submits a rating', async () => {
      const res = await req('/apps/app_001/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user_1', rating: 5 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { rating: number; ratingsCount: number };
      expect(body.rating).toBe(5);
      expect(body.ratingsCount).toBe(1);
    });

    it('rejects invalid rating value', async () => {
      const res = await req('/apps/app_001/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user_1', rating: 6 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /apps/:id/install', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Chess', slug: 'chess', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
    });

    it('increments install count', async () => {
      const res = await req('/apps/app_001/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user_1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { installs: number };
      expect(body.installs).toBe(1);
    });
  });

  describe('GET /categories', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Snake', slug: 'snake', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_002', name: 'Calc', slug: 'calc', authorId: '@alice', category: 'utility', version: '1.0.0', isPublic: true });
    });

    it('returns categories with counts', async () => {
      const res = await req('/categories');
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ category: string; count: number }>;
      expect(body).toHaveLength(2);
    });
  });
});
