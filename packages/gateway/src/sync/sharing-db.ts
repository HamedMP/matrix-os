import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";

const SAFE_SYNC_USER_VALUE = /^[A-Za-z0-9_-]{1,256}$/;

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

export interface SyncUserSeed {
  id: string;
  handle: string;
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

export function assertSafeSyncUserId(id: string): void {
  if (!SAFE_SYNC_USER_VALUE.test(id)) {
    throw new Error("Invalid sync user id");
  }
}

export function assertSafeSyncUserHandle(handle: string): void {
  if (!SAFE_SYNC_USER_VALUE.test(handle)) {
    throw new Error("Invalid sync user handle");
  }
}

async function reserveTemporarySyncUserHandle(
  trx: Transaction<SyncDatabase>,
  input: SyncUserSeed,
  existingId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const digest = createHash("sha256")
      .update(`${input.id}\0${input.handle}\0${existingId}\0${attempt}`)
      .digest("hex")
      .slice(0, 12);
    const prefix = "__sync_seed_";
    const suffix = `_${digest}`;
    const maxIdLength = 256 - prefix.length - suffix.length;
    const handle = `${prefix}${input.id.slice(0, Math.max(1, maxIdLength))}${suffix}`;
    const existing = await trx
      .selectFrom("users")
      .select("id")
      .where("handle", "=", handle)
      .executeTakeFirst();
    if (!existing) {
      return handle;
    }
  }

  throw new Error("Could not reserve temporary sync user handle");
}

async function migrateSyncUserReferences(
  trx: Transaction<SyncDatabase>,
  fromId: string,
  input: SyncUserSeed,
): Promise<void> {
  const temporaryHandle = await reserveTemporarySyncUserHandle(trx, input, fromId);

  await trx
    .insertInto("users")
    .values({ id: input.id, handle: temporaryHandle })
    .execute();
  await trx
    .updateTable("sync_manifests")
    .set({ user_id: input.id })
    .where("user_id", "=", fromId)
    .execute();
  await trx
    .updateTable("sync_shares")
    .set({ owner_id: input.id })
    .where("owner_id", "=", fromId)
    .execute();
  await trx
    .updateTable("sync_shares")
    .set({ grantee_id: input.id })
    .where("grantee_id", "=", fromId)
    .execute();
  await trx
    .deleteFrom("users")
    .where("id", "=", fromId)
    .execute();
  await trx
    .updateTable("users")
    .set({ handle: input.handle })
    .where("id", "=", input.id)
    .execute();
}

export async function ensureSyncUser(
  db: Kysely<SyncDatabase>,
  input: SyncUserSeed,
): Promise<void> {
  assertSafeSyncUserId(input.id);
  assertSafeSyncUserHandle(input.handle);

  await db.transaction().setIsolationLevel("serializable").execute(async (trx) => {
    const rowById = await trx
      .selectFrom("users")
      .select(["id", "handle"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    const rowByHandle = await trx
      .selectFrom("users")
      .select(["id", "handle"])
      .where("handle", "=", input.handle)
      .executeTakeFirst();

    if (rowById && rowByHandle && rowByHandle.id !== input.id) {
      console.warn(
        `[sync] Skipped sync user seed for id "${input.id}" and handle "${input.handle}" because they already belong to different users.`,
      );
      return;
    }

    if (rowById) {
      await trx
        .updateTable("users")
        .set({ handle: input.handle })
        .where("id", "=", input.id)
        .execute();
      return;
    }

    if (rowByHandle) {
      await migrateSyncUserReferences(trx, rowByHandle.id, input);
      return;
    }

    await trx
      .insertInto("users")
      .values({ id: input.id, handle: input.handle })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          handle: input.handle,
        }),
      )
      .execute();
  });
}

function isLocalDevelopmentEnv(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = env.NODE_ENV;
  return nodeEnv === undefined ||
    nodeEnv === "" ||
    nodeEnv === "development" ||
    nodeEnv === "test" ||
    nodeEnv === "local";
}

export function deriveGatewaySyncUserSeeds(
  env: NodeJS.ProcessEnv = process.env,
): SyncUserSeed[] {
  const seeds = new Map<string, string>();
  const addSeed = (id: string, handle: string) => {
    assertSafeSyncUserId(id);
    assertSafeSyncUserHandle(handle);
    seeds.set(id, handle);
  };

  if (env.MATRIX_USER_ID) {
    addSeed(env.MATRIX_USER_ID, env.MATRIX_HANDLE ?? env.MATRIX_USER_ID);
  } else if (
    isLocalDevelopmentEnv(env) &&
    !env.MATRIX_AUTH_TOKEN &&
    env.NODE_ENV !== "production"
  ) {
    addSeed("default", "default");
  }

  if (
    env.MATRIX_HOME_MIRROR === "true" &&
    !env.MATRIX_USER_ID &&
    isLocalDevelopmentEnv(env) &&
    env.MATRIX_HANDLE
  ) {
    addSeed(env.MATRIX_HANDLE, env.MATRIX_HANDLE);
  }

  return Array.from(seeds, ([id, handle]) => ({ id, handle }));
}
