import { describe, it, expect, beforeEach } from "vitest";
import { createDB, type MatrixDB } from "@matrix-os/kernel";
import {
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  getFollowCounts,
  getFollowingIds,
  isFollowing,
} from "../../packages/gateway/src/social.js";

describe("T2033: Social follows", () => {
  let db: MatrixDB;

  beforeEach(() => {
    db = createDB(":memory:");
  });

  it("follows a user", () => {
    const result = followUser(db, "bob", "alice");
    expect(result).toBe(true);
    expect(isFollowing(db, "bob", "alice")).toBe(true);
  });

  it("returns false when already following", () => {
    followUser(db, "bob", "alice");
    const result = followUser(db, "bob", "alice");
    expect(result).toBe(false);
  });

  it("unfollows a user", () => {
    followUser(db, "bob", "alice");
    const result = unfollowUser(db, "bob", "alice");
    expect(result).toBe(true);
    expect(isFollowing(db, "bob", "alice")).toBe(false);
  });

  it("returns false when unfollowing non-existent follow", () => {
    const result = unfollowUser(db, "bob", "alice");
    expect(result).toBe(false);
  });

  it("gets followers of a user", () => {
    followUser(db, "bob", "alice");
    followUser(db, "carol", "alice");

    const followers = getFollowers(db, "alice");
    expect(followers).toHaveLength(2);
    const followerIds = followers.map((f) => f.followerId);
    expect(followerIds).toContain("bob");
    expect(followerIds).toContain("carol");
  });

  it("gets who a user is following", () => {
    followUser(db, "alice", "bob");
    followUser(db, "alice", "carol");

    const following = getFollowing(db, "alice");
    expect(following).toHaveLength(2);
    const followeeIds = following.map((f) => f.followeeId);
    expect(followeeIds).toContain("bob");
    expect(followeeIds).toContain("carol");
  });

  it("gets follow counts", () => {
    followUser(db, "bob", "alice");
    followUser(db, "carol", "alice");
    followUser(db, "alice", "dave");

    const counts = getFollowCounts(db, "alice");
    expect(counts.followers).toBe(2);
    expect(counts.following).toBe(1);
  });

  it("gets following IDs for feed building", () => {
    followUser(db, "alice", "bob");
    followUser(db, "alice", "carol");

    const ids = getFollowingIds(db, "alice");
    expect(ids).toHaveLength(2);
    expect(ids).toContain("bob");
    expect(ids).toContain("carol");
  });

  it("returns zero counts for unknown user", () => {
    const counts = getFollowCounts(db, "nobody");
    expect(counts.followers).toBe(0);
    expect(counts.following).toBe(0);
  });
});
