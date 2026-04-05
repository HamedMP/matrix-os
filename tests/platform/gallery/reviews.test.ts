import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { GalleryDatabase } from '../../../packages/platform/src/gallery/types.js';
import { runGalleryMigrations } from '../../../packages/platform/src/gallery/migrations.js';
import {
  submitReview,
  updateReview,
  deleteReview,
  listByListing,
  recalculateAverage,
  flagReview,
  addAuthorResponse,
  getRatingDistribution,
} from '../../../packages/platform/src/gallery/reviews.js';

const TEST_DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

describe.skipIf(!TEST_DB_URL)('gallery/reviews', () => {
  let db: Kysely<GalleryDatabase>;

  const authorId = '00000000-0000-0000-0000-000000000001';
  const reviewerId = '00000000-0000-0000-0000-000000000002';
  const reviewer2Id = '00000000-0000-0000-0000-000000000003';
  const reviewer3Id = '00000000-0000-0000-0000-000000000004';
  let listingId: string;

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

    const listing = await db
      .insertInto('app_listings')
      .values({
        slug: 'reviews-test-app',
        name: 'Reviews Test App',
        author_id: authorId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    listingId = listing.id;
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
    await db.deleteFrom('app_reviews').execute();
    await db
      .updateTable('app_listings')
      .set({ avg_rating: '0.0', ratings_count: 0 })
      .where('id', '=', listingId)
      .execute();
  });

  describe('submitReview', () => {
    it('creates a review and updates listing avg_rating + ratings_count', async () => {
      const review = await submitReview(db, listingId, reviewerId, 4, 'Great app!');

      expect(review.id).toBeDefined();
      expect(review.rating).toBe(4);
      expect(review.body).toBe('Great app!');
      expect(review.reviewer_id).toBe(reviewerId);

      const listing = await db
        .selectFrom('app_listings')
        .select(['avg_rating', 'ratings_count'])
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();

      expect(Number(listing.avg_rating)).toBe(4.0);
      expect(listing.ratings_count).toBe(1);
    });

    it('creates a review without body', async () => {
      const review = await submitReview(db, listingId, reviewerId, 5);

      expect(review.rating).toBe(5);
      expect(review.body).toBeNull();
    });

    it('recalculates average with multiple reviews', async () => {
      await submitReview(db, listingId, reviewerId, 4);
      await submitReview(db, listingId, reviewer2Id, 2);

      const listing = await db
        .selectFrom('app_listings')
        .select(['avg_rating', 'ratings_count'])
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();

      expect(Number(listing.avg_rating)).toBe(3.0);
      expect(listing.ratings_count).toBe(2);
    });

    it('enforces one review per user per listing (UNIQUE constraint)', async () => {
      await submitReview(db, listingId, reviewerId, 4);

      await expect(submitReview(db, listingId, reviewerId, 5)).rejects.toThrow();
    });
  });

  describe('updateReview', () => {
    it('updates rating and body, recalculates avg', async () => {
      const review = await submitReview(db, listingId, reviewerId, 4, 'Good');

      const updated = await updateReview(db, review.id, reviewerId, {
        rating: 2,
        body: 'Not so good',
      });

      expect(updated.rating).toBe(2);
      expect(updated.body).toBe('Not so good');

      const listing = await db
        .selectFrom('app_listings')
        .select(['avg_rating'])
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();

      expect(Number(listing.avg_rating)).toBe(2.0);
    });

    it('updates only rating', async () => {
      const review = await submitReview(db, listingId, reviewerId, 3, 'OK');
      const updated = await updateReview(db, review.id, reviewerId, { rating: 5 });

      expect(updated.rating).toBe(5);
      expect(updated.body).toBe('OK');
    });

    it('updates only body', async () => {
      const review = await submitReview(db, listingId, reviewerId, 3);
      const updated = await updateReview(db, review.id, reviewerId, {
        body: 'Added text',
      });

      expect(updated.rating).toBe(3);
      expect(updated.body).toBe('Added text');
    });

    it('rejects update from non-author', async () => {
      const review = await submitReview(db, listingId, reviewerId, 4);

      await expect(
        updateReview(db, review.id, reviewer2Id, { rating: 1 }),
      ).rejects.toThrow();
    });
  });

  describe('deleteReview', () => {
    it('removes review and recalculates avg', async () => {
      const r1 = await submitReview(db, listingId, reviewerId, 4);
      await submitReview(db, listingId, reviewer2Id, 2);

      await deleteReview(db, r1.id, reviewerId);

      const listing = await db
        .selectFrom('app_listings')
        .select(['avg_rating', 'ratings_count'])
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();

      expect(Number(listing.avg_rating)).toBe(2.0);
      expect(listing.ratings_count).toBe(1);
    });

    it('sets avg to 0 when last review deleted', async () => {
      const review = await submitReview(db, listingId, reviewerId, 5);
      await deleteReview(db, review.id, reviewerId);

      const listing = await db
        .selectFrom('app_listings')
        .select(['avg_rating', 'ratings_count'])
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();

      expect(Number(listing.avg_rating)).toBe(0.0);
      expect(listing.ratings_count).toBe(0);
    });

    it('rejects delete from non-author', async () => {
      const review = await submitReview(db, listingId, reviewerId, 4);
      await expect(deleteReview(db, review.id, reviewer2Id)).rejects.toThrow();
    });
  });

  describe('listByListing', () => {
    it('returns paginated reviews sorted by most recent', async () => {
      await submitReview(db, listingId, reviewerId, 5, 'First');
      await submitReview(db, listingId, reviewer2Id, 3, 'Second');
      await submitReview(db, listingId, reviewer3Id, 4, 'Third');

      const page1 = await listByListing(db, listingId, {
        sort: 'recent',
        limit: 2,
        offset: 0,
      });

      expect(page1).toHaveLength(2);
      expect(page1[0].body).toBe('Third');
      expect(page1[1].body).toBe('Second');

      const page2 = await listByListing(db, listingId, {
        sort: 'recent',
        limit: 2,
        offset: 2,
      });

      expect(page2).toHaveLength(1);
      expect(page2[0].body).toBe('First');
    });

    it('sorts by highest rating', async () => {
      await submitReview(db, listingId, reviewerId, 2, 'Low');
      await submitReview(db, listingId, reviewer2Id, 5, 'High');
      await submitReview(db, listingId, reviewer3Id, 3, 'Mid');

      const results = await listByListing(db, listingId, {
        sort: 'highest',
        limit: 10,
        offset: 0,
      });

      expect(results[0].body).toBe('High');
      expect(results[1].body).toBe('Mid');
      expect(results[2].body).toBe('Low');
    });

    it('sorts by lowest rating', async () => {
      await submitReview(db, listingId, reviewerId, 5, 'High');
      await submitReview(db, listingId, reviewer2Id, 1, 'Low');

      const results = await listByListing(db, listingId, {
        sort: 'lowest',
        limit: 10,
        offset: 0,
      });

      expect(results[0].body).toBe('Low');
      expect(results[1].body).toBe('High');
    });

    it('returns empty array for listing with no reviews', async () => {
      const results = await listByListing(db, listingId, {
        sort: 'recent',
        limit: 10,
        offset: 0,
      });
      expect(results).toEqual([]);
    });
  });

  describe('recalculateAverage', () => {
    it('computes correct avg from app_reviews and updates app_listings', async () => {
      await submitReview(db, listingId, reviewerId, 5);
      await submitReview(db, listingId, reviewer2Id, 3);
      await submitReview(db, listingId, reviewer3Id, 1);

      // Manually corrupt the denormalized value
      await db
        .updateTable('app_listings')
        .set({ avg_rating: '0.0', ratings_count: 0 })
        .where('id', '=', listingId)
        .execute();

      const result = await recalculateAverage(db, listingId);

      expect(Number(result.avg_rating)).toBe(3.0);
      expect(result.ratings_count).toBe(3);

      const listing = await db
        .selectFrom('app_listings')
        .select(['avg_rating', 'ratings_count'])
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();

      expect(Number(listing.avg_rating)).toBe(3.0);
      expect(listing.ratings_count).toBe(3);
    });

    it('sets to 0 when no reviews exist', async () => {
      const result = await recalculateAverage(db, listingId);

      expect(Number(result.avg_rating)).toBe(0.0);
      expect(result.ratings_count).toBe(0);
    });
  });

  describe('flagReview', () => {
    it('sets flagged = true', async () => {
      const review = await submitReview(db, listingId, reviewerId, 1, 'Spam');
      const flagged = await flagReview(db, review.id);

      expect(flagged.flagged).toBe(true);
    });

    it('throws for non-existent review', async () => {
      await expect(
        flagReview(db, '00000000-0000-0000-0000-999999999999'),
      ).rejects.toThrow();
    });
  });

  describe('addAuthorResponse', () => {
    it('adds author response when caller is listing author', async () => {
      const review = await submitReview(db, listingId, reviewerId, 3, 'Decent');

      const responded = await addAuthorResponse(
        db,
        review.id,
        authorId,
        'Thanks for the feedback!',
      );

      expect(responded.author_response).toBe('Thanks for the feedback!');
      expect(responded.author_responded_at).toBeTruthy();
    });

    it('rejects response from non-listing-author', async () => {
      const review = await submitReview(db, listingId, reviewerId, 4);

      await expect(
        addAuthorResponse(db, review.id, reviewer2Id, 'Not my app'),
      ).rejects.toThrow();
    });
  });

  describe('getRatingDistribution', () => {
    it('returns count per star (1-5)', async () => {
      await submitReview(db, listingId, reviewerId, 5);
      await submitReview(db, listingId, reviewer2Id, 5);
      await submitReview(db, listingId, reviewer3Id, 3);

      const dist = await getRatingDistribution(db, listingId);

      expect(dist).toEqual({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 2 });
    });

    it('returns all zeros when no reviews', async () => {
      const dist = await getRatingDistribution(db, listingId);
      expect(dist).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    });
  });
});
