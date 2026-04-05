import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import {
  listPublic,
  search,
  getByAuthorSlug,
  listCategories,
  createListing,
  updateListing,
  createOrUpdateFromPublish,
} from '../../../packages/platform/src/gallery/listings.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

describe.skipIf(!TEST_DB_URL)('gallery/listings', () => {
  let db: Kysely<GalleryDatabase>;
  const authorId = '00000000-0000-0000-0000-000000000001';
  const authorId2 = '00000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    db = new Kysely<GalleryDatabase>({ dialect: new PostgresDialect({ pool }) });

    await sql`DROP TABLE IF EXISTS org_memberships CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS security_audits CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS app_reviews CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS app_installations CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS app_versions CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS app_listings CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS organizations CASCADE`.execute(db);
    await sql`DROP FUNCTION IF EXISTS app_listings_search_vector_update CASCADE`.execute(db);

    await runGalleryMigrations(db);
  });

  afterAll(async () => {
    if (db) {
      await sql`DROP TABLE IF EXISTS org_memberships CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS security_audits CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_reviews CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_installations CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_versions CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS app_listings CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS organizations CASCADE`.execute(db);
      await sql`DROP FUNCTION IF EXISTS app_listings_search_vector_update CASCADE`.execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM app_versions`.execute(db);
    await sql`UPDATE app_listings SET current_version_id = NULL`.execute(db);
    await sql`DELETE FROM app_listings`.execute(db);
  });

  async function seedListing(overrides: Partial<{
    slug: string; name: string; author_id: string; category: string;
    description: string; visibility: string; status: string; installs_count: number;
    avg_rating: string; tags: string[];
  }> = {}) {
    const slug = overrides.slug ?? `test-app-${Date.now()}`;
    return db.insertInto('app_listings').values({
      slug,
      name: overrides.name ?? 'Test App',
      author_id: overrides.author_id ?? authorId,
      description: overrides.description ?? 'A test application',
      category: overrides.category ?? 'utility',
      visibility: overrides.visibility ?? 'public',
      status: overrides.status ?? 'active',
      installs_count: overrides.installs_count ?? 0,
      avg_rating: overrides.avg_rating ?? '0.0',
      tags: overrides.tags ?? [],
    }).returningAll().executeTakeFirstOrThrow();
  }

  describe('createListing', () => {
    it('creates a listing and returns it', async () => {
      const listing = await createListing(db, {
        slug: 'my-app',
        name: 'My App',
        author_id: authorId,
        description: 'A great app',
        category: 'productivity',
        tags: ['todo', 'tasks'],
        visibility: 'public',
      });

      expect(listing.id).toBeDefined();
      expect(listing.slug).toBe('my-app');
      expect(listing.name).toBe('My App');
      expect(listing.author_id).toBe(authorId);
      expect(listing.category).toBe('productivity');
      expect(listing.status).toBe('active');
    });

    it('rejects duplicate slugs', async () => {
      await seedListing({ slug: 'duplicate-slug' });
      await expect(
        createListing(db, {
          slug: 'duplicate-slug',
          name: 'Dup',
          author_id: authorId,
          description: 'Dup',
          category: 'utility',
          visibility: 'public',
        }),
      ).rejects.toThrow();
    });
  });

  describe('updateListing', () => {
    it('updates listing fields', async () => {
      const listing = await seedListing({ slug: 'updatable' });
      const updated = await updateListing(db, listing.id, {
        description: 'Updated desc',
        category: 'games',
        tags: ['fun'],
      });
      expect(updated?.description).toBe('Updated desc');
      expect(updated?.category).toBe('games');
    });
  });

  describe('listPublic', () => {
    it('returns only public active listings', async () => {
      await seedListing({ slug: 'public-app', visibility: 'public', status: 'active' });
      await seedListing({ slug: 'unlisted-app', visibility: 'unlisted', status: 'active' });
      await seedListing({ slug: 'delisted-app', visibility: 'public', status: 'delisted' });

      const result = await listPublic(db, {});
      expect(result.apps.length).toBe(1);
      expect(result.apps[0].slug).toBe('public-app');
    });

    it('paginates with limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await seedListing({ slug: `page-app-${i}`, name: `Page App ${i}` });
      }

      const page1 = await listPublic(db, { limit: 2, offset: 0 });
      expect(page1.apps.length).toBe(2);
      expect(page1.total).toBe(5);
      expect(page1.hasMore).toBe(true);

      const page2 = await listPublic(db, { limit: 2, offset: 4 });
      expect(page2.apps.length).toBe(1);
      expect(page2.hasMore).toBe(false);
    });

    it('filters by category', async () => {
      await seedListing({ slug: 'game-app', category: 'games' });
      await seedListing({ slug: 'util-app', category: 'utility' });

      const result = await listPublic(db, { category: 'games' });
      expect(result.apps.length).toBe(1);
      expect(result.apps[0].slug).toBe('game-app');
    });

    it('sorts by popular', async () => {
      await seedListing({ slug: 'low', installs_count: 10 });
      await seedListing({ slug: 'high', installs_count: 1000 });

      const result = await listPublic(db, { sort: 'popular' });
      expect(result.apps[0].slug).toBe('high');
    });

    it('sorts by rated', async () => {
      await seedListing({ slug: 'low-rated', avg_rating: '2.0' });
      await seedListing({ slug: 'high-rated', avg_rating: '4.5' });

      const result = await listPublic(db, { sort: 'rated' });
      expect(result.apps[0].slug).toBe('high-rated');
    });

    it('sorts by new (default)', async () => {
      const a = await seedListing({ slug: 'old-app' });
      const b = await seedListing({ slug: 'new-app' });

      const result = await listPublic(db, {});
      expect(result.apps[0].slug).toBe('new-app');
    });
  });

  describe('search', () => {
    it('finds by name using tsvector', async () => {
      await seedListing({ slug: 'todo-app', name: 'Todo Manager', description: 'Manage tasks' });
      await seedListing({ slug: 'weather-app', name: 'Weather Dashboard', description: 'See weather' });

      const results = await search(db, 'todo');
      expect(results.results.length).toBe(1);
      expect(results.results[0].slug).toBe('todo-app');
    });

    it('finds by description using tsvector', async () => {
      await seedListing({ slug: 'task-app', name: 'Task App', description: 'Track your daily habits and routines' });

      const results = await search(db, 'habits');
      expect(results.results.length).toBe(1);
      expect(results.results[0].slug).toBe('task-app');
    });

    it('returns empty for no matches', async () => {
      await seedListing({ slug: 'some-app' });
      const results = await search(db, 'nonexistentxyz');
      expect(results.results.length).toBe(0);
    });

    it('filters by category', async () => {
      await seedListing({ slug: 'game-todo', name: 'Todo Game', category: 'games' });
      await seedListing({ slug: 'prod-todo', name: 'Todo Prod', category: 'productivity' });

      const results = await search(db, 'todo', { category: 'games' });
      expect(results.results.length).toBe(1);
      expect(results.results[0].slug).toBe('game-todo');
    });
  });

  describe('getByAuthorSlug', () => {
    it('returns listing detail by author handle and slug', async () => {
      // Insert a fake user row? The function joins users. For now, test without join.
      const listing = await seedListing({ slug: 'my-detail-app', author_id: authorId });

      const detail = await getByAuthorSlug(db, authorId, 'my-detail-app');
      expect(detail).toBeDefined();
      expect(detail!.slug).toBe('my-detail-app');
      expect(detail!.id).toBe(listing.id);
    });

    it('returns null for non-existent slug', async () => {
      const result = await getByAuthorSlug(db, authorId, 'no-such-app');
      expect(result).toBeNull();
    });

    it('returns null for delisted listings', async () => {
      await seedListing({ slug: 'hidden', status: 'delisted' });
      const result = await getByAuthorSlug(db, authorId, 'hidden');
      expect(result).toBeNull();
    });
  });

  describe('listCategories', () => {
    it('returns categories with counts', async () => {
      await seedListing({ slug: 'g1', category: 'games' });
      await seedListing({ slug: 'g2', category: 'games' });
      await seedListing({ slug: 'u1', category: 'utility' });

      const cats = await listCategories(db);
      const games = cats.find((c) => c.category === 'games');
      expect(games).toBeDefined();
      expect(Number(games!.count)).toBe(2);
    });

    it('excludes non-public listings from counts', async () => {
      await seedListing({ slug: 'pub', category: 'games', visibility: 'public' });
      await seedListing({ slug: 'priv', category: 'games', visibility: 'unlisted' });

      const cats = await listCategories(db);
      const games = cats.find((c) => c.category === 'games');
      expect(Number(games!.count)).toBe(1);
    });
  });

  describe('createOrUpdateFromPublish', () => {
    it('creates a new listing on first publish', async () => {
      const listing = await createOrUpdateFromPublish(db, {
        slug: 'publish-new',
        name: 'Published App',
        author_id: authorId,
        description: 'First publish',
        category: 'utility',
        tags: [],
        visibility: 'public',
        manifest: { name: 'Published App' },
      });

      expect(listing.id).toBeDefined();
      expect(listing.slug).toBe('publish-new');
    });

    it('updates an existing listing on re-publish', async () => {
      const original = await seedListing({ slug: 'republish', name: 'Original' });

      const updated = await createOrUpdateFromPublish(db, {
        slug: 'republish',
        name: 'Updated Name',
        author_id: authorId,
        description: 'Updated desc',
        category: 'utility',
        tags: ['updated'],
        visibility: 'public',
        manifest: { name: 'Updated Name' },
      });

      expect(updated.id).toBe(original.id);
      expect(updated.name).toBe('Updated Name');
    });
  });
});
