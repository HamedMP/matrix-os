import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query";
import { BridgeQueryBodySchema } from "../../packages/gateway/src/app-db-contracts";
import { registerBridgeDataRoutes } from "../../packages/gateway/src/server/bridge-routes";
import type { AppRegistry } from "../../packages/gateway/src/app-db-registry";

const expected = { id: "logical-record", fields: { title: "Original" }, sources: [], manualFields: [] };
const body = { action: "compareAndSwap", app: "starter", table: "records", id: "row-id", expectedPayload: expected, data: { payload: { ...expected, fields: { title: "Edited" } } } };

describe("app payload compare and swap contract", () => {
  it("requires a JSON object snapshot and validated mutation columns", () => {
    expect(BridgeQueryBodySchema.safeParse(body).success).toBe(true);
    for (const expectedPayload of [null, [], "old", 1, { invalid: undefined }, { invalid: NaN }])
      expect(BridgeQueryBodySchema.safeParse({ ...body, expectedPayload }).success).toBe(false);
    expect(BridgeQueryBodySchema.safeParse({ ...body, data: {} }).success).toBe(false);
    expect(BridgeQueryBodySchema.safeParse({ ...body, data: { "bad column": 1 } }).success).toBe(false);
    expect(BridgeQueryBodySchema.safeParse({ ...body, unexpected: true }).success).toBe(false);
  });
});

describe("atomic app payload compare and swap", () => {
  let db: AppDb;
  let engine: QueryEngine;
  beforeEach(async () => {
    const instance = await KyselyPGlite.create();
    db = createAppDb({ dialect: instance.dialect }).db;
    await db.bootstrap();
    await db.createAppSchema("starter");
    await db.createTable("starter", "records", { payload: "jsonb", source_id: "text" });
    engine = createQueryEngine(db);
  });
  afterEach(async () => { await db.destroy(); });

  it.each(["edit", "import", "archive"])("allows one winner against a competing %s snapshot", async (kind) => {
    const { id } = await engine.insert("starter", "records", { payload: expected });
    const first = { ...expected, fields: { title: "Owner edit" }, manualFields: ["title"] };
    const competing = kind === "archive" ? { ...expected, archivedAt: "2026-10-06" }
      : kind === "import" ? { ...expected, sources: [{ id: "new-evidence" }] }
      : { ...expected, fields: { title: "Other edit" } };
    const results = await Promise.all([
      engine.compareAndSwap("starter", "records", id, expected, { payload: first }),
      engine.compareAndSwap("starter", "records", id, expected, { payload: competing }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const saved = await engine.findOne("starter", "records", id);
    expect(saved?.payload).toEqual(results[0].ok ? first : competing);
  });

  it("matches JSON structure rather than key order and returns false for a missing row", async () => {
    const { id } = await engine.insert("starter", "records", { payload: expected });
    const reordered = { manualFields: [], sources: [], fields: { title: "Original" }, id: "logical-record" };
    await expect(engine.compareAndSwap("starter", "records", id, reordered, { payload: { ...expected, fields: { title: "New" } } })).resolves.toEqual({ ok: true });
    await expect(engine.compareAndSwap("starter", "records", "00000000-0000-4000-8000-000000000000", expected, body.data)).resolves.toEqual({ ok: false });
  });

  it("binds the exact snapshot in one conditional SQL write without a pre-read", async () => {
    const raw = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
    const isolated = createQueryEngine({ raw } as unknown as AppDb);
    await expect(isolated.compareAndSwap("starter", "records", "row-id", expected, body.data)).resolves.toEqual({ ok: false });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0][0]).toMatch(/UPDATE .* WHERE id = \$2 AND payload = \$3::jsonb RETURNING id/);
    expect(raw.mock.calls[0][1]).toEqual([body.data.payload, "row-id", JSON.stringify(expected)]);
  });
});

describe("compare and swap owner bridge route", () => {
  it.each([true, false])("returns %s and notifies subscribers only for a successful write", async (ok) => {
    const compareAndSwap = vi.fn(async () => ({ ok }));
    const broadcast = vi.fn();
    const provision = vi.fn(async () => undefined);
    const app = new Hono();
    registerBridgeDataRoutes(app, {
      homePath: "/unused", queryEngine: { compareAndSwap } as unknown as QueryEngine,
      appRegistry: {} as AppRegistry, kvStore: null, ensureAppProvisioned: provision,
      broadcast, queryBodyLimit: bodyLimit({ maxSize: 1024 }), dataBodyLimit: bodyLimit({ maxSize: 1024 }), logUnexpectedJsonParseFailure: vi.fn(),
    });
    const response = await app.request("/api/bridge/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok });
    expect(provision).toHaveBeenCalledWith("starter");
    expect(compareAndSwap).toHaveBeenCalledWith("starter", "records", body.id, expected, body.data);
    expect(broadcast).toHaveBeenCalledTimes(ok ? 1 : 0);
    const invalid = await app.request("/api/bridge/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, expectedPayload: [] }) });
    expect(invalid.status).toBe(400);
    const oversized = await app.request("/api/bridge/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, expectedPayload: { value: "x".repeat(2000) } }) });
    expect(oversized.status).toBe(413);
    expect(compareAndSwap).toHaveBeenCalledTimes(1);
  });
});
