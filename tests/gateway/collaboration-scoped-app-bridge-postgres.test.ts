import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScopedAppBridge } from "../../packages/gateway/src/collaboration/scoped-app-bridge.js";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

let SCOPE: string;
const APP = "board";
let namespace: string;

const fixtureFactory = process.env.MATRIX_TEST_POSTGRES_URL ? createRealCollaborationTestDatabase : createCollaborationTestDatabase;

describe("scoped app bridge", () => {
  let fixture: CollaborationTestDatabase;
  let schema: string;
  let bridge: ReturnType<typeof createScopedAppBridge>;

  beforeEach(async () => {
    SCOPE = randomUUID();
    namespace = `p${createHash("sha256").update(SCOPE).update("\0").update(APP).digest("hex").slice(0, 32)}`;
    fixture = await fixtureFactory();
    const result = await sql<{ name: string }>`SELECT current_schema() AS name`.execute(fixture.db);
    schema = result.rows[0]!.name;
    await sql`CREATE TABLE ${sql.id(schema)}.${sql.id("cards")} (id TEXT PRIMARY KEY, title TEXT NOT NULL)`.execute(fixture.db);
    await sql`CREATE TABLE IF NOT EXISTS public._kv (app TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (app, key))`.execute(fixture.db);
    bridge = createScopedAppBridge({
      resolveApp: async (appId) => appId === APP ? { storageSchema: schema, tables: ["cards"] } : null,
    });
  });
  afterEach(async () => {
    await sql`DELETE FROM public._kv WHERE app = ${namespace}`.execute(fixture.db);
    await fixture.destroy();
  });

  it("uses the owner transaction and a registered schema for reads and mutations", async () => {
    await fixture.db.transaction().execute(async (transaction) => {
      const inserted = await bridge.execute({ namespace, appId: APP, storageSchema: schema, scopeId: SCOPE,
        actorId: "member", action: { action: "insert", app: namespace, table: "cards", data: { id: "one", title: "First" } }, transaction });
      expect(inserted).toEqual({ id: "one" });
      const found = await bridge.execute({ namespace, appId: APP, storageSchema: schema, scopeId: SCOPE,
        actorId: "member", action: { action: "find", app: namespace, table: "cards", filter: { id: "one" } }, transaction });
      expect(found).toEqual([{ id: "one", title: "First" }]);
    });
    const count = await sql<{ count: string }>`SELECT COUNT(*) AS count FROM ${sql.id(schema)}.${sql.id("cards")}`.execute(fixture.db);
    expect(Number(count.rows[0]?.count)).toBe(1);
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
