import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  insertPost,
  getPost,
  listFeed,
  deletePost,
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
  isFollowing,
  searchUsers,
  type PostRecord,
} from '../../packages/platform/src/social-feed.js';

describe('platform/social-feed', () => {
  let tmpDir: string;
  let db: PlatformDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'social-feed-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('posts', () => {
    it('inserts and retrieves a post', () => {
      const id = insertPost(db, {
        authorId: '@alice',
        content: 'Hello world!',
        type: 'text',
      });

      expect(id).toBeTruthy();
      const post = getPost(db, id);
      expect(post).toBeTruthy();
      expect(post!.authorId).toBe('@alice');
      expect(post!.content).toBe('Hello world!');
      expect(post!.type).toBe('text');
      expect(post!.likesCount).toBe(0);
      expect(post!.commentsCount).toBe(0);
    });

    it('inserts different post types', () => {
      const textId = insertPost(db, { authorId: '@alice', content: 'Text post', type: 'text' });
      const appId = insertPost(db, {
        authorId: '@alice',
        content: 'Check out my app!',
        type: 'app_share',
        appRef: 'app_123',
      });
      const activityId = insertPost(db, {
        authorId: '@alice',
        content: 'Published Snake game',
        type: 'activity',
      });

      expect(getPost(db, textId)!.type).toBe('text');
      expect(getPost(db, appId)!.type).toBe('app_share');
      expect(getPost(db, appId)!.appRef).toBe('app_123');
      expect(getPost(db, activityId)!.type).toBe('activity');
    });

    it('deletes a post', () => {
      const id = insertPost(db, { authorId: '@alice', content: 'Temp', type: 'text' });
      expect(getPost(db, id)).toBeTruthy();

      deletePost(db, id);
      expect(getPost(db, id)).toBeNull();
    });
  });

  describe('feed', () => {
    it('returns posts in reverse chronological order', () => {
      insertPost(db, { authorId: '@alice', content: 'First', type: 'text' });
      insertPost(db, { authorId: '@alice', content: 'Second', type: 'text' });
      insertPost(db, { authorId: '@alice', content: 'Third', type: 'text' });

      const feed = listFeed(db, { authorIds: ['@alice'] });
      expect(feed.posts).toHaveLength(3);
      expect(feed.posts[0].content).toBe('Third');
      expect(feed.posts[2].content).toBe('First');
    });

    it('filters feed by followed authors', () => {
      insertPost(db, { authorId: '@alice', content: 'Alice post', type: 'text' });
      insertPost(db, { authorId: '@bob', content: 'Bob post', type: 'text' });
      insertPost(db, { authorId: '@charlie', content: 'Charlie post', type: 'text' });

      const feed = listFeed(db, { authorIds: ['@alice', '@bob'] });
      expect(feed.posts).toHaveLength(2);
      expect(feed.posts.map((p) => p.authorId)).toContain('@alice');
      expect(feed.posts.map((p) => p.authorId)).toContain('@bob');
    });

    it('supports cursor-based pagination', () => {
      for (let i = 0; i < 5; i++) {
        insertPost(db, { authorId: '@alice', content: `Post ${i}`, type: 'text' });
      }

      const page1 = listFeed(db, { authorIds: ['@alice'], limit: 2 });
      expect(page1.posts).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBeTruthy();

      const page2 = listFeed(db, { authorIds: ['@alice'], limit: 2, cursor: page1.cursor });
      expect(page2.posts).toHaveLength(2);
      expect(page2.hasMore).toBe(true);

      const page3 = listFeed(db, { authorIds: ['@alice'], limit: 2, cursor: page2.cursor });
      expect(page3.posts).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
    });

    it('returns empty feed for no authors', () => {
      insertPost(db, { authorId: '@alice', content: 'Post', type: 'text' });
      const feed = listFeed(db, { authorIds: [] });
      expect(feed.posts).toHaveLength(0);
    });
  });

  describe('likes', () => {
    it('likes and unlikes a post', () => {
      const id = insertPost(db, { authorId: '@alice', content: 'Like me', type: 'text' });

      likePost(db, id, '@bob');
      expect(getLikeCount(db, id)).toBe(1);
      expect(isLikedBy(db, id, '@bob')).toBe(true);
      expect(isLikedBy(db, id, '@charlie')).toBe(false);

      // Verify post count is updated
      expect(getPost(db, id)!.likesCount).toBe(1);

      unlikePost(db, id, '@bob');
      expect(getLikeCount(db, id)).toBe(0);
      expect(isLikedBy(db, id, '@bob')).toBe(false);
      expect(getPost(db, id)!.likesCount).toBe(0);
    });

    it('prevents duplicate likes', () => {
      const id = insertPost(db, { authorId: '@alice', content: 'Once', type: 'text' });
      likePost(db, id, '@bob');
      likePost(db, id, '@bob'); // duplicate
      expect(getLikeCount(db, id)).toBe(1);
    });

    it('multiple users can like same post', () => {
      const id = insertPost(db, { authorId: '@alice', content: 'Popular', type: 'text' });
      likePost(db, id, '@bob');
      likePost(db, id, '@charlie');
      likePost(db, id, '@dave');
      expect(getLikeCount(db, id)).toBe(3);
      expect(getPost(db, id)!.likesCount).toBe(3);
    });
  });

  describe('comments', () => {
    it('adds and lists comments', () => {
      const postId = insertPost(db, { authorId: '@alice', content: 'Post', type: 'text' });

      const cid1 = addComment(db, { postId, authorId: '@bob', content: 'Nice post!' });
      const cid2 = addComment(db, { postId, authorId: '@charlie', content: 'Agreed!' });

      const comments = listComments(db, postId);
      expect(comments).toHaveLength(2);
      expect(comments[0].content).toBe('Nice post!');
      expect(comments[1].content).toBe('Agreed!');

      // Verify post count is updated
      expect(getPost(db, postId)!.commentsCount).toBe(2);
    });
  });

  describe('follows', () => {
    it('follows and unfollows a user', () => {
      followUser(db, '@alice', '@bob', 'user');
      expect(isFollowing(db, '@alice', '@bob')).toBe(true);

      unfollowUser(db, '@alice', '@bob');
      expect(isFollowing(db, '@alice', '@bob')).toBe(false);
    });

    it('supports following user and AI separately', () => {
      followUser(db, '@alice', '@bob', 'user');
      followUser(db, '@alice', '@bob_ai', 'ai');

      expect(isFollowing(db, '@alice', '@bob')).toBe(true);
      expect(isFollowing(db, '@alice', '@bob_ai')).toBe(true);
    });

    it('prevents duplicate follows', () => {
      followUser(db, '@alice', '@bob', 'user');
      followUser(db, '@alice', '@bob', 'user'); // duplicate

      const counts = getFollowCounts(db, '@bob');
      expect(counts.followers).toBe(1);
    });

    it('gets followers and following lists', () => {
      followUser(db, '@alice', '@bob', 'user');
      followUser(db, '@charlie', '@bob', 'user');
      followUser(db, '@bob', '@alice', 'user');

      const bobFollowers = getFollowers(db, '@bob');
      expect(bobFollowers).toHaveLength(2);
      expect(bobFollowers.map((f) => f.followerId)).toContain('@alice');
      expect(bobFollowers.map((f) => f.followerId)).toContain('@charlie');

      const bobFollowing = getFollowing(db, '@bob');
      expect(bobFollowing).toHaveLength(1);
      expect(bobFollowing[0].followingId).toBe('@alice');
    });

    it('returns follow counts', () => {
      followUser(db, '@alice', '@bob', 'user');
      followUser(db, '@charlie', '@bob', 'user');
      followUser(db, '@bob', '@alice', 'user');

      const bobCounts = getFollowCounts(db, '@bob');
      expect(bobCounts.followers).toBe(2);
      expect(bobCounts.following).toBe(1);

      const aliceCounts = getFollowCounts(db, '@alice');
      expect(aliceCounts.followers).toBe(1);
      expect(aliceCounts.following).toBe(1);
    });
  });

  describe('searchUsers', () => {
    it('searches posts by author id', () => {
      insertPost(db, { authorId: '@alice', content: 'Hello from Alice', type: 'text' });
      insertPost(db, { authorId: '@bob', content: 'Bob here', type: 'text' });

      const feed = listFeed(db, { authorIds: ['@alice'] });
      expect(feed.posts).toHaveLength(1);
      expect(feed.posts[0].authorId).toBe('@alice');
    });
  });
});
