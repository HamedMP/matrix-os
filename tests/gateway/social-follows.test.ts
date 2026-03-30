import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { KyselyPGlite } from "kysely-pglite";
import {
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  getFollowCounts,
  getFollowingIds,
  isFollowing,
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

describe("T2050: Social follows (Postgres)", () => {
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

  it("follows a user", async () => {
    expect(await followUser(engine, "alice", "bob")).toBe(true);
    expect(await isFollowing(engine, "alice", "bob")).toBe(true);
  });

  it("prevents double-following", async () => {
    expect(await followUser(engine, "alice", "bob")).toBe(true);
    expect(await followUser(engine, "alice", "bob")).toBe(false);
  });

  it("unfollows a user", async () => {
    await followUser(engine, "alice", "bob");
    expect(await unfollowUser(engine, "alice", "bob")).toBe(true);
    expect(await isFollowing(engine, "alice", "bob")).toBe(false);
  });

  it("returns false when unfollowing non-followed user", async () => {
    expect(await unfollowUser(engine, "alice", "bob")).toBe(false);
  });

  it("gets followers of a user", async () => {
    await followUser(engine, "alice", "bob");
    await followUser(engine, "carol", "bob");

    const followers = await getFollowers(engine, "bob");
    expect(followers).toHaveLength(2);
    const followerIds = followers.map((f) => f.follower_id);
    expect(followerIds).toContain("alice");
    expect(followerIds).toContain("carol");
  });

  it("gets following of a user", async () => {
    await followUser(engine, "alice", "bob");
    await followUser(engine, "alice", "carol");

    const following = await getFollowing(engine, "alice");
    expect(following).toHaveLength(2);
    const followeeIds = following.map((f) => f.followee_id);
    expect(followeeIds).toContain("bob");
    expect(followeeIds).toContain("carol");
  });

  it("gets follow counts", async () => {
    await followUser(engine, "alice", "bob");
    await followUser(engine, "carol", "bob");
    await followUser(engine, "bob", "alice");

    const counts = await getFollowCounts(engine, "bob");
    expect(counts.followers).toBe(2);
    expect(counts.following).toBe(1);
  });

  it("gets following IDs", async () => {
    await followUser(engine, "alice", "bob");
    await followUser(engine, "alice", "carol");
    await followUser(engine, "alice", "dave");

    const ids = await getFollowingIds(engine, "alice");
    expect(ids).toHaveLength(3);
    expect(ids).toContain("bob");
    expect(ids).toContain("carol");
    expect(ids).toContain("dave");
  });

  it("isFollowing returns false for non-followed", async () => {
    expect(await isFollowing(engine, "alice", "bob")).toBe(false);
  });
});
