import { describe, it, expect, beforeEach } from "vitest";
import { createDB, type MatrixDB } from "@matrix-os/kernel";
import { createSocialRoutes, insertPost, followUser } from "../../packages/gateway/src/social.js";

describe("T2031-T2035: Social API routes", () => {
  let db: MatrixDB;
  let app: ReturnType<typeof createSocialRoutes>;
  const currentUser = "alice";

  beforeEach(() => {
    db = createDB(":memory:");
    app = createSocialRoutes(db, () => currentUser);
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
      expect(data.id).toMatch(/^p_/);
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
      insertPost(db, { authorId: "bob", content: "Bob post" });

      const res = await req("GET", "/posts?author=alice");
      const data = await res.json();
      expect(data.posts).toHaveLength(1);
      expect(data.posts[0].authorId).toBe("alice");
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
      const res = await req("GET", "/posts/nonexistent");
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
      const id = insertPost(db, { authorId: "bob", content: "Bob's post" });
      const res = await req("DELETE", `/posts/${id}`);
      expect(res.status).toBe(403);
    });
  });

  // --- Feed ---

  describe("GET /feed", () => {
    it("returns posts from followed users and self", async () => {
      followUser(db, "alice", "bob");
      insertPost(db, { authorId: "bob", content: "Bob post" });
      insertPost(db, { authorId: "carol", content: "Carol post" });
      await req("POST", "/posts", { content: "Alice post" });

      const res = await req("GET", "/feed");
      const data = await res.json();
      expect(data.posts).toHaveLength(2);
      const authors = data.posts.map((p: { authorId: string }) => p.authorId);
      expect(authors).toContain("alice");
      expect(authors).toContain("bob");
    });

    it("falls back to all posts when no follows", async () => {
      insertPost(db, { authorId: "bob", content: "Bob post" });
      await req("POST", "/posts", { content: "Alice post" });

      const res = await req("GET", "/feed");
      const data = await res.json();
      // Should include own posts since alice is in authorIds
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

      // Like
      const likeRes = await req("POST", `/posts/${id}/like`);
      const likeData = await likeRes.json();
      expect(likeData.liked).toBe(true);
      expect(likeData.likesCount).toBe(1);

      // Unlike (toggle)
      const unlikeRes = await req("POST", `/posts/${id}/like`);
      const unlikeData = await unlikeRes.json();
      expect(unlikeData.liked).toBe(false);
      expect(unlikeData.likesCount).toBe(0);
    });

    it("returns 404 for missing post", async () => {
      const res = await req("POST", "/posts/nonexistent/like");
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
      followUser(db, "bob", "alice");
      followUser(db, "carol", "alice");

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
      insertPost(db, { authorId: "bob", content: "Bob post" });
      followUser(db, "alice", "bob");

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
