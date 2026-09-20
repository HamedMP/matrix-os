import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import { createManifestDb } from "../../../packages/gateway/src/sync/db-impl.js";
import {
  deriveGatewaySyncUserSeeds,
  ensureSyncUser,
  type SyncDatabase,
} from "../../../packages/gateway/src/sync/sharing-db.js";

describe("createManifestDb", () => {
  let sqlite: Database.Database;
  let db: Kysely<SyncDatabase>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        handle TEXT UNIQUE
      );
      CREATE TABLE sync_manifests (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        runtime_slot TEXT NOT NULL DEFAULT 'primary',
        version INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        total_size INTEGER NOT NULL,
        etag TEXT,
        accepted_manifest_key TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, runtime_slot)
      );
      CREATE TABLE sync_shares (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        grantee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
        accepted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        UNIQUE (owner_id, path, grantee_id),
        CHECK (owner_id != grantee_id)
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

  it("requires a seeded sync user before manifest metadata writes", async () => {
    const manifestDb = createManifestDb(db);
    const meta = {
      version: 1,
      file_count: 1,
      total_size: 42n,
      etag: '"etag-1"',
    };

    await expect(manifestDb.upsertManifestMeta("dev-user", meta)).rejects.toThrow(
      /FOREIGN KEY constraint failed/i,
    );

    await ensureSyncUser(db, { id: "dev-user", handle: "dev-user" });
    await expect(manifestDb.upsertManifestMeta("dev-user", meta)).resolves.toBeUndefined();

    const row = sqlite.prepare(`
      SELECT user_id, version, file_count, total_size, etag
      FROM sync_manifests
      WHERE user_id = ?
    `).get("dev-user");
    expect(row).toEqual({
      user_id: "dev-user",
      version: 1,
      file_count: 1,
      total_size: 42,
      etag: '"etag-1"',
    });
  });

  it("persists the accepted immutable manifest generation pointer", async () => {
    const manifestDb = createManifestDb(db);
    await ensureSyncUser(db, { id: "user1", handle: "alice" });

    await manifestDb.upsertManifestMeta("user1", {
      version: 4,
      file_count: 1,
      total_size: 42n,
      etag: '"etag-4"',
      accepted_manifest_key: "matrixos-sync/user1/manifests/4-" + "a".repeat(64) + ".json",
    });

    await expect(manifestDb.getManifestMeta("user1")).resolves.toMatchObject({
      version: 4,
      accepted_manifest_key: "matrixos-sync/user1/manifests/4-" + "a".repeat(64) + ".json",
    });
  });

  it("advances the accepted generation only from the expected version", async () => {
    const manifestDb = createManifestDb(db);
    await ensureSyncUser(db, { id: "user1", handle: "alice" });
    await manifestDb.upsertManifestMeta("user1", {
      version: 4,
      file_count: 1,
      total_size: 42n,
      etag: '"etag-4"',
      accepted_manifest_key: "generation-4",
    });

    await expect(manifestDb.advanceManifestMeta("user1", 3, {
      version: 5,
      file_count: 2,
      total_size: 84n,
      etag: '"etag-5-stale"',
      accepted_manifest_key: "generation-5-stale",
    })).resolves.toBe(false);
    await expect(manifestDb.getManifestMeta("user1")).resolves.toMatchObject({
      version: 4,
      accepted_manifest_key: "generation-4",
    });

    await expect(manifestDb.advanceManifestMeta("user1", 4, {
      version: 5,
      file_count: 2,
      total_size: 84n,
      etag: '"etag-5"',
      accepted_manifest_key: "generation-5",
    })).resolves.toBe(true);
    await expect(manifestDb.getManifestMeta("user1")).resolves.toMatchObject({
      version: 5,
      accepted_manifest_key: "generation-5",
    });
  });

  it("creates revision one only when no accepted metadata row exists", async () => {
    const manifestDb = createManifestDb(db);
    await ensureSyncUser(db, { id: "user1", handle: "alice" });
    const revisionOne = {
      version: 1,
      file_count: 1,
      total_size: 42n,
      etag: '"etag-1"',
      accepted_manifest_key: "generation-1",
    };

    await expect(manifestDb.advanceManifestMeta("user1", 0, revisionOne)).resolves.toBe(true);
    await expect(manifestDb.advanceManifestMeta("user1", 0, {
      ...revisionOne,
      accepted_manifest_key: "generation-1-race",
    })).resolves.toBe(false);
    await expect(manifestDb.getManifestMeta("user1")).resolves.toMatchObject({
      accepted_manifest_key: "generation-1",
    });
  });

  it("keeps manifest metadata isolated between runtime slots", async () => {
    const manifestDb = createManifestDb(db);
    await ensureSyncUser(db, { id: "user1", handle: "alice" });

    await manifestDb.upsertManifestMeta({ ownerId: "user1", runtimeSlot: "primary" }, {
      version: 2,
      file_count: 1,
      total_size: 10n,
      etag: '"primary"',
      accepted_manifest_key: null,
    });
    await manifestDb.upsertManifestMeta({ ownerId: "user1", runtimeSlot: "studio" }, {
      version: 8,
      file_count: 3,
      total_size: 30n,
      etag: '"studio"',
      accepted_manifest_key: null,
    });

    await expect(manifestDb.getManifestMeta({
      ownerId: "user1",
      runtimeSlot: "primary",
    })).resolves.toMatchObject({ version: 2, etag: '"primary"' });
    await expect(manifestDb.getManifestMeta({
      ownerId: "user1",
      runtimeSlot: "studio",
    })).resolves.toMatchObject({ version: 8, etag: '"studio"' });
  });

  it("seeds sync users idempotently by id", async () => {
    await ensureSyncUser(db, { id: "dev-user", handle: "dev-user" });
    await ensureSyncUser(db, { id: "dev-user", handle: "developer" });

    const row = sqlite.prepare("SELECT id, handle FROM users WHERE id = ?").get("dev-user");
    expect(row).toEqual({ id: "dev-user", handle: "developer" });
  });

  it("seeds sync users idempotently by unique handle", async () => {
    sqlite.prepare("INSERT INTO users (id, handle) VALUES (?, ?)").run(
      "legacy-user",
      "developer",
    );

    await ensureSyncUser(db, { id: "dev-user", handle: "developer" });

    const rows = sqlite.prepare("SELECT id, handle FROM users ORDER BY handle").all();
    expect(rows).toEqual([{ id: "dev-user", handle: "developer" }]);
  });

  it("preserves manifest foreign-key links when reconciling a handle-owned user id", async () => {
    sqlite.prepare("INSERT INTO users (id, handle) VALUES (?, ?)").run(
      "legacy-user",
      "developer",
    );
    sqlite.prepare("INSERT INTO users (id, handle) VALUES (?, ?)").run(
      "collaborator",
      "collaborator",
    );
    sqlite.prepare(`
      INSERT INTO sync_manifests (user_id, version, file_count, total_size, etag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("legacy-user", 7, 3, 300, '"etag-7"', new Date().toISOString());
    sqlite.prepare(`
      INSERT INTO sync_shares (id, owner_id, path, grantee_id, role, accepted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("share-owned", "legacy-user", "notes", "collaborator", "editor", 1, new Date().toISOString());
    sqlite.prepare(`
      INSERT INTO sync_shares (id, owner_id, path, grantee_id, role, accepted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("share-granted", "collaborator", "shared", "legacy-user", "viewer", 1, new Date().toISOString());

    await expect(ensureSyncUser(db, { id: "dev-user", handle: "developer" }))
      .resolves.toBeUndefined();

    const manifest = sqlite.prepare(`
      SELECT user_id, version, file_count, total_size, etag
      FROM sync_manifests
    `).get();
    expect(manifest).toEqual({
      user_id: "dev-user",
      version: 7,
      file_count: 3,
      total_size: 300,
      etag: '"etag-7"',
    });
    const shares = sqlite.prepare(`
      SELECT id, owner_id, grantee_id
      FROM sync_shares
      ORDER BY id
    `).all();
    expect(shares).toEqual([
      { id: "share-granted", owner_id: "collaborator", grantee_id: "dev-user" },
      { id: "share-owned", owner_id: "dev-user", grantee_id: "collaborator" },
    ]);
  });

  it("does not crash when seed id and handle already belong to different rows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sqlite.prepare("INSERT INTO users (id, handle) VALUES (?, ?)").run(
      "dev-user",
      "old-dev",
    );
    sqlite.prepare("INSERT INTO users (id, handle) VALUES (?, ?)").run(
      "legacy-user",
      "developer",
    );

    try {
      await expect(ensureSyncUser(db, { id: "dev-user", handle: "developer" }))
        .resolves.toBeUndefined();

      const rows = sqlite.prepare("SELECT id, handle FROM users ORDER BY id").all();
      expect(rows).toEqual([
        { id: "dev-user", handle: "old-dev" },
        { id: "legacy-user", handle: "developer" },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipped sync user seed"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects unsafe sync user seed values before writing rows", async () => {
    await expect(ensureSyncUser(db, { id: "../secret", handle: "safe" })).rejects.toThrow(
      /Invalid sync user id/,
    );
    await expect(ensureSyncUser(db, { id: "safe", handle: "" })).rejects.toThrow(
      /Invalid sync user handle/,
    );
    await expect(ensureSyncUser(db, { id: "safe", handle: "bad/handle" })).rejects.toThrow(
      /Invalid sync user handle/,
    );

    const count = sqlite.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("derives configured gateway sync user seeds", () => {
    expect(deriveGatewaySyncUserSeeds({
      MATRIX_USER_ID: "user_123",
      MATRIX_HANDLE: "alice",
      NODE_ENV: "production",
    })).toEqual([{ id: "user_123", handle: "alice" }]);

    expect(deriveGatewaySyncUserSeeds({
      NODE_ENV: "development",
    })).toEqual([{ id: "default", handle: "default" }]);

    expect(deriveGatewaySyncUserSeeds({
      NODE_ENV: "production",
    })).toEqual([]);

    expect(() =>
      deriveGatewaySyncUserSeeds({
        MATRIX_USER_ID: "../secret",
        NODE_ENV: "production",
      }),
    ).toThrow(/Invalid sync user id/);
  });

  it("derives home-mirror development fallback seeds", () => {
    expect(deriveGatewaySyncUserSeeds({
      MATRIX_HANDLE: "alice",
      MATRIX_HOME_MIRROR: "true",
      NODE_ENV: "development",
    })).toEqual([
      { id: "default", handle: "default" },
      { id: "alice", handle: "alice" },
    ]);
  });
});
