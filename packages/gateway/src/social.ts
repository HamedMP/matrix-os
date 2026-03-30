import { Hono } from "hono";
import type { AppDb } from "./app-db.js";
import type { QueryEngine, FindOptions } from "./app-db-query.js";

// --- Types ---

export interface SocialPost {
  id: string;
  author_id: string;
  content: string;
  type: string;
  media_urls: string | null;
  app_ref: string | null;
  parent_id: string | null;
  likes_count: number;
  comments_count: number;
  created_at: string;
  updated_at: string;
}

export interface SocialLike {
  id: string;
  post_id: string;
  user_id: string;
  created_at: string;
}

export interface SocialFollow {
  id: string;
  follower_id: string;
  followee_id: string;
  created_at: string;
}

// --- Constants ---

const SCHEMA = "social";
const VALID_POST_TYPES = ["text", "image", "link", "app_share", "activity"];

// --- Posts CRUD ---

export async function insertPost(
  engine: QueryEngine,
  input: {
    authorId: string;
    content: string;
    type?: string;
    parentId?: string;
    mediaUrls?: string;
    appRef?: string;
  },
): Promise<string> {
  const { id } = await engine.insert(SCHEMA, "posts", {
    author_id: input.authorId,
    content: input.content,
    type: input.type ?? "text",
    parent_id: input.parentId ?? null,
    media_urls: input.mediaUrls ?? null,
    app_ref: input.appRef ?? null,
    likes_count: 0,
    comments_count: 0,
  });
  return id;
}

export async function getPost(
  engine: QueryEngine,
  id: string,
): Promise<SocialPost | null> {
  try {
    const row = await engine.findOne(SCHEMA, "posts", id);
    return row as SocialPost | null;
  } catch {
    return null;
  }
}

export async function deletePost(
  db: AppDb,
  engine: QueryEngine,
  id: string,
): Promise<boolean> {
  const post = await getPost(engine, id);
  if (!post) return false;
  // Delete likes on the post itself
  await db.raw(
    `DELETE FROM "${SCHEMA}"."likes" WHERE post_id = $1::text`,
    [id],
  );
  // Delete likes on child comments
  await db.raw(
    `DELETE FROM "${SCHEMA}"."likes" WHERE post_id IN (SELECT id::text FROM "${SCHEMA}"."posts" WHERE parent_id = $1::text)`,
    [id],
  );
  // Delete child comments
  await db.raw(
    `DELETE FROM "${SCHEMA}"."posts" WHERE parent_id = $1::text`,
    [id],
  );
  await engine.delete(SCHEMA, "posts", id);
  return true;
}

export async function listPosts(
  engine: QueryEngine,
  opts?: { authorId?: string; type?: string; limit?: number; offset?: number },
): Promise<SocialPost[]> {
  const filter: Record<string, unknown> = { parent_id: null };
  if (opts?.authorId) filter.author_id = opts.authorId;
  if (opts?.type) filter.type = opts.type;

  const rows = await engine.find(SCHEMA, "posts", {
    filter,
    orderBy: { created_at: "desc" },
    limit: opts?.limit ?? 20,
    offset: opts?.offset ?? 0,
  });
  return rows as SocialPost[];
}

// --- Feed ---

export interface FeedResult {
  posts: SocialPost[];
  hasMore: boolean;
  cursor?: string;
}

export async function listFeed(
  db: AppDb,
  opts: { authorIds: string[]; limit?: number; cursor?: string },
): Promise<FeedResult> {
  const { authorIds, limit = 20, cursor } = opts;
  if (authorIds.length === 0) return { posts: [], hasMore: false };

  const placeholders = authorIds.map((_, i) => `$${i + 1}`).join(", ");
  let q = `SELECT * FROM "${SCHEMA}"."posts" WHERE author_id IN (${placeholders}) AND parent_id IS NULL`;
  const params: unknown[] = [...authorIds];

  if (cursor) {
    const cursorResult = await db.raw(
      `SELECT created_at, id FROM "${SCHEMA}"."posts" WHERE id = $1`,
      [cursor],
    );
    if (cursorResult.rows.length > 0) {
      const cursorTs = cursorResult.rows[0].created_at;
      const cursorId = cursorResult.rows[0].id;
      params.push(cursorTs);
      const tsIdx = params.length;
      params.push(cursorTs);
      const tsIdx2 = params.length;
      params.push(cursorId);
      const idIdx = params.length;
      q += ` AND (created_at < $${tsIdx} OR (created_at = $${tsIdx2} AND id < $${idIdx}))`;
    }
  }

  params.push(limit + 1);
  q += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

  const result = await db.raw(q, params);
  const rows = result.rows as SocialPost[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    posts: page,
    hasMore,
    cursor: page.length > 0 ? String(page[page.length - 1].id) : undefined,
  };
}

export async function listTrendingPosts(
  engine: QueryEngine,
  limit = 20,
): Promise<SocialPost[]> {
  const rows = await engine.find(SCHEMA, "posts", {
    filter: { parent_id: null },
    orderBy: { likes_count: "desc" },
    limit,
  });
  return rows as SocialPost[];
}

// --- Likes ---

export async function likePost(
  db: AppDb,
  engine: QueryEngine,
  postId: string,
  userId: string,
): Promise<boolean> {
  const existing = await engine.find(SCHEMA, "likes", {
    filter: { post_id: postId, user_id: userId },
    limit: 1,
  });
  if (existing.length > 0) return false;

  await engine.insert(SCHEMA, "likes", {
    post_id: postId,
    user_id: userId,
  });
  await db.raw(
    `UPDATE "${SCHEMA}"."posts" SET likes_count = likes_count + 1, updated_at = now() WHERE id = $1`,
    [postId],
  );
  return true;
}

export async function unlikePost(
  db: AppDb,
  engine: QueryEngine,
  postId: string,
  userId: string,
): Promise<boolean> {
  const existing = await engine.find(SCHEMA, "likes", {
    filter: { post_id: postId, user_id: userId },
    limit: 1,
  });
  if (existing.length === 0) return false;

  const likeId = (existing[0] as SocialLike).id;
  await engine.delete(SCHEMA, "likes", likeId);
  await db.raw(
    `UPDATE "${SCHEMA}"."posts" SET likes_count = GREATEST(likes_count - 1, 0), updated_at = now() WHERE id = $1`,
    [postId],
  );
  return true;
}

export async function isLikedBy(
  engine: QueryEngine,
  postId: string,
  userId: string,
): Promise<boolean> {
  const rows = await engine.find(SCHEMA, "likes", {
    filter: { post_id: postId, user_id: userId },
    limit: 1,
  });
  return rows.length > 0;
}

export async function getLikers(
  engine: QueryEngine,
  postId: string,
): Promise<string[]> {
  const rows = await engine.find(SCHEMA, "likes", {
    filter: { post_id: postId },
  });
  return rows.map((r) => r.user_id as string);
}

// --- Comments (posts with parent_id) ---

export async function addComment(
  db: AppDb,
  engine: QueryEngine,
  input: { postId: string; authorId: string; content: string },
): Promise<string> {
  const id = await insertPost(engine, {
    authorId: input.authorId,
    content: input.content,
    type: "text",
    parentId: input.postId,
  });
  await db.raw(
    `UPDATE "${SCHEMA}"."posts" SET comments_count = comments_count + 1, updated_at = now() WHERE id = $1`,
    [input.postId],
  );
  return id;
}

export async function listComments(
  engine: QueryEngine,
  postId: string,
): Promise<SocialPost[]> {
  const rows = await engine.find(SCHEMA, "posts", {
    filter: { parent_id: postId },
    orderBy: { created_at: "asc" },
  });
  return rows as SocialPost[];
}

// --- Follows ---

export async function followUser(
  engine: QueryEngine,
  followerId: string,
  followeeId: string,
): Promise<boolean> {
  const existing = await engine.find(SCHEMA, "follows", {
    filter: { follower_id: followerId, followee_id: followeeId },
    limit: 1,
  });
  if (existing.length > 0) return false;

  await engine.insert(SCHEMA, "follows", {
    follower_id: followerId,
    followee_id: followeeId,
  });
  return true;
}

export async function unfollowUser(
  engine: QueryEngine,
  followerId: string,
  followeeId: string,
): Promise<boolean> {
  const existing = await engine.find(SCHEMA, "follows", {
    filter: { follower_id: followerId, followee_id: followeeId },
    limit: 1,
  });
  if (existing.length === 0) return false;

  const followId = (existing[0] as SocialFollow).id;
  await engine.delete(SCHEMA, "follows", followId);
  return true;
}

export async function getFollowers(
  engine: QueryEngine,
  handle: string,
): Promise<SocialFollow[]> {
  const rows = await engine.find(SCHEMA, "follows", {
    filter: { followee_id: handle },
    orderBy: { created_at: "desc" },
  });
  return rows as SocialFollow[];
}

export async function getFollowing(
  engine: QueryEngine,
  handle: string,
): Promise<SocialFollow[]> {
  const rows = await engine.find(SCHEMA, "follows", {
    filter: { follower_id: handle },
    orderBy: { created_at: "desc" },
  });
  return rows as SocialFollow[];
}

export async function getFollowCounts(
  engine: QueryEngine,
  handle: string,
): Promise<{ followers: number; following: number }> {
  const followers = await engine.count(SCHEMA, "follows", { followee_id: handle });
  const following = await engine.count(SCHEMA, "follows", { follower_id: handle });
  return { followers, following };
}

export async function getFollowingIds(
  engine: QueryEngine,
  handle: string,
): Promise<string[]> {
  const rows = await engine.find(SCHEMA, "follows", {
    filter: { follower_id: handle },
  });
  return rows.map((r) => r.followee_id as string);
}

export async function isFollowing(
  engine: QueryEngine,
  followerId: string,
  followeeId: string,
): Promise<boolean> {
  const rows = await engine.find(SCHEMA, "follows", {
    filter: { follower_id: followerId, followee_id: followeeId },
    limit: 1,
  });
  return rows.length > 0;
}

// --- User stats ---

export async function getUserStats(
  engine: QueryEngine,
  handle: string,
): Promise<{ postCount: number; followers: number; following: number }> {
  const postCount = await engine.count(SCHEMA, "posts", {
    author_id: handle,
    parent_id: null,
  });
  const counts = await getFollowCounts(engine, handle);
  return { postCount, ...counts };
}

// --- API response mapping (snake_case DB -> camelCase frontend) ---

export function toPostResponse(p: SocialPost & { liked?: boolean }) {
  return {
    id: p.id,
    authorId: p.author_id,
    content: p.content,
    type: p.type,
    mediaUrls: p.media_urls,
    appRef: p.app_ref,
    parentId: p.parent_id,
    likesCount: p.likes_count,
    commentsCount: p.comments_count,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    ...(p.liked !== undefined ? { liked: p.liked } : {}),
  };
}

// --- Enrichment ---

export async function enrichWithLiked(
  engine: QueryEngine,
  posts: SocialPost[],
  userId: string,
): Promise<(SocialPost & { liked: boolean })[]> {
  if (posts.length === 0) return [];
  const likedSet = new Set<string>();
  for (const p of posts) {
    const rows = await engine.find(SCHEMA, "likes", {
      filter: { post_id: String(p.id), user_id: userId },
      limit: 1,
    });
    if (rows.length > 0) likedSet.add(String(p.id));
  }
  return posts.map((p) => ({ ...p, liked: likedSet.has(String(p.id)) }));
}

// --- Hono routes ---

export function createSocialRoutes(
  db: AppDb,
  engine: QueryEngine,
  getCurrentUser: () => string,
): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err.message.includes("JSON")) return c.json({ error: "Invalid JSON body" }, 400);
    return c.json({ error: "Internal error" }, 500);
  });

  // Posts
  api.get("/posts", async (c) => {
    const author = c.req.query("author");
    const type = c.req.query("type");
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
    const offset = Number(c.req.query("offset")) || 0;
    const posts = await listPosts(engine, { authorId: author, type, limit, offset });
    const enriched = await enrichWithLiked(engine, posts, getCurrentUser());
    return c.json({ posts: enriched.map(toPostResponse) });
  });

  api.get("/posts/:id", async (c) => {
    const id = c.req.param("id");
    const post = await getPost(engine, id);
    if (!post) return c.json({ error: "Post not found" }, 404);
    const comments = await listComments(engine, id);
    const liked = await isLikedBy(engine, id, getCurrentUser());
    return c.json({ post: toPostResponse({ ...post, liked }), comments: comments.map(toPostResponse), liked });
  });

  api.post("/posts", async (c) => {
    const body = await c.req.json<{ content?: string; type?: string; parentId?: string }>();
    if (!body.content) return c.json({ error: "content is required" }, 400);
    if (body.content.length > 500) return c.json({ error: "Content must be 500 characters or less" }, 400);
    if (body.type && !VALID_POST_TYPES.includes(body.type)) {
      return c.json({ error: "Invalid post type" }, 400);
    }

    const authorId = getCurrentUser();
    const id = await insertPost(engine, {
      authorId,
      content: body.content,
      type: body.type,
      parentId: body.parentId,
    });
    return c.json({ id }, 201);
  });

  api.delete("/posts/:id", async (c) => {
    const id = c.req.param("id");
    const post = await getPost(engine, id);
    if (!post) return c.json({ error: "Post not found" }, 404);
    if (post.author_id !== getCurrentUser()) return c.json({ error: "Not authorized" }, 403);
    await deletePost(db, engine, id);
    return c.json({ ok: true });
  });

  // Feed
  api.get("/feed", async (c) => {
    const userId = getCurrentUser();
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
    const cursor = c.req.query("cursor");
    const followingIds = await getFollowingIds(engine, userId);
    if (followingIds.length === 0) {
      // No follows: show recent posts from everyone
      const posts = await listPosts(engine, { limit });
      const enriched = await enrichWithLiked(engine, posts, userId);
      return c.json({ posts: enriched.map(toPostResponse), hasMore: false });
    }
    const authorIds = [...followingIds, userId];
    const result = await listFeed(db, { authorIds, limit, cursor: cursor || undefined });
    const enriched = await enrichWithLiked(engine, result.posts, userId);
    return c.json({ ...result, posts: enriched.map(toPostResponse) });
  });

  // Explore
  api.get("/explore", async (c) => {
    const userId = getCurrentUser();
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
    const posts = await listTrendingPosts(engine, limit);
    const enriched = await enrichWithLiked(engine, posts, userId);
    return c.json({ posts: enriched.map(toPostResponse) });
  });

  // Likes
  api.post("/posts/:id/like", async (c) => {
    const postId = c.req.param("id");
    const post = await getPost(engine, postId);
    if (!post) return c.json({ error: "Post not found" }, 404);
    const userId = getCurrentUser();
    const liked = await isLikedBy(engine, postId, userId);
    if (liked) {
      await unlikePost(db, engine, postId, userId);
    } else {
      await likePost(db, engine, postId, userId);
    }
    const updatedPost = await getPost(engine, postId);
    return c.json({ liked: !liked, likesCount: updatedPost!.likes_count });
  });

  api.get("/posts/:id/likes", async (c) => {
    const postId = c.req.param("id");
    const likers = await getLikers(engine, postId);
    return c.json({ likers });
  });

  // Comments
  api.post("/posts/:id/comments", async (c) => {
    const postId = c.req.param("id");
    const post = await getPost(engine, postId);
    if (!post) return c.json({ error: "Post not found" }, 404);
    const body = await c.req.json<{ content?: string }>();
    if (!body.content) return c.json({ error: "content is required" }, 400);
    if (body.content.length > 500) return c.json({ error: "Comment must be 500 characters or less" }, 400);
    const authorId = getCurrentUser();
    const id = await addComment(db, engine, { postId, authorId, content: body.content });
    return c.json({ id }, 201);
  });

  api.get("/posts/:id/comments", async (c) => {
    const postId = c.req.param("id");
    const comments = await listComments(engine, postId);
    return c.json({ comments: comments.map(toPostResponse) });
  });

  // Follows
  api.post("/follows", async (c) => {
    const body = await c.req.json<{ handle?: string }>();
    if (!body.handle) return c.json({ error: "handle is required" }, 400);
    const followerId = getCurrentUser();
    if (followerId === body.handle) return c.json({ error: "Cannot follow yourself" }, 400);
    const followed = await followUser(engine, followerId, body.handle);
    return c.json({ ok: true, followed });
  });

  api.delete("/follows/:handle", async (c) => {
    const handle = c.req.param("handle");
    const followerId = getCurrentUser();
    const unfollowed = await unfollowUser(engine, followerId, handle);
    return c.json({ ok: true, unfollowed });
  });

  api.get("/followers/:handle", async (c) => {
    const handle = c.req.param("handle");
    const followers = await getFollowers(engine, handle);
    const counts = await getFollowCounts(engine, handle);
    return c.json({ followers, count: counts.followers });
  });

  api.get("/following/:handle", async (c) => {
    const handle = c.req.param("handle");
    const following = await getFollowing(engine, handle);
    const counts = await getFollowCounts(engine, handle);
    return c.json({ following, count: counts.following });
  });

  // Users / discovery
  api.get("/users", async (c) => {
    const handle = getCurrentUser();
    const stats = await getUserStats(engine, handle);
    return c.json({ users: [{ handle, ...stats }] });
  });

  api.get("/users/:handle", async (c) => {
    const handle = c.req.param("handle");
    const stats = await getUserStats(engine, handle);
    const currentUser = getCurrentUser();
    const follows = currentUser !== handle ? await isFollowing(engine, currentUser, handle) : false;
    return c.json({ handle, ...stats, following: follows });
  });

  return api;
}
