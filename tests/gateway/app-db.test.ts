import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { KyselyPGlite } from "kysely-pglite";

describe("AppDb connection", () => {
  let db: AppDb;
  let instance: InstanceType<typeof KyselyPGlite>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    ({ db } = createAppDb({ dialect: instance.dialect }));
    await db.bootstrap();
  });

  afterEach(async () => {
    await db.raw("DROP SCHEMA IF EXISTS test_app CASCADE");
    await db.destroy();
  });

  it("bootstraps _apps, _kv, and users tables in public schema", async () => {
    const tables = await db.raw(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('_apps', '_kv', 'users') ORDER BY table_name",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(["_apps", "_kv", "users"]);
  });

  it("tracks the immutable installed app version for first-run migrations", async () => {
    const columns = await db.raw(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '_apps' ORDER BY ordinal_position",
    );
    expect(columns.rows.map((row) => row.column_name)).toContain("installed_version");
  });

  it("adds install-version tracking without classifying legacy apps as new", async () => {
    await db.raw("ALTER TABLE public._apps DROP COLUMN installed_version");
    await db.raw(
      "INSERT INTO public._apps (slug, name, version, tables) VALUES ($1, $2, $3, $4::jsonb)",
      ["legacy-clock", "Clock", "1.0.0", "{}"],
    );

    await db.bootstrap();

    const app = await db.raw(
      "SELECT installed_version FROM public._apps WHERE slug = $1",
      ["legacy-clock"],
    );
    expect(app.rows[0]?.installed_version).toBeNull();
  });

  it("creates a schema for an app", async () => {
    await db.createAppSchema("test-app");
    const schemas = await db.raw(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'test-app'",
    );
    expect(schemas.rows).toHaveLength(1);
  });

  it("drops a schema for an app", async () => {
    await db.createAppSchema("test-app");
    await db.dropAppSchema("test-app");
    const schemas = await db.raw(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'test-app'",
    );
    expect(schemas.rows).toHaveLength(0);
  });

  it("rejects invalid schema names", async () => {
    await expect(db.createAppSchema("../evil")).rejects.toThrow(/invalid/i);
    await expect(db.createAppSchema("")).rejects.toThrow(/invalid/i);
    await expect(db.createAppSchema("DROP TABLE")).rejects.toThrow(/invalid/i);
  });

  it("creates tables in app schema from column definitions", async () => {
    await db.createAppSchema("test-app");
    await db.createTable("test-app", "items", {
      title: "text",
      done: "boolean",
      count: "integer",
    });

    const cols = await db.raw(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'test-app' AND table_name = 'items' ORDER BY ordinal_position",
    );
    const colNames = cols.rows.map((r) => r.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("title");
    expect(colNames).toContain("done");
    expect(colNames).toContain("count");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
  });

  it("ignores built-in columns declared by app manifests", async () => {
    await db.createAppSchema("test-app");
    await db.createTable("test-app", "items", {
      id: "uuid",
      title: "text",
      created_at: "timestamptz",
      updated_at: "timestamptz",
    });

    const cols = await db.raw(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'test-app' AND table_name = 'items' ORDER BY ordinal_position",
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["id", "title", "created_at", "updated_at"]);
  });

  it("creates indexes on specified columns", async () => {
    await db.createAppSchema("test-app");
    await db.createTable("test-app", "items", { title: "text", done: "boolean" }, ["title"]);

    const indexes = await db.raw(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'test-app' AND tablename = 'items' AND indexname LIKE 'idx_%'",
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0].indexname).toContain("title");
  });

  it("creates unique indexes on specified columns", async () => {
    await db.createAppSchema("test-app");
    await db.createTable("test-app", "items", { title: "text" }, undefined, ["title"]);

    const indexes = await db.raw(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'test-app' AND tablename = 'items' AND indexname LIKE 'uidx_%'",
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0].indexname).toContain("title");

    await db.raw('INSERT INTO "test-app"."items" (title) VALUES ($1)', ["Unique title"]);
    await expect(
      db.raw('INSERT INTO "test-app"."items" (title) VALUES ($1)', ["Unique title"]),
    ).rejects.toThrow();
  });

  it("rejects invalid index column names instead of silently skipping manifest constraints", async () => {
    await db.createAppSchema("test-app");

    await expect(
      db.createTable("test-app", "items", { title: "text" }, ["../title"]),
    ).rejects.toThrow(/invalid index column name/i);
    await expect(
      db.createTable("test-app", "items", { title: "text" }, undefined, ["../title"]),
    ).rejects.toThrow(/invalid unique index column name/i);
  });

  it("maps type aliases correctly", async () => {
    await db.createAppSchema("test-app");
    await db.createTable("test-app", "typed", {
      name: "string",
      active: "bool",
      price: "float",
      when: "timestamp",
      data: "json",
    });

    const cols = await db.raw(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'test-app' AND table_name = 'typed' AND column_name NOT IN ('id', 'created_at', 'updated_at') ORDER BY ordinal_position",
    );
    const typeMap: Record<string, string> = {};
    for (const row of cols.rows) {
      typeMap[row.column_name as string] = row.data_type as string;
    }
    expect(typeMap.name).toBe("text");
    expect(typeMap.active).toBe("boolean");
    expect(typeMap.price).toBe("double precision");
    expect(typeMap.when).toContain("timestamp");
    expect(typeMap.data).toBe("jsonb");
  });

  it("createTable is idempotent", async () => {
    await db.createAppSchema("test-app");
    await db.createTable("test-app", "items", { title: "text" });
    await db.createTable("test-app", "items", { title: "text" });
    // No error on second call
    const cols = await db.raw(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'test-app' AND table_name = 'items'",
    );
    expect(cols.rows.length).toBeGreaterThan(0);
  });

  it("rejects invalid table names", async () => {
    await db.createAppSchema("test-app");
    await expect(db.createTable("test-app", "../evil", { x: "text" })).rejects.toThrow(/invalid/i);
  });
});
