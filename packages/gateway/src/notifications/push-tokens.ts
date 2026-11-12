/**
 * Expo push tokens in owner Postgres (spec 652, A2), so pushes keep working
 * after gateway restarts and updates. A token is one device: registering it
 * again refreshes `last_seen_at` and moves it to the owner who registered it.
 * Callers pass validated, bounded values; the table's CHECKs back the bounds.
 */
import { sql, type Kysely } from "kysely";
import type { NotificationDatabase } from "./schema.js";

export interface PushTokenStore {
  /**
   * Upserts the token, then evicts the owner's least recently seen tokens
   * beyond `maxPerOwner` in the same transaction. A per-owner advisory lock
   * keeps concurrent registrations from overshooting the cap.
   */
  register(input: { token: string; platform: string; ownerId: string; seenAt: Date; maxPerOwner: number }): Promise<void>;
  /** Removes the token only if it belongs to `ownerId`. */
  remove(input: { token: string; ownerId: string }): Promise<void>;
  /** Removes tokens Expo reported as no longer registered, whoever owns them. */
  removeDeviceTokens(tokens: readonly string[]): Promise<void>;
  /** Newest tokens seen since `seenSince`; every owner's when `ownerId` is undefined. */
  listRecent(input: { ownerId?: string; seenSince: Date; limit: number }): Promise<string[]>;
  /** Deletes tokens last seen before `cutoff` and returns how many. */
  deleteUnseenBefore(cutoff: Date): Promise<number>;
}

export function createPushTokenStore(db: Kysely<NotificationDatabase>): PushTokenStore {
  return {
    async register({ token, platform, ownerId, seenAt, maxPerOwner }) {
      await db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`matrix-push-tokens:${ownerId}`}, 0))`.execute(trx);
        await trx.insertInto("notification_push_tokens")
          .values({ token, owner_id: ownerId, platform, created_at: seenAt, last_seen_at: seenAt })
          .onConflict((conflict) => conflict.column("token").doUpdateSet({ owner_id: ownerId, platform, last_seen_at: seenAt }))
          .execute();
        const kept = trx.selectFrom("notification_push_tokens").select("token")
          .where("owner_id", "=", ownerId)
          .orderBy("last_seen_at", "desc").orderBy("token", "desc")
          .limit(maxPerOwner);
        await trx.deleteFrom("notification_push_tokens")
          .where("owner_id", "=", ownerId)
          .where("token", "not in", kept)
          .execute();
      });
    },

    async remove({ token, ownerId }) {
      await db.deleteFrom("notification_push_tokens")
        .where("token", "=", token).where("owner_id", "=", ownerId).execute();
    },

    async removeDeviceTokens(tokens) {
      if (tokens.length === 0) return;
      await db.deleteFrom("notification_push_tokens").where("token", "in", [...tokens]).execute();
    },

    async listRecent({ ownerId, seenSince, limit }) {
      let query = db.selectFrom("notification_push_tokens").select("token")
        .where("last_seen_at", ">=", seenSince);
      if (ownerId !== undefined) query = query.where("owner_id", "=", ownerId);
      const rows = await query.orderBy("last_seen_at", "desc").orderBy("token", "desc").limit(limit).execute();
      return rows.map((row) => row.token);
    },

    async deleteUnseenBefore(cutoff) {
      const result = await db.deleteFrom("notification_push_tokens")
        .where("last_seen_at", "<", cutoff).executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
