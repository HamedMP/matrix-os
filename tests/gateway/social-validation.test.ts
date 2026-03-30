import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { KyselyPGlite } from "kysely-pglite";
import { createSocialRoutes, insertPost } from "../../packages/gateway/src/social.js";

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

describe("Social API validation (Postgres)", () => {
  let db: AppDb;
  let engine: QueryEngine;
  let app: ReturnType<typeof createSocialRoutes>;
  let instance: InstanceType<typeof KyselyPGlite>;
  const currentUser = "alice";

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    const created = createAppDb({ dialect: instance.dialect });
    db = created.db;
    await db.bootstrap();
    const registry = createAppRegistry(db, created.kysely);
    await registry.register({ slug: "social", name: "Social", tables: SOCIAL_TABLES });
    engine = createQueryEngine(db);
    app = createSocialRoutes(db, engine, () => currentUser);
  });

  afterEach(async () => {
    await db.raw("DROP SCHEMA IF EXISTS social CASCADE");
    await db.raw("DELETE FROM public._apps");
    await db.destroy();
  });

  function req(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method };
    if (body) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    return app.request(path, init);
  }

  describe("POST /posts content length", () => {
    it("rejects content longer than 500 characters", async () => {
      const res = await req("POST", "/posts", { content: "x".repeat(501) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("500");
    });

    it("accepts content at exactly 500 characters", async () => {
      const res = await req("POST", "/posts", { content: "x".repeat(500) });
      expect(res.status).toBe(201);
    });
  });

  describe("DELETE /posts/:id authorization", () => {
    it("returns 403 when deleting another user's post", async () => {
      const postId = await insertPost(engine, { authorId: "bob", content: "Bob post" });
      const res = await req("DELETE", `/posts/${postId}`);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("Not authorized");
    });

    it("returns 404 when deleting non-existent post", async () => {
      const res = await req("DELETE", "/posts/00000000-0000-0000-0000-000000000000");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /posts/:id/comments validation", () => {
    it("rejects comment on non-existent post", async () => {
      const res = await req("POST", "/posts/00000000-0000-0000-0000-000000000000/comments", { content: "Hello" });
      expect(res.status).toBe(404);
    });

    it("rejects comment with empty content", async () => {
      const createRes = await req("POST", "/posts", { content: "A post" });
      const { id } = await createRes.json();
      const res = await req("POST", `/posts/${id}/comments`, {});
      expect(res.status).toBe(400);
    });
  });

  describe("GET /posts list with query params", () => {
    it("respects limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await req("POST", "/posts", { content: `Post ${i}` });
      }

      const res = await req("GET", "/posts?limit=2&offset=1");
      const data = await res.json();
      expect(data.posts).toHaveLength(2);
    });

    it("filters by type", async () => {
      await req("POST", "/posts", { content: "Regular post" });
      await insertPost(engine, { authorId: "alice", content: "Activity post", type: "activity" });

      const res = await req("GET", "/posts?type=activity");
      const data = await res.json();
      expect(data.posts).toHaveLength(1);
      expect(data.posts[0].type).toBe("activity");
    });
  });

  describe("GET /feed with cursor", () => {
    it("supports cursor-based pagination", async () => {
      for (let i = 0; i < 3; i++) {
        await req("POST", "/posts", { content: `Post ${i}` });
      }

      const firstPage = await req("GET", "/feed?limit=2");
      const firstData = await firstPage.json();
      expect(firstData.posts.length).toBeLessThanOrEqual(2);
    });
  });

  describe("GET /explore with limit", () => {
    it("respects custom limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await req("POST", "/posts", { content: `Post ${i}` });
      }

      const res = await req("GET", "/explore?limit=3");
      const data = await res.json();
      expect(data.posts.length).toBeLessThanOrEqual(3);
    });
  });
});
