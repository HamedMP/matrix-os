import { sql, type Kysely } from 'kysely';
import type { GalleryDatabase } from './types.js';

interface ListPublicOptions {
  category?: string;
  sort?: 'popular' | 'rated' | 'new';
  limit?: number;
  offset?: number;
}

interface ListPublicResult {
  apps: Array<{
    id: string;
    slug: string;
    name: string;
    author_id: string;
    description: string | null;
    category: string;
    icon_url: string | null;
    avg_rating: string;
    ratings_count: number;
    installs_count: number;
    price: number;
    tags: string[];
    created_at: Date;
  }>;
  total: number;
  hasMore: boolean;
}

export async function listPublic(
  db: Kysely<GalleryDatabase>,
  options: ListPublicOptions,
): Promise<ListPublicResult> {
  const { category, sort = 'new', limit = 50, offset = 0 } = options;

  let query = db.selectFrom('app_listings')
    .selectAll()
    .where('visibility', '=', 'public')
    .where('status', '=', 'active');

  let countQuery = db.selectFrom('app_listings')
    .select(sql<number>`count(*)`.as('count'))
    .where('visibility', '=', 'public')
    .where('status', '=', 'active');

  if (category) {
    query = query.where('category', '=', category);
    countQuery = countQuery.where('category', '=', category);
  }

  if (sort === 'popular') {
    query = query.orderBy('installs_count', 'desc');
  } else if (sort === 'rated') {
    query = query.orderBy('avg_rating', 'desc');
  } else {
    query = query.orderBy('created_at', 'desc');
  }

  const [apps, countResult] = await Promise.all([
    query.limit(limit).offset(offset).execute(),
    countQuery.executeTakeFirst(),
  ]);

  const total = Number(countResult?.count ?? 0);

  return {
    apps,
    total,
    hasMore: offset + apps.length < total,
  };
}

interface SearchOptions {
  category?: string;
  limit?: number;
}

interface SearchResult {
  results: Array<{
    id: string;
    slug: string;
    name: string;
    author_id: string;
    description: string | null;
    category: string;
    icon_url: string | null;
    avg_rating: string;
    ratings_count: number;
    installs_count: number;
    price: number;
    tags: string[];
  }>;
  total: number;
}

export async function search(
  db: Kysely<GalleryDatabase>,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const { category, limit = 20 } = options;

  let q = db.selectFrom('app_listings')
    .selectAll()
    .where('visibility', '=', 'public')
    .where('status', '=', 'active')
    .where(sql`search_vector @@ plainto_tsquery('english', ${query})`);

  if (category) {
    q = q.where('category', '=', category);
  }

  q = q.orderBy(sql`ts_rank(search_vector, plainto_tsquery('english', ${query}))`, 'desc')
    .limit(limit);

  const results = await q.execute();

  return {
    results,
    total: results.length,
  };
}

export async function getByAuthorSlug(
  db: Kysely<GalleryDatabase>,
  authorId: string,
  slug: string,
): Promise<{
  id: string;
  slug: string;
  name: string;
  author_id: string;
  description: string | null;
  long_description: string | null;
  category: string;
  icon_url: string | null;
  screenshots: string[];
  avg_rating: string;
  ratings_count: number;
  installs_count: number;
  price: number;
  tags: string[];
  visibility: string;
  manifest: unknown;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
} | null> {
  const listing = await db.selectFrom('app_listings')
    .selectAll()
    .where('author_id', '=', authorId)
    .where('slug', '=', slug)
    .where('status', '!=', 'delisted')
    .where('status', '!=', 'suspended')
    .executeTakeFirst();

  return listing ?? null;
}

export async function listCategories(
  db: Kysely<GalleryDatabase>,
): Promise<Array<{ category: string; count: number }>> {
  const rows = await db.selectFrom('app_listings')
    .select(['category'])
    .select(sql<number>`count(*)`.as('count'))
    .where('visibility', '=', 'public')
    .where('status', '=', 'active')
    .groupBy('category')
    .execute();

  return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
}

interface CreateListingInput {
  slug: string;
  name: string;
  author_id: string;
  description?: string;
  long_description?: string;
  category: string;
  tags?: string[];
  icon_url?: string;
  screenshots?: string[];
  visibility: string;
  org_id?: string;
  manifest?: unknown;
}

export async function createListing(
  db: Kysely<GalleryDatabase>,
  input: CreateListingInput,
) {
  return db.insertInto('app_listings')
    .values({
      slug: input.slug,
      name: input.name,
      author_id: input.author_id,
      description: input.description ?? null,
      long_description: input.long_description ?? null,
      category: input.category,
      tags: input.tags ?? [],
      icon_url: input.icon_url ?? null,
      screenshots: input.screenshots ?? [],
      visibility: input.visibility,
      org_id: input.org_id ?? null,
      manifest: input.manifest ? JSON.stringify(input.manifest) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

interface UpdateListingInput {
  name?: string;
  description?: string;
  long_description?: string;
  category?: string;
  tags?: string[];
  icon_url?: string;
  screenshots?: string[];
  visibility?: string;
  manifest?: unknown;
  status?: string;
}

export async function updateListing(
  db: Kysely<GalleryDatabase>,
  id: string,
  input: UpdateListingInput,
) {
  const values: Record<string, unknown> = { updated_at: new Date() };

  if (input.name !== undefined) values.name = input.name;
  if (input.description !== undefined) values.description = input.description;
  if (input.long_description !== undefined) values.long_description = input.long_description;
  if (input.category !== undefined) values.category = input.category;
  if (input.tags !== undefined) values.tags = input.tags;
  if (input.icon_url !== undefined) values.icon_url = input.icon_url;
  if (input.screenshots !== undefined) values.screenshots = input.screenshots;
  if (input.visibility !== undefined) values.visibility = input.visibility;
  if (input.manifest !== undefined) values.manifest = JSON.stringify(input.manifest);
  if (input.status !== undefined) values.status = input.status;

  return db.updateTable('app_listings')
    .set(values)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

interface PublishInput {
  slug: string;
  name: string;
  author_id: string;
  description?: string;
  long_description?: string;
  category: string;
  tags?: string[];
  icon_url?: string;
  screenshots?: string[];
  visibility: string;
  org_id?: string;
  manifest?: unknown;
}

export async function createOrUpdateFromPublish(
  db: Kysely<GalleryDatabase>,
  input: PublishInput,
) {
  const existing = await db.selectFrom('app_listings')
    .selectAll()
    .where('slug', '=', input.slug)
    .executeTakeFirst();

  if (existing) {
    // Prevent overwriting another author's listing
    if (existing.author_id !== input.author_id) {
      throw new Error(`Slug "${input.slug}" is already taken by another author`);
    }

    return db.updateTable('app_listings')
      .set({
        name: input.name,
        description: input.description ?? existing.description,
        long_description: input.long_description ?? existing.long_description,
        category: input.category,
        tags: input.tags ?? existing.tags,
        icon_url: input.icon_url ?? existing.icon_url,
        screenshots: input.screenshots ?? existing.screenshots,
        visibility: input.visibility,
        manifest: input.manifest ? JSON.stringify(input.manifest) : existing.manifest,
        updated_at: new Date(),
      })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  return createListing(db, input);
}
