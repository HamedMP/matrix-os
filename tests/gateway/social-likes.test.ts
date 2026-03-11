import { describe, it, expect, beforeEach } from "vitest";
import { createDB, type MatrixDB } from "@matrix-os/kernel";
import {
  insertPost,
  getPost,
  likePost,
  unlikePost,
  isLikedBy,
  getLikers,
} from "../../packages/gateway/src/social.js";

describe("T2034: Social likes", () => {
  let db: MatrixDB;
  let postId: string;

  beforeEach(() => {
    db = createDB(":memory:");
    postId = insertPost(db, { authorId: "alice", content: "Like this" });
  });

  it("likes a post", () => {
    const result = likePost(db, postId, "bob");
    expect(result).toBe(true);
    expect(isLikedBy(db, postId, "bob")).toBe(true);

    const post = getPost(db, postId);
    expect(post!.likesCount).toBe(1);
  });

  it("returns false when already liked", () => {
    likePost(db, postId, "bob");
    const result = likePost(db, postId, "bob");
    expect(result).toBe(false);

    // Count should still be 1
    const post = getPost(db, postId);
    expect(post!.likesCount).toBe(1);
  });

  it("unlikes a post", () => {
    likePost(db, postId, "bob");
    const result = unlikePost(db, postId, "bob");
    expect(result).toBe(true);
    expect(isLikedBy(db, postId, "bob")).toBe(false);

    const post = getPost(db, postId);
    expect(post!.likesCount).toBe(0);
  });

  it("returns false when unliking non-liked post", () => {
    const result = unlikePost(db, postId, "bob");
    expect(result).toBe(false);
  });

  it("multiple users can like a post", () => {
    likePost(db, postId, "bob");
    likePost(db, postId, "carol");
    likePost(db, postId, "dave");

    const post = getPost(db, postId);
    expect(post!.likesCount).toBe(3);

    const likers = getLikers(db, postId);
    expect(likers).toHaveLength(3);
    expect(likers).toContain("bob");
    expect(likers).toContain("carol");
    expect(likers).toContain("dave");
  });

  it("likes count does not go below 0", () => {
    // Edge case: try unliking when count is 0
    unlikePost(db, postId, "bob");
    const post = getPost(db, postId);
    expect(post!.likesCount).toBe(0);
  });

  it("isLikedBy returns false for non-liked post", () => {
    expect(isLikedBy(db, postId, "bob")).toBe(false);
  });

  it("getLikers returns empty for post with no likes", () => {
    expect(getLikers(db, postId)).toHaveLength(0);
  });
});
