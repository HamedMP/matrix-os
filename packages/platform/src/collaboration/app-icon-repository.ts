import { sql, type Kysely } from "kysely";
import type { CollaborativeAppIconContentType } from "@matrix-os/contracts";
import type { CollaborationPlatformDatabase } from "./database.js";

/** Icons a runtime may keep at once; shares beyond this keep the launcher letter tile. */
const DEFAULT_MAX_ICONS_PER_RUNTIME = 64;
/** An unreferenced upload survives this long so a directory event still in flight can name it. */
const UNREFERENCED_ICON_GRACE_MS = 7 * 24 * 60 * 60_000;

export class CollaborativeAppIconCapacityError extends Error {
  constructor() {
    super("Collaborative app icon capacity reached");
    this.name = "CollaborativeAppIconCapacityError";
  }
}

/**
 * Content-addressed shared app icons, scoped to the uploading runtime. The platform stores only
 * bytes an authenticated owner runtime pushed after raster sniffing; it never fetches owner URLs.
 */
export class CollaborativeAppIconRepository {
  private readonly now: () => Date;
  private readonly maxPerRuntime: number;

  constructor(
    private readonly db: Kysely<CollaborationPlatformDatabase>,
    options: { now?: () => Date; maxPerRuntime?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxPerRuntime = Math.max(1, Math.trunc(options.maxPerRuntime ?? DEFAULT_MAX_ICONS_PER_RUNTIME));
  }

  /**
   * Idempotent upsert. A repeat upload only refreshes `last_uploaded_at` (the bytes are identical by
   * address). When the runtime is at its cap, its oldest icon no directory row names is evicted in
   * the same transaction; if every stored icon is still named, the upload is refused.
   */
  async put(input: {
    runtimeId: string;
    sha256: string;
    contentType: CollaborativeAppIconContentType;
    bytes: Uint8Array;
    uploadedAt?: Date;
  }): Promise<void> {
    const uploadedAt = (input.uploadedAt ?? this.now()).toISOString();
    await this.db.transaction().execute(async (trx) => {
      // Serializes cap accounting per runtime; distinct runtimes stay parallel.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`collaboration_app_icons:${input.runtimeId}`}))`.execute(trx);
      const refreshed = await trx.updateTable("collaboration_app_icons")
        .set({ last_uploaded_at: uploadedAt })
        .where("runtime_id", "=", input.runtimeId)
        .where("sha256", "=", input.sha256)
        .returning("sha256")
        .executeTakeFirst();
      if (refreshed) return;
      const counted = await trx.selectFrom("collaboration_app_icons")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("runtime_id", "=", input.runtimeId)
        .executeTakeFirstOrThrow();
      const overflow = Number(counted.count) - this.maxPerRuntime + 1;
      if (overflow > 0) {
        const evicted = await trx.deleteFrom("collaboration_app_icons")
          .where("runtime_id", "=", input.runtimeId)
          .where("sha256", "in", (eb) => eb.selectFrom("collaboration_app_icons as icon")
            .select("icon.sha256")
            .where("icon.runtime_id", "=", input.runtimeId)
            .where(({ not, exists, selectFrom }) => not(exists(
              selectFrom("collaboration_directory as directory").select("directory.scope_id")
                .whereRef("directory.runtime_id", "=", "icon.runtime_id")
                .whereRef("directory.app_icon_sha256", "=", "icon.sha256"),
            )))
            .orderBy("icon.last_uploaded_at", "asc")
            .limit(overflow))
          .returning("sha256")
          .execute();
        if (evicted.length < overflow) throw new CollaborativeAppIconCapacityError();
      }
      await trx.insertInto("collaboration_app_icons").values({
        runtime_id: input.runtimeId,
        sha256: input.sha256,
        content_type: input.contentType,
        bytes: Buffer.from(input.bytes),
        created_at: uploadedAt,
        last_uploaded_at: uploadedAt,
      }).onConflict((conflict) => conflict.columns(["runtime_id", "sha256"]).doUpdateSet({
        last_uploaded_at: uploadedAt,
      })).execute();
    });
  }

  async get(runtimeId: string, sha256: string): Promise<{ contentType: CollaborativeAppIconContentType; bytes: Buffer } | null> {
    const row = await this.db.selectFrom("collaboration_app_icons")
      .select(["content_type", "bytes"])
      .where("runtime_id", "=", runtimeId)
      .where("sha256", "=", sha256)
      .executeTakeFirst();
    return row ? { contentType: row.content_type, bytes: Buffer.from(row.bytes) } : null;
  }

  /** Bounded sweep of icons no directory row names and no runtime refreshed within the grace period. */
  async collectUnreferenced(limit = 25): Promise<number> {
    const cutoff = new Date(this.now().getTime() - UNREFERENCED_ICON_GRACE_MS).toISOString();
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const victims = await this.db.selectFrom("collaboration_app_icons as icon")
      .select(["icon.runtime_id", "icon.sha256"])
      .where("icon.last_uploaded_at", "<", cutoff)
      .where(({ not, exists, selectFrom }) => not(exists(
        selectFrom("collaboration_directory as directory").select("directory.scope_id")
          .whereRef("directory.runtime_id", "=", "icon.runtime_id")
          .whereRef("directory.app_icon_sha256", "=", "icon.sha256"),
      )))
      .orderBy("icon.last_uploaded_at", "asc")
      .limit(bounded)
      .execute();
    let deleted = 0;
    for (const victim of victims) {
      // Re-checked in the delete itself: an event that named the icon since the scan keeps it.
      const result = await this.db.deleteFrom("collaboration_app_icons")
        .where("runtime_id", "=", victim.runtime_id)
        .where("sha256", "=", victim.sha256)
        .where("last_uploaded_at", "<", cutoff)
        .where(({ not, exists, selectFrom }) => not(exists(
          selectFrom("collaboration_directory as directory").select("directory.scope_id")
            .where("directory.runtime_id", "=", victim.runtime_id)
            .where("directory.app_icon_sha256", "=", victim.sha256),
        )))
        .returning("sha256")
        .executeTakeFirst();
      if (result) deleted += 1;
    }
    return deleted;
  }
}
