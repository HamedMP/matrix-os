import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { KyselyPGlite } from "kysely-pglite";
import {
  insertPost,
  listFeed,
  listTrendingPosts,
  followUser,
  getFollowingIds,
  likePost,
  getUserStats,
  addComment,
} from "../../packages/gateway/src/social.js";

const SOCIAL_TABLES = {
  posts: {
    columns: {
      author_id: "text",
      content: "text",
      type: "text",
      media_urls: "text",
      app_ref: "text",
      parent_id: "text",
      likes_count: "integer",
      comments_count: "integer",
    },
    indexes: ["author_id", "type", "created_at", "likes_count", "parent_id"],
  },
  likes: {
    columns: { post_id: "text", user_id: "text" },
    indexes: ["post_id", "user_id"],
  },
  follows: {
    columns: { follower_id: "text", followee_id: "text" },
    indexes: ["follower_id", "followee_id"],
  },
};

describe("T2050: Social feed and trending (Postgres)", () => {
  let db: AppDb;
  let engine: QueryEngine;
  let instance: InstanceType<typeof KyselyPGlite>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    const created = createAppDb({ dialect: instance.dialect });
    db = created.db;
    await db.bootstrap();
    const registry = createAppRegistry(db, created.kysely);
    await registry.register({ slug: "social", name: "Social", tables: SOCIAL_TABLES });
    engine = createQueryEngine(db);
  });

  afterEach(async () => {
    await db.raw("DROP SCHEMA IF EXISTS social CASCADE");
    await db.raw("DELETE FROM public._apps");
    await db.destroy();
  });

  it("returns feed from followed users", async () => {
    await insertPost(engine, { authorId: "alice", content: "Alice post" });
    await insertPost(engine, { authorId: "bob", content: "Bob post" });
    await insertPost(engine, { authorId: "carol", content: "Carol post" });

    const result = await listFeed(db, { authorIds: ["alice", "bob"] });
    expect(result.posts).toHaveLength(2);
    const authors = result.posts.map((p) => p.author_id);
    expect(authors).toContain("alice");
    expect(authors).toContain("bob");
    expect(authors).not.toContain("carol");
  });

  it("returns empty feed for empty authorIds", async () => {
    const result = await listFeed(db, { authorIds: [] });
    expect(result.posts).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("supports cursor pagination in feed", async () => {
    for (let i = 0; i < 5; i++) {
      await insertPost(engine, { authorId: "alice", content: `Post ${i}` });
    }

    const page1 = await listFeed(db, { authorIds: ["alice"], limit: 2 });
    expect(page1.posts).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBeDefined();

    const page2 = await listFeed(db, { authorIds: ["alice"], limit: 2, cursor: page1.cursor });
    expect(page2.posts).toHaveLength(2);
    expect(page2.hasMore).toBe(true);
    expect(page2.posts[0].id).not.toBe(page1.posts[0].id);

    const page3 = await listFeed(db, { authorIds: ["alice"], limit: 2, cursor: page2.cursor });
    expect(page3.posts).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
  });

  it("excludes comments from feed", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Post" });
    await addComment(db, engine, { postId, authorId: "alice", content: "Comment" });

    const result = await listFeed(db, { authorIds: ["alice"] });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].id).toBe(postId);
  });

  it("returns trending posts ordered by likes", async () => {
    const id1 = await insertPost(engine, { authorId: "alice", content: "Unpopular" });
    const id2 = await insertPost(engine, { authorId: "bob", content: "Popular" });

    await likePost(db, engine, id2, "carol");
    await likePost(db, engine, id2, "dave");
    await likePost(db, engine, id2, "eve");

    const trending = await listTrendingPosts(engine, 10);
    expect(trending[0].id).toBe(id2);
    expect(trending[0].likes_count).toBe(3);
  });

  it("feed integrates with follow system", async () => {
    await insertPost(engine, { authorId: "alice", content: "Alice says hi" });
    await insertPost(engine, { authorId: "bob", content: "Bob says hi" });
    await followUser(engine, "carol", "alice");

    const followingIds = await getFollowingIds(engine, "carol");
    const authorIds = [...followingIds, "carol"];

    const result = await listFeed(db, { authorIds });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].author_id).toBe("alice");
  });

  it("getUserStats returns correct counts", async () => {
    await insertPost(engine, { authorId: "alice", content: "Post 1" });
    await insertPost(engine, { authorId: "alice", content: "Post 2" });
    await followUser(engine, "bob", "alice");
    await followUser(engine, "carol", "alice");
    await followUser(engine, "alice", "dave");

    const stats = await getUserStats(engine, "alice");
    expect(stats.postCount).toBe(2);
    expect(stats.followers).toBe(2);
    expect(stats.following).toBe(1);
  });
});
