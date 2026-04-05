import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import { createGalleryStoreApi } from '../../../packages/platform/src/store-api.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

describe.skipIf(!TEST_DB_URL)('gallery/review-api', () => {
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
      slug: 'review-test-app',
      name: 'Review Test App',
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

    // Create installation for the reviewer
    await db.insertInto('app_installations').values({
      listing_id: listingId,
      version_id: versionId,
      user_id: reviewerId,
      install_target: 'personal',
    }).execute();
  });

  describe('POST /apps/:id/reviews', () => {
    it('submits a review from an installed user', async () => {
      const res = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 4, body: 'Great app!' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.rating).toBe(4);
      expect(body.body).toBe('Great app!');
    });

    it('rejects review from user without installation', async () => {
      const nonInstalledUser = '00000000-0000-0000-0000-000000000099';
      const res = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': nonInstalledUser },
        body: JSON.stringify({ rating: 5 }),
      });

      expect(res.status).toBe(403);
    });

    it('rejects invalid rating', async () => {
      const res = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 6 }),
      });

      expect(res.status).toBe(400);
    });

    it('requires authentication', async () => {
      const res = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 5 }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe('PUT /apps/:id/reviews/:reviewId', () => {
    it('updates an existing review', async () => {
      // Create review first
      const createRes = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 3, body: 'Okay' }),
      });
      const created = await createRes.json();

      const res = await app.request(`/apps/${listingId}/reviews/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 5, body: 'Actually great!' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rating).toBe(5);
      expect(body.body).toBe('Actually great!');
    });
  });

  describe('DELETE /apps/:id/reviews/:reviewId', () => {
    it('deletes a review', async () => {
      const createRes = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 4 }),
      });
      const created = await createRes.json();

      const res = await app.request(`/apps/${listingId}/reviews/${created.id}`, {
        method: 'DELETE',
        headers: { 'x-user-id': reviewerId },
      });

      expect(res.status).toBe(200);
    });
  });

  describe('GET /apps/:id/reviews', () => {
    it('returns reviews with rating distribution', async () => {
      await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 4, body: 'Nice' }),
      });

      const res = await app.request(`/apps/${listingId}/reviews`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reviews.length).toBe(1);
      expect(body.distribution).toBeDefined();
      expect(body.distribution[4]).toBe(1);
    });
  });

  describe('POST /apps/:id/reviews/:reviewId/respond', () => {
    it('allows listing author to respond', async () => {
      const createRes = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 4, body: 'Nice' }),
      });
      const created = await createRes.json();

      const res = await app.request(`/apps/${listingId}/reviews/${created.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': authorId },
        body: JSON.stringify({ response: 'Thanks for the feedback!' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.author_response).toBe('Thanks for the feedback!');
    });

    it('rejects non-author response', async () => {
      const createRes = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 4 }),
      });
      const created = await createRes.json();

      const res = await app.request(`/apps/${listingId}/reviews/${created.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ response: 'Hacking!' }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /apps/:id/reviews/:reviewId/flag', () => {
    it('flags a review', async () => {
      const createRes = await app.request(`/apps/${listingId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': reviewerId },
        body: JSON.stringify({ rating: 1, body: 'Spam' }),
      });
      const created = await createRes.json();

      const res = await app.request(`/apps/${listingId}/reviews/${created.id}/flag`, {
        method: 'POST',
        headers: { 'x-user-id': authorId },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.flagged).toBe(true);
    });
  });
});
