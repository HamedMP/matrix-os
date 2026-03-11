import { describe, it, expect, beforeEach } from "vitest";
import { createDB, type MatrixDB } from "@matrix-os/kernel";
import {
  insertPost,
  listFeed,
  listTrendingPosts,
  followUser,
  likePost,
} from "../../packages/gateway/src/social.js";

describe("T2032: Social feed", () => {
  let db: MatrixDB;

  beforeEach(() => {
    db = createDB(":memory:");
  });

  it("returns empty feed when no follows", () => {
    insertPost(db, { authorId: "alice", content: "Hello" });
    const result = listFeed(db, { authorIds: [] });
    expect(result.posts).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("returns posts from followed users", () => {
    insertPost(db, { authorId: "alice", content: "Alice post" });
    insertPost(db, { authorId: "bob", content: "Bob post" });
    insertPost(db, { authorId: "carol", content: "Carol post" });

    const result = listFeed(db, { authorIds: ["alice", "bob"] });
    expect(result.posts).toHaveLength(2);
    const authors = result.posts.map((p) => p.authorId);
    expect(authors).toContain("alice");
    expect(authors).toContain("bob");
    expect(authors).not.toContain("carol");
  });

  it("paginates with cursor", () => {
    for (let i = 0; i < 5; i++) {
      insertPost(db, { authorId: "alice", content: `Post ${i}` });
    }

    const page1 = listFeed(db, { authorIds: ["alice"], limit: 2 });
    expect(page1.posts).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBeDefined();

    const page2 = listFeed(db, { authorIds: ["alice"], limit: 2, cursor: page1.cursor });
    expect(page2.posts).toHaveLength(2);

    // Pages should not overlap
    const page1Ids = new Set(page1.posts.map((p) => p.id));
    for (const post of page2.posts) {
      expect(page1Ids.has(post.id)).toBe(false);
    }
  });

  it("hasMore is false when fewer posts than limit", () => {
    insertPost(db, { authorId: "alice", content: "Only one" });
    const result = listFeed(db, { authorIds: ["alice"], limit: 10 });
    expect(result.hasMore).toBe(false);
  });

  it("excludes comments from feed", () => {
    const postId = insertPost(db, { authorId: "alice", content: "Post" });
    insertPost(db, { authorId: "alice", content: "Comment", parentId: postId });

    const result = listFeed(db, { authorIds: ["alice"] });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].id).toBe(postId);
  });

  it("lists trending posts ordered by likes", () => {
    const p1 = insertPost(db, { authorId: "alice", content: "Popular" });
    const p2 = insertPost(db, { authorId: "bob", content: "Less popular" });
    insertPost(db, { authorId: "carol", content: "Not popular" });

    likePost(db, p1, "user1");
    likePost(db, p1, "user2");
    likePost(db, p1, "user3");
    likePost(db, p2, "user1");

    const trending = listTrendingPosts(db, 10);
    expect(trending).toHaveLength(3);
    expect(trending[0].id).toBe(p1);
    expect(trending[1].id).toBe(p2);
  });
});
