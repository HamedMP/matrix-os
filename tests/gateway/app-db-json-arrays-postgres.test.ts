import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { boardFromRows, cardToRow } from "../../home/apps/task-manager/src/persistence.js";
import type { Card } from "../../home/apps/task-manager/src/board-model.js";

const url = process.env.MATRIX_TEST_POSTGRES_URL;

describe.skipIf(!url)("app JSON arrays through the real PostgreSQL driver", () => {
  let schema: string;
  let db: AppDb;
  let reader: AppDb;
  let engine: QueryEngine;

  beforeEach(async () => {
    if (!new URL(url!).pathname.includes("test")) throw Error("Dedicated test database required");
    schema = `app_arrays_${randomUUID().replaceAll("-", "")}`;
    db = createAppDb(url!).db;
    reader = createAppDb(url!).db;
    await db.createAppSchema(schema);
    await db.createTable(schema, "cards", {
      column_id: "text", title: "text", description: "text", labels: "jsonb",
      assignee: "text", priority: "text", due: "date", checklist: "jsonb",
      position: "integer", payload: "jsonb", json_value: "json",
    });
    // Genuine SQL arrays are distinct from the manifest's JSONB collection fields.
    await db.raw(`ALTER TABLE "${schema}".cards ADD COLUMN sql_tags text[]`);
    await db.raw(`ALTER TABLE "${schema}".cards ALTER COLUMN json_value TYPE json USING json_value::json`);
    engine = createQueryEngine(db);
  });

  afterEach(async () => {
    try { if (db && schema) await db.dropAppSchema(schema); }
    finally { await Promise.all([db?.destroy(), reader?.destroy()]); }
  });

  async function read(id: string) {
    return createQueryEngine(reader).findOne(schema, "cards", id);
  }

  it("keeps empty labels and checklists as arrays rather than silently storing objects", async () => {
    const { id } = await engine.insert(schema, "cards", { title: "Empty card", labels: [], checklist: [] });
    expect(await read(id)).toMatchObject({ labels: [], checklist: [] });
  });

  it("round-trips the real Task Manager producer and consumer across independent connections", async () => {
    const checklist = [{ id: "check-one", text: "Persist me", done: false }];
    const card: Card = {
      id: "optimistic", projectId: "project-default", columnId: "column-one",
      title: "Owner card", description: "Synthetic", labels: ["audit", "quote\"slash\\"],
      assignee: "Owner", priority: "high", dueDate: "", checklist, delegation: null,
      order: 0, createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
    };
    const { id } = await engine.insert(schema, "cards", cardToRow(card, 0));
    await engine.update(schema, "cards", id, {
      labels: ["updated"], checklist: [{ ...checklist[0], done: true }],
    });
    const saved = await read(id);
    const board = boardFromRows([{ id: "column-one", title: "Backlog", position: 0 }], [saved!]);
    expect(board.cards[0]).toMatchObject({ id, labels: ["updated"], checklist: [{ ...checklist[0], done: true }] });
    await engine.update(schema, "cards", id, { labels: [], checklist: [] });
    expect(await read(id)).toMatchObject({ labels: [], checklist: [] });
  });

  it("updates nonempty collections on an existing card and handles JSON as well as JSONB", async () => {
    const { id } = await engine.insert(schema, "cards", { title: "Existing", payload: { stable: true } });
    await engine.update(schema, "cards", id, {
      labels: ["urgent"], checklist: [{ id: "one", text: "Done", done: true }],
      json_value: [null, { nested: [1, "quoted\"\\"] }],
    });
    expect(await read(id)).toMatchObject({
      labels: ["urgent"], checklist: [{ id: "one", text: "Done", done: true }],
      json_value: [null, { nested: [1, "quoted\"\\"] }], payload: { stable: true },
    });
  });

  it("preserves JSON arrays in atomic bulk inserts and sparse bulk updates", async () => {
    const { ids } = await engine.bulkInsert(schema, "cards", [
      { title: "First", labels: ["a"], checklist: [] },
      { title: "Second", labels: [], checklist: [{ id: "two", text: "Two", done: false }] },
    ]);
    const rows = await engine.find(schema, "cards");
    const first = rows.find(row => row.title === "First")!;
    const second = rows.find(row => row.title === "Second")!;
    expect(ids).toHaveLength(2);
    await engine.bulkUpdate(schema, "cards", [
      { id: String(first.id), data: { labels: [] } },
      { id: String(second.id), data: { checklist: [], labels: ["b"] } },
    ]);
    expect(await read(String(first.id))).toMatchObject({ labels: [], checklist: [] });
    expect(await read(String(second.id))).toMatchObject({ labels: ["b"], checklist: [] });
  });

  it("serializes collection patches without weakening the compare-and-swap predicate", async () => {
    const before = { version: 1 };
    const { id } = await engine.insert(schema, "cards", { payload: before });
    expect(await engine.compareAndSwap(schema, "cards", id, before, {
      payload: { version: 2 }, labels: ["winner"], checklist: [],
    })).toEqual({ ok: true });
    expect(await engine.compareAndSwap(schema, "cards", id, before, { labels: ["stale"] })).toEqual({ ok: false });
    expect(await read(id)).toMatchObject({ payload: { version: 2 }, labels: ["winner"], checklist: [] });
  });

  it("retains genuine SQL-array, object and null semantics, including after a column type changes", async () => {
    const { id } = await engine.insert(schema, "cards", {
      sql_tags: ["one", "comma,two", "quote\"slash\\"], payload: { nested: [1, 2] }, labels: null,
    });
    expect(await read(id)).toMatchObject({ sql_tags: ["one", "comma,two", "quote\"slash\\"], payload: { nested: [1, 2] }, labels: null });
    await engine.update(schema, "cards", id, { sql_tags: [], payload: null });
    expect(await read(id)).toMatchObject({ sql_tags: [], payload: null });
    await db.raw(`ALTER TABLE "${schema}".cards ALTER COLUMN sql_tags TYPE jsonb USING to_jsonb(sql_tags)`);
    await engine.update(schema, "cards", id, { sql_tags: ["now-json"] });
    expect(await read(id)).toMatchObject({ sql_tags: ["now-json"] });
  });
});
