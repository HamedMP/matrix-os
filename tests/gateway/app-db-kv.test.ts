import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createKvStore, type KvStore } from "../../packages/gateway/src/app-db-kv.js";
import { KyselyPGlite } from "kysely-pglite";

describe("KvStore", () => {
  let db: AppDb;
  let kv: KvStore;
  let instance: InstanceType<typeof KyselyPGlite>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    const created = createAppDb({ dialect: instance.dialect });
    db = created.db;
    await db.bootstrap();
    kv = createKvStore(created.kysely);
  });

  afterEach(async () => {
    await db.raw("DELETE FROM public._kv");
    await db.destroy();
  });

  it("read returns null for non-existent key", async () => {
    const value = await kv.read("todo", "tasks");
    expect(value).toBeNull();
  });

  it("write and read roundtrip", async () => {
    await kv.write("todo", "tasks", JSON.stringify([{ id: 1, text: "Buy milk" }]));
    const value = await kv.read("todo", "tasks");
    expect(value).toBe(JSON.stringify([{ id: 1, text: "Buy milk" }]));
  });

  it("write upserts on conflict", async () => {
    await kv.write("todo", "tasks", "old");
    await kv.write("todo", "tasks", "new");
    const value = await kv.read("todo", "tasks");
    expect(value).toBe("new");
  });

  it("list returns all keys for an app", async () => {
    await kv.write("todo", "tasks", "[]");
    await kv.write("todo", "settings", "{}");
    await kv.write("notes", "entries", "[]");

    const keys = await kv.list("todo");
    expect(keys).toEqual(["settings", "tasks"]);
  });

  it("list returns empty array for app with no keys", async () => {
    const keys = await kv.list("nonexistent");
    expect(keys).toEqual([]);
  });

  it("apps are isolated", async () => {
    await kv.write("app-a", "data", "secret");
    const value = await kv.read("app-b", "data");
    expect(value).toBeNull();
  });

  it("handles empty string values", async () => {
    await kv.write("todo", "empty", "");
    const value = await kv.read("todo", "empty");
    expect(value).toBe("");
  });

  it("handles large values", async () => {
    const large = "x".repeat(100000);
    await kv.write("todo", "big", large);
    const value = await kv.read("todo", "big");
    expect(value).toBe(large);
  });
});
