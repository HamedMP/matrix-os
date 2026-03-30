import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { KyselyPGlite } from "kysely-pglite";
import { createSocialRoutes, insertPost, followUser } from "../../packages/gateway/src/social.js";

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

describe("T2051: Social API routes (Postgres)", () => {
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

  // --- Posts ---

  describe("POST /posts", () => {
    it("creates a post", async () => {
      const res = await req("POST", "/posts", { content: "Hello world" });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeDefined();
    });

    it("rejects empty content", async () => {
      const res = await req("POST", "/posts", {});
      expect(res.status).toBe(400);
    });

    it("rejects content over 500 chars", async () => {
      const res = await req("POST", "/posts", { content: "x".repeat(501) });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /posts", () => {
    it("lists posts", async () => {
      await req("POST", "/posts", { content: "Post 1" });
      await req("POST", "/posts", { content: "Post 2" });

      const res = await req("GET", "/posts");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.posts).toHaveLength(2);
    });

    it("filters by author", async () => {
      await req("POST", "/posts", { content: "Alice post" });
      await insertPost(engine, { authorId: "bob", content: "Bob post" });

      const res = await req("GET", "/posts?author=alice");
      const data = await res.json();
      expect(data.posts).toHaveLength(1);
      expect(data.posts[0].author_id).toBe("alice");
    });
  });

  describe("GET /posts/:id", () => {
    it("returns post with comments and liked status", async () => {
      const createRes = await req("POST", "/posts", { content: "Test post" });
      const { id } = await createRes.json();

      const res = await req("GET", `/posts/${id}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.post.content).toBe("Test post");
      expect(data.comments).toHaveLength(0);
      expect(data.liked).toBe(false);
    });

    it("returns 404 for missing post", async () => {
      const res = await req("GET", "/posts/00000000-0000-0000-0000-000000000000");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /posts/:id", () => {
    it("deletes own post", async () => {
      const createRes = await req("POST", "/posts", { content: "To delete" });
      const { id } = await createRes.json();

      const res = await req("DELETE", `/posts/${id}`);
      expect(res.status).toBe(200);

      const getRes = await req("GET", `/posts/${id}`);
      expect(getRes.status).toBe(404);
    });

    it("rejects deleting other user's post", async () => {
      const id = await insertPost(engine, { authorId: "bob", content: "Bob's post" });
      const res = await req("DELETE", `/posts/${id}`);
      expect(res.status).toBe(403);
    });
  });

  // --- Feed ---

  describe("GET /feed", () => {
    it("returns posts from followed users and self", async () => {
      await followUser(engine, "alice", "bob");
      await insertPost(engine, { authorId: "bob", content: "Bob post" });
      await insertPost(engine, { authorId: "carol", content: "Carol post" });
      await req("POST", "/posts", { content: "Alice post" });

      const res = await req("GET", "/feed");
      const data = await res.json();
      expect(data.posts).toHaveLength(2);
      const authors = data.posts.map((p: { author_id: string }) => p.author_id);
      expect(authors).toContain("alice");
      expect(authors).toContain("bob");
    });

    it("falls back to all posts when no follows", async () => {
      await insertPost(engine, { authorId: "bob", content: "Bob post" });
      await req("POST", "/posts", { content: "Alice post" });

      const res = await req("GET", "/feed");
      const data = await res.json();
      expect(data.posts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // --- Explore ---

  describe("GET /explore", () => {
    it("returns trending posts", async () => {
      await req("POST", "/posts", { content: "Trending" });
      const res = await req("GET", "/explore");
      const data = await res.json();
      expect(data.posts).toHaveLength(1);
    });
  });

  // --- Likes ---

  describe("POST /posts/:id/like", () => {
    it("toggles like on and off", async () => {
      const createRes = await req("POST", "/posts", { content: "Likeable" });
      const { id } = await createRes.json();

      const likeRes = await req("POST", `/posts/${id}/like`);
      const likeData = await likeRes.json();
      expect(likeData.liked).toBe(true);
      expect(likeData.likesCount).toBe(1);

      const unlikeRes = await req("POST", `/posts/${id}/like`);
      const unlikeData = await unlikeRes.json();
      expect(unlikeData.liked).toBe(false);
      expect(unlikeData.likesCount).toBe(0);
    });

    it("returns 404 for missing post", async () => {
      const res = await req("POST", "/posts/00000000-0000-0000-0000-000000000000/like");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /posts/:id/likes", () => {
    it("returns likers list", async () => {
      const createRes = await req("POST", "/posts", { content: "Popular" });
      const { id } = await createRes.json();
      await req("POST", `/posts/${id}/like`);

      const res = await req("GET", `/posts/${id}/likes`);
      const data = await res.json();
      expect(data.likers).toContain("alice");
    });
  });

  // --- Comments ---

  describe("POST /posts/:id/comments", () => {
    it("adds a comment to a post", async () => {
      const createRes = await req("POST", "/posts", { content: "Post" });
      const { id } = await createRes.json();

      const commentRes = await req("POST", `/posts/${id}/comments`, { content: "Nice!" });
      expect(commentRes.status).toBe(201);

      const getRes = await req("GET", `/posts/${id}/comments`);
      const data = await getRes.json();
      expect(data.comments).toHaveLength(1);
      expect(data.comments[0].content).toBe("Nice!");
    });

    it("rejects empty comment", async () => {
      const createRes = await req("POST", "/posts", { content: "Post" });
      const { id } = await createRes.json();
      const res = await req("POST", `/posts/${id}/comments`, {});
      expect(res.status).toBe(400);
    });
  });

  // --- Follows ---

  describe("POST /follows", () => {
    it("follows a user", async () => {
      const res = await req("POST", "/follows", { handle: "bob" });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.followed).toBe(true);
    });

    it("rejects following yourself", async () => {
      const res = await req("POST", "/follows", { handle: "alice" });
      expect(res.status).toBe(400);
    });

    it("rejects missing handle", async () => {
      const res = await req("POST", "/follows", {});
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /follows/:handle", () => {
    it("unfollows a user", async () => {
      await req("POST", "/follows", { handle: "bob" });
      const res = await req("DELETE", "/follows/bob");
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.unfollowed).toBe(true);
    });
  });

  describe("GET /followers/:handle and /following/:handle", () => {
    it("returns followers and following lists", async () => {
      await followUser(engine, "bob", "alice");
      await followUser(engine, "carol", "alice");

      const followersRes = await req("GET", "/followers/alice");
      const followersData = await followersRes.json();
      expect(followersData.count).toBe(2);

      const followingRes = await req("GET", "/following/alice");
      const followingData = await followingRes.json();
      expect(followingData.count).toBe(0);
    });
  });

  // --- Users ---

  describe("GET /users", () => {
    it("returns current user", async () => {
      const res = await req("GET", "/users");
      const data = await res.json();
      expect(data.users).toHaveLength(1);
      expect(data.users[0].handle).toBe("alice");
    });
  });

  describe("GET /users/:handle", () => {
    it("returns user stats and following status", async () => {
      await insertPost(engine, { authorId: "bob", content: "Bob post" });
      await followUser(engine, "alice", "bob");

      const res = await req("GET", "/users/bob");
      const data = await res.json();
      expect(data.handle).toBe("bob");
      expect(data.postCount).toBe(1);
      expect(data.following).toBe(true);
    });

    it("following is false for own profile", async () => {
      const res = await req("GET", "/users/alice");
      const data = await res.json();
      expect(data.following).toBe(false);
    });
  });
});
