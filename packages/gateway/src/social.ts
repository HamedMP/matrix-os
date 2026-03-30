import { randomUUID } from "node:crypto";
import { eq, and, desc, sql, inArray, lt } from "drizzle-orm";
import { Hono } from "hono";
import {
  socialPosts,
  socialLikes,
  socialFollows,
  type MatrixDB,
  type SocialPost,
} from "@matrix-os/kernel";

// --- ID generation ---

let postSeq = 0;

function makePostId(): string {
  const ts = Date.now().toString(36);
  const seq = (postSeq++).toString(36).padStart(4, "0");
  const rand = randomUUID().slice(0, 6);
  return `p_${ts}_${seq}_${rand}`;
}

// --- Posts CRUD ---

export function insertPost(
  db: MatrixDB,
  input: {
    authorId: string;
    content: string;
    type?: string;
    parentId?: string;
    mediaUrls?: string;
    appRef?: string;
  },
): string {
  const id = makePostId();
  db.insert(socialPosts)
    .values({
      id,
      authorId: input.authorId,
      content: input.content,
      type: input.type ?? "text",
      parentId: input.parentId,
      mediaUrls: input.mediaUrls,
      appRef: input.appRef,
      likesCount: 0,
      commentsCount: 0,
      createdAt: new Date().toISOString(),
    })
    .run();
  return id;
}

export function getPost(db: MatrixDB, id: string): SocialPost | undefined {
  return db.select().from(socialPosts).where(eq(socialPosts.id, id)).get();
}

export function deletePost(db: MatrixDB, id: string): boolean {
  const existing = getPost(db, id);
  if (!existing) return false;
  // better-sqlite3 is synchronous and single-connection, so sequential
  // DELETEs are effectively atomic (no concurrent writes). Order matters:
  // likes first, then child comments, then the post itself.
  db.delete(socialLikes).where(eq(socialLikes.postId, id)).run();
  db.delete(socialPosts).where(eq(socialPosts.parentId, id)).run();
  db.delete(socialPosts).where(eq(socialPosts.id, id)).run();
  return true;
}

export function listPosts(
  db: MatrixDB,
  opts?: { authorId?: string; type?: string; limit?: number; offset?: number },
): SocialPost[] {
  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;
  const conditions = [sql`${socialPosts.parentId} IS NULL`];
  if (opts?.authorId) conditions.push(eq(socialPosts.authorId, opts.authorId));
  if (opts?.type) conditions.push(eq(socialPosts.type, opts.type));

  return db
    .select()
    .from(socialPosts)
    .where(and(...conditions))
    .orderBy(desc(socialPosts.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
}

// --- Feed ---

export interface FeedResult {
  posts: SocialPost[];
  hasMore: boolean;
  cursor?: string;
}

export function listFeed(
  db: MatrixDB,
  opts: { authorIds: string[]; limit?: number; cursor?: string },
): FeedResult {
  const { authorIds, limit = 20, cursor } = opts;
  if (authorIds.length === 0) return { posts: [], hasMore: false };

  const conditions = [
    inArray(socialPosts.authorId, authorIds),
    sql`${socialPosts.parentId} IS NULL`,
  ];
  if (cursor) conditions.push(lt(socialPosts.id, cursor));

  const result = db
    .select()
    .from(socialPosts)
    .where(and(...conditions))
    .orderBy(desc(socialPosts.createdAt), desc(socialPosts.id))
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

export function listTrendingPosts(db: MatrixDB, limit = 20): SocialPost[] {
  return db
    .select()
    .from(socialPosts)
    .where(sql`${socialPosts.parentId} IS NULL`)
    .orderBy(desc(socialPosts.likesCount), desc(socialPosts.createdAt))
    .limit(limit)
    .all();
}

// --- Likes ---

// better-sqlite3 is synchronous and single-connection. The check-then-mutate
// pattern (SELECT + INSERT + UPDATE) has no race window because concurrent
// requests are serialized by the Node.js event loop.
export function likePost(db: MatrixDB, postId: string, userId: string): boolean {
  const existing = db
    .select()
    .from(socialLikes)
    .where(and(eq(socialLikes.postId, postId), eq(socialLikes.userId, userId)))
    .get();
  if (existing) return false;

  db.insert(socialLikes)
    .values({ postId, userId, createdAt: new Date().toISOString() })
    .run();
  db.update(socialPosts)
    .set({ likesCount: sql`${socialPosts.likesCount} + 1` })
    .where(eq(socialPosts.id, postId))
    .run();
  return true;
}

export function unlikePost(db: MatrixDB, postId: string, userId: string): boolean {
  const existing = db
    .select()
    .from(socialLikes)
    .where(and(eq(socialLikes.postId, postId), eq(socialLikes.userId, userId)))
    .get();
  if (!existing) return false;

  db.delete(socialLikes)
    .where(and(eq(socialLikes.postId, postId), eq(socialLikes.userId, userId)))
    .run();
  db.update(socialPosts)
    .set({ likesCount: sql`MAX(${socialPosts.likesCount} - 1, 0)` })
    .where(eq(socialPosts.id, postId))
    .run();
  return true;
}

export function isLikedBy(db: MatrixDB, postId: string, userId: string): boolean {
  return !!db
    .select()
    .from(socialLikes)
    .where(and(eq(socialLikes.postId, postId), eq(socialLikes.userId, userId)))
    .get();
}

export function getLikers(db: MatrixDB, postId: string): string[] {
  return db
    .select({ userId: socialLikes.userId })
    .from(socialLikes)
    .where(eq(socialLikes.postId, postId))
    .all()
    .map((r) => r.userId);
}

// --- Comments (posts with parentId) ---

export function addComment(
  db: MatrixDB,
  input: { postId: string; authorId: string; content: string },
): string {
  const id = insertPost(db, {
    authorId: input.authorId,
    content: input.content,
    type: "text",
    parentId: input.postId,
  });
  db.update(socialPosts)
    .set({ commentsCount: sql`${socialPosts.commentsCount} + 1` })
    .where(eq(socialPosts.id, input.postId))
    .run();
  return id;
}

export function listComments(db: MatrixDB, postId: string): SocialPost[] {
  return db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.parentId, postId))
    .orderBy(socialPosts.createdAt)
    .all();
}

// --- Follows ---

export function followUser(db: MatrixDB, followerId: string, followeeId: string): boolean {
  const existing = db
    .select()
    .from(socialFollows)
    .where(and(eq(socialFollows.followerId, followerId), eq(socialFollows.followeeId, followeeId)))
    .get();
  if (existing) return false;

  db.insert(socialFollows)
    .values({ followerId, followeeId, createdAt: new Date().toISOString() })
    .run();
  return true;
}

export function unfollowUser(db: MatrixDB, followerId: string, followeeId: string): boolean {
  const existing = db
    .select()
    .from(socialFollows)
    .where(and(eq(socialFollows.followerId, followerId), eq(socialFollows.followeeId, followeeId)))
    .get();
  if (!existing) return false;

  db.delete(socialFollows)
    .where(and(eq(socialFollows.followerId, followerId), eq(socialFollows.followeeId, followeeId)))
    .run();
  return true;
}

export function getFollowers(db: MatrixDB, handle: string) {
  return db
    .select()
    .from(socialFollows)
    .where(eq(socialFollows.followeeId, handle))
    .orderBy(desc(socialFollows.createdAt))
    .all();
}

export function getFollowing(db: MatrixDB, handle: string) {
  return db
    .select()
    .from(socialFollows)
    .where(eq(socialFollows.followerId, handle))
    .orderBy(desc(socialFollows.createdAt))
    .all();
}

export function getFollowCounts(
  db: MatrixDB,
  handle: string,
): { followers: number; following: number } {
  const followers = db
    .select({ count: sql<number>`count(*)` })
    .from(socialFollows)
    .where(eq(socialFollows.followeeId, handle))
    .get();
  const following = db
    .select({ count: sql<number>`count(*)` })
    .from(socialFollows)
    .where(eq(socialFollows.followerId, handle))
    .get();
  return {
    followers: followers?.count ?? 0,
    following: following?.count ?? 0,
  };
}

export function getFollowingIds(db: MatrixDB, handle: string): string[] {
  return db
    .select({ followeeId: socialFollows.followeeId })
    .from(socialFollows)
    .where(eq(socialFollows.followerId, handle))
    .all()
    .map((r) => r.followeeId);
}

export function isFollowing(db: MatrixDB, followerId: string, followeeId: string): boolean {
  return !!db
    .select()
    .from(socialFollows)
    .where(and(eq(socialFollows.followerId, followerId), eq(socialFollows.followeeId, followeeId)))
    .get();
}

// --- User stats ---

export function getUserStats(
  db: MatrixDB,
  handle: string,
): { postCount: number; followers: number; following: number } {
  const postCount = db
    .select({ count: sql<number>`count(*)` })
    .from(socialPosts)
    .where(and(eq(socialPosts.authorId, handle), sql`${socialPosts.parentId} IS NULL`))
    .get();
  const counts = getFollowCounts(db, handle);
  return {
    postCount: postCount?.count ?? 0,
    ...counts,
  };
}

// --- Constants ---

const VALID_POST_TYPES = ['text', 'image', 'link', 'app_share', 'activity'];

// --- Hono routes ---

export function createSocialRoutes(db: MatrixDB, getCurrentUser: () => string): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err.message.includes('JSON')) return c.json({ error: 'Invalid JSON body' }, 400);
    return c.json({ error: 'Internal error' }, 500);
  });

  function enrichWithLiked(posts: SocialPost[], userId: string) {
    return posts.map((p) => ({ ...p, liked: isLikedBy(db, p.id, userId) }));
  }

  // Posts
  api.get("/posts", (c) => {
    const author = c.req.query("author");
    const type = c.req.query("type");
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
    const offset = Number(c.req.query("offset")) || 0;
    const posts = listPosts(db, { authorId: author, type, limit, offset });
    return c.json({ posts: enrichWithLiked(posts, getCurrentUser()) });
  });

  api.get("/posts/:id", (c) => {
    const id = c.req.param("id");
    const post = getPost(db, id);
    if (!post) return c.json({ error: "Post not found" }, 404);
    const comments = listComments(db, id);
    const liked = isLikedBy(db, id, getCurrentUser());
    return c.json({ post, comments, liked });
  });

  api.post("/posts", async (c) => {
    const body = await c.req.json<{ content?: string; type?: string; parentId?: string }>();
    if (!body.content) return c.json({ error: "content is required" }, 400);
    if (body.content.length > 500) return c.json({ error: "Content must be 500 characters or less" }, 400);
    if (body.type && !VALID_POST_TYPES.includes(body.type)) {
      return c.json({ error: "Invalid post type" }, 400);
    }

    const authorId = getCurrentUser();
    const id = insertPost(db, {
      authorId,
      content: body.content,
      type: body.type,
      parentId: body.parentId,
    });
    return c.json({ id }, 201);
  });

  api.delete("/posts/:id", (c) => {
    const id = c.req.param("id");
    const post = getPost(db, id);
    if (!post) return c.json({ error: "Post not found" }, 404);
    if (post.authorId !== getCurrentUser()) return c.json({ error: "Not authorized" }, 403);
    deletePost(db, id);
    return c.json({ ok: true });
  });

  // Feed
  api.get("/feed", (c) => {
    const userId = getCurrentUser();
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
    const cursor = c.req.query("cursor");
    const followingIds = getFollowingIds(db, userId);
    const authorIds = [...followingIds, userId];
    if (authorIds.length === 0) {
      const posts = listPosts(db, { limit });
      return c.json({ posts: enrichWithLiked(posts, userId), hasMore: false });
    }
    const result = listFeed(db, { authorIds, limit, cursor: cursor || undefined });
    return c.json({ ...result, posts: enrichWithLiked(result.posts, userId) });
  });

  // Explore
  api.get("/explore", (c) => {
    const userId = getCurrentUser();
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
    const posts = listTrendingPosts(db, limit);
    return c.json({ posts: enrichWithLiked(posts, userId) });
  });

  // Likes
  api.post("/posts/:id/like", (c) => {
    const postId = c.req.param("id");
    const post = getPost(db, postId);
    if (!post) return c.json({ error: "Post not found" }, 404);
    const userId = getCurrentUser();
    const liked = isLikedBy(db, postId, userId);
    if (liked) {
      unlikePost(db, postId, userId);
    } else {
      likePost(db, postId, userId);
    }
    const updatedPost = getPost(db, postId)!;
    return c.json({ liked: !liked, likesCount: updatedPost.likesCount });
  });

  api.get("/posts/:id/likes", (c) => {
    const postId = c.req.param("id");
    const likers = getLikers(db, postId);
    return c.json({ likers });
  });

  // Comments
  api.post("/posts/:id/comments", async (c) => {
    const postId = c.req.param("id");
    const post = getPost(db, postId);
    if (!post) return c.json({ error: "Post not found" }, 404);
    const body = await c.req.json<{ content?: string }>();
    if (!body.content) return c.json({ error: "content is required" }, 400);
    if (body.content.length > 500) return c.json({ error: "Comment must be 500 characters or less" }, 400);
    const authorId = getCurrentUser();
    const id = addComment(db, { postId, authorId, content: body.content });
    return c.json({ id }, 201);
  });

  api.get("/posts/:id/comments", (c) => {
    const postId = c.req.param("id");
    const comments = listComments(db, postId);
    return c.json({ comments });
  });

  // Follows
  api.post("/follows", async (c) => {
    const body = await c.req.json<{ handle?: string }>();
    if (!body.handle) return c.json({ error: "handle is required" }, 400);
    const followerId = getCurrentUser();
    if (followerId === body.handle) return c.json({ error: "Cannot follow yourself" }, 400);
    const followed = followUser(db, followerId, body.handle);
    return c.json({ ok: true, followed });
  });

  api.delete("/follows/:handle", (c) => {
    const handle = c.req.param("handle");
    const followerId = getCurrentUser();
    const unfollowed = unfollowUser(db, followerId, handle);
    return c.json({ ok: true, unfollowed });
  });

  api.get("/followers/:handle", (c) => {
    const handle = c.req.param("handle");
    const followers = getFollowers(db, handle);
    const counts = getFollowCounts(db, handle);
    return c.json({ followers, count: counts.followers });
  });

  api.get("/following/:handle", (c) => {
    const handle = c.req.param("handle");
    const following = getFollowing(db, handle);
    const counts = getFollowCounts(db, handle);
    return c.json({ following, count: counts.following });
  });

  // Users / discovery
  api.get("/users", (c) => {
    // In single-user mode, return the current user and their AI
    const handle = getCurrentUser();
    const stats = getUserStats(db, handle);
    return c.json({ users: [{ handle, ...stats }] });
  });

  api.get("/users/:handle", (c) => {
    const handle = c.req.param("handle");
    const stats = getUserStats(db, handle);
    const currentUser = getCurrentUser();
    const following = currentUser !== handle ? isFollowing(db, currentUser, handle) : false;
    return c.json({ handle, ...stats, following });
  });

  return api;
}
