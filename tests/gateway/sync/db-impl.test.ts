import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import { createManifestDb } from "../../../packages/gateway/src/sync/db-impl.js";
import {
  ensureSyncUser,
  type SyncDatabase,
} from "../../../packages/gateway/src/sync/sharing-db.js";

describe("createManifestDb", () => {
  let sqlite: Database.Database;
  let db: Kysely<SyncDatabase>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        handle TEXT UNIQUE
      );
      CREATE TABLE sync_manifests (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        total_size INTEGER NOT NULL,
        etag TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    db = new Kysely<SyncDatabase>({
      dialect: new SqliteDialect({ database: sqlite }),
    });
  });

  afterEach(async () => {
    await db.destroy();
    sqlite.close();
  });

  it("does not regress manifest metadata when a stale repair races with a newer write", async () => {
    const manifestDb = createManifestDb(db);
    await ensureSyncUser(db, { id: "user1", handle: "alice" });
    sqlite.prepare(`
      INSERT INTO sync_manifests (user_id, version, file_count, total_size, etag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("user1", 6, 2, 200, '"etag-6"', new Date().toISOString());

    await manifestDb.upsertManifestMeta("user1", {
      version: 5,
      file_count: 1,
      total_size: 100n,
      etag: '"etag-5"',
    });

    const row = sqlite.prepare(`
      SELECT user_id, version, file_count, total_size, etag
      FROM sync_manifests
      WHERE user_id = ?
    `).get("user1") as {
      user_id: string;
      version: number;
      file_count: number;
      total_size: number;
      etag: string | null;
    };

    expect(row.version).toBe(6);
    expect(row.file_count).toBe(2);
    expect(row.total_size).toBe(200);
    expect(row.etag).toBe('"etag-6"');
  });

  it("seeds configured sync users idempotently before manifest metadata writes", async () => {
    const manifestDb = createManifestDb(db);

    await ensureSyncUser(db, { id: "dev", handle: "dev" });
    await ensureSyncUser(db, { id: "dev", handle: "developer" });
    await manifestDb.upsertManifestMeta("dev", {
      version: 1,
      file_count: 1,
      total_size: 42n,
      etag: '"etag-1"',
    });

    const user = sqlite.prepare("SELECT id, handle FROM users WHERE id = ?").get("dev") as {
      id: string;
      handle: string;
    };
    const manifest = sqlite.prepare("SELECT user_id, version FROM sync_manifests WHERE user_id = ?").get("dev") as {
      user_id: string;
      version: number;
    };

    expect(user).toEqual({ id: "dev", handle: "developer" });
    expect(manifest).toEqual({ user_id: "dev", version: 1 });
  });
});
