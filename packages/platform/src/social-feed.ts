import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { PlatformDB } from './db.js';

export interface PostRecord {
  id: string;
  authorId: string;
  content: string;
  type: string;
  mediaUrls: string | null;
  appRef: string | null;
  likesCount: number;
  commentsCount: number;
  createdAt: string;
}

export interface CommentRecord {
  id: string;
  postId: string;
  authorId: string;
  content: string;
  createdAt: string;
}

export interface FollowRecord {
  followerId: string;
  followingId: string;
  followingType: string;
  createdAt: string;
}

function mapPost(row: {
  id: string;
  author_id: string;
  content: string;
  type: string;
  media_urls: string | null;
  app_ref: string | null;
  likes_count: number;
  comments_count: number;
  created_at: string;
}): PostRecord {
  return {
    id: row.id,
    authorId: row.author_id,
    content: row.content,
    type: row.type,
    mediaUrls: row.media_urls,
    appRef: row.app_ref,
    likesCount: row.likes_count,
    commentsCount: row.comments_count,
    createdAt: row.created_at,
  };
}

function mapComment(row: {
  id: string;
  post_id: string;
  author_id: string;
  content: string;
  created_at: string;
}): CommentRecord {
  return {
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    content: row.content,
    createdAt: row.created_at,
  };
}

function mapFollow(row: {
  follower_id: string;
  following_id: string;
  following_type: string;
  created_at: string;
}): FollowRecord {
  return {
    followerId: row.follower_id,
    followingId: row.following_id,
    followingType: row.following_type,
    createdAt: row.created_at,
  };
}

let postSeq = 0;

function makePostId(): string {
  const ts = Date.now().toString(36);
  const seq = (postSeq++).toString(36).padStart(4, '0');
  const rand = randomUUID().slice(0, 6);
  return `p_${ts}_${seq}_${rand}`;
}

export async function insertPost(
  db: PlatformDB,
  input: { authorId: string; content: string; type: string; mediaUrls?: string; appRef?: string },
): Promise<string> {
  await db.ready;
  const id = makePostId();
  await db.executor.insertInto('social_posts').values({
    id,
    author_id: input.authorId,
    content: input.content,
    type: input.type,
    media_urls: input.mediaUrls ?? null,
    app_ref: input.appRef ?? null,
    likes_count: 0,
    comments_count: 0,
    created_at: new Date().toISOString(),
  }).execute();
  return id;
}

export async function getPost(db: PlatformDB, id: string): Promise<PostRecord | null> {
  await db.ready;
  const row = await db.executor.selectFrom('social_posts').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? mapPost(row) : null;
}

export async function deletePost(db: PlatformDB, id: string): Promise<boolean> {
  return db.transaction(async (trx) => {
    const existing = await getPost(trx, id);
    if (!existing) return false;
    await trx.executor.deleteFrom('social_likes').where('post_id', '=', id).execute();
    await trx.executor.deleteFrom('social_comments').where('post_id', '=', id).execute();
    await trx.executor.deleteFrom('social_posts').where('id', '=', id).execute();
    return true;
  });
}

interface FeedOptions {
  authorIds: string[];
  limit?: number;
  cursor?: string;
}

interface FeedResult {
  posts: PostRecord[];
  hasMore: boolean;
  cursor?: string;
}

export async function listFeed(db: PlatformDB, options: FeedOptions): Promise<FeedResult> {
  await db.ready;
  const { authorIds, limit = 20, cursor } = options;
  if (authorIds.length === 0) {
    return { posts: [], hasMore: false };
  }

  let query = db.executor
    .selectFrom('social_posts')
    .selectAll()
    .where('author_id', 'in', authorIds);
  if (cursor) query = query.where('id', '<', cursor);

  const result = await query.orderBy('id', 'desc').limit(limit + 1).execute();
  const hasMore = result.length > limit;
  const page = hasMore ? result.slice(0, limit) : result;
  const posts = page.map(mapPost);
  return {
    posts,
    hasMore,
    cursor: posts.length > 0 ? posts[posts.length - 1].id : undefined,
  };
}

export async function listTrendingPosts(db: PlatformDB, limit: number = 20): Promise<PostRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('social_posts')
    .selectAll()
    .orderBy('likes_count', 'desc')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map(mapPost);
}

export async function likePost(db: PlatformDB, postId: string, userId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const inserted = await trx.executor
      .insertInto('social_likes')
      .values({ post_id: postId, user_id: userId, created_at: new Date().toISOString() })
      .onConflict((oc) => oc.columns(['post_id', 'user_id']).doNothing())
      .returning('post_id')
      .executeTakeFirst();
    if (!inserted) return;
    await trx.executor
      .updateTable('social_posts')
      .set({ likes_count: sql<number>`likes_count + 1` })
      .where('id', '=', postId)
      .execute();
  });
}

export async function unlikePost(db: PlatformDB, postId: string, userId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const deleted = await trx.executor
      .deleteFrom('social_likes')
      .where('post_id', '=', postId)
      .where('user_id', '=', userId)
      .returning('post_id')
      .executeTakeFirst();
    if (!deleted) return;
    await trx.executor
      .updateTable('social_posts')
      .set({ likes_count: sql<number>`GREATEST(likes_count - 1, 0)` })
      .where('id', '=', postId)
      .execute();
  });
}

export async function getLikeCount(db: PlatformDB, postId: string): Promise<number> {
  await db.ready;
  const result = await db.executor
    .selectFrom('social_likes')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('post_id', '=', postId)
    .executeTakeFirst();
  return Number(result?.count ?? 0);
}

export async function isLikedBy(db: PlatformDB, postId: string, userId: string): Promise<boolean> {
  await db.ready;
  const result = await db.executor
    .selectFrom('social_likes')
    .select('post_id')
    .where('post_id', '=', postId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return !!result;
}

export async function addComment(
  db: PlatformDB,
  input: { postId: string; authorId: string; content: string },
): Promise<string> {
  const id = `comment_${randomUUID().slice(0, 12)}`;
  await db.transaction(async (trx) => {
    await trx.executor.insertInto('social_comments').values({
      id,
      post_id: input.postId,
      author_id: input.authorId,
      content: input.content,
      created_at: new Date().toISOString(),
    }).execute();
    await trx.executor
      .updateTable('social_posts')
      .set({ comments_count: sql<number>`comments_count + 1` })
      .where('id', '=', input.postId)
      .execute();
  });
  return id;
}

export async function listComments(db: PlatformDB, postId: string): Promise<CommentRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('social_comments')
    .selectAll()
    .where('post_id', '=', postId)
    .orderBy('created_at')
    .execute();
  return rows.map(mapComment);
}

export async function followUser(
  db: PlatformDB,
  followerId: string,
  followingId: string,
  followingType: 'user' | 'ai',
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('social_follows')
    .values({
      follower_id: followerId,
      following_id: followingId,
      following_type: followingType,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.columns(['follower_id', 'following_id']).doNothing())
    .execute();
}

export async function unfollowUser(db: PlatformDB, followerId: string, followingId: string): Promise<void> {
  await db.ready;
  await db.executor
    .deleteFrom('social_follows')
    .where('follower_id', '=', followerId)
    .where('following_id', '=', followingId)
    .execute();
}

export async function isFollowing(db: PlatformDB, followerId: string, followingId: string): Promise<boolean> {
  await db.ready;
  const result = await db.executor
    .selectFrom('social_follows')
    .select('follower_id')
    .where('follower_id', '=', followerId)
    .where('following_id', '=', followingId)
    .executeTakeFirst();
  return !!result;
}

export async function getFollowers(db: PlatformDB, handle: string): Promise<FollowRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('social_follows')
    .selectAll()
    .where('following_id', '=', handle)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(mapFollow);
}

export async function getFollowing(db: PlatformDB, handle: string): Promise<FollowRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('social_follows')
    .selectAll()
    .where('follower_id', '=', handle)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(mapFollow);
}

export async function getFollowCounts(
  db: PlatformDB,
  handle: string,
): Promise<{ followers: number; following: number }> {
  await db.ready;
  const [followersResult, followingResult] = await Promise.all([
    db.executor
      .selectFrom('social_follows')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('following_id', '=', handle)
      .executeTakeFirst(),
    db.executor
      .selectFrom('social_follows')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('follower_id', '=', handle)
      .executeTakeFirst(),
  ]);

  return {
    followers: Number(followersResult?.count ?? 0),
    following: Number(followingResult?.count ?? 0),
  };
}

export async function getFollowingIds(db: PlatformDB, handle: string): Promise<string[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('social_follows')
    .select('following_id')
    .where('follower_id', '=', handle)
    .execute();
  return rows.map((r) => r.following_id);
}

export async function searchUsers(_db: PlatformDB, _query: string): Promise<unknown[]> {
  return [];
}
