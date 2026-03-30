import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { KyselyPGlite } from "kysely-pglite";

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

describe("T2050: Social schema (Postgres)", () => {
  let db: AppDb;
  let instance: InstanceType<typeof KyselyPGlite>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    const created = createAppDb({ dialect: instance.dialect });
    db = created.db;
    await db.bootstrap();
    const registry = createAppRegistry(db, created.kysely);
    await registry.register({ slug: "social", name: "Social", tables: SOCIAL_TABLES });
  });

  afterEach(async () => {
    await db.raw("DROP SCHEMA IF EXISTS social CASCADE");
    await db.raw("DELETE FROM public._apps");
    await db.destroy();
  });

  it("creates posts table with correct columns", async () => {
    const result = await db.raw(
      `INSERT INTO "social"."posts" (author_id, content, type, likes_count, comments_count) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      ["alice", "Hello world", "text", 0, 0],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].author_id).toBe("alice");
    expect(result.rows[0].content).toBe("Hello world");
    expect(result.rows[0].id).toBeDefined();
  });

  it("creates likes table", async () => {
    const post = await db.raw(
      `INSERT INTO "social"."posts" (author_id, content, type, likes_count, comments_count) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      ["alice", "test", "text", 0, 0],
    );
    const postId = String(post.rows[0].id);

    await db.raw(
      `INSERT INTO "social"."likes" (post_id, user_id) VALUES ($1, $2)`,
      [postId, "bob"],
    );

    const result = await db.raw(
      `SELECT * FROM "social"."likes" WHERE post_id = $1`,
      [postId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].user_id).toBe("bob");
  });

  it("creates follows table", async () => {
    await db.raw(
      `INSERT INTO "social"."follows" (follower_id, followee_id) VALUES ($1, $2)`,
      ["bob", "alice"],
    );

    const result = await db.raw(
      `SELECT * FROM "social"."follows" WHERE follower_id = $1`,
      ["bob"],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].followee_id).toBe("alice");
  });

  it("app is registered in _apps table", async () => {
    const result = await db.raw(`SELECT * FROM public._apps WHERE slug = $1`, ["social"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Social");
  });

  it("indexes are created", async () => {
    const result = await db.raw(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      ["social"],
    );
    const names = result.rows.map((r) => r.indexname as string);
    expect(names.some((n) => n.includes("author_id"))).toBe(true);
    expect(names.some((n) => n.includes("likes_count"))).toBe(true);
    expect(names.some((n) => n.includes("follower_id"))).toBe(true);
  });
});
