import { sql, type Kysely } from "kysely";

// ---------------------------------------------------------------------------
// Kysely table interfaces
// ---------------------------------------------------------------------------

export interface SyncManifestsTable {
  user_id: string;
  version: number;
  file_count: number;
  total_size: bigint;
  etag: string | null;
  updated_at: Date;
}

export interface SyncSharesTable {
  id: string;
  owner_id: string;
  path: string;
  grantee_id: string;
  role: "viewer" | "editor" | "admin";
  accepted: boolean;
  created_at: Date;
  expires_at: Date | null;
}

export interface SyncUsersTable {
  id: string;
  handle: string;
}

export interface SyncDatabase {
  sync_manifests: SyncManifestsTable;
  sync_shares: SyncSharesTable;
  users: SyncUsersTable;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export async function migrateSyncTables(db: Kysely<SyncDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS sync_manifests (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      total_size BIGINT NOT NULL DEFAULT 0,
      etag TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS sync_shares (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      grantee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
      accepted BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      UNIQUE (owner_id, path, grantee_id),
      CHECK (owner_id != grantee_id)
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_sync_shares_grantee ON sync_shares(grantee_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_sync_shares_owner ON sync_shares(owner_id)`.execute(db);
}
