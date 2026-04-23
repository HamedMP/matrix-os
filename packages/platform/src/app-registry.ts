import { eq, and, desc, sql, like, or } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { PlatformDB } from './db.js';

// --- Schema ---

export const appsRegistry = sqliteTable(
  'apps_registry',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    authorId: text('author_id').notNull(),
    description: text('description'),
    category: text('category').default('utility'),
    tags: text('tags'),
    version: text('version').default('1.0.0'),
    sourceUrl: text('source_url'),
    manifest: text('manifest'),
    screenshots: text('screenshots'),
    installs: integer('installs').default(0).notNull(),
    rating: integer('rating').default(0).notNull(),
    ratingsCount: integer('ratings_count').default(0).notNull(),
    forksCount: integer('forks_count').default(0).notNull(),
    isPublic: integer('is_public', { mode: 'boolean' }).default(false).notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_apps_author_slug').on(table.authorId, table.slug),
    index('idx_apps_category').on(table.category),
    index('idx_apps_public').on(table.isPublic),
    index('idx_apps_installs').on(table.installs),
  ],
);

export const appRatings = sqliteTable(
  'app_ratings',
  {
    appId: text('app_id').notNull(),
    userId: text('user_id').notNull(),
    rating: integer('rating').notNull(),
    review: text('review'),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_ratings_app_user').on(table.appId, table.userId),
  ],
);

export const appInstalls = sqliteTable(
  'app_installs',
  {
    appId: text('app_id').notNull(),
    userId: text('user_id').notNull(),
    installedAt: text('installed_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_installs_app_user').on(table.appId, table.userId),
  ],
);

// --- Types ---

export type AppRegistryRecord = typeof appsRegistry.$inferSelect;
export type NewAppRegistry = typeof appsRegistry.$inferInsert;
export type AppRatingRecord = typeof appRatings.$inferSelect;
export type AppInstallRecord = typeof appInstalls.$inferSelect;

// --- Migration ---

export function runAppRegistryMigrations(sqlite: { prepare(sql: string): { run(): unknown } }): void {
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS apps_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      author_id TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'utility',
      tags TEXT,
      version TEXT DEFAULT '1.0.0',
      source_url TEXT,
      manifest TEXT,
      screenshots TEXT,
      installs INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 0,
      ratings_count INTEGER NOT NULL DEFAULT 0,
      forks_count INTEGER NOT NULL DEFAULT 0,
      is_public INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_author_slug ON apps_registry(author_id, slug)'
  ).run();

  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_apps_category ON apps_registry(category)'
  ).run();

  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_apps_public ON apps_registry(is_public)'
  ).run();

  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_apps_installs ON apps_registry(installs)'
  ).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS app_ratings (
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      review TEXT,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_app_user ON app_ratings(app_id, user_id)'
  ).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS app_installs (
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      installed_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_installs_app_user ON app_installs(app_id, user_id)'
  ).run();
}

// --- CRUD ---

export function insertApp(
  db: PlatformDB,
  record: Omit<NewAppRegistry, 'createdAt' | 'updatedAt' | 'installs' | 'rating' | 'ratingsCount' | 'forksCount'>,
): void {
  const now = new Date().toISOString();
  db.insert(appsRegistry)
    .values({
      ...record,
      installs: 0,
      rating: 0,
      ratingsCount: 0,
      forksCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

export function getApp(db: PlatformDB, id: string): AppRegistryRecord | undefined {
  return db.select().from(appsRegistry).where(eq(appsRegistry.id, id)).get();
}

export function getAppBySlug(db: PlatformDB, authorId: string, slug: string): AppRegistryRecord | undefined {
  return db
    .select()
    .from(appsRegistry)
    .where(and(eq(appsRegistry.authorId, authorId), eq(appsRegistry.slug, slug)))
    .get();
}

export function updateApp(
  db: PlatformDB,
  id: string,
  updates: Partial<Pick<NewAppRegistry, 'name' | 'description' | 'category' | 'tags' | 'version' | 'sourceUrl' | 'manifest' | 'screenshots' | 'isPublic'>>,
): void {
  db.update(appsRegistry)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(appsRegistry.id, id))
    .run();
}

export function deleteApp(db: PlatformDB, id: string): void {
  db.delete(appsRegistry).where(eq(appsRegistry.id, id)).run();
  db.delete(appRatings).where(eq(appRatings.appId, id)).run();
  db.delete(appInstalls).where(eq(appInstalls.appId, id)).run();
}

// --- Listing ---

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

export function listApps(db: PlatformDB, options: ListAppsOptions): ListAppsResult {
  const { category, authorId, publicOnly, sort = 'new', limit = 50, offset = 0 } = options;

  const conditions = [];
  if (publicOnly) conditions.push(eq(appsRegistry.isPublic, true));
  if (category) conditions.push(eq(appsRegistry.category, category));
  if (authorId) conditions.push(eq(appsRegistry.authorId, authorId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(appsRegistry)
    .where(where)
    .get();
  const total = countResult?.count ?? 0;

  const orderBy =
    sort === 'popular'
      ? desc(appsRegistry.installs)
      : sort === 'rated'
        ? desc(appsRegistry.rating)
        : desc(appsRegistry.createdAt);

  const apps = db
    .select()
    .from(appsRegistry)
    .where(where)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset)
    .all();

  return {
    apps,
    total,
    hasMore: offset + apps.length < total,
  };
}

// --- Search ---

export function searchApps(db: PlatformDB, query: string): AppRegistryRecord[] {
  const pattern = `%${query}%`;
  return db
    .select()
    .from(appsRegistry)
    .where(
      and(
        eq(appsRegistry.isPublic, true),
        or(
          like(appsRegistry.name, pattern),
          like(appsRegistry.description, pattern),
          like(appsRegistry.tags, pattern),
        ),
      ),
    )
    .all();
}

// --- Installs ---

export function incrementInstalls(db: PlatformDB, appId: string): void {
  db.update(appsRegistry)
    .set({
      installs: sql`${appsRegistry.installs} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(appsRegistry.id, appId))
    .run();
}

export function recordInstall(db: PlatformDB, appId: string, userId: string): void {
  const existing = db
    .select()
    .from(appInstalls)
    .where(and(eq(appInstalls.appId, appId), eq(appInstalls.userId, userId)))
    .get();

  if (existing) return;

  db.insert(appInstalls)
    .values({ appId, userId, installedAt: new Date().toISOString() })
    .run();

  incrementInstalls(db, appId);
}

// --- Ratings ---

export function submitRating(
  db: PlatformDB,
  input: { appId: string; userId: string; rating: number; review?: string },
): void {
  const { appId, userId, rating, review } = input;
  const now = new Date().toISOString();

  const existing = db
    .select()
    .from(appRatings)
    .where(and(eq(appRatings.appId, appId), eq(appRatings.userId, userId)))
    .get();

  if (existing) {
    db.update(appRatings)
      .set({ rating, review, createdAt: now })
      .where(and(eq(appRatings.appId, appId), eq(appRatings.userId, userId)))
      .run();
  } else {
    db.insert(appRatings)
      .values({ appId, userId, rating, review, createdAt: now })
      .run();
  }

  recalculateRating(db, appId);
}

function recalculateRating(db: PlatformDB, appId: string): void {
  const result = db
    .select({
      avg: sql<number>`CAST(ROUND(AVG(${appRatings.rating})) AS INTEGER)`,
      count: sql<number>`count(*)`,
    })
    .from(appRatings)
    .where(eq(appRatings.appId, appId))
    .get();

  db.update(appsRegistry)
    .set({
      rating: result?.avg ?? 0,
      ratingsCount: result?.count ?? 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(appsRegistry.id, appId))
    .run();
}

export function getAppRating(
  db: PlatformDB,
  appId: string,
  userId: string,
): AppRatingRecord | undefined {
  return db
    .select()
    .from(appRatings)
    .where(and(eq(appRatings.appId, appId), eq(appRatings.userId, userId)))
    .get();
}

export function listAppRatings(db: PlatformDB, appId: string): AppRatingRecord[] {
  return db
    .select()
    .from(appRatings)
    .where(eq(appRatings.appId, appId))
    .orderBy(desc(appRatings.createdAt))
    .all();
}

// --- Categories ---

export function listCategories(db: PlatformDB): Array<{ category: string; count: number }> {
  return db
    .select({
      category: appsRegistry.category,
      count: sql<number>`count(*)`,
    })
    .from(appsRegistry)
    .where(eq(appsRegistry.isPublic, true))
    .groupBy(appsRegistry.category)
    .all() as Array<{ category: string; count: number }>;
}
