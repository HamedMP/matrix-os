import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Kysely } from 'kysely';
import { z } from 'zod/v4';
import type { GalleryDatabase } from './gallery/types.js';
import {
  listPublic,
  search,
  getByAuthorSlug,
  listCategories,
} from './gallery/listings.js';
import { listByUser, getByUserAndListing } from './gallery/installations.js';
import { getLatestAudit } from './gallery/security-audit.js';
import { listVersions } from './gallery/versions.js';
import {
  getInstallationsWithUpdateStatus,
} from './gallery/update-detection.js';
import {
  submitReview,
  updateReview,
  deleteReview,
  listByListing,
  flagReview,
  addAuthorResponse,
  getRatingDistribution,
} from './gallery/reviews.js';

// --- Zod schemas for request validation ---

const ReviewSubmitSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().max(2000).optional(),
});

const ReviewUpdateSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  body: z.string().max(2000).optional(),
});

const AuthorResponseSchema = z.object({
  response: z.string().min(1).max(2000),
});

const DelistSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

// --- Rate limiter for gallery mutations ---
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_WRITES = 30;
const writeCounters = new Map<string, { count: number; windowStart: number }>();
const MAX_TRACKED_IPS = 10_000;

function checkWriteRate(userId: string): boolean {
  const now = Date.now();
  let record = writeCounters.get(userId);
  if (!record || now - record.windowStart > RATE_WINDOW_MS) {
    if (writeCounters.size >= MAX_TRACKED_IPS) {
      const oldest = [...writeCounters.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart)[0];
      if (oldest) writeCounters.delete(oldest[0]);
    }
    record = { count: 0, windowStart: now };
    writeCounters.set(userId, record);
  }
  record.count++;
  return record.count <= RATE_MAX_WRITES;
}

// --- Helper: extract authenticated user or return 401 ---
function requireAuth(c: { req: { header: (name: string) => string | undefined } }): string | null {
  return c.req.header('x-user-id') ?? null;
}

/**
 * Gallery store API -- Postgres/Kysely backed.
 * Mount: /api/store
 */
export function createGalleryStoreApi(galleryDb: Kysely<GalleryDatabase>): Hono {
  const api = new Hono();

  // Body limit for all POST/PUT/DELETE
  api.use('*', async (c, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method)) {
      return bodyLimit({ maxSize: 64 * 1024 })(c, next);
    }
    return next();
  });

  // GET /apps -- browse gallery listings
  api.get('/apps', async (c) => {
    const category = c.req.query('category');
    const sort = c.req.query('sort') as 'popular' | 'rated' | 'new' | undefined;
    const limit = Math.min(Number(c.req.query('limit')) || 50, 100);
    const offset = Number(c.req.query('offset')) || 0;

    const result = await listPublic(galleryDb, { category, sort, limit, offset });
    return c.json(result);
  });

  // GET /apps/search -- full-text search
  api.get('/apps/search', async (c) => {
    const q = c.req.query('q');
    if (!q || q.length < 2) {
      return c.json({ error: 'Query parameter "q" is required (min 2 chars)' }, 400);
    }

    const category = c.req.query('category');
    const limit = Math.min(Number(c.req.query('limit')) || 20, 100);

    const result = await search(galleryDb, q, { category, limit });
    return c.json(result);
  });

  // GET /apps/:author/:slug -- listing detail
  api.get('/apps/:author/:slug', async (c) => {
    const authorId = c.req.param('author');
    const slug = c.req.param('slug');

    const listing = await getByAuthorSlug(galleryDb, authorId, slug);
    if (!listing) {
      return c.json({ error: 'App not found' }, 404);
    }

    return c.json(listing);
  });

  // GET /categories -- list categories with counts
  api.get('/categories', async (c) => {
    const categories = await listCategories(galleryDb);
    return c.json(categories);
  });

  // GET /installations -- user's installed apps (authenticated)
  api.get('/installations', async (c) => {
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const orgId = c.req.query('orgId');
    const installations = await listByUser(galleryDb, userId, orgId);
    return c.json({ installations });
  });

  // GET /apps/:id/audit -- latest audit results (author only)
  api.get('/apps/:id/audit', async (c) => {
    const listingId = c.req.param('id');
    const userId = requireAuth(c);

    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    // Verify user is the listing author
    const listing = await galleryDb.selectFrom('app_listings')
      .select(['id', 'author_id', 'current_version_id'])
      .where('id', '=', listingId)
      .executeTakeFirst();

    if (!listing) {
      return c.json({ error: 'Listing not found' }, 404);
    }

    if (listing.author_id !== userId) {
      return c.json({ error: 'Only the listing author can view audit results' }, 403);
    }

    if (!listing.current_version_id) {
      return c.json({ error: 'No version published yet' }, 404);
    }

    const audit = await getLatestAudit(galleryDb, listing.current_version_id);
    if (!audit) {
      return c.json({ error: 'No audit found' }, 404);
    }

    return c.json(audit);
  });

  // --- Version & Update Endpoints ---

  // GET /apps/:id/versions -- list all versions for a listing
  api.get('/apps/:id/versions', async (c) => {
    const listingId = c.req.param('id');
    const versions = await listVersions(galleryDb, listingId);
    return c.json(versions);
  });

  // GET /installations/updates -- user's installations with update status
  api.get('/installations/updates', async (c) => {
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const installations = await getInstallationsWithUpdateStatus(galleryDb, userId);
    return c.json({ installations });
  });

  // --- Review Endpoints ---

  // GET /apps/:id/reviews -- list reviews with distribution
  api.get('/apps/:id/reviews', async (c) => {
    const listingId = c.req.param('id');
    const sort = (c.req.query('sort') ?? 'recent') as 'recent' | 'highest' | 'lowest';
    const limit = Math.min(Number(c.req.query('limit')) || 20, 100);
    const offset = Number(c.req.query('offset')) || 0;

    const [reviews, distribution] = await Promise.all([
      listByListing(galleryDb, listingId, { sort, limit, offset }),
      getRatingDistribution(galleryDb, listingId),
    ]);

    const listing = await galleryDb.selectFrom('app_listings')
      .select(['avg_rating', 'ratings_count'])
      .where('id', '=', listingId)
      .executeTakeFirst();

    return c.json({
      reviews,
      total: reviews.length,
      averageRating: listing ? Number(listing.avg_rating) : 0,
      distribution,
    });
  });

  // POST /apps/:id/reviews -- submit a review (requires installation)
  api.post('/apps/:id/reviews', async (c) => {
    const listingId = c.req.param('id');
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    if (!checkWriteRate(userId)) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = ReviewSubmitSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', details: parsed.error.issues }, 400);
    }

    const installation = await getByUserAndListing(galleryDb, userId, listingId);
    if (!installation) {
      return c.json({ error: 'You must install this app before reviewing it' }, 403);
    }

    try {
      const review = await submitReview(galleryDb, listingId, userId, parsed.data.rating, parsed.data.body);
      return c.json(review, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit review';
      if (message.includes('unique') || message.includes('duplicate')) {
        return c.json({ error: 'You have already reviewed this app' }, 409);
      }
      return c.json({ error: 'Failed to submit review' }, 500);
    }
  });

  // PUT /apps/:id/reviews/:reviewId -- update a review
  api.put('/apps/:id/reviews/:reviewId', async (c) => {
    const reviewId = c.req.param('reviewId');
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    if (!checkWriteRate(userId)) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = ReviewUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', details: parsed.error.issues }, 400);
    }

    try {
      const review = await updateReview(galleryDb, reviewId, userId, parsed.data);
      return c.json(review);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('not found') || message.includes('not owned')) {
        return c.json({ error: 'Review not found or not owned by you' }, 404);
      }
      return c.json({ error: 'Failed to update review' }, 500);
    }
  });

  // DELETE /apps/:id/reviews/:reviewId -- delete a review
  api.delete('/apps/:id/reviews/:reviewId', async (c) => {
    const reviewId = c.req.param('reviewId');
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    if (!checkWriteRate(userId)) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    try {
      await deleteReview(galleryDb, reviewId, userId);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('not found') || message.includes('not owned')) {
        return c.json({ error: 'Review not found or not owned by you' }, 404);
      }
      return c.json({ error: 'Failed to delete review' }, 500);
    }
  });

  // POST /apps/:id/reviews/:reviewId/respond -- author responds to review
  api.post('/apps/:id/reviews/:reviewId/respond', async (c) => {
    const reviewId = c.req.param('reviewId');
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    if (!checkWriteRate(userId)) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = AuthorResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', details: parsed.error.issues }, 400);
    }

    try {
      const review = await addAuthorResponse(galleryDb, reviewId, userId, parsed.data.response);
      return c.json(review);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('not found')) {
        return c.json({ error: 'Review not found' }, 404);
      }
      if (message.includes('Only the listing author')) {
        return c.json({ error: 'Only the listing author can respond to reviews' }, 403);
      }
      return c.json({ error: 'Failed to add response' }, 500);
    }
  });

  // POST /apps/:id/reviews/:reviewId/flag -- flag a review
  api.post('/apps/:id/reviews/:reviewId/flag', async (c) => {
    const reviewId = c.req.param('reviewId');
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    if (!checkWriteRate(userId)) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    try {
      const review = await flagReview(galleryDb, reviewId);
      return c.json(review);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('not found')) {
        return c.json({ error: 'Review not found' }, 404);
      }
      return c.json({ error: 'Failed to flag review' }, 500);
    }
  });

  // --- Delisting & Flagging Endpoints (FR-035, FR-038) ---

  // POST /apps/:id/delist -- author delists their app
  api.post('/apps/:id/delist', async (c) => {
    const listingId = c.req.param('id');
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const raw = await c.req.json().catch(() => ({}));
    const parsed = DelistSchema.safeParse(raw);

    const listing = await galleryDb.selectFrom('app_listings')
      .select(['id', 'author_id', 'status'])
      .where('id', '=', listingId)
      .executeTakeFirst();

    if (!listing) {
      return c.json({ error: 'Listing not found' }, 404);
    }

    if (listing.author_id !== userId) {
      return c.json({ error: 'Only the listing author can delist' }, 403);
    }

    if (listing.status === 'delisted') {
      return c.json({ error: 'Listing is already delisted' }, 400);
    }

    await galleryDb.updateTable('app_listings')
      .set({ status: 'delisted', updated_at: new Date() })
      .where('id', '=', listingId)
      .execute();

    return c.json({ delisted: true, listingId });
  });

  // POST /apps/:id/relist -- author relists their app
  api.post('/apps/:id/relist', async (c) => {
    const listingId = c.req.param('id');
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const listing = await galleryDb.selectFrom('app_listings')
      .select(['id', 'author_id', 'status'])
      .where('id', '=', listingId)
      .executeTakeFirst();

    if (!listing) {
      return c.json({ error: 'Listing not found' }, 404);
    }

    if (listing.author_id !== userId) {
      return c.json({ error: 'Only the listing author can relist' }, 403);
    }

    if (listing.status !== 'delisted') {
      return c.json({ error: 'Listing is not delisted' }, 400);
    }

    await galleryDb.updateTable('app_listings')
      .set({ status: 'active', updated_at: new Date() })
      .where('id', '=', listingId)
      .execute();

    return c.json({ relisted: true, listingId });
  });

  // POST /apps/:id/flag -- flag a listing for review (any authenticated user)
  api.post('/apps/:id/flag', async (c) => {
    const listingId = c.req.param('id');
    const userId = requireAuth(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    if (!checkWriteRate(userId)) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    const listing = await galleryDb.selectFrom('app_listings')
      .select(['id', 'status'])
      .where('id', '=', listingId)
      .executeTakeFirst();

    if (!listing) {
      return c.json({ error: 'Listing not found' }, 404);
    }

    await galleryDb.updateTable('app_listings')
      .set({ status: 'flagged', updated_at: new Date() })
      .where('id', '=', listingId)
      .execute();

    return c.json({ flagged: true, listingId });
  });

  return api;
}

// Re-export legacy createStoreApi for backward compatibility
// The old SQLite-based store API is preserved for the platform DB
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
  listCategories as listCategoriesLegacy,
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
    const id = `app_${crypto.randomUUID().slice(0, 12)}`;

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
    const body = await c.req.json<{ userId?: string }>().catch(() => ({}));

    if (body.userId) {
      recordInstall(db, appId, body.userId);
    } else {
      incrementInstalls(db, appId);
    }

    const app = getApp(db, appId);
    return c.json({ installs: app?.installs ?? 0 });
  });

  api.get('/categories', (c) => {
    const categories = listCategoriesLegacy(db);
    return c.json(categories);
  });

  return api;
}
