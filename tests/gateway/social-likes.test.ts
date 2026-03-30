import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { KyselyPGlite } from "kysely-pglite";
import {
  insertPost,
  getPost,
  likePost,
  unlikePost,
  isLikedBy,
  getLikers,
  enrichWithLiked,
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

describe("T2050: Social likes (Postgres)", () => {
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

  it("likes a post and increments count", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Hello" });
    expect(await likePost(db, engine, postId, "bob")).toBe(true);

    const post = await getPost(engine, postId);
    expect(post!.likes_count).toBe(1);
    expect(await isLikedBy(engine, postId, "bob")).toBe(true);
  });

  it("prevents double-liking", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Hello" });
    expect(await likePost(db, engine, postId, "bob")).toBe(true);
    expect(await likePost(db, engine, postId, "bob")).toBe(false);

    const post = await getPost(engine, postId);
    expect(post!.likes_count).toBe(1);
  });

  it("unlikes a post and decrements count", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Hello" });
    await likePost(db, engine, postId, "bob");
    expect(await unlikePost(db, engine, postId, "bob")).toBe(true);

    const post = await getPost(engine, postId);
    expect(post!.likes_count).toBe(0);
    expect(await isLikedBy(engine, postId, "bob")).toBe(false);
  });

  it("returns false when unliking non-liked post", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Hello" });
    expect(await unlikePost(db, engine, postId, "bob")).toBe(false);
  });

  it("likes_count never goes below 0", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Hello" });
    await db.raw(
      `UPDATE "social"."posts" SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1`,
      [postId],
    );
    const post = await getPost(engine, postId);
    expect(post!.likes_count).toBe(0);
  });

  it("multiple users can like the same post", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Hello" });
    await likePost(db, engine, postId, "bob");
    await likePost(db, engine, postId, "carol");
    await likePost(db, engine, postId, "dave");

    const post = await getPost(engine, postId);
    expect(post!.likes_count).toBe(3);
    expect(await getLikers(engine, postId)).toHaveLength(3);
  });

  it("getLikers returns user IDs", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Hello" });
    await likePost(db, engine, postId, "bob");
    await likePost(db, engine, postId, "carol");

    const likers = await getLikers(engine, postId);
    expect(likers).toContain("bob");
    expect(likers).toContain("carol");
  });

  it("enrichWithLiked adds liked field to posts", async () => {
    const id1 = await insertPost(engine, { authorId: "alice", content: "Post 1" });
    const id2 = await insertPost(engine, { authorId: "alice", content: "Post 2" });
    await likePost(db, engine, id1, "bob");

    const posts = [
      (await getPost(engine, id1))!,
      (await getPost(engine, id2))!,
    ];
    const enriched = await enrichWithLiked(engine, posts, "bob");
    expect(enriched[0].liked).toBe(true);
    expect(enriched[1].liked).toBe(false);
  });

  it("enrichWithLiked handles empty array", async () => {
    const enriched = await enrichWithLiked(engine, [], "bob");
    expect(enriched).toHaveLength(0);
  });
});
