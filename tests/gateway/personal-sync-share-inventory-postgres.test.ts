import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase, type OwnerCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { inventoryPersonToPersonRecords } from "../../packages/gateway/src/collaboration/person-to-person-inventory.js";
import { inventoryPersonalSyncShares } from "../../packages/gateway/src/sync/share-inventory.js";
import { migrateSyncTables, type SyncDatabase } from "../../packages/gateway/src/sync/sharing-db.js";

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const execFileAsync = promisify(execFile);

describe.skipIf(!connectionString)("T102 personal sync grant operator inventory on real Postgres", () => {
  let admin: Kysely<Record<string, never>>;
  let db: Kysely<OwnerCollaborationDatabase & SyncDatabase>;
  let schema: string;

  beforeEach(async () => {
    schema = `personal_sync_inventory_${randomUUID().replaceAll("-", "")}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = new Kysely({ dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: 3, options: `-c search_path=${schema},public` }),
    }) });
  });

  afterEach(async () => {
    await db.destroy();
    await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin);
    await admin.destroy();
  });

  it("distinguishes an absent table from zero and counts every personal sync grant without reclassifying it", async () => {
    expect(await inventoryPersonalSyncShares(db)).toEqual({ state: "missing" });
    await sql`CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL)`.execute(db);
    await migrateSyncTables(db);
    expect(await inventoryPersonalSyncShares(db)).toEqual({
      state: "present", totalGrants: 0, pendingGrants: 0, acceptedGrants: 0, expiredGrants: 0,
    });

    await db.insertInto("users").values([
      { id: "owner", handle: "owner" },
      { id: "member-a", handle: "member-a" },
      { id: "member-b", handle: "member-b" },
      { id: "member-c", handle: "member-c" },
    ]).execute();
    const now = new Date();
    await db.insertInto("sync_shares").values([
      { id: randomUUID(), owner_id: "owner", path: "docs/a", grantee_id: "member-a", role: "viewer",
        accepted: false, created_at: now, expires_at: null },
      { id: randomUUID(), owner_id: "owner", path: "docs/b", grantee_id: "member-b", role: "editor",
        accepted: true, created_at: now, expires_at: null },
      { id: randomUUID(), owner_id: "owner", path: "docs/c", grantee_id: "member-c", role: "admin",
        accepted: true, created_at: now, expires_at: new Date(now.getTime() - 1000) },
    ]).execute();
    expect(await inventoryPersonalSyncShares(db)).toEqual({
      state: "present", totalGrants: 3, pendingGrants: 1, acceptedGrants: 2, expiredGrants: 1,
    });
    await bootstrapChatDatabase(db);
    await bootstrapCollaborationDatabase(db);
    expect(await inventoryPersonToPersonRecords(db)).toMatchObject({ total: 0 });
    expect(await db.selectFrom("sync_shares").select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()).toMatchObject({ count: "3" });

    const scriptUrl = new URL(connectionString!);
    scriptUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const { stdout } = await execFileAsync("pnpm", ["exec", "tsx", "scripts/collaboration/inventory-person-to-person.ts"], {
      cwd: process.cwd(), timeout: 15_000,
      env: { ...process.env, GATEWAY_DATABASE_URL: scriptUrl.toString(), PLATFORM_DATABASE_URL: "" },
    });
    expect(JSON.parse(stdout)).toMatchObject({
      gateway: { total: 0 },
      personalSync: { state: "present", totalGrants: 3, pendingGrants: 1, acceptedGrants: 2, expiredGrants: 1 },
      platform: null,
    });
  });
});
