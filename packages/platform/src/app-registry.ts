import { sql } from 'kysely';
import type { PlatformDB } from './db.js';

export interface AppRegistryRecord {
  id: string;
  name: string;
  slug: string;
  authorId: string;
  description: string | null;
  category: string | null;
  tags: string | null;
  version: string | null;
  sourceUrl: string | null;
  manifest: string | null;
  screenshots: string | null;
  installs: number;
  rating: number;
  ratingsCount: number;
  forksCount: number;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewAppRegistry {
  id: string;
  name: string;
  slug: string;
  authorId: string;
  description?: string | null;
  category?: string | null;
  tags?: string | null;
  version?: string | null;
  sourceUrl?: string | null;
  manifest?: string | null;
  screenshots?: string | null;
  isPublic?: boolean;
}

export interface AppRatingRecord {
  appId: string;
  userId: string;
  rating: number;
  review: string | null;
  createdAt: string;
}

function mapApp(row: {
  id: string;
  name: string;
  slug: string;
  author_id: string;
  description: string | null;
  category: string | null;
  tags: string | null;
  version: string | null;
  source_url: string | null;
  manifest: string | null;
  screenshots: string | null;
  installs: number;
  rating: number;
  ratings_count: number;
  forks_count: number;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}): AppRegistryRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    authorId: row.author_id,
    description: row.description,
    category: row.category,
    tags: row.tags,
    version: row.version,
    sourceUrl: row.source_url,
    manifest: row.manifest,
    screenshots: row.screenshots,
    installs: row.installs,
    rating: row.rating,
    ratingsCount: row.ratings_count,
    forksCount: row.forks_count,
    isPublic: row.is_public,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRating(row: {
  app_id: string;
  user_id: string;
  rating: number;
  review: string | null;
  created_at: string;
}): AppRatingRecord {
  return {
    appId: row.app_id,
    userId: row.user_id,
    rating: row.rating,
    review: row.review,
    createdAt: row.created_at,
  };
}

export async function insertApp(
  db: PlatformDB,
  record: Omit<NewAppRegistry, 'createdAt' | 'updatedAt' | 'installs' | 'rating' | 'ratingsCount' | 'forksCount'>,
): Promise<void> {
  await db.ready;
  const now = new Date().toISOString();
  await db.executor
    .insertInto('apps_registry')
    .values({
      id: record.id,
      name: record.name,
      slug: record.slug,
      author_id: record.authorId,
      description: record.description ?? null,
      category: record.category ?? 'utility',
      tags: record.tags ?? null,
      version: record.version ?? '1.0.0',
      source_url: record.sourceUrl ?? null,
      manifest: record.manifest ?? null,
      screenshots: record.screenshots ?? null,
      installs: 0,
      rating: 0,
      ratings_count: 0,
      forks_count: 0,
      is_public: record.isPublic ?? false,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

export async function getApp(db: PlatformDB, id: string): Promise<AppRegistryRecord | undefined> {
  await db.ready;
  const row = await db.executor.selectFrom('apps_registry').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? mapApp(row) : undefined;
}

export async function getAppBySlug(
  db: PlatformDB,
  authorId: string,
  slug: string,
): Promise<AppRegistryRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('apps_registry')
    .selectAll()
    .where('author_id', '=', authorId)
    .where('slug', '=', slug)
    .executeTakeFirst();
  return row ? mapApp(row) : undefined;
}

export async function updateApp(
  db: PlatformDB,
  id: string,
  updates: Partial<Pick<NewAppRegistry, 'name' | 'description' | 'category' | 'tags' | 'version' | 'sourceUrl' | 'manifest' | 'screenshots' | 'isPublic'>>,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('apps_registry')
    .set({
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.category !== undefined ? { category: updates.category } : {}),
      ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
      ...(updates.version !== undefined ? { version: updates.version } : {}),
      ...(updates.sourceUrl !== undefined ? { source_url: updates.sourceUrl } : {}),
      ...(updates.manifest !== undefined ? { manifest: updates.manifest } : {}),
      ...(updates.screenshots !== undefined ? { screenshots: updates.screenshots } : {}),
      ...(updates.isPublic !== undefined ? { is_public: updates.isPublic } : {}),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute();
}

export async function deleteApp(db: PlatformDB, id: string): Promise<void> {
  await db.transaction(async (trx) => {
    await trx.executor.deleteFrom('app_ratings').where('app_id', '=', id).execute();
    await trx.executor.deleteFrom('app_installs').where('app_id', '=', id).execute();
    await trx.executor.deleteFrom('apps_registry').where('id', '=', id).execute();
  });
}

interface ListAppsOptions {
  category?: string;
  authorId?: string;
  publicOnly?: boolean;
  sort?: 'new' | 'popular' | 'rated';
  limit?: number;
  offset?: number;
}

interface ListAppsResult {
  apps: AppRegistryRecord[];
  total: number;
  hasMore: boolean;
}

export async function listApps(db: PlatformDB, options: ListAppsOptions): Promise<ListAppsResult> {
  await db.ready;
  const { category, authorId, publicOnly, sort = 'new', limit = 50, offset = 0 } = options;
  let countQuery = db.executor.selectFrom('apps_registry').select((eb) => eb.fn.countAll<number>().as('count'));
  let listQuery = db.executor.selectFrom('apps_registry').selectAll();

  if (publicOnly) {
    countQuery = countQuery.where('is_public', '=', true);
    listQuery = listQuery.where('is_public', '=', true);
  }
  if (category) {
    countQuery = countQuery.where('category', '=', category);
    listQuery = listQuery.where('category', '=', category);
  }
  if (authorId) {
    countQuery = countQuery.where('author_id', '=', authorId);
    listQuery = listQuery.where('author_id', '=', authorId);
  }

  const countResult = await countQuery.executeTakeFirst();
  const total = Number(countResult?.count ?? 0);
  const orderColumn = sort === 'popular' ? 'installs' : sort === 'rated' ? 'rating' : 'created_at';
  const rows = await listQuery.orderBy(orderColumn, 'desc').limit(limit).offset(offset).execute();
  const apps = rows.map(mapApp);

  return {
    apps,
    total,
    hasMore: offset + apps.length < total,
  };
}

export async function searchApps(db: PlatformDB, query: string): Promise<AppRegistryRecord[]> {
  await db.ready;
  const pattern = `%${query}%`;
  const rows = await db.executor
    .selectFrom('apps_registry')
    .selectAll()
    .where('is_public', '=', true)
    .where((eb) =>
      eb.or([
        eb('name', 'ilike', pattern),
        eb('description', 'ilike', pattern),
        eb('tags', 'ilike', pattern),
      ]),
    )
    .execute();
  return rows.map(mapApp);
}

export async function incrementInstalls(db: PlatformDB, appId: string): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('apps_registry')
    .set({
      installs: sql<number>`installs + 1`,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', appId)
    .execute();
}

export async function recordInstall(db: PlatformDB, appId: string, userId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const inserted = await trx.executor
      .insertInto('app_installs')
      .values({ app_id: appId, user_id: userId, installed_at: new Date().toISOString() })
      .onConflict((oc) => oc.columns(['app_id', 'user_id']).doNothing())
      .returning('app_id')
      .executeTakeFirst();
    if (inserted) {
      await incrementInstalls(trx, appId);
    }
  });
}

export async function submitRating(
  db: PlatformDB,
  input: { appId: string; userId: string; rating: number; review?: string },
): Promise<void> {
  const { appId, userId, rating, review } = input;
  await db.transaction(async (trx) => {
    await trx.executor
      .insertInto('app_ratings')
      .values({
        app_id: appId,
        user_id: userId,
        rating,
        review: review ?? null,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(['app_id', 'user_id']).doUpdateSet({
          rating,
          review: review ?? null,
          created_at: new Date().toISOString(),
        }),
      )
      .execute();
    await recalculateRating(trx, appId);
  });
}

async function recalculateRating(db: PlatformDB, appId: string): Promise<void> {
  const result = await db.executor
    .selectFrom('app_ratings')
    .select((eb) => [
      eb.fn.avg<number>('rating').as('avg'),
      eb.fn.countAll<number>().as('count'),
    ])
    .where('app_id', '=', appId)
    .executeTakeFirst();

  await db.executor
    .updateTable('apps_registry')
    .set({
      rating: Math.round(Number(result?.avg ?? 0)),
      ratings_count: Number(result?.count ?? 0),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', appId)
    .execute();
}

export async function getAppRating(
  db: PlatformDB,
  appId: string,
  userId: string,
): Promise<AppRatingRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('app_ratings')
    .selectAll()
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row ? mapRating(row) : undefined;
}

export async function listAppRatings(db: PlatformDB, appId: string): Promise<AppRatingRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('app_ratings')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(mapRating);
}

export async function listCategories(db: PlatformDB): Promise<Array<{ category: string; count: number }>> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('apps_registry')
    .select((eb) => [
      'category',
      eb.fn.countAll<number>().as('count'),
    ])
    .where('is_public', '=', true)
    .where('category', 'is not', null)
    .groupBy('category')
    .execute();
  return rows.map((row) => ({ category: row.category ?? 'utility', count: Number(row.count) }));
}
