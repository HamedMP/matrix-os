import { sql, type ColumnType, type Kysely } from "kysely";

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;

export interface OrganizationDrivesTable {
  organization_id: string;
  scope_id: string;
  authority_runtime_id: string;
  authority_generation: number | string;
  quota_bytes: number | string;
  used_bytes: number | string;
  reserved_bytes: number | string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrganizationDriveFilesTable {
  id: string;
  organization_id: string;
  path: string;
  current_version: number;
  deleted_at: Date | string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrganizationDriveVersionsTable {
  id: string;
  file_id: string;
  version: number;
  object_key: string;
  size_bytes: number | string;
  sha256: string;
  created_by: string;
  created_at: Timestamp;
}

export interface OrganizationDriveUploadsTable {
  id: string;
  organization_id: string;
  actor_id: string;
  request_id: string;
  path: string;
  base_version: number;
  object_key: string;
  size_bytes: number | string;
  sha256: string;
  status: "pending" | "committed" | "expired" | "aborted";
  expires_at: Timestamp;
  committed_file_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrganizationDriveGarbageTable {
  object_key: string;
  organization_id: string;
  remove_after: Timestamp;
  attempts: number;
  created_at: Timestamp;
}

export interface OrganizationDriveDatabase {
  organization_drives: OrganizationDrivesTable;
  organization_drive_files: OrganizationDriveFilesTable;
  organization_drive_versions: OrganizationDriveVersionsTable;
  organization_drive_uploads: OrganizationDriveUploadsTable;
  organization_drive_garbage: OrganizationDriveGarbageTable;
}

/** Owner Postgres owns the drive index; the platform directory stores no file paths. */
export async function bootstrapOrganizationDriveDatabase(db: Kysely<OrganizationDriveDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`
      CREATE TABLE IF NOT EXISTS organization_drives (
        organization_id TEXT PRIMARY KEY,
        scope_id UUID NOT NULL UNIQUE,
        authority_runtime_id TEXT NOT NULL,
        authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
        quota_bytes BIGINT NOT NULL DEFAULT 1000000000000 CHECK (quota_bytes > 0),
        used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
        reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (used_bytes + reserved_bytes <= quota_bytes)
      )
    `.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS organization_drive_files (
        id UUID PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organization_drives(organization_id),
        path TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 800),
        current_version INTEGER NOT NULL CHECK (current_version > 0),
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(trx);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS organization_drive_files_live_path
      ON organization_drive_files(organization_id, path) WHERE deleted_at IS NULL`.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS organization_drive_versions (
        id UUID PRIMARY KEY,
        file_id UUID NOT NULL REFERENCES organization_drive_files(id),
        version INTEGER NOT NULL CHECK (version > 0),
        object_key TEXT NOT NULL UNIQUE,
        size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (file_id, version)
      )
    `.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS organization_drive_uploads (
        id UUID PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organization_drives(organization_id),
        actor_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        path TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 800),
        base_version INTEGER NOT NULL CHECK (base_version >= 0),
        object_key TEXT NOT NULL UNIQUE,
        size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'expired', 'aborted')),
        expires_at TIMESTAMPTZ NOT NULL,
        committed_file_id UUID REFERENCES organization_drive_files(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (organization_id, actor_id, request_id)
      )
    `.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS organization_drive_uploads_expiry
      ON organization_drive_uploads(expires_at) WHERE status = 'pending'`.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS organization_drive_garbage (
        object_key TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organization_drives(organization_id),
        remove_after TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(trx);
  });
}
