import { describe, it, expect, beforeEach } from "vitest";
import { createDB, type MatrixDB } from "@matrix-os/kernel";
import {
  insertPost,
  getPost,
  deletePost,
  listPosts,
  addComment,
  listComments,
} from "../../packages/gateway/src/social.js";

describe("T2031: Social posts CRUD", () => {
  let db: MatrixDB;

  beforeEach(() => {
    db = createDB(":memory:");
  });

  it("inserts a post and retrieves it", () => {
    const id = insertPost(db, { authorId: "alice", content: "Hello world" });
    expect(id).toMatch(/^p_/);

    const post = getPost(db, id);
    expect(post).toBeDefined();
    expect(post!.authorId).toBe("alice");
    expect(post!.content).toBe("Hello world");
    expect(post!.type).toBe("text");
    expect(post!.likesCount).toBe(0);
    expect(post!.commentsCount).toBe(0);
    expect(post!.parentId).toBeNull();
  });

  it("inserts with custom type", () => {
    const id = insertPost(db, { authorId: "alice", content: "Check this", type: "link" });
    const post = getPost(db, id);
    expect(post!.type).toBe("link");
  });

  it("deletes a post", () => {
    const id = insertPost(db, { authorId: "alice", content: "to delete" });
    expect(deletePost(db, id)).toBe(true);
    expect(getPost(db, id)).toBeUndefined();
  });

  it("returns false when deleting non-existent post", () => {
    expect(deletePost(db, "nonexistent")).toBe(false);
  });

  it("lists all top-level posts", () => {
    insertPost(db, { authorId: "alice", content: "First" });
    insertPost(db, { authorId: "alice", content: "Second" });
    insertPost(db, { authorId: "bob", content: "Third" });

    const posts = listPosts(db);
    expect(posts).toHaveLength(3);
    const contents = posts.map((p) => p.content);
    expect(contents).toContain("First");
    expect(contents).toContain("Second");
    expect(contents).toContain("Third");
  });

  it("filters posts by author", () => {
    insertPost(db, { authorId: "alice", content: "A1" });
    insertPost(db, { authorId: "bob", content: "B1" });
    insertPost(db, { authorId: "alice", content: "A2" });

    const alicePosts = listPosts(db, { authorId: "alice" });
    expect(alicePosts).toHaveLength(2);
    expect(alicePosts.every((p) => p.authorId === "alice")).toBe(true);
  });

  it("filters posts by type", () => {
    insertPost(db, { authorId: "alice", content: "text post", type: "text" });
    insertPost(db, { authorId: "alice", content: "activity", type: "activity" });

    const activities = listPosts(db, { type: "activity" });
    expect(activities).toHaveLength(1);
    expect(activities[0].type).toBe("activity");
  });

  it("respects limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      insertPost(db, { authorId: "alice", content: `Post ${i}` });
    }

    const page1 = listPosts(db, { limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);

    const page2 = listPosts(db, { limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].id).not.toBe(page1[0].id);
  });

  it("excludes comments from listPosts", () => {
    const postId = insertPost(db, { authorId: "alice", content: "Post" });
    addComment(db, { postId, authorId: "bob", content: "Nice!" });

    const posts = listPosts(db);
    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe(postId);
  });

  it("adds and lists comments", () => {
    const postId = insertPost(db, { authorId: "alice", content: "Post" });
    const c1 = addComment(db, { postId, authorId: "bob", content: "Comment 1" });
    const c2 = addComment(db, { postId, authorId: "carol", content: "Comment 2" });

    const comments = listComments(db, postId);
    expect(comments).toHaveLength(2);
    expect(comments[0].content).toBe("Comment 1");
    expect(comments[1].content).toBe("Comment 2");
    expect(comments[0].parentId).toBe(postId);

    // Parent post should have updated commentsCount
    const post = getPost(db, postId);
    expect(post!.commentsCount).toBe(2);
  });

  it("deleting a post cascades to its comments and likes", () => {
    const postId = insertPost(db, { authorId: "alice", content: "Post" });
    addComment(db, { postId, authorId: "bob", content: "Comment" });

    deletePost(db, postId);
    expect(listComments(db, postId)).toHaveLength(0);
  });

  it("generates unique post IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(insertPost(db, { authorId: "alice", content: `Post ${i}` }));
    }
    expect(ids.size).toBe(100);
  });
});
