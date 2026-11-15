import { sql, type Kysely, type Transaction } from "kysely";
import type {
  CollaborativeAppArtworkContentType,
  CollaborativeAppPresentationPublish,
} from "@matrix-os/contracts";
import type { CollaborationPlatformDatabase } from "./database.js";

const MAX_LISTED_SCOPES = 100;
const EXPIRED_WINDOW_SWEEP_LIMIT = 100;

export interface CollaborativeAppPresentationOwner {
  scopeId: string;
  runtimeId: string;
  ownerId: string;
}

/** What a launcher may show: the owner's name, plus a digest only once verified bytes are stored. */
export interface CollaborativeAppStoredPresentation {
  name: string;
  artworkSha256?: string;
}

/**
 * Owner-published launcher presentation. Every write is bound to the directory row's owner,
 * runtime, and exact app, and only while that row is an active current-membership share.
 */
export class CollaborativeAppPresentationRepository {
  constructor(
    private readonly db: Kysely<CollaborationPlatformDatabase>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Returns null when the scope is not this runtime's active share of `appId`. */
  async publish(
    owner: CollaborativeAppPresentationOwner,
    input: CollaborativeAppPresentationPublish,
  ): Promise<{ artworkRequired: boolean } | null> {
    return this.db.transaction().execute(async (trx) => {
      if (!await lockActiveShare(trx, owner, input.appId)) return null;
      const artwork = input.artwork;
      const row = await trx.insertInto("collaboration_app_presentations").values({
        scope_id: owner.scopeId,
        app_id: input.appId,
        name: input.name,
        artwork_sha256: artwork?.sha256 ?? null,
        artwork_content_type: artwork?.contentType ?? null,
        artwork_byte_length: artwork?.byteLength ?? null,
        artwork_bytes: null,
        updated_at: this.now().toISOString(),
      }).onConflict((conflict) => conflict.column("scope_id").doUpdateSet({
        app_id: (eb) => eb.ref("excluded.app_id"),
        name: (eb) => eb.ref("excluded.name"),
        artwork_sha256: (eb) => eb.ref("excluded.artwork_sha256"),
        artwork_content_type: (eb) => eb.ref("excluded.artwork_content_type"),
        artwork_byte_length: (eb) => eb.ref("excluded.artwork_byte_length"),
        // Verified bytes survive only an unchanged declaration; any change waits for a new upload.
        artwork_bytes: sql<Uint8Array | null>`CASE
          WHEN collaboration_app_presentations.app_id = excluded.app_id
            AND collaboration_app_presentations.artwork_sha256 IS NOT DISTINCT FROM excluded.artwork_sha256
            AND collaboration_app_presentations.artwork_content_type IS NOT DISTINCT FROM excluded.artwork_content_type
          THEN collaboration_app_presentations.artwork_bytes ELSE NULL END`,
        updated_at: (eb) => eb.ref("excluded.updated_at"),
      }))
        .returning(sql<boolean>`artwork_bytes IS NULL`.as("artwork_missing"))
        .executeTakeFirstOrThrow();
      return { artworkRequired: artwork !== null && row.artwork_missing };
    });
  }

  /** `conflict`: the bytes do not answer the current declaration (stale, undeclared, or mismatched). */
  async storeArtwork(
    owner: CollaborativeAppPresentationOwner,
    artwork: { sha256: string; contentType: CollaborativeAppArtworkContentType; bytes: Uint8Array },
  ): Promise<"stored" | "not_found" | "conflict"> {
    return this.db.transaction().execute(async (trx) => {
      const presentation = await trx.selectFrom("collaboration_app_presentations").select("app_id")
        .where("scope_id", "=", owner.scopeId).executeTakeFirst();
      if (!await lockActiveShare(trx, owner, presentation?.app_id)) return "not_found";
      const stored = await trx.updateTable("collaboration_app_presentations")
        .set({ artwork_bytes: artwork.bytes, updated_at: this.now().toISOString() })
        .where("scope_id", "=", owner.scopeId)
        .where("artwork_sha256", "=", artwork.sha256)
        .where("artwork_content_type", "=", artwork.contentType)
        .where("artwork_byte_length", "=", artwork.bytes.byteLength)
        .returning("scope_id")
        .executeTakeFirst();
      return stored ? "stored" : "conflict";
    });
  }

  /**
   * The current artwork's type and size for an active share, without reading its bytes, so a
   * revalidation or a refused read never loads an image. Membership is the caller's responsibility.
   */
  async describeArtwork(scopeId: string, sha256: string): Promise<{ contentType: CollaborativeAppArtworkContentType; byteLength: number } | null> {
    const row = await this.currentArtwork(scopeId, sha256)
      .select(["presentation.artwork_content_type", "presentation.artwork_byte_length"])
      .executeTakeFirst();
    return row?.artwork_content_type && row.artwork_byte_length
      ? { contentType: row.artwork_content_type, byteLength: Number(row.artwork_byte_length) }
      : null;
  }

  /** The current artwork's bytes, under the same active-share and current-digest conditions. */
  async readArtworkBytes(scopeId: string, sha256: string): Promise<Uint8Array | null> {
    const row = await this.currentArtwork(scopeId, sha256).select("presentation.artwork_bytes").executeTakeFirst();
    return row?.artwork_bytes ? new Uint8Array(row.artwork_bytes) : null;
  }

  /**
   * Atomically reserves `bytes` of one member's fleet-wide artwork budget for the current fixed
   * window; every worker shares the same row, so the bound does not multiply per worker. Expired
   * windows are swept in bounded batches as new reads are recorded.
   */
  async reserveArtworkReadBytes(input: { actorId: string; bytes: number; limit: number; windowMs: number; now: number }): Promise<boolean> {
    if (input.bytes <= 0 || input.bytes > input.limit) return false;
    const windowStart = new Date(Math.floor(input.now / input.windowMs) * input.windowMs);
    return this.db.transaction().execute(async (trx) => {
      const reserved = await trx.insertInto("collaboration_app_artwork_reads")
        .values({ actor_id: input.actorId, window_start: windowStart.toISOString(), bytes: input.bytes })
        .onConflict((conflict) => conflict.columns(["actor_id", "window_start"])
          .doUpdateSet({ bytes: sql<number>`collaboration_app_artwork_reads.bytes + excluded.bytes` })
          .where(sql<boolean>`collaboration_app_artwork_reads.bytes + excluded.bytes <= ${input.limit}`))
        .returning("bytes")
        .executeTakeFirst();
      if (!reserved) return false;
      await trx.deleteFrom("collaboration_app_artwork_reads")
        .where("actor_id", "=", input.actorId)
        .where("window_start", "<", windowStart.toISOString())
        .execute();
      await sql`DELETE FROM collaboration_app_artwork_reads
        WHERE (actor_id, window_start) IN (
          SELECT actor_id, window_start FROM collaboration_app_artwork_reads
          WHERE window_start < ${windowStart.toISOString()} LIMIT ${EXPIRED_WINDOW_SWEEP_LIMIT}
        )`.execute(trx);
      return true;
    });
  }

  private currentArtwork(scopeId: string, sha256: string) {
    return this.db.selectFrom("collaboration_app_presentations as presentation")
      .innerJoin("collaboration_directory as directory", "directory.scope_id", "presentation.scope_id")
      .where("presentation.scope_id", "=", scopeId)
      .where("presentation.artwork_sha256", "=", sha256)
      .where("presentation.artwork_bytes", "is not", null)
      .where("directory.app_state", "=", "active")
      .whereRef("directory.app_id", "=", "presentation.app_id");
  }

  /** Presentations for listed shares; an entry whose app changed since publication has none. */
  async listForShares(shares: ReadonlyArray<{ scopeId: string; appId: string }>): Promise<Map<string, CollaborativeAppStoredPresentation>> {
    const bounded = shares.slice(0, MAX_LISTED_SCOPES);
    if (bounded.length === 0) return new Map();
    const rows = await this.db.selectFrom("collaboration_app_presentations")
      .select(["scope_id", "app_id", "name", "artwork_sha256", sql<boolean>`artwork_bytes IS NOT NULL`.as("artwork_ready")])
      .where("scope_id", "in", bounded.map((share) => share.scopeId))
      .execute();
    const expected = new Map(bounded.map((share) => [share.scopeId, share.appId]));
    const presentations = new Map<string, CollaborativeAppStoredPresentation>();
    for (const row of rows) {
      if (expected.get(row.scope_id) !== row.app_id) continue;
      presentations.set(row.scope_id, {
        name: row.name,
        ...(row.artwork_ready && row.artwork_sha256 ? { artworkSha256: row.artwork_sha256 } : {}),
      });
    }
    return presentations;
  }
}

/** Shares the directory row so a concurrent stop or rebind cannot slip between check and write. */
async function lockActiveShare(
  trx: Transaction<CollaborationPlatformDatabase>,
  owner: CollaborativeAppPresentationOwner,
  appId: string | undefined,
): Promise<boolean> {
  if (!appId) return false;
  const route = await trx.selectFrom("collaboration_directory")
    .select(["kind", "audience", "app_state", "app_id", "owner_id", "runtime_id"])
    .where("scope_id", "=", owner.scopeId)
    .forShare()
    .executeTakeFirst();
  return Boolean(route && route.kind === "app" && route.audience === "current_membership"
    && route.app_state === "active" && route.app_id === appId
    && route.owner_id === owner.ownerId && route.runtime_id === owner.runtimeId);
}
