import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import { createGalleryStoreApi } from '../../../packages/platform/src/store-api.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

describe.skipIf(!TEST_DB_URL)('E2E Gallery Flow', () => {
  let db: Kysely<GalleryDatabase>;
  let app: ReturnType<typeof createGalleryStoreApi>;
  const authorId = 'e2e-author-001';
  const userId = 'e2e-user-001';

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

  it('runs the full gallery lifecycle: list -> detail -> install -> review -> delist', async () => {
    // 1. Seed a listing with a version
    const listing = await db.insertInto('app_listings').values({
      slug: 'e2e-test-app',
      name: 'E2E Test App',
      author_id: authorId,
      description: 'An app for end-to-end testing',
      category: 'utility',
      visibility: 'public',
    }).returningAll().executeTakeFirstOrThrow();

    const version = await db.insertInto('app_versions').values({
      listing_id: listing.id,
      version: '1.0.0',
      manifest: JSON.stringify({ name: 'E2E Test App' }),
      audit_status: 'passed',
    }).returningAll().executeTakeFirstOrThrow();

    await db.updateTable('app_listings')
      .set({ current_version_id: version.id })
      .where('id', '=', listing.id)
      .execute();

    // 2. Browse -- listing should appear in public list
    const browseRes = await app.request('/apps?sort=new&limit=10');
    expect(browseRes.status).toBe(200);
    const browseData = await browseRes.json();
    expect(browseData.apps?.length).toBeGreaterThan(0);

    // 3. Detail -- fetch by author/slug
    const detailRes = await app.request(`/apps/${authorId}/e2e-test-app`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.name).toBe('E2E Test App');

    // 4. Categories
    const catRes = await app.request('/categories');
    expect(catRes.status).toBe(200);

    // 5. Create installation (simulating what the gateway does)
    await db.insertInto('app_installations').values({
      listing_id: listing.id,
      version_id: version.id,
      user_id: userId,
      install_target: 'personal',
    }).execute();

    // 6. Verify installations endpoint
    const instRes = await app.request('/installations', {
      headers: { 'x-user-id': userId },
    });
    expect(instRes.status).toBe(200);
    const instData = await instRes.json();
    expect(instData.installations.length).toBe(1);

    // 7. Submit a review
    const reviewRes = await app.request(`/apps/${listing.id}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ rating: 5, body: 'Excellent app!' }),
    });
    expect(reviewRes.status).toBe(201);

    // 8. Read reviews
    const reviewsRes = await app.request(`/apps/${listing.id}/reviews`);
    expect(reviewsRes.status).toBe(200);
    const reviewsData = await reviewsRes.json();
    expect(reviewsData.reviews.length).toBe(1);
    expect(reviewsData.reviews[0].body).toBe('Excellent app!');
    expect(reviewsData.distribution[5]).toBe(1);

    // 9. Author responds to review
    const respondRes = await app.request(`/apps/${listing.id}/reviews/${reviewsData.reviews[0].id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': authorId },
      body: JSON.stringify({ response: 'Thank you!' }),
    });
    expect(respondRes.status).toBe(200);
    const respondData = await respondRes.json();
    expect(respondData.author_response).toBe('Thank you!');

    // 10. Version history
    const versionsRes = await app.request(`/apps/${listing.id}/versions`);
    expect(versionsRes.status).toBe(200);

    // 11. Delist the app
    const delistRes = await app.request(`/apps/${listing.id}/delist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': authorId },
      body: JSON.stringify({ reason: 'End of test' }),
    });
    expect(delistRes.status).toBe(200);
    const delistData = await delistRes.json();
    expect(delistData.delisted).toBe(true);

    // 12. Relist the app
    const relistRes = await app.request(`/apps/${listing.id}/relist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': authorId },
    });
    expect(relistRes.status).toBe(200);
    expect((await relistRes.json()).relisted).toBe(true);
  });
});
