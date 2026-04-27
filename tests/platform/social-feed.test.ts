import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { type PlatformDB } from '../../packages/platform/src/db.js';
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
} from '../../packages/platform/src/social-feed.js';

describe('platform/social-feed', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  describe('posts', () => {
    it('inserts and retrieves a post', async () => {
      const id = await insertPost(db, {
        authorId: '@alice',
        content: 'Hello world!',
        type: 'text',
      });

      expect(id).toBeTruthy();
      const post = await getPost(db, id);
      expect(post).toBeTruthy();
      expect(post!.authorId).toBe('@alice');
      expect(post!.content).toBe('Hello world!');
      expect(post!.type).toBe('text');
      expect(post!.likesCount).toBe(0);
      expect(post!.commentsCount).toBe(0);
    });

    it('inserts different post types', async () => {
      const textId = await insertPost(db, { authorId: '@alice', content: 'Text post', type: 'text' });
      const appId = await insertPost(db, {
        authorId: '@alice',
        content: 'Check out my app!',
        type: 'app_share',
        appRef: 'app_123',
      });
      const activityId = await insertPost(db, {
        authorId: '@alice',
        content: 'Published Snake game',
        type: 'activity',
      });

      expect((await getPost(db, textId))!.type).toBe('text');
      expect((await getPost(db, appId))!.type).toBe('app_share');
      expect((await getPost(db, appId))!.appRef).toBe('app_123');
      expect((await getPost(db, activityId))!.type).toBe('activity');
    });

    it('deletes a post', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Temp', type: 'text' });
      expect(await getPost(db, id)).toBeTruthy();

      await deletePost(db, id);
      expect(await getPost(db, id)).toBeNull();
    });
  });

  describe('feed', () => {
    it('returns posts in reverse chronological order', async () => {
      await insertPost(db, { authorId: '@alice', content: 'First', type: 'text' });
      await insertPost(db, { authorId: '@alice', content: 'Second', type: 'text' });
      await insertPost(db, { authorId: '@alice', content: 'Third', type: 'text' });

      const feed = await listFeed(db, { authorIds: ['@alice'] });
      expect(feed.posts).toHaveLength(3);
      expect(feed.posts[0].content).toBe('Third');
      expect(feed.posts[2].content).toBe('First');
    });

    it('filters feed by followed authors', async () => {
      await insertPost(db, { authorId: '@alice', content: 'Alice post', type: 'text' });
      await insertPost(db, { authorId: '@bob', content: 'Bob post', type: 'text' });
      await insertPost(db, { authorId: '@charlie', content: 'Charlie post', type: 'text' });

      const feed = await listFeed(db, { authorIds: ['@alice', '@bob'] });
      expect(feed.posts).toHaveLength(2);
      expect(feed.posts.map((p) => p.authorId)).toContain('@alice');
      expect(feed.posts.map((p) => p.authorId)).toContain('@bob');
    });

    it('supports cursor-based pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await insertPost(db, { authorId: '@alice', content: `Post ${i}`, type: 'text' });
      }

      const page1 = await listFeed(db, { authorIds: ['@alice'], limit: 2 });
      expect(page1.posts).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBeTruthy();

      const page2 = await listFeed(db, { authorIds: ['@alice'], limit: 2, cursor: page1.cursor });
      expect(page2.posts).toHaveLength(2);
      expect(page2.hasMore).toBe(true);

      const page3 = await listFeed(db, { authorIds: ['@alice'], limit: 2, cursor: page2.cursor });
      expect(page3.posts).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
    });

    it('returns empty feed for no authors', async () => {
      await insertPost(db, { authorId: '@alice', content: 'Post', type: 'text' });
      const feed = await listFeed(db, { authorIds: [] });
      expect(feed.posts).toHaveLength(0);
    });
  });

  describe('likes', () => {
    it('likes and unlikes a post', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Like me', type: 'text' });

      await likePost(db, id, '@bob');
      expect(await getLikeCount(db, id)).toBe(1);
      expect(await isLikedBy(db, id, '@bob')).toBe(true);
      expect(await isLikedBy(db, id, '@charlie')).toBe(false);

      expect((await getPost(db, id))!.likesCount).toBe(1);

      await unlikePost(db, id, '@bob');
      expect(await getLikeCount(db, id)).toBe(0);
      expect(await isLikedBy(db, id, '@bob')).toBe(false);
      expect((await getPost(db, id))!.likesCount).toBe(0);
    });

    it('prevents duplicate likes', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Once', type: 'text' });
      await likePost(db, id, '@bob');
      await likePost(db, id, '@bob');
      expect(await getLikeCount(db, id)).toBe(1);
    });

    it('multiple users can like same post', async () => {
      const id = await insertPost(db, { authorId: '@alice', content: 'Popular', type: 'text' });
      await likePost(db, id, '@bob');
      await likePost(db, id, '@charlie');
      await likePost(db, id, '@dave');
      expect(await getLikeCount(db, id)).toBe(3);
      expect((await getPost(db, id))!.likesCount).toBe(3);
    });
  });

  describe('comments', () => {
    it('adds and lists comments', async () => {
      const postId = await insertPost(db, { authorId: '@alice', content: 'Post', type: 'text' });

      await addComment(db, { postId, authorId: '@bob', content: 'Nice post!' });
      await addComment(db, { postId, authorId: '@charlie', content: 'Agreed!' });

      const comments = await listComments(db, postId);
      expect(comments).toHaveLength(2);
      expect(comments[0].content).toBe('Nice post!');
      expect(comments[1].content).toBe('Agreed!');

      expect((await getPost(db, postId))!.commentsCount).toBe(2);
    });
  });

  describe('follows', () => {
    it('follows and unfollows a user', async () => {
      await followUser(db, '@alice', '@bob', 'user');
      expect(await isFollowing(db, '@alice', '@bob')).toBe(true);

      await unfollowUser(db, '@alice', '@bob');
      expect(await isFollowing(db, '@alice', '@bob')).toBe(false);
    });

    it('supports following user and AI separately', async () => {
      await followUser(db, '@alice', '@bob', 'user');
      await followUser(db, '@alice', '@bob_ai', 'ai');

      expect(await isFollowing(db, '@alice', '@bob')).toBe(true);
      expect(await isFollowing(db, '@alice', '@bob_ai')).toBe(true);
    });

    it('prevents duplicate follows', async () => {
      await followUser(db, '@alice', '@bob', 'user');
      await followUser(db, '@alice', '@bob', 'user');

      const counts = await getFollowCounts(db, '@bob');
      expect(counts.followers).toBe(1);
    });

    it('gets followers and following lists', async () => {
      await followUser(db, '@alice', '@bob', 'user');
      await followUser(db, '@charlie', '@bob', 'user');
      await followUser(db, '@bob', '@alice', 'user');

      const bobFollowers = await getFollowers(db, '@bob');
      expect(bobFollowers).toHaveLength(2);
      expect(bobFollowers.map((f) => f.followerId)).toContain('@alice');
      expect(bobFollowers.map((f) => f.followerId)).toContain('@charlie');

      const bobFollowing = await getFollowing(db, '@bob');
      expect(bobFollowing).toHaveLength(1);
      expect(bobFollowing[0].followingId).toBe('@alice');
    });

    it('returns follow counts', async () => {
      await followUser(db, '@alice', '@bob', 'user');
      await followUser(db, '@charlie', '@bob', 'user');
      await followUser(db, '@bob', '@alice', 'user');

      const bobCounts = await getFollowCounts(db, '@bob');
      expect(bobCounts.followers).toBe(2);
      expect(bobCounts.following).toBe(1);

      const aliceCounts = await getFollowCounts(db, '@alice');
      expect(aliceCounts.followers).toBe(1);
      expect(aliceCounts.following).toBe(1);
    });
  });

  describe('searchUsers', () => {
    it('searches posts by author id', async () => {
      await insertPost(db, { authorId: '@alice', content: 'Hello from Alice', type: 'text' });
      await insertPost(db, { authorId: '@bob', content: 'Bob here', type: 'text' });

      const feed = await listFeed(db, { authorIds: ['@alice'] });
      expect(feed.posts).toHaveLength(1);
      expect(feed.posts[0].authorId).toBe('@alice');
    });
  });
});
