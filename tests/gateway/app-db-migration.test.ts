import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createKvStore, type KvStore } from "../../packages/gateway/src/app-db-kv.js";
import { migrateJsonToKv } from "../../packages/gateway/src/app-db-migration.js";
import { KyselyPGlite } from "kysely-pglite";

describe("migrateJsonToKv", () => {
  let db: AppDb;
  let kv: KvStore;
  let homePath: string;
  let instance: InstanceType<typeof KyselyPGlite>;

  beforeEach(async () => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "migrate-test-")));
    instance = await KyselyPGlite.create();
    const created = createAppDb({ dialect: instance.dialect });
    db = created.db;
    await db.bootstrap();
    kv = createKvStore(created.kysely);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(homePath, { recursive: true, force: true });
  });

  it("migrates JSON files to _kv table", async () => {
    mkdirSync(join(homePath, "data/todo"), { recursive: true });
    writeFileSync(join(homePath, "data/todo/tasks.json"), JSON.stringify([{ id: 1, text: "Buy milk" }]));
    writeFileSync(join(homePath, "data/todo/settings.json"), JSON.stringify({ theme: "dark" }));

    const result = await migrateJsonToKv(homePath, kv);
    expect(result.apps).toBe(1);
    expect(result.keys).toBe(2);
    expect(result.errors).toHaveLength(0);

    const tasks = await kv.read("todo", "tasks");
    expect(tasks).toBe(JSON.stringify([{ id: 1, text: "Buy milk" }]));

    const settings = await kv.read("todo", "settings");
    expect(settings).toBe(JSON.stringify({ theme: "dark" }));
  });

  it("handles multiple apps", async () => {
    mkdirSync(join(homePath, "data/todo"), { recursive: true });
    mkdirSync(join(homePath, "data/notes"), { recursive: true });
    writeFileSync(join(homePath, "data/todo/tasks.json"), "[]");
    writeFileSync(join(homePath, "data/notes/entries.json"), "[]");

    const result = await migrateJsonToKv(homePath, kv);
    expect(result.apps).toBe(2);
    expect(result.keys).toBe(2);
  });

  it("returns empty result for missing data dir", async () => {
    const result = await migrateJsonToKv(homePath, kv);
    expect(result.apps).toBe(0);
    expect(result.keys).toBe(0);
  });

  it("is idempotent", async () => {
    mkdirSync(join(homePath, "data/todo"), { recursive: true });
    writeFileSync(join(homePath, "data/todo/tasks.json"), "[]");

    await migrateJsonToKv(homePath, kv);
    await migrateJsonToKv(homePath, kv);

    const keys = await kv.list("todo");
    expect(keys).toEqual(["tasks"]);
  });

  it("skips directories with no JSON files", async () => {
    mkdirSync(join(homePath, "data/empty-app"), { recursive: true });
    writeFileSync(join(homePath, "data/empty-app/readme.txt"), "not json");

    const result = await migrateJsonToKv(homePath, kv);
    expect(result.apps).toBe(0);
    expect(result.keys).toBe(0);
  });

  it("handles non-JSON content gracefully", async () => {
    mkdirSync(join(homePath, "data/weird"), { recursive: true });
    writeFileSync(join(homePath, "data/weird/raw.json"), "this is not json but has .json ext");

    const result = await migrateJsonToKv(homePath, kv);
    expect(result.apps).toBe(1);
    expect(result.keys).toBe(1);

    const value = await kv.read("weird", "raw");
    expect(value).toBe("this is not json but has .json ext");
  });
});
