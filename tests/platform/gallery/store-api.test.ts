import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import { createGalleryStoreApi } from '../../../packages/platform/src/store-api.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

describe.skipIf(!TEST_DB_URL)('gallery/store-api', () => {
  let db: Kysely<GalleryDatabase>;
  let app: ReturnType<typeof createGalleryStoreApi>;
  const authorId = '00000000-0000-0000-0000-000000000001';

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
    app = createGalleryStoreApi(db);
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
    await sql`DELETE FROM security_audits`.execute(db);
    await sql`DELETE FROM app_installations`.execute(db);
    await sql`DELETE FROM app_versions`.execute(db);
    await sql`UPDATE app_listings SET current_version_id = NULL`.execute(db);
    await sql`DELETE FROM app_listings`.execute(db);
  });

  async function seedListing(slug: string, overrides: Record<string, unknown> = {}) {
    return db.insertInto('app_listings').values({
      slug,
      name: (overrides.name as string) ?? slug,
      author_id: (overrides.author_id as string) ?? authorId,
      description: (overrides.description as string) ?? `Description for ${slug}`,
      category: (overrides.category as string) ?? 'utility',
      visibility: 'public',
      status: 'active',
    }).returningAll().executeTakeFirstOrThrow();
  }

  describe('GET /apps', () => {
    it('returns paginated listings', async () => {
      await seedListing('app-1');
      await seedListing('app-2');

      const res = await app.request('/apps?limit=1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.apps.length).toBe(1);
      expect(body.total).toBe(2);
      expect(body.hasMore).toBe(true);
    });

    it('filters by category', async () => {
      await seedListing('game-1', { category: 'games' });
      await seedListing('util-1', { category: 'utility' });

      const res = await app.request('/apps?category=games');
      const body = await res.json();
      expect(body.apps.length).toBe(1);
      expect(body.apps[0].slug).toBe('game-1');
    });

    it('sorts by popular', async () => {
      const a = await seedListing('low-installs');
      const b = await seedListing('high-installs');
      await db.updateTable('app_listings').set({ installs_count: 100 }).where('id', '=', b.id).execute();

      const res = await app.request('/apps?sort=popular');
      const body = await res.json();
      expect(body.apps[0].slug).toBe('high-installs');
    });
  });

  describe('GET /apps/search', () => {
    it('requires q parameter', async () => {
      const res = await app.request('/apps/search');
      expect(res.status).toBe(400);
    });

    it('returns search results', async () => {
      await seedListing('todo-app', { name: 'Todo Manager' });
      await seedListing('weather', { name: 'Weather Dashboard' });

      const res = await app.request('/apps/search?q=todo');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.length).toBe(1);
      expect(body.results[0].slug).toBe('todo-app');
    });
  });

  describe('GET /apps/:author/:slug', () => {
    it('returns listing detail', async () => {
      await seedListing('detail-app', { author_id: authorId });

      const res = await app.request(`/apps/${authorId}/detail-app`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.slug).toBe('detail-app');
    });

    it('returns 404 for non-existent', async () => {
      const res = await app.request(`/apps/${authorId}/no-such-app`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /categories', () => {
    it('returns categories with counts', async () => {
      await seedListing('g1', { category: 'games' });
      await seedListing('g2', { category: 'games' });
      await seedListing('u1', { category: 'utility' });

      const res = await app.request('/categories');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      const games = body.find((c: { category: string }) => c.category === 'games');
      expect(Number(games.count)).toBe(2);
    });
  });

  describe('GET /installations', () => {
    it('returns empty for user with no installations', async () => {
      const res = await app.request('/installations', {
        headers: { 'x-user-id': authorId },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.installations.length).toBe(0);
    });

    it('returns installations for authenticated user', async () => {
      const listing = await seedListing('installed-app');
      const version = await db.insertInto('app_versions').values({
        listing_id: listing.id,
        version: '1.0.0',
        manifest: JSON.stringify({ name: 'Test' }),
      }).returningAll().executeTakeFirstOrThrow();

      await db.insertInto('app_installations').values({
        listing_id: listing.id,
        version_id: version.id,
        user_id: authorId,
        install_target: 'personal',
      }).execute();

      const res = await app.request('/installations', {
        headers: { 'x-user-id': authorId },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.installations.length).toBe(1);
    });
  });

  describe('GET /apps/:id/audit', () => {
    it('returns audit for listing author', async () => {
      const listing = await seedListing('audit-app');
      const version = await db.insertInto('app_versions').values({
        listing_id: listing.id,
        version: '1.0.0',
        manifest: JSON.stringify({ name: 'Test' }),
      }).returningAll().executeTakeFirstOrThrow();

      await db.insertInto('security_audits').values({
        version_id: version.id,
        status: 'passed',
        manifest_findings: JSON.stringify([]),
        static_findings: JSON.stringify([]),
        sandbox_findings: JSON.stringify([]),
      }).execute();

      const res = await app.request(`/apps/${listing.id}/audit`, {
        headers: { 'x-user-id': authorId },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('passed');
    });

    it('returns 403 for non-author', async () => {
      const listing = await seedListing('secret-audit');
      const res = await app.request(`/apps/${listing.id}/audit`, {
        headers: { 'x-user-id': '00000000-0000-0000-0000-000000000099' },
      });
      expect(res.status).toBe(403);
    });
  });
});
