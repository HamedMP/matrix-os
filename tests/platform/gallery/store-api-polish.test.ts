import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import { createGalleryStoreApi } from '../../../packages/platform/src/store-api.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

describe.skipIf(!TEST_DB_URL)('gallery/store-api-polish', () => {
  let db: Kysely<GalleryDatabase>;
  let app: ReturnType<typeof createGalleryStoreApi>;
  const authorId = '00000000-0000-0000-0000-000000000001';
  const reviewerId = '00000000-0000-0000-0000-000000000002';
  let listingId: string;
  let versionId: string;

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
    await sql`DELETE FROM app_reviews`.execute(db);
    await sql`DELETE FROM app_installations`.execute(db);
    await sql`DELETE FROM app_versions`.execute(db);
    await sql`UPDATE app_listings SET current_version_id = NULL`.execute(db);
    await sql`DELETE FROM app_listings`.execute(db);

    const listing = await db.insertInto('app_listings').values({
      slug: 'polish-test-app',
      name: 'Polish Test App',
      author_id: authorId,
      description: 'Test',
      category: 'utility',
    }).returningAll().executeTakeFirstOrThrow();
    listingId = listing.id;

    const version = await db.insertInto('app_versions').values({
      listing_id: listingId,
      version: '1.0.0',
      manifest: JSON.stringify({ name: 'Test' }),
    }).returningAll().executeTakeFirstOrThrow();
    versionId = version.id;

    await db.insertInto('app_installations').values({
      listing_id: listingId,
      version_id: versionId,
      user_id: reviewerId,
      install_target: 'personal',
    }).execute();
  });

  describe('Zod validation', () => {
    it('rejects review with rating out of range', async () => {
      const res = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 0 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.details).toBeDefined();
    });

    it('rejects review with non-integer rating', async () => {
      const res = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 3.5 }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects review body exceeding 2000 chars', async () => {
      const res = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 5, body: 'x'.repeat(2001) }),
      });
      expect(res.status).toBe(400);
    });

    it('accepts valid review', async () => {
      const res = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 4, body: 'Great app' }),
      });
      expect(res.status).toBe(201);
    });

    it('rejects empty author response', async () => {
      // First create a review
      await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 4 }),
      });

      const reviews = await app.request(`/apps/${listingId}/reviews`);
      const data = await reviews.json();
      const reviewId = data.reviews[0]?.id;

      const res = await app.request(`/apps/${listingId}/reviews/${reviewId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': authorId },
        body: JSON.stringify({ response: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects malformed JSON body', async () => {
      const res = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: 'not json',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Delist/Relist (FR-038)', () => {
    it('allows author to delist', async () => {
      const res = await app.request(`/apps/${listingId}/delist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': authorId },
        body: JSON.stringify({ reason: 'Deprecated' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.delisted).toBe(true);
    });

    it('rejects delist by non-author', async () => {
      const res = await app.request(`/apps/${listingId}/delist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });

    it('allows author to relist', async () => {
      // Delist first
      await app.request(`/apps/${listingId}/delist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': authorId },
        body: JSON.stringify({}),
      });

      const res = await app.request(`/apps/${listingId}/relist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': authorId },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.relisted).toBe(true);
    });

    it('rejects relist when not delisted', async () => {
      const res = await app.request(`/apps/${listingId}/relist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': authorId },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Flag listing (FR-035)', () => {
    it('allows authenticated user to flag', async () => {
      const res = await app.request(`/apps/${listingId}/flag`, {
        method: 'POST',
        headers: { 'x-user-id': reviewerId },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.flagged).toBe(true);
    });

    it('rejects unauthenticated flag', async () => {
      const res = await app.request(`/apps/${listingId}/flag`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('returns 404 for missing listing', async () => {
      const res = await app.request(`/apps/nonexistent/flag`, {
        method: 'POST',
        headers: { 'x-user-id': reviewerId },
      });
      expect(res.status).toBe(404);
    });
  });
});
