import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { KyselyPGlite } from "kysely-pglite";
import {
  insertPost,
  getPost,
  deletePost,
  listPosts,
  addComment,
  listComments,
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

describe("T2050: Social posts CRUD (Postgres)", () => {
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

  it("inserts a post and retrieves it", async () => {
    const id = await insertPost(engine, { authorId: "alice", content: "Hello world" });
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");

    const post = await getPost(engine, id);
    expect(post).toBeDefined();
    expect(post!.author_id).toBe("alice");
    expect(post!.content).toBe("Hello world");
    expect(post!.type).toBe("text");
    expect(post!.likes_count).toBe(0);
    expect(post!.comments_count).toBe(0);
    expect(post!.parent_id).toBeNull();
  });

  it("inserts with custom type", async () => {
    const id = await insertPost(engine, { authorId: "alice", content: "Check this", type: "link" });
    const post = await getPost(engine, id);
    expect(post!.type).toBe("link");
  });

  it("deletes a post", async () => {
    const id = await insertPost(engine, { authorId: "alice", content: "to delete" });
    expect(await deletePost(db, engine, id)).toBe(true);
    expect(await getPost(engine, id)).toBeNull();
  });

  it("returns false when deleting non-existent post", async () => {
    expect(await deletePost(db, engine, "nonexistent")).toBe(false);
  });

  it("lists all top-level posts", async () => {
    await insertPost(engine, { authorId: "alice", content: "First" });
    await insertPost(engine, { authorId: "alice", content: "Second" });
    await insertPost(engine, { authorId: "bob", content: "Third" });

    const posts = await listPosts(engine);
    expect(posts).toHaveLength(3);
    const contents = posts.map((p) => p.content);
    expect(contents).toContain("First");
    expect(contents).toContain("Second");
    expect(contents).toContain("Third");
  });

  it("filters posts by author", async () => {
    await insertPost(engine, { authorId: "alice", content: "A1" });
    await insertPost(engine, { authorId: "bob", content: "B1" });
    await insertPost(engine, { authorId: "alice", content: "A2" });

    const alicePosts = await listPosts(engine, { authorId: "alice" });
    expect(alicePosts).toHaveLength(2);
    expect(alicePosts.every((p) => p.author_id === "alice")).toBe(true);
  });

  it("filters posts by type", async () => {
    await insertPost(engine, { authorId: "alice", content: "text post", type: "text" });
    await insertPost(engine, { authorId: "alice", content: "activity", type: "activity" });

    const activities = await listPosts(engine, { type: "activity" });
    expect(activities).toHaveLength(1);
    expect(activities[0].type).toBe("activity");
  });

  it("respects limit and offset", async () => {
    for (let i = 0; i < 10; i++) {
      await insertPost(engine, { authorId: "alice", content: `Post ${i}` });
    }

    const page1 = await listPosts(engine, { limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);

    const page2 = await listPosts(engine, { limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].id).not.toBe(page1[0].id);
  });

  it("excludes comments from listPosts", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Post" });
    await addComment(db, engine, { postId, authorId: "bob", content: "Nice!" });

    const posts = await listPosts(engine);
    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe(postId);
  });

  it("adds and lists comments", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Post" });
    await addComment(db, engine, { postId, authorId: "bob", content: "Comment 1" });
    await addComment(db, engine, { postId, authorId: "carol", content: "Comment 2" });

    const comments = await listComments(engine, postId);
    expect(comments).toHaveLength(2);
    expect(comments[0].content).toBe("Comment 1");
    expect(comments[1].content).toBe("Comment 2");
    expect(comments[0].parent_id).toBe(postId);

    // Parent post should have updated comments_count
    const post = await getPost(engine, postId);
    expect(post!.comments_count).toBe(2);
  });

  it("deleting a post cascades to its comments and likes", async () => {
    const postId = await insertPost(engine, { authorId: "alice", content: "Post" });
    await addComment(db, engine, { postId, authorId: "bob", content: "Comment" });

    await deletePost(db, engine, postId);
    expect(await listComments(engine, postId)).toHaveLength(0);
  });

  it("generates unique post IDs", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(await insertPost(engine, { authorId: "alice", content: `Post ${i}` }));
    }
    expect(ids.size).toBe(100);
  });
});
