import { describe, it, expect, beforeEach } from "vitest";
import { createDB, type MatrixDB } from "@matrix-os/kernel";

describe("T2030: Social schema", () => {
  let db: MatrixDB;

  beforeEach(() => {
    db = createDB(":memory:");
  });

  it("creates social_posts table with correct columns", () => {
    const client = (db as unknown as { $client: { prepare: (s: string) => { run: (...args: unknown[]) => void; get: (...args: unknown[]) => Record<string, unknown> | undefined } } }).$client;
    client.prepare(
      "INSERT INTO social_posts (id, author_id, content, type, likes_count, comments_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "alice", "Hello world", "text", 0, 0, new Date().toISOString());

    const result = client.prepare("SELECT * FROM social_posts WHERE id = ?").get("p1");

    expect(result).toBeDefined();
    expect(result!.author_id).toBe("alice");
    expect(result!.content).toBe("Hello world");
    expect(result!.type).toBe("text");
    expect(result!.likes_count).toBe(0);
  });

  it("creates social_likes table with unique constraint", () => {
    const client = (db as unknown as { $client: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).$client;
    client.prepare(
      "INSERT INTO social_posts (id, author_id, content, type, likes_count, comments_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "alice", "test", "text", 0, 0, new Date().toISOString());

    client.prepare(
      "INSERT INTO social_likes (post_id, user_id, created_at) VALUES (?, ?, ?)",
    ).run("p1", "bob", new Date().toISOString());

    // Duplicate should fail
    expect(() => {
      client.prepare(
        "INSERT INTO social_likes (post_id, user_id, created_at) VALUES (?, ?, ?)",
      ).run("p1", "bob", new Date().toISOString());
    }).toThrow();
  });

  it("creates social_follows table with unique constraint", () => {
    const client = (db as unknown as { $client: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).$client;
    client.prepare(
      "INSERT INTO social_follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)",
    ).run("bob", "alice", new Date().toISOString());

    // Duplicate should fail
    expect(() => {
      client.prepare(
        "INSERT INTO social_follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)",
      ).run("bob", "alice", new Date().toISOString());
    }).toThrow();
  });

  it("supports parent_id for comment posts", () => {
    const client = (db as unknown as { $client: { prepare: (s: string) => { run: (...args: unknown[]) => void; get: (...args: unknown[]) => Record<string, unknown> | undefined } } }).$client;
    const now = new Date().toISOString();
    client.prepare(
      "INSERT INTO social_posts (id, author_id, content, type, likes_count, comments_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "alice", "Original post", "text", 0, 0, now);

    client.prepare(
      "INSERT INTO social_posts (id, author_id, content, type, parent_id, likes_count, comments_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("c1", "bob", "Nice post!", "text", "p1", 0, 0, now);

    const comment = client.prepare("SELECT * FROM social_posts WHERE id = ?").get("c1");
    expect(comment).toBeDefined();
    expect(comment!.parent_id).toBe("p1");
  });

  it("indexes are created for performance", () => {
    const client = (db as unknown as { $client: { prepare: (s: string) => { all: () => Array<{ name: string }> } } }).$client;
    const indexes = client.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all();
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_posts_author");
    expect(indexNames).toContain("idx_posts_created");
    expect(indexNames).toContain("idx_posts_likes");
    expect(indexNames).toContain("idx_posts_parent");
    expect(indexNames).toContain("idx_likes_post_user");
    expect(indexNames).toContain("idx_follows_pair");
    expect(indexNames).toContain("idx_follows_follower");
    expect(indexNames).toContain("idx_follows_followee");
  });
});
