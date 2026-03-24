import { Hono } from 'hono';
import type { PlatformDB } from './db.js';
import {
  insertPost,
  getPost,
  deletePost,
  listFeed,
  listTrendingPosts,
  likePost,
  unlikePost,
  getLikeCount,
  isLikedBy,
  addComment,
  listComments,
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  getFollowCounts,
  getFollowingIds,
} from './social-feed.js';

const VALID_POST_TYPES = ['text', 'image', 'link', 'app_share', 'activity'];

export function createSocialFeedApi(db: PlatformDB): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err.message.includes('JSON')) return c.json({ error: 'Invalid JSON body' }, 400);
    return c.json({ error: 'Internal error' }, 500);
  });

  // --- Feed ---

  api.get('/feed', (c) => {
    const userId = c.req.query('userId');
    if (!userId) {
      return c.json({ error: 'userId parameter is required' }, 400);
    }

    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);
    const cursor = c.req.query('cursor');

    const followingIds = getFollowingIds(db, userId);
    const authorIds = [...followingIds, userId];
    const result = listFeed(db, {
      authorIds,
      limit,
      cursor: cursor || undefined,
    });

    return c.json(result);
  });

  // --- Posts ---

  api.post('/posts', async (c) => {
    const body = await c.req.json<{
      authorId?: string;
      content?: string;
      type?: string;
      mediaUrls?: string;
      appRef?: string;
    }>();

    if (!body.authorId || !body.content || !body.type) {
      return c.json({ error: 'authorId, content, and type are required' }, 400);
    }

    if (body.content.length > 500) {
      return c.json({ error: 'Content must be 500 characters or less' }, 400);
    }

    if (!VALID_POST_TYPES.includes(body.type)) {
      return c.json({ error: 'Invalid post type' }, 400);
    }

    const id = insertPost(db, {
      authorId: body.authorId,
      content: body.content,
      type: body.type,
      mediaUrls: body.mediaUrls,
      appRef: body.appRef,
    });

    return c.json({ id }, 201);
  });

  api.delete('/posts/:id', (c) => {
    const id = c.req.param('id');
    const userId = c.req.query('userId') || c.req.header('x-user-id');
    const post = getPost(db, id);
    if (!post) return c.json({ error: 'Post not found' }, 404);
    if (userId && post.authorId !== userId) return c.json({ error: 'Not authorized' }, 403);
    deletePost(db, id);
    return c.json({ ok: true });
  });

  // --- Likes ---

  api.post('/posts/:id/like', async (c) => {
    const postId = c.req.param('id');
    const body = await c.req.json<{ userId?: string }>();
    if (!body.userId) {
      return c.json({ error: 'userId is required' }, 400);
    }

    likePost(db, postId, body.userId);
    return c.json({
      likesCount: getLikeCount(db, postId),
      liked: true,
    });
  });

  api.delete('/posts/:id/like', async (c) => {
    const postId = c.req.param('id');
    const body = await c.req.json<{ userId?: string }>();
    if (!body.userId) {
      return c.json({ error: 'userId is required' }, 400);
    }

    unlikePost(db, postId, body.userId);
    return c.json({
      likesCount: getLikeCount(db, postId),
      liked: false,
    });
  });

  // --- Comments ---

  api.post('/posts/:id/comments', async (c) => {
    const postId = c.req.param('id');
    const body = await c.req.json<{ authorId?: string; content?: string }>();
    if (!body.authorId || !body.content) {
      return c.json({ error: 'authorId and content are required' }, 400);
    }
    if (body.content.length > 500) {
      return c.json({ error: 'Comment must be 500 characters or less' }, 400);
    }

    const id = addComment(db, {
      postId,
      authorId: body.authorId,
      content: body.content,
    });

    return c.json({ id }, 201);
  });

  api.get('/posts/:id/comments', (c) => {
    const postId = c.req.param('id');
    const result = listComments(db, postId);
    return c.json({ comments: result });
  });

  // --- Follow ---

  api.post('/follow', async (c) => {
    const body = await c.req.json<{
      followerId?: string;
      followingId?: string;
      followingType?: 'user' | 'ai';
    }>();

    if (!body.followerId || !body.followingId) {
      return c.json({ error: 'followerId and followingId are required' }, 400);
    }

    followUser(db, body.followerId, body.followingId, body.followingType ?? 'user');
    return c.json({ ok: true });
  });

  api.delete('/follow', async (c) => {
    const body = await c.req.json<{ followerId?: string; followingId?: string }>();
    if (!body.followerId || !body.followingId) {
      return c.json({ error: 'followerId and followingId are required' }, 400);
    }

    unfollowUser(db, body.followerId, body.followingId);
    return c.json({ ok: true });
  });

  api.get('/followers/:handle', (c) => {
    const handle = c.req.param('handle');
    const followers = getFollowers(db, handle);
    const counts = getFollowCounts(db, handle);
    return c.json({ followers, count: counts.followers });
  });

  api.get('/following/:handle', (c) => {
    const handle = c.req.param('handle');
    const following = getFollowing(db, handle);
    const counts = getFollowCounts(db, handle);
    return c.json({ following, count: counts.following });
  });

  // --- Explore ---

  api.get('/explore', (c) => {
    const sort = c.req.query('sort') ?? 'trending';
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);

    if (sort === 'trending') {
      const trending = listTrendingPosts(db, limit);
      return c.json({ posts: trending });
    }

    return c.json({ posts: [] });
  });

  return api;
}
