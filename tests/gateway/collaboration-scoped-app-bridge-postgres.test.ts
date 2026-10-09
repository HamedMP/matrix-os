import { createHash } from "node:crypto";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScopedAppBridge } from "../../packages/gateway/src/collaboration/scoped-app-bridge.js";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const SCOPE = "10000000-0000-4000-8000-000000000601";
const APP = "board";
const namespace = `p${createHash("sha256").update(SCOPE).update("\0").update(APP).digest("hex").slice(0, 32)}`;

const fixtureFactory = process.env.MATRIX_TEST_POSTGRES_URL ? createRealCollaborationTestDatabase : createCollaborationTestDatabase;

describe("scoped app bridge", () => {
  let fixture: CollaborationTestDatabase;
  let schema: string;
  let bridge: ReturnType<typeof createScopedAppBridge>;

  beforeEach(async () => {
    fixture = await fixtureFactory();
    const result = await sql<{ name: string }>`SELECT current_schema() AS name`.execute(fixture.db);
    schema = result.rows[0]!.name;
    await sql`CREATE TABLE ${sql.id(schema)}.${sql.id("cards")} (id TEXT PRIMARY KEY, title TEXT NOT NULL, payload JSONB, updated_at TIMESTAMPTZ DEFAULT now())`.execute(fixture.db);
    bridge = createScopedAppBridge({
      resolveApp: async (appId) => appId === APP ? { storageSchema: schema, tables: ["cards"] } : null,
    });
  });
  afterEach(async () => { await fixture.destroy(); });

  it("uses the owner transaction and a registered schema for reads and mutations", async () => {
    await fixture.db.transaction().execute(async (transaction) => {
      const inserted = await bridge.execute({ namespace, appId: APP, storageSchema: schema, scopeId: SCOPE,
        actorId: "member", action: { action: "insert", app: namespace, table: "cards", data: { id: "one", title: "First" } }, transaction });
      expect(inserted).toEqual({ id: "one" });
      const found = await bridge.execute({ namespace, appId: APP, storageSchema: schema, scopeId: SCOPE,
        actorId: "member", action: { action: "find", app: namespace, table: "cards", filter: { id: "one" } }, transaction });
      expect(found).toEqual([expect.objectContaining({ id: "one", title: "First" })]);
    });
    const count = await sql<{ count: string }>`SELECT COUNT(*) AS count FROM ${sql.id(schema)}.${sql.id("cards")}`.execute(fixture.db);
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it("conditionally writes the exact payload in the verified owner transaction", async () => {
    const expected = { fields: { title: "Original" }, sources: [] };
    const changed = { fields: { title: "Edited" }, sources: [{ id: "evidence" }] };
    await sql`INSERT INTO ${sql.id(schema)}.${sql.id("cards")} (id, title, payload) VALUES ('cas', 'Original', ${JSON.stringify(expected)}::jsonb)`.execute(fixture.db);
    await fixture.db.transaction().execute(async (transaction) => {
      const input = { namespace, appId: APP, storageSchema: schema, scopeId: SCOPE, actorId: "member", transaction };
      const action = { action: "compareAndSwap" as const, app: namespace, table: "cards", id: "cas", expectedPayload: expected, data: { payload: changed } };
      expect(await bridge.execute({ ...input, action })).toEqual({ ok: true });
      expect(await bridge.execute({ ...input, action: { ...action, data: { payload: { ...expected, archivedAt: "2026-10-06" } } } })).toEqual({ ok: false });
      await expect(bridge.execute({ ...input, action: { ...action, app: "other" } })).rejects.toMatchObject({ code: "invalid_action" });
      await expect(bridge.execute({ ...input, action: { ...action, table: "private" } })).rejects.toMatchObject({ code: "forbidden" });
    });
    const result = await sql<{ payload: unknown }>`SELECT payload FROM ${sql.id(schema)}.${sql.id("cards")} WHERE id = 'cas'`.execute(fixture.db);
    expect(result.rows[0]?.payload).toEqual(changed);
  });

  it("rejects a forged namespace and rolls mutations back with the owner transaction", async () => {
    await expect(fixture.db.transaction().execute(async (transaction) => {
      await bridge.execute({ namespace: "forged", appId: APP, storageSchema: schema, scopeId: SCOPE,
        actorId: "member", action: { action: "find", app: "forged", table: "cards" }, transaction });
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(fixture.db.transaction().execute(async (transaction) => {
      await bridge.execute({ namespace, appId: APP, storageSchema: schema, scopeId: SCOPE,
        actorId: "member", action: { action: "insert", app: namespace, table: "cards", data: { id: "two", title: "Rolled back" } }, transaction });
      throw new Error("abort transaction");
    })).rejects.toThrow("abort transaction");
    const count = await sql<{ count: string }>`SELECT COUNT(*) AS count FROM ${sql.id(schema)}.${sql.id("cards")}`.execute(fixture.db);
    expect(Number(count.rows[0]?.count)).toBe(0);
  });

  it("never reaches an unregistered table or an app schema outside its binding", async () => {
    await expect(fixture.db.transaction().execute(async (transaction) => bridge.execute({ namespace, appId: APP,
      storageSchema: schema, scopeId: SCOPE, actorId: "member",
      action: { action: "find", app: namespace, table: "private" }, transaction })))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(fixture.db.transaction().execute(async (transaction) => bridge.execute({ namespace, appId: APP,
      storageSchema: "other", scopeId: SCOPE, actorId: "member",
      action: { action: "find", app: namespace, table: "cards" }, transaction })))
      .rejects.toMatchObject({ code: "forbidden" });
  });
});
