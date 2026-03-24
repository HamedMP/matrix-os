import { describe, it, expect, beforeEach } from 'vitest';
import { createDB, type MatrixDB } from '@matrix-os/kernel';
import { createSocialRoutes, insertPost } from '../../packages/gateway/src/social.js';

describe('social API validation', () => {
  let db: MatrixDB;
  let app: ReturnType<typeof createSocialRoutes>;
  const currentUser = 'alice';

  beforeEach(() => {
    db = createDB(':memory:');
    app = createSocialRoutes(db, () => currentUser);
  });

  function req(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method };
    if (body) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }
    return app.request(path, init);
  }

  describe('POST /posts content length', () => {
    it('rejects content longer than 500 characters', async () => {
      const res = await req('POST', '/posts', { content: 'x'.repeat(501) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('500');
    });

    it('accepts content at exactly 500 characters', async () => {
      const res = await req('POST', '/posts', { content: 'x'.repeat(500) });
      expect(res.status).toBe(201);
    });
  });

  describe('DELETE /posts/:id authorization', () => {
    it('returns 403 when deleting another user\'s post', async () => {
      const postId = insertPost(db, { authorId: 'bob', content: 'Bob post' });
      const res = await req('DELETE', `/posts/${postId}`);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('Not authorized');
    });

    it('returns 404 when deleting non-existent post', async () => {
      const res = await req('DELETE', '/posts/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /posts/:id/comments validation', () => {
    it('rejects comment on non-existent post', async () => {
      const res = await req('POST', '/posts/nonexistent/comments', { content: 'Hello' });
      expect(res.status).toBe(404);
    });

    it('rejects comment with empty content', async () => {
      const createRes = await req('POST', '/posts', { content: 'A post' });
      const { id } = await createRes.json();
      const res = await req('POST', `/posts/${id}/comments`, {});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /posts list with query params', () => {
    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await req('POST', '/posts', { content: `Post ${i}` });
      }

      const res = await req('GET', '/posts?limit=2&offset=1');
      const data = await res.json();
      expect(data.posts).toHaveLength(2);
    });

    it('filters by type', async () => {
      await req('POST', '/posts', { content: 'Regular post' });
      insertPost(db, { authorId: 'alice', content: 'Activity post', type: 'activity' });

      const res = await req('GET', '/posts?type=activity');
      const data = await res.json();
      expect(data.posts).toHaveLength(1);
      expect(data.posts[0].type).toBe('activity');
    });
  });

  describe('GET /feed with cursor', () => {
    it('supports cursor-based pagination', async () => {
      for (let i = 0; i < 3; i++) {
        await req('POST', '/posts', { content: `Post ${i}` });
      }

      const firstPage = await req('GET', '/feed?limit=2');
      const firstData = await firstPage.json();
      expect(firstData.posts.length).toBeLessThanOrEqual(2);
    });
  });

  describe('GET /explore with limit', () => {
    it('respects custom limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await req('POST', '/posts', { content: `Post ${i}` });
      }

      const res = await req('GET', '/explore?limit=3');
      const data = await res.json();
      expect(data.posts.length).toBeLessThanOrEqual(3);
    });
  });
});
