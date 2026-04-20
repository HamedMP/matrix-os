import { sql, type Kysely } from "kysely";
import type { ManifestDb, ManifestDbExecutor, ManifestMeta } from "./manifest.js";
import type { SharingDb, ShareRow } from "./sharing.js";
import type { ShareRole } from "./types.js";
import type { SyncDatabase } from "./sharing-db.js";

export function createManifestDb(kysely: Kysely<SyncDatabase>): ManifestDb {
  function getExecutor(executor?: ManifestDbExecutor): ManifestDbExecutor {
    return executor ?? kysely;
  }

  return {
    async getManifestMeta(
      userId: string,
      executor?: ManifestDbExecutor,
    ): Promise<ManifestMeta | null> {
      const row = await getExecutor(executor)
        .selectFrom("sync_manifests")
        .selectAll()
        .where("user_id", "=", userId)
        .executeTakeFirst();

      if (!row) return null;

      return {
        version: row.version,
        file_count: row.file_count,
        total_size: BigInt(row.total_size),
        etag: row.etag,
        updated_at: row.updated_at,
      };
    },

    async getAggregateManifestStats(): Promise<{ fileCount: number; totalSize: bigint }> {
      const row = await kysely
        .selectFrom("sync_manifests")
        .select([
          sql<number>`COALESCE(SUM(file_count), 0)`.as("file_count"),
          sql<string>`COALESCE(SUM(total_size), 0)`.as("total_size"),
        ])
        .executeTakeFirstOrThrow();

      return {
        fileCount: Number(row.file_count ?? 0),
        totalSize: BigInt(row.total_size ?? "0"),
      };
    },

    async upsertManifestMeta(
      userId: string,
      meta: Omit<ManifestMeta, "updated_at">,
      executor?: ManifestDbExecutor,
    ): Promise<void> {
      await getExecutor(executor)
        .insertInto("sync_manifests")
        .values({
          user_id: userId,
          version: meta.version,
          file_count: meta.file_count,
          total_size: meta.total_size,
          etag: meta.etag,
          updated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.column("user_id").doUpdateSet({
            version: meta.version,
            file_count: meta.file_count,
            total_size: meta.total_size,
            etag: meta.etag,
            updated_at: new Date(),
          }),
        )
        .execute();
    },

    async withAdvisoryLock<T>(
      userId: string,
      fn: (executor: ManifestDbExecutor) => Promise<T>,
    ): Promise<T> {
      return await kysely.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`.execute(trx);
        return fn(trx);
      });
    },
  };
}

export function createKyselySharingDb(kysely: Kysely<SyncDatabase>): SharingDb {
  return {
    async insertShare(input: {
      owner_id: string;
      path: string;
      grantee_id: string;
      role: ShareRole;
      expires_at?: string;
    }): Promise<ShareRow> {
      const row = await kysely
        .insertInto("sync_shares")
        .values({
          owner_id: input.owner_id,
          path: input.path,
          grantee_id: input.grantee_id,
          role: input.role,
          accepted: false,
          created_at: new Date(),
          expires_at: input.expires_at ? new Date(input.expires_at) : null,
        } as any)
        .returningAll()
        .executeTakeFirstOrThrow();

      return row as unknown as ShareRow;
    },

    async getShare(shareId: string): Promise<ShareRow | null> {
      const row = await kysely
        .selectFrom("sync_shares")
        .selectAll()
        .where("id", "=", shareId)
        .executeTakeFirst();

      return (row as unknown as ShareRow) ?? null;
    },

    async updateShareAccepted(shareId: string, accepted: boolean): Promise<void> {
      await kysely
        .updateTable("sync_shares")
        .set({ accepted })
        .where("id", "=", shareId)
        .execute();
    },

    async deleteShare(shareId: string): Promise<void> {
      await kysely
        .deleteFrom("sync_shares")
        .where("id", "=", shareId)
        .execute();
    },

    async listSharesByOwner(ownerId: string): Promise<ShareRow[]> {
      const rows = await kysely
        .selectFrom("sync_shares")
        .selectAll()
        .where("owner_id", "=", ownerId)
        .execute();

      return rows as unknown as ShareRow[];
    },

    async listSharesByGrantee(granteeId: string): Promise<ShareRow[]> {
      const rows = await kysely
        .selectFrom("sync_shares")
        .selectAll()
        .where("grantee_id", "=", granteeId)
        .execute();

      return rows as unknown as ShareRow[];
    },

    async listSharesByGranteeAndOwner(granteeId: string, ownerId: string): Promise<ShareRow[]> {
      const rows = await kysely
        .selectFrom("sync_shares")
        .selectAll()
        .where("grantee_id", "=", granteeId)
        .where("owner_id", "=", ownerId)
        .execute();

      return rows as unknown as ShareRow[];
    },

    async resolveHandle(handle: string): Promise<string | null> {
      const row = await kysely
        .selectFrom("users" as any)
        .select("id")
        .where("handle" as any, "=", handle)
        .executeTakeFirst();

      return (row as any)?.id ?? null;
    },

    async resolveUserId(userId: string): Promise<string | null> {
      const row = await kysely
        .selectFrom("users" as any)
        .select("handle" as any)
        .where("id" as any, "=", userId)
        .executeTakeFirst();

      return (row as any)?.handle ?? null;
    },

    async resolveUserIds(userIds: string[]): Promise<Map<string, string>> {
      const ids = Array.from(new Set(userIds));
      if (ids.length === 0) {
        return new Map();
      }

      const rows = await kysely
        .selectFrom("users" as any)
        .select(["id" as any, "handle" as any])
        .where("id" as any, "in", ids)
        .execute();

      const resolved = new Map<string, string>();
      for (const row of rows as Array<{ id: string; handle: string }>) {
        resolved.set(row.id, row.handle);
      }
      return resolved;
    },
  };
}
