import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { Hono } from 'hono';
import { type PlatformDB } from '../../packages/platform/src/db.js';
import { createSocialFeedApi } from '../../packages/platform/src/social-api.js';
import { insertPost, followUser, likePost, addComment } from '../../packages/platform/src/social-feed.js';

describe('platform/social-api', () => {
  let db: PlatformDB;
  let app: Hono;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    app = new Hono();
    app.route('/api/social', createSocialFeedApi(db));
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function req(path: string, init?: RequestInit) {
    return app.request(`http://localhost/api/social${path}`, init);
  }

  describe('GET /feed', () => {
    it('returns paginated feed for given user', async () => {
      await insertPost(db, { authorId: '@alice', content: 'Post 1', type: 'text' });
      await insertPost(db, { authorId: '@bob', content: 'Post 2', type: 'text' });
      await followUser(db, '@viewer', '@alice', 'user');
      await followUser(db, '@viewer', '@bob', 'user');

      const res = await req('/feed?userId=@viewer');
      expect(res.status).toBe(200);
      const body = await res.json() as { posts: unknown[]; hasMore: boolean };
      expect(body.posts).toHaveLength(2);
    });

    it('returns empty feed when user follows nobody', async () => {
      await insertPost(db, { authorId: '@alice', content: 'Post 1', type: 'text' });

      const res = await req('/feed?userId=@viewer');
      expect(res.status).toBe(200);
      const body = await res.json() as { posts: unknown[] };
      expect(body.posts).toHaveLength(0);
    });

    it('requires userId parameter', async () => {
      const res = await req('/feed');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /posts', () => {
    it('creates a new text post', async () => {
      const res = await req('/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorId: '@alice',
          content: 'My first post!',
          type: 'text',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { id: string };
      expect(body.id).toBeTruthy();
    });

    it('creates an app_share post', async () => {
      const res = await req('/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorId: '@alice',
          content: 'Check out my Snake game!',
          type: 'app_share',
          appRef: 'app_001',
        }),
      });

      expect(res.status).toBe(201);
    });

    it('rejects post without required fields', async () => {
      const res = await req('/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'No author' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects post content over 500 characters', async () => {
      const res = await req('/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorId: '@alice',
          content: 'x'.repeat(501),
          type: 'text',
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /posts/:id', () => {
    it('deletes a post', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Delete me', type: 'text' });

      const res = await req(`/posts/${id}`, {
        method: 'DELETE',
        headers: { 'x-user-id': '@alice' },
      });
      expect(res.status).toBe(200);
    });

    it('returns 401 without userId', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Delete me', type: 'text' });
      const res = await req(`/posts/${id}`, { method: 'DELETE' });
      expect(res.status).toBe(401);
    });

    it('returns 403 for wrong user', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Delete me', type: 'text' });
      const res = await req(`/posts/${id}`, {
        method: 'DELETE',
        headers: { 'x-user-id': '@bob' },
      });
      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent post', async () => {
      const res = await req('/posts/nonexistent', {
        method: 'DELETE',
        headers: { 'x-user-id': '@alice' },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /posts/:id/like', () => {
    it('likes a post', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Like me', type: 'text' });

      const res = await req(`/posts/${id}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '@bob' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { likesCount: number; liked: boolean };
      expect(body.likesCount).toBe(1);
      expect(body.liked).toBe(true);
    });
  });

  describe('DELETE /posts/:id/like', () => {
    it('unlikes a post', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Unlike me', type: 'text' });
      await likePost(db, id, '@bob');

      const res = await req(`/posts/${id}/like`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '@bob' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { likesCount: number; liked: boolean };
      expect(body.likesCount).toBe(0);
      expect(body.liked).toBe(false);
    });
  });

  describe('POST /posts/:id/comments', () => {
    it('adds a comment to a post', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Comment me', type: 'text' });

      const res = await req(`/posts/${id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorId: '@bob', content: 'Great post!' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { id: string };
      expect(body.id).toBeTruthy();
    });
  });

  describe('GET /posts/:id/comments', () => {
    it('lists comments on a post', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Post', type: 'text' });
      await addComment(db, { postId: id, authorId: '@bob', content: 'Comment 1' });
      await addComment(db, { postId: id, authorId: '@charlie', content: 'Comment 2' });

      const res = await req(`/posts/${id}/comments`);
      expect(res.status).toBe(200);
      const body = await res.json() as { comments: unknown[] };
      expect(body.comments).toHaveLength(2);
    });
  });

  describe('POST /follow', () => {
    it('follows a user', async () => {
      const res = await req('/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          followerId: '@alice',
          followingId: '@bob',
          followingType: 'user',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  describe('DELETE /follow', () => {
    it('unfollows a user', async () => {
      await followUser(db, '@alice', '@bob', 'user');

      const res = await req('/follow', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followerId: '@alice', followingId: '@bob' }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /followers/:handle', () => {
    it('returns followers for a handle', async () => {
      await followUser(db, '@alice', '@bob', 'user');
      await followUser(db, '@charlie', '@bob', 'user');

      const res = await req('/followers/@bob');
      expect(res.status).toBe(200);
      const body = await res.json() as { followers: unknown[]; count: number };
      expect(body.followers).toHaveLength(2);
      expect(body.count).toBe(2);
    });
  });

  describe('GET /following/:handle', () => {
    it('returns following list for a handle', async () => {
      await followUser(db, '@bob', '@alice', 'user');
      await followUser(db, '@bob', '@charlie', 'user');

      const res = await req('/following/@bob');
      expect(res.status).toBe(200);
      const body = await res.json() as { following: unknown[]; count: number };
      expect(body.following).toHaveLength(2);
      expect(body.count).toBe(2);
    });
  });

  describe('GET /explore', () => {
    it('returns trending posts (most liked)', async () => {
      const p1 = await insertPost(db, { authorId: '@alice', content: 'Popular', type: 'text' });
      const p2 = await insertPost(db, { authorId: '@bob', content: 'Less popular', type: 'text' });
      await likePost(db, p1, '@user1');
      await likePost(db, p1, '@user2');
      await likePost(db, p1, '@user3');
      await likePost(db, p2, '@user1');

      const res = await req('/explore?sort=trending');
      expect(res.status).toBe(200);
      const body = await res.json() as { posts: Array<{ id: string; likesCount: number }> };
      expect(body.posts[0].id).toBe(p1);
    });
  });
});
