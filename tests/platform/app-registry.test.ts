import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { type PlatformDB } from '../../packages/platform/src/db.js';
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
  getAppRating,
  listAppRatings,
  recordInstall,
  listCategories,
} from '../../packages/platform/src/app-registry.js';

describe('platform/app-registry', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  describe('CRUD operations', () => {
    it('creates and retrieves an app by id', async () => {
      await insertApp(db, {
        id: 'app_001',
        name: 'Snake Game',
        slug: 'snake-game',
        authorId: '@hamed',
        description: 'Classic snake game',
        category: 'game',
        tags: JSON.stringify(['game', 'arcade']),
        version: '1.0.0',
        manifest: JSON.stringify({ name: 'Snake Game', runtime: 'static' }),
        isPublic: true,
      });

      const app = await getApp(db, 'app_001');
      expect(app).toBeDefined();
      expect(app!.name).toBe('Snake Game');
      expect(app!.slug).toBe('snake-game');
      expect(app!.authorId).toBe('@hamed');
      expect(app!.description).toBe('Classic snake game');
      expect(app!.category).toBe('game');
      expect(app!.version).toBe('1.0.0');
      expect(app!.isPublic).toBe(true);
      expect(app!.installs).toBe(0);
      expect(app!.rating).toBe(0);
      expect(app!.ratingsCount).toBe(0);
      expect(app!.createdAt).toBeTruthy();
      expect(app!.updatedAt).toBeTruthy();
    });

    it('retrieves an app by slug', async () => {
      await insertApp(db, {
        id: 'app_002',
        name: 'Chess',
        slug: 'chess',
        authorId: '@hamed',
        category: 'game',
        version: '1.0.0',
        isPublic: true,
      });

      const app = await getAppBySlug(db, '@hamed', 'chess');
      expect(app).toBeDefined();
      expect(app!.name).toBe('Chess');
    });

    it('returns undefined for non-existent app', async () => {
      expect(await getApp(db, 'nonexistent')).toBeUndefined();
      expect(await getAppBySlug(db, '@nobody', 'nope')).toBeUndefined();
    });

    it('rejects duplicate slugs for same author', async () => {
      await insertApp(db, {
        id: 'app_001',
        name: 'Chess',
        slug: 'chess',
        authorId: '@hamed',
        category: 'game',
        version: '1.0.0',
        isPublic: true,
      });

      await expect(
        insertApp(db, {
          id: 'app_002',
          name: 'Chess 2',
          slug: 'chess',
          authorId: '@hamed',
          category: 'game',
          version: '1.0.0',
          isPublic: true,
        }),
      ).rejects.toThrow();
    });

    it('allows same slug for different authors', async () => {
      await insertApp(db, {
        id: 'app_001',
        name: 'Chess',
        slug: 'chess',
        authorId: '@hamed',
        category: 'game',
        version: '1.0.0',
        isPublic: true,
      });

      await insertApp(db, {
        id: 'app_002',
        name: 'Chess',
        slug: 'chess',
        authorId: '@alice',
        category: 'game',
        version: '1.0.0',
        isPublic: true,
      });

      expect(await getAppBySlug(db, '@hamed', 'chess')).toBeDefined();
      expect(await getAppBySlug(db, '@alice', 'chess')).toBeDefined();
    });

    it('updates an app', async () => {
      await insertApp(db, {
        id: 'app_001',
        name: 'Chess',
        slug: 'chess',
        authorId: '@hamed',
        category: 'game',
        version: '1.0.0',
        isPublic: false,
      });

      await updateApp(db, 'app_001', {
        description: 'Updated chess game',
        version: '1.1.0',
        isPublic: true,
      });

      const app = await getApp(db, 'app_001');
      expect(app!.description).toBe('Updated chess game');
      expect(app!.version).toBe('1.1.0');
      expect(app!.isPublic).toBe(true);
    });

    it('deletes an app', async () => {
      await insertApp(db, {
        id: 'app_001',
        name: 'Chess',
        slug: 'chess',
        authorId: '@hamed',
        category: 'game',
        version: '1.0.0',
        isPublic: true,
      });

      await deleteApp(db, 'app_001');
      expect(await getApp(db, 'app_001')).toBeUndefined();
    });
  });

  describe('listing and pagination', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Snake', slug: 'snake', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_002', name: 'Chess', slug: 'chess', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_003', name: 'Calculator', slug: 'calculator', authorId: '@alice', category: 'utility', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_004', name: 'Todo', slug: 'todo', authorId: '@bob', category: 'productivity', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_005', name: 'Private App', slug: 'private', authorId: '@hamed', category: 'utility', version: '1.0.0', isPublic: false });
    });

    it('lists all public apps', async () => {
      const result = await listApps(db, { publicOnly: true });
      expect(result.apps).toHaveLength(4);
      expect(result.apps.every(a => a.isPublic)).toBe(true);
    });

    it('lists all apps including private', async () => {
      const result = await listApps(db, {});
      expect(result.apps).toHaveLength(5);
    });

    it('filters by category', async () => {
      const result = await listApps(db, { category: 'game', publicOnly: true });
      expect(result.apps).toHaveLength(2);
      expect(result.apps.every(a => a.category === 'game')).toBe(true);
    });

    it('filters by author', async () => {
      const result = await listApps(db, { authorId: '@hamed', publicOnly: true });
      expect(result.apps).toHaveLength(2);
    });

    it('supports pagination with limit and offset', async () => {
      const page1 = await listApps(db, { limit: 2, offset: 0, publicOnly: true });
      expect(page1.apps).toHaveLength(2);
      expect(page1.total).toBe(4);
      expect(page1.hasMore).toBe(true);

      const page2 = await listApps(db, { limit: 2, offset: 2, publicOnly: true });
      expect(page2.apps).toHaveLength(2);
      expect(page2.hasMore).toBe(false);
    });

    it('sorts by newest first by default', async () => {
      const result = await listApps(db, { sort: 'new', publicOnly: true });
      // All created at ~same timestamp, just verify sort doesn't throw and returns correct count
      expect(result.apps).toHaveLength(4);
      // createdAt should be in descending order (or equal)
      for (let i = 1; i < result.apps.length; i++) {
        expect(result.apps[i - 1].createdAt >= result.apps[i].createdAt).toBe(true);
      }
    });

    it('sorts by popular (most installs)', async () => {
      await incrementInstalls(db, 'app_001');
      await incrementInstalls(db, 'app_001');
      await incrementInstalls(db, 'app_003');

      const result = await listApps(db, { sort: 'popular', publicOnly: true });
      expect(result.apps[0].id).toBe('app_001');
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Snake Game', slug: 'snake-game', authorId: '@hamed', description: 'Classic arcade snake', category: 'game', tags: JSON.stringify(['arcade', 'classic']), version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_002', name: 'Chess Master', slug: 'chess-master', authorId: '@alice', description: 'Two player chess', category: 'game', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_003', name: 'Budget Tracker', slug: 'budget-tracker', authorId: '@bob', description: 'Track your expenses', category: 'productivity', version: '1.0.0', isPublic: true });
    });

    it('searches by name', async () => {
      const results = await searchApps(db, 'snake');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Snake Game');
    });

    it('searches by description', async () => {
      const results = await searchApps(db, 'arcade');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Snake Game');
    });

    it('search is case-insensitive', async () => {
      const results = await searchApps(db, 'CHESS');
      expect(results).toHaveLength(1);
    });

    it('returns empty for no matches', async () => {
      const results = await searchApps(db, 'nonexistent');
      expect(results).toHaveLength(0);
    });

    it('only searches public apps', async () => {
      await insertApp(db, { id: 'app_004', name: 'Secret Snake', slug: 'secret-snake', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: false });
      const results = await searchApps(db, 'snake');
      expect(results).toHaveLength(1);
    });
  });

  describe('installs tracking', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Chess', slug: 'chess', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
    });

    it('increments install count atomically', async () => {
      await incrementInstalls(db, 'app_001');
      await incrementInstalls(db, 'app_001');
      await incrementInstalls(db, 'app_001');

      const app = await getApp(db, 'app_001');
      expect(app!.installs).toBe(3);
    });

    it('records individual installs per user', async () => {
      await recordInstall(db, 'app_001', 'user_1');
      await recordInstall(db, 'app_001', 'user_2');

      const app = await getApp(db, 'app_001');
      expect(app!.installs).toBe(2);
    });

    it('prevents duplicate installs from same user', async () => {
      await recordInstall(db, 'app_001', 'user_1');
      await recordInstall(db, 'app_001', 'user_1');

      const app = await getApp(db, 'app_001');
      expect(app!.installs).toBe(1);
    });
  });

  describe('ratings', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Chess', slug: 'chess', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
    });

    it('submits a rating', async () => {
      await submitRating(db, { appId: 'app_001', userId: 'user_1', rating: 5 });

      const app = await getApp(db, 'app_001');
      expect(app!.rating).toBe(5);
      expect(app!.ratingsCount).toBe(1);
    });

    it('calculates average rating correctly', async () => {
      await submitRating(db, { appId: 'app_001', userId: 'user_1', rating: 5 });
      await submitRating(db, { appId: 'app_001', userId: 'user_2', rating: 3 });
      await submitRating(db, { appId: 'app_001', userId: 'user_3', rating: 4 });

      const app = await getApp(db, 'app_001');
      expect(app!.rating).toBe(4);
      expect(app!.ratingsCount).toBe(3);
    });

    it('allows user to update their rating', async () => {
      await submitRating(db, { appId: 'app_001', userId: 'user_1', rating: 2 });
      await submitRating(db, { appId: 'app_001', userId: 'user_1', rating: 5 });

      const app = await getApp(db, 'app_001');
      expect(app!.rating).toBe(5);
      expect(app!.ratingsCount).toBe(1);
    });

    it('retrieves a specific user rating', async () => {
      await submitRating(db, { appId: 'app_001', userId: 'user_1', rating: 4, review: 'Great game!' });

      const rating = await getAppRating(db, 'app_001', 'user_1');
      expect(rating).toBeDefined();
      expect(rating!.rating).toBe(4);
      expect(rating!.review).toBe('Great game!');
    });

    it('lists all ratings for an app', async () => {
      await submitRating(db, { appId: 'app_001', userId: 'user_1', rating: 5 });
      await submitRating(db, { appId: 'app_001', userId: 'user_2', rating: 3, review: 'Decent' });

      const ratings = await listAppRatings(db, 'app_001');
      expect(ratings).toHaveLength(2);
    });
  });

  describe('categories', () => {
    beforeEach(async () => {
      await insertApp(db, { id: 'app_001', name: 'Snake', slug: 'snake', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_002', name: 'Chess', slug: 'chess', authorId: '@alice', category: 'game', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_003', name: 'Calc', slug: 'calc', authorId: '@bob', category: 'utility', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_004', name: 'Todo', slug: 'todo', authorId: '@bob', category: 'productivity', version: '1.0.0', isPublic: true });
      await insertApp(db, { id: 'app_005', name: 'Secret', slug: 'secret', authorId: '@hamed', category: 'game', version: '1.0.0', isPublic: false });
    });

    it('lists categories with counts (public only)', async () => {
      const cats = await listCategories(db);
      expect(cats).toEqual(
        expect.arrayContaining([
          { category: 'game', count: 2 },
          { category: 'utility', count: 1 },
          { category: 'productivity', count: 1 },
        ]),
      );
      expect(cats).toHaveLength(3);
    });
  });
});
