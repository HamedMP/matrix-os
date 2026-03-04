import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql, inArray, lt, gt } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { PlatformDB } from './db.js';

// --- Schema ---

export const posts = sqliteTable(
  'social_posts',
  {
    id: text('id').primaryKey(),
    authorId: text('author_id').notNull(),
    content: text('content').notNull(),
    type: text('type').notNull(), // text | image | link | app_share | activity
    mediaUrls: text('media_urls'),
    appRef: text('app_ref'),
    likesCount: integer('likes_count').default(0).notNull(),
    commentsCount: integer('comments_count').default(0).notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_posts_author').on(table.authorId),
    index('idx_posts_type').on(table.type),
    index('idx_posts_created').on(table.createdAt),
    index('idx_posts_likes').on(table.likesCount),
  ],
);

export const comments = sqliteTable(
  'social_comments',
  {
    id: text('id').primaryKey(),
    postId: text('post_id').notNull(),
    authorId: text('author_id').notNull(),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_comments_post').on(table.postId),
  ],
);

export const likes = sqliteTable(
  'social_likes',
  {
    postId: text('post_id').notNull(),
    userId: text('user_id').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_likes_post_user').on(table.postId, table.userId),
  ],
);

export const follows = sqliteTable(
  'social_follows',
  {
    followerId: text('follower_id').notNull(),
    followingId: text('following_id').notNull(),
    followingType: text('following_type').notNull(), // user | ai
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_follows_pair').on(table.followerId, table.followingId),
    index('idx_follows_follower').on(table.followerId),
    index('idx_follows_following').on(table.followingId),
  ],
);

// --- Types ---

export type PostRecord = typeof posts.$inferSelect;
export type CommentRecord = typeof comments.$inferSelect;
export type FollowRecord = typeof follows.$inferSelect;

// --- Migration ---

export function runSocialFeedMigrations(sqlite: { prepare(sql: string): { run(): unknown } }): void {
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      media_urls TEXT,
      app_ref TEXT,
      likes_count INTEGER NOT NULL DEFAULT 0,
      comments_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_posts_author ON social_posts(author_id)').run();
  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_posts_type ON social_posts(type)').run();
  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_posts_created ON social_posts(created_at)').run();
  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_posts_likes ON social_posts(likes_count)').run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS social_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_comments_post ON social_comments(post_id)').run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS social_likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_post_user ON social_likes(post_id, user_id)'
  ).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS social_follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      following_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_pair ON social_follows(follower_id, following_id)'
  ).run();
  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_follows_follower ON social_follows(follower_id)'
  ).run();
  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_follows_following ON social_follows(following_id)'
  ).run();
}

// --- Posts CRUD ---

let postSeq = 0;

function makePostId(): string {
  const ts = Date.now().toString(36);
  const seq = (postSeq++).toString(36).padStart(4, '0');
  const rand = randomUUID().slice(0, 6);
  return `p_${ts}_${seq}_${rand}`;
}

export function insertPost(
  db: PlatformDB,
  input: { authorId: string; content: string; type: string; mediaUrls?: string; appRef?: string },
): string {
  const id = makePostId();
  const now = new Date().toISOString();
  db.insert(posts).values({
    id,
    authorId: input.authorId,
    content: input.content,
    type: input.type,
    mediaUrls: input.mediaUrls,
    appRef: input.appRef,
    likesCount: 0,
    commentsCount: 0,
    createdAt: now,
  }).run();
  return id;
}

export function getPost(db: PlatformDB, id: string): PostRecord | null {
  return db.select().from(posts).where(eq(posts.id, id)).get() ?? null;
}

export function deletePost(db: PlatformDB, id: string): boolean {
  const existing = getPost(db, id);
  if (!existing) return false;

  db.delete(likes).where(eq(likes.postId, id)).run();
  db.delete(comments).where(eq(comments.postId, id)).run();
  db.delete(posts).where(eq(posts.id, id)).run();
  return true;
}

// --- Feed ---

interface FeedOptions {
  authorIds: string[];
  limit?: number;
  cursor?: string; // post id for cursor-based pagination
}

interface FeedResult {
  posts: PostRecord[];
  hasMore: boolean;
  cursor?: string;
}

export function listFeed(db: PlatformDB, options: FeedOptions): FeedResult {
  const { authorIds, limit = 20, cursor } = options;

  if (authorIds.length === 0) {
    return { posts: [], hasMore: false };
  }

  const conditions = [inArray(posts.authorId, authorIds)];
  if (cursor) {
    conditions.push(lt(posts.id, cursor));
  }

  const result = db
    .select()
    .from(posts)
    .where(and(...conditions))
    .orderBy(desc(posts.id))
    .limit(limit + 1)
    .all();

  const hasMore = result.length > limit;
  const page = hasMore ? result.slice(0, limit) : result;

  return {
    posts: page,
    hasMore,
    cursor: page.length > 0 ? page[page.length - 1].id : undefined,
  };
}

export function listTrendingPosts(db: PlatformDB, limit: number = 20): PostRecord[] {
  return db
    .select()
    .from(posts)
    .orderBy(desc(posts.likesCount), desc(posts.createdAt))
    .limit(limit)
    .all();
}

// --- Likes ---

export function likePost(db: PlatformDB, postId: string, userId: string): void {
  const existing = db
    .select()
    .from(likes)
    .where(and(eq(likes.postId, postId), eq(likes.userId, userId)))
    .get();

  if (existing) return;

  db.insert(likes).values({
    postId,
    userId,
    createdAt: new Date().toISOString(),
  }).run();

  db.update(posts)
    .set({ likesCount: sql`${posts.likesCount} + 1` })
    .where(eq(posts.id, postId))
    .run();
}

export function unlikePost(db: PlatformDB, postId: string, userId: string): void {
  const existing = db
    .select()
    .from(likes)
    .where(and(eq(likes.postId, postId), eq(likes.userId, userId)))
    .get();

  if (!existing) return;

  db.delete(likes)
    .where(and(eq(likes.postId, postId), eq(likes.userId, userId)))
    .run();

  db.update(posts)
    .set({ likesCount: sql`MAX(${posts.likesCount} - 1, 0)` })
    .where(eq(posts.id, postId))
    .run();
}

export function getLikeCount(db: PlatformDB, postId: string): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(likes)
    .where(eq(likes.postId, postId))
    .get();
  return result?.count ?? 0;
}

export function isLikedBy(db: PlatformDB, postId: string, userId: string): boolean {
  const result = db
    .select()
    .from(likes)
    .where(and(eq(likes.postId, postId), eq(likes.userId, userId)))
    .get();
  return !!result;
}

// --- Comments ---

export function addComment(
  db: PlatformDB,
  input: { postId: string; authorId: string; content: string },
): string {
  const id = `comment_${randomUUID().slice(0, 12)}`;
  db.insert(comments).values({
    id,
    postId: input.postId,
    authorId: input.authorId,
    content: input.content,
    createdAt: new Date().toISOString(),
  }).run();

  db.update(posts)
    .set({ commentsCount: sql`${posts.commentsCount} + 1` })
    .where(eq(posts.id, input.postId))
    .run();

  return id;
}

export function listComments(db: PlatformDB, postId: string): CommentRecord[] {
  return db
    .select()
    .from(comments)
    .where(eq(comments.postId, postId))
    .orderBy(comments.createdAt)
    .all();
}

// --- Follows ---

export function followUser(
  db: PlatformDB,
  followerId: string,
  followingId: string,
  followingType: 'user' | 'ai',
): void {
  const existing = db
    .select()
    .from(follows)
    .where(and(eq(follows.followerId, followerId), eq(follows.followingId, followingId)))
    .get();

  if (existing) return;

  db.insert(follows).values({
    followerId,
    followingId,
    followingType,
    createdAt: new Date().toISOString(),
  }).run();
}

export function unfollowUser(db: PlatformDB, followerId: string, followingId: string): void {
  db.delete(follows)
    .where(and(eq(follows.followerId, followerId), eq(follows.followingId, followingId)))
    .run();
}

export function isFollowing(db: PlatformDB, followerId: string, followingId: string): boolean {
  const result = db
    .select()
    .from(follows)
    .where(and(eq(follows.followerId, followerId), eq(follows.followingId, followingId)))
    .get();
  return !!result;
}

export function getFollowers(db: PlatformDB, handle: string): FollowRecord[] {
  return db
    .select()
    .from(follows)
    .where(eq(follows.followingId, handle))
    .orderBy(desc(follows.createdAt))
    .all();
}

export function getFollowing(db: PlatformDB, handle: string): FollowRecord[] {
  return db
    .select()
    .from(follows)
    .where(eq(follows.followerId, handle))
    .orderBy(desc(follows.createdAt))
    .all();
}

export function getFollowCounts(
  db: PlatformDB,
  handle: string,
): { followers: number; following: number } {
  const followersResult = db
    .select({ count: sql<number>`count(*)` })
    .from(follows)
    .where(eq(follows.followingId, handle))
    .get();

  const followingResult = db
    .select({ count: sql<number>`count(*)` })
    .from(follows)
    .where(eq(follows.followerId, handle))
    .get();

  return {
    followers: followersResult?.count ?? 0,
    following: followingResult?.count ?? 0,
  };
}

export function getFollowingIds(db: PlatformDB, handle: string): string[] {
  return db
    .select({ followingId: follows.followingId })
    .from(follows)
    .where(eq(follows.followerId, handle))
    .all()
    .map((r) => r.followingId);
}

export function searchUsers(_db: PlatformDB, _query: string): unknown[] {
  return [];
}
