import { expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppDb } from "../../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../../packages/gateway/src/app-db-registry.js";
import { registerNativeAppStorage } from "../../../packages/gateway/src/native-app-storage.js";
import { AoedeActions } from "../../../packages/gateway/src/aoede/actions.js";

it("serializes concurrent Notes writers on PostgreSQL without losing rich text", async () => {
  const url = process.env.MATRIX_TEST_POSTGRES_URL;
  if (!url || !new URL(url).pathname.includes("test")) throw new Error("MATRIX_TEST_POSTGRES_URL must name a dedicated test database with CREATE DATABASE permission");
  const admin = new Pool({ connectionString: url });
  const name = `aoede_test_${randomUUID().replaceAll("-", "")}`;
  const home = await mkdtemp(join(tmpdir(), "aoede-pg-"));
  let storage: ReturnType<typeof createAppDb> | undefined;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const isolated = new URL(url); isolated.pathname = `/${name}`;
    storage = createAppDb(isolated.toString());
    await storage.db.bootstrap();
    const registry = createAppRegistry(storage.db, storage.kysely);
    await registerNativeAppStorage(registry);
    const actions = new AoedeActions({ principal: { userId: "owner", source: "jwt" }, ownerId: "owner", homePath: home,
      registry, database: storage.kysely, uiAction: async () => { throw new Error("No UI expected"); }, notifyDataChange: () => {} });
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "eggs", marks: [{ type: "bold" }] }] }] };
    await storage.kysely.insertInto("notes.notes").values({ title: "Groceries", content: "**eggs**", content_json: JSON.stringify(doc) }).execute();
    const results = await Promise.all(["milk", "bread"].map(text => actions.execute({ type: "append_note", title: "Groceries", text }, "s")));
    expect(results.map(r => r.status)).toEqual(["ok", "ok"]);
    const row = await storage.kysely.selectFrom("notes.notes").selectAll().executeTakeFirstOrThrow();
    expect(row.content.split("\n\n").sort()).toEqual(["**eggs**", "bread", "milk"]);
    expect(row.content_json.content[0]).toEqual(doc.content[0]);
    expect(row.content_json.content.slice(1).map((n: any) => n.content[0].text).sort()).toEqual(["bread", "milk"]);
    // An actual DB-side suppressed write must never produce a success result.
    await storage.db.raw(`CREATE FUNCTION notes.suppress_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    await storage.db.raw(`CREATE TRIGGER suppress_write BEFORE UPDATE ON notes.notes FOR EACH ROW EXECUTE FUNCTION notes.suppress_write()`);
    expect((await actions.execute({ type: "append_note", title: "Groceries", text: "tea" }, "s")).status).toBe("failed");
    expect(await storage.kysely.selectFrom("notes.notes").selectAll().executeTakeFirstOrThrow()).toEqual(row);
  } finally {
    await storage?.db.destroy();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
