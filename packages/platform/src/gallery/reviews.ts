import { sql, type Kysely } from 'kysely';
import type { GalleryDatabase } from './types.js';

type Db = Kysely<GalleryDatabase>;

export async function submitReview(
  db: Db,
  listingId: string,
  reviewerId: string,
  rating: number,
  body?: string,
) {
  return db.transaction().execute(async (tx) => {
    const review = await tx
      .insertInto('app_reviews')
      .values({
        listing_id: listingId,
        reviewer_id: reviewerId,
        rating,
        body: body ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recalculate(tx, listingId);
    return review;
  });
}

export async function updateReview(
  db: Db,
  reviewId: string,
  reviewerId: string,
  fields: { rating?: number; body?: string },
) {
  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('app_reviews')
      .select(['id', 'listing_id', 'reviewer_id'])
      .where('id', '=', reviewId)
      .executeTakeFirst();

    if (!existing || existing.reviewer_id !== reviewerId) {
      throw new Error('Review not found or not owned by caller');
    }

    const updates: Record<string, unknown> = { updated_at: sql`now()` };
    if (fields.rating !== undefined) updates.rating = fields.rating;
    if (fields.body !== undefined) updates.body = fields.body;

    const updated = await tx
      .updateTable('app_reviews')
      .set(updates)
      .where('id', '=', reviewId)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (fields.rating !== undefined) {
      await recalculate(tx, existing.listing_id);
    }

    return updated;
  });
}

export async function deleteReview(
  db: Db,
  reviewId: string,
  reviewerId: string,
) {
  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('app_reviews')
      .select(['id', 'listing_id', 'reviewer_id'])
      .where('id', '=', reviewId)
      .executeTakeFirst();

    if (!existing || existing.reviewer_id !== reviewerId) {
      throw new Error('Review not found or not owned by caller');
    }

    await tx.deleteFrom('app_reviews').where('id', '=', reviewId).execute();
    await recalculate(tx, existing.listing_id);
  });
}

export async function listByListing(
  db: Db,
  listingId: string,
  opts: { sort: 'recent' | 'highest' | 'lowest'; limit: number; offset: number },
) {
  let query = db
    .selectFrom('app_reviews')
    .selectAll()
    .where('listing_id', '=', listingId);

  switch (opts.sort) {
    case 'recent':
      query = query.orderBy('created_at', 'desc');
      break;
    case 'highest':
      query = query.orderBy('rating', 'desc').orderBy('created_at', 'desc');
      break;
    case 'lowest':
      query = query.orderBy('rating', 'asc').orderBy('created_at', 'desc');
      break;
  }

  return query.limit(opts.limit).offset(opts.offset).execute();
}

export async function recalculateAverage(db: Db, listingId: string) {
  return recalculate(db, listingId);
}

export async function flagReview(db: Db, reviewId: string) {
  const updated = await db
    .updateTable('app_reviews')
    .set({ flagged: true, updated_at: sql`now()` })
    .where('id', '=', reviewId)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    throw new Error('Review not found');
  }

  return updated;
}

export async function addAuthorResponse(
  db: Db,
  reviewId: string,
  authorId: string,
  response: string,
) {
  const review = await db
    .selectFrom('app_reviews')
    .select(['id', 'listing_id'])
    .where('id', '=', reviewId)
    .executeTakeFirst();

  if (!review) {
    throw new Error('Review not found');
  }

  const listing = await db
    .selectFrom('app_listings')
    .select(['author_id'])
    .where('id', '=', review.listing_id)
    .executeTakeFirstOrThrow();

  if (listing.author_id !== authorId) {
    throw new Error('Only the listing author can respond to reviews');
  }

  return db
    .updateTable('app_reviews')
    .set({
      author_response: response,
      author_responded_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .where('id', '=', reviewId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getRatingDistribution(
  db: Db,
  listingId: string,
): Promise<Record<1 | 2 | 3 | 4 | 5, number>> {
  const rows = await db
    .selectFrom('app_reviews')
    .select(['rating', sql<string>`count(*)`.as('count')])
    .where('listing_id', '=', listingId)
    .groupBy('rating')
    .execute();

  const dist: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of rows) {
    const star = row.rating as 1 | 2 | 3 | 4 | 5;
    dist[star] = Number(row.count);
  }
  return dist;
}

async function recalculate(db: Db | Kysely<GalleryDatabase>, listingId: string) {
  const agg = await (db as Db)
    .selectFrom('app_reviews')
    .select([
      sql<string>`coalesce(round(avg(rating)::numeric, 1), 0)`.as('avg_rating'),
      sql<string>`count(*)`.as('ratings_count'),
    ])
    .where('listing_id', '=', listingId)
    .executeTakeFirstOrThrow();

  const avgRating = String(agg.avg_rating);
  const ratingsCount = Number(agg.ratings_count);

  await (db as Db)
    .updateTable('app_listings')
    .set({
      avg_rating: avgRating,
      ratings_count: ratingsCount,
      updated_at: sql`now()`,
    })
    .where('id', '=', listingId)
    .execute();

  return { avg_rating: avgRating, ratings_count: ratingsCount };
}
