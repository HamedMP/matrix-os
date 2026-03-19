import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry, type AppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { KyselyPGlite } from "kysely-pglite";

describe("AppRegistry", () => {
  let db: AppDb;
  let registry: AppRegistry;
  let instance: InstanceType<typeof KyselyPGlite>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    db = createAppDb({ dialect: instance.dialect });
    await db.bootstrap();
    registry = createAppRegistry(db);
  });

  afterEach(async () => {
    await db.raw("DROP SCHEMA IF EXISTS todo CASCADE");
    await db.raw("DROP SCHEMA IF EXISTS notes CASCADE");
    await db.raw("DELETE FROM public._apps");
    await db.destroy();
  });

  it("registers an app with schema and tables", async () => {
    await registry.register({
      slug: "todo",
      name: "Todo",
      tables: {
        tasks: {
          columns: { title: "text", done: "boolean", due: "timestamptz" },
          indexes: ["due"],
        },
      },
    });

    const app = await registry.get("todo");
    expect(app).toBeDefined();
    expect(app!.name).toBe("Todo");
    expect(app!.tables).toHaveProperty("tasks");
  });

  it("creates Postgres schema and tables on register", async () => {
    await registry.register({
      slug: "todo",
      name: "Todo",
      tables: {
        tasks: {
          columns: { title: "text", done: "boolean" },
        },
      },
    });

    const schemas = await db.raw(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'todo'",
    );
    expect(schemas.rows).toHaveLength(1);

    const cols = await db.raw(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'todo' AND table_name = 'tasks'",
    );
    const colNames = cols.rows.map((r) => r.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("title");
    expect(colNames).toContain("done");
  });

  it("lists all registered apps", async () => {
    await registry.register({ slug: "todo", name: "Todo", tables: {} });
    await registry.register({ slug: "notes", name: "Notes", tables: {} });

    const apps = await registry.listApps();
    expect(apps).toHaveLength(2);
    expect(apps.map((a) => a.slug).sort()).toEqual(["notes", "todo"]);
  });

  it("returns schema info for agent introspection", async () => {
    await registry.register({
      slug: "todo",
      name: "Todo",
      tables: {
        tasks: {
          columns: { title: "text", done: "boolean", due: "timestamptz" },
          indexes: ["due"],
        },
      },
    });

    const schema = await registry.getSchema("todo");
    expect(schema).toHaveProperty("tasks");
    expect(schema.tasks.columns).toHaveProperty("title");
  });

  it("unregisters an app and drops schema", async () => {
    await registry.register({ slug: "todo", name: "Todo", tables: {} });
    await registry.unregister("todo");

    const app = await registry.get("todo");
    expect(app).toBeNull();

    const schemas = await db.raw(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'todo'",
    );
    expect(schemas.rows).toHaveLength(0);
  });

  it("upserts on re-register", async () => {
    await registry.register({ slug: "todo", name: "Todo v1", tables: {} });
    await registry.register({ slug: "todo", name: "Todo v2", tables: {} });

    const apps = await registry.listApps();
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Todo v2");
  });

  it("returns null for non-existent app", async () => {
    const app = await registry.get("nonexistent");
    expect(app).toBeNull();
  });

  it("getSchema throws for non-existent app", async () => {
    await expect(registry.getSchema("nonexistent")).rejects.toThrow(/not found/i);
  });
});
