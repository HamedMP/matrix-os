import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { KyselyPGlite } from "kysely-pglite";

describe("QueryEngine", () => {
  let db: AppDb;
  let engine: QueryEngine;
  let instance: InstanceType<typeof KyselyPGlite>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    db = createAppDb({ dialect: instance.dialect });
    await db.bootstrap();
    const registry = createAppRegistry(db);
    await registry.register({
      slug: "todo",
      name: "Todo",
      tables: {
        tasks: {
          columns: { title: "text", done: "boolean", due: "timestamptz", priority: "integer" },
          indexes: ["due"],
        },
      },
    });
    engine = createQueryEngine(db);
  });

  afterEach(async () => {
    await db.raw("DROP SCHEMA IF EXISTS todo CASCADE");
    await db.raw("DELETE FROM public._apps");
    await db.destroy();
  });

  it("inserts a row and returns id", async () => {
    const result = await engine.insert("todo", "tasks", {
      title: "Buy milk",
      done: false,
      priority: 1,
    });
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe("string");
  });

  it("finds rows with no filter", async () => {
    await engine.insert("todo", "tasks", { title: "A", done: false });
    await engine.insert("todo", "tasks", { title: "B", done: true });

    const rows = await engine.find("todo", "tasks");
    expect(rows).toHaveLength(2);
  });

  it("finds rows with equality filter", async () => {
    await engine.insert("todo", "tasks", { title: "A", done: false });
    await engine.insert("todo", "tasks", { title: "B", done: true });

    const rows = await engine.find("todo", "tasks", { filter: { done: false } });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("A");
  });

  it("finds rows with $lte filter", async () => {
    await engine.insert("todo", "tasks", { title: "Soon", due: "2026-03-20T00:00:00Z", done: false });
    await engine.insert("todo", "tasks", { title: "Later", due: "2026-04-01T00:00:00Z", done: false });

    const rows = await engine.find("todo", "tasks", {
      filter: { due: { $lte: "2026-03-21T00:00:00Z" } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Soon");
  });

  it("finds rows with $gt filter", async () => {
    await engine.insert("todo", "tasks", { title: "Low", priority: 1, done: false });
    await engine.insert("todo", "tasks", { title: "High", priority: 5, done: false });

    const rows = await engine.find("todo", "tasks", {
      filter: { priority: { $gt: 3 } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("High");
  });

  it("finds rows with $in filter", async () => {
    await engine.insert("todo", "tasks", { title: "A", priority: 1, done: false });
    await engine.insert("todo", "tasks", { title: "B", priority: 2, done: false });
    await engine.insert("todo", "tasks", { title: "C", priority: 3, done: false });

    const rows = await engine.find("todo", "tasks", {
      filter: { priority: { $in: [1, 3] } },
    });
    expect(rows).toHaveLength(2);
  });

  it("finds rows with $like filter", async () => {
    await engine.insert("todo", "tasks", { title: "Buy milk", done: false });
    await engine.insert("todo", "tasks", { title: "Buy eggs", done: false });
    await engine.insert("todo", "tasks", { title: "Clean house", done: false });

    const rows = await engine.find("todo", "tasks", {
      filter: { title: { $like: "Buy%" } },
    });
    expect(rows).toHaveLength(2);
  });

  it("finds rows with $ne filter", async () => {
    await engine.insert("todo", "tasks", { title: "A", done: false });
    await engine.insert("todo", "tasks", { title: "B", done: true });

    const rows = await engine.find("todo", "tasks", {
      filter: { done: { $ne: true } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("A");
  });

  it("supports orderBy and limit", async () => {
    await engine.insert("todo", "tasks", { title: "C", priority: 3, done: false });
    await engine.insert("todo", "tasks", { title: "A", priority: 1, done: false });
    await engine.insert("todo", "tasks", { title: "B", priority: 2, done: false });

    const rows = await engine.find("todo", "tasks", {
      orderBy: { priority: "asc" },
      limit: 2,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("A");
    expect(rows[1].title).toBe("B");
  });

  it("supports offset for pagination", async () => {
    await engine.insert("todo", "tasks", { title: "A", priority: 1, done: false });
    await engine.insert("todo", "tasks", { title: "B", priority: 2, done: false });
    await engine.insert("todo", "tasks", { title: "C", priority: 3, done: false });

    const rows = await engine.find("todo", "tasks", {
      orderBy: { priority: "asc" },
      limit: 2,
      offset: 1,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("B");
    expect(rows[1].title).toBe("C");
  });

  it("updates a row by id", async () => {
    const { id } = await engine.insert("todo", "tasks", { title: "Buy milk", done: false });
    await engine.update("todo", "tasks", id, { done: true });

    const row = await engine.findOne("todo", "tasks", id);
    expect(row!.done).toBe(true);
  });

  it("deletes a row by id", async () => {
    const { id } = await engine.insert("todo", "tasks", { title: "Delete me", done: false });
    await engine.delete("todo", "tasks", id);

    const rows = await engine.find("todo", "tasks");
    expect(rows).toHaveLength(0);
  });

  it("counts rows with filter", async () => {
    await engine.insert("todo", "tasks", { title: "A", done: false });
    await engine.insert("todo", "tasks", { title: "B", done: true });
    await engine.insert("todo", "tasks", { title: "C", done: false });

    const total = await engine.count("todo", "tasks");
    expect(total).toBe(3);

    const undone = await engine.count("todo", "tasks", { done: false });
    expect(undone).toBe(2);
  });

  it("findOne returns single row or null", async () => {
    const { id } = await engine.insert("todo", "tasks", { title: "Only one", done: false });

    const row = await engine.findOne("todo", "tasks", id);
    expect(row).toBeDefined();
    expect(row!.title).toBe("Only one");

    const missing = await engine.findOne("todo", "tasks", "00000000-0000-0000-0000-000000000000");
    expect(missing).toBeNull();
  });

  it("handles null filter value", async () => {
    await engine.insert("todo", "tasks", { title: "No due", done: false, due: null });
    await engine.insert("todo", "tasks", { title: "Has due", done: false, due: "2026-03-20T00:00:00Z" });

    const rows = await engine.find("todo", "tasks", {
      filter: { due: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("No due");
  });

  it("combines multiple filter conditions", async () => {
    await engine.insert("todo", "tasks", { title: "A", done: false, priority: 1 });
    await engine.insert("todo", "tasks", { title: "B", done: false, priority: 5 });
    await engine.insert("todo", "tasks", { title: "C", done: true, priority: 3 });

    const rows = await engine.find("todo", "tasks", {
      filter: { done: false, priority: { $gte: 3 } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("B");
  });

  it("rejects invalid schema/table/column names", async () => {
    await expect(engine.find("../evil", "tasks")).rejects.toThrow(/invalid/i);
    await expect(engine.find("todo", "../evil")).rejects.toThrow(/invalid/i);
    await expect(engine.insert("todo", "tasks", { "DROP TABLE": "x" })).rejects.toThrow(/invalid/i);
  });
});
