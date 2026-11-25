/**
 * Durable per-phone consent and replaceable delivery tokens in owner Postgres.
 * A private retained identity survives Expo token rotation. Expiry and provider
 * cleanup remove delivery only; explicit opt-out retains a consent tombstone.
 * Callers pass validated, bounded values; database CHECKs back the bounds.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { NotificationDatabase } from "./schema.js";
import { trimPushConsents } from "./push-consent-schema.js";
export { MAX_PUSH_CONSENTS_PER_OWNER } from "./push-consent-schema.js";

export interface PushRegistrationStatus { enabled: boolean; registered: boolean }
type Registration = { token: string; identity?: string; platform: string; ownerId: string; seenAt: Date; maxPerOwner: number };

export interface PushTokenStore {
  /**
   * Upserts the token, then evicts the owner's least recently seen tokens
   * beyond `maxPerOwner` in the same transaction. A per-owner advisory lock
   * keeps concurrent registrations from overshooting the cap.
   */
  register(input: Registration): Promise<void>;
  /** Refreshes delivery only while durable consent is still on. Never grants consent. */
  refresh(input: Registration): Promise<boolean>;
  /** Explicit opt-out: retain off consent, remove this owner's linked delivery tokens. */
  remove(input: { token: string; deliveryToken?: string; ownerId: string; seenAt?: Date }): Promise<void>;
  status(input: { identity: string; ownerId: string; seenSince: Date }): Promise<PushRegistrationStatus>;
  /** Removes tokens Expo reported as no longer registered, whoever owns them. */
  removeDeviceTokens(tokens: readonly string[]): Promise<void>;
  /** The owner's newest tokens seen since `seenSince`. There is no query across owners. */
  listRecent(input: { ownerId: string; seenSince: Date; limit: number }): Promise<string[]>;
  /** Deletes tokens last seen before `cutoff` and returns how many. */
  deleteUnseenBefore(cutoff: Date): Promise<number>;
}

export function createPushTokenStore(db: Kysely<NotificationDatabase>): PushTokenStore {
  async function withOwner<T>(ownerId: string, operation: (trx: Transaction<NotificationDatabase>) => Promise<T>): Promise<T> {
    return db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('matrix-notification-schema', 0))`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`matrix-push-tokens:${ownerId}`}, 0))`.execute(trx);
      return operation(trx);
    });
  }

  async function consent(trx: Transaction<NotificationDatabase>, ownerId: string, identity: string, token: string, enabled: boolean, at: Date) {
    await trx.insertInto("notification_push_consents").values({ owner_id: ownerId, identity, delivery_token: token, enabled, updated_at: at })
      .onConflict((conflict) => conflict.columns(["owner_id", "identity"]).doUpdateSet({ enabled, delivery_token: token, updated_at: at })).execute();
  }

  async function delivery(trx: Transaction<NotificationDatabase>, input: Registration) {
    const { token, platform, ownerId, seenAt, maxPerOwner } = input;
    const identity = input.identity ?? token;
    // A rotating Expo token must not leave a second delivery behind for the
    // same phone, and opt-out must be able to revoke the current token later.
    await trx.deleteFrom("notification_push_tokens").where("owner_id", "=", ownerId)
      .where("identity", "=", identity).where("token", "!=", token).execute();
    await trx.insertInto("notification_push_tokens")
      .values({ token, identity, owner_id: ownerId, platform, created_at: seenAt, last_seen_at: seenAt })
      .onConflict((conflict) => conflict.column("token").doUpdateSet({ identity, owner_id: ownerId, platform, last_seen_at: seenAt })).execute();
    // A legacy import may have used this delivery token as another identity.
    // Collapse that alias when the retained identity proves the same phone.
    await trx.deleteFrom("notification_push_consents").where("owner_id", "=", ownerId).where("identity", "!=", identity)
      .where((eb) => eb.or([eb("identity", "=", token), eb("delivery_token", "=", token)])).execute();
    const kept = trx.selectFrom("notification_push_tokens").select("token").where("owner_id", "=", ownerId)
      .orderBy("last_seen_at", "desc").orderBy("token", "desc").limit(maxPerOwner);
    await trx.deleteFrom("notification_push_tokens").where("owner_id", "=", ownerId).where("token", "not in", kept).execute();
  }

  return {
    async register(input) {
      await withOwner(input.ownerId, async (trx) => {
        await consent(trx, input.ownerId, input.identity ?? input.token, input.token, true, input.seenAt);
        await delivery(trx, input);
        await trimPushConsents(trx, input.ownerId);
      });
    },

    async refresh(input) {
      return withOwner(input.ownerId, async (trx) => {
        const identity = input.identity ?? input.token;
        const allowed = await trx.selectFrom("notification_push_consents").select("identity")
          .where("owner_id", "=", input.ownerId).where("identity", "=", identity).where("enabled", "=", true).forUpdate().executeTakeFirst();
        if (!allowed) return false;
        const offAlias = await trx.selectFrom("notification_push_consents").select("identity")
          .where("owner_id", "=", input.ownerId).where("enabled", "=", false)
          .where((eb) => eb.or([eb("identity", "=", input.token), eb("delivery_token", "=", input.token)])).executeTakeFirst();
        if (offAlias) return false;
        await delivery(trx, input);
        await trx.updateTable("notification_push_consents").set({ delivery_token: input.token, updated_at: input.seenAt })
          .where("owner_id", "=", input.ownerId).where("identity", "=", identity).where("enabled", "=", true).execute();
        return true;
      });
    },

    async remove({ token, deliveryToken, ownerId, seenAt = new Date() }) {
      await withOwner(ownerId, async (trx) => {
        const aliases = deliveryToken && deliveryToken !== token ? [token, deliveryToken] : [token];
        const related = await trx.selectFrom("notification_push_consents").select(["identity", "delivery_token"])
          .where("owner_id", "=", ownerId)
          .where((eb) => eb.or([eb("identity", "in", aliases), eb("delivery_token", "in", aliases)])).execute();
        const deliveries = await trx.selectFrom("notification_push_tokens").select("identity")
          .where("owner_id", "=", ownerId).where("token", "in", aliases).execute();
        // At most the owner's 64 consent records plus the two supplied aliases.
        // Retain both an imported rotation and the stable identity on opt-out.
        const identities = new Set(related.map((row) => row.identity));
        for (const row of deliveries) if (row.identity) identities.add(row.identity);
        if (!related.some((row) => row.identity === token || row.delivery_token === token)) identities.add(token);
        for (const identity of identities) {
          const prior = related.find((row) => row.identity === identity);
          await consent(trx, ownerId, identity, prior?.delivery_token ?? deliveryToken ?? token, false, seenAt);
        }
        await trx.insertInto("notification_push_consent_owners").values({ owner_id: ownerId, legacy_import_blocked: true, updated_at: seenAt })
          .onConflict((conflict) => conflict.column("owner_id").doUpdateSet({ legacy_import_blocked: true, updated_at: seenAt })).execute();
        await trx.deleteFrom("notification_push_tokens").where("owner_id", "=", ownerId)
          .where((eb) => eb.or([eb("identity", "in", [...identities]), eb("token", "in", aliases)])).execute();
        await trimPushConsents(trx, ownerId);
      });
    },

    async status({ identity, ownerId, seenSince }) {
      const row = await db.selectFrom("notification_push_consents").select(["enabled", sql<boolean>`EXISTS (
        SELECT 1 FROM notification_push_tokens AS delivery WHERE delivery.owner_id = ${ownerId}
        AND delivery.identity = notification_push_consents.identity AND delivery.last_seen_at >= ${seenSince}
      )`.as("registered")]).where("owner_id", "=", ownerId)
        .where((eb) => eb.or([eb("identity", "=", identity), eb("delivery_token", "=", identity)]))
        .orderBy("enabled", "asc").executeTakeFirst();
      return row ?? { enabled: false, registered: false };
    },

    async removeDeviceTokens(tokens) {
      if (tokens.length === 0) return;
      await db.deleteFrom("notification_push_tokens").where("token", "in", [...tokens]).execute();
    },

    async listRecent({ ownerId, seenSince, limit }) {
      const rows = await db.selectFrom("notification_push_tokens as delivery")
        .innerJoin("notification_push_consents as consent", (join) => join
          .onRef("consent.owner_id", "=", "delivery.owner_id").onRef("consent.identity", "=", "delivery.identity"))
        .select("delivery.token").where("delivery.owner_id", "=", ownerId).where("consent.enabled", "=", true)
        .where("delivery.last_seen_at", ">=", seenSince)
        .orderBy("delivery.last_seen_at", "desc").orderBy("delivery.token", "desc").limit(limit).execute();
      return rows.map((row) => row.token);
    },

    async deleteUnseenBefore(cutoff) {
      const result = await db.deleteFrom("notification_push_tokens")
        .where("last_seen_at", "<", cutoff).executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
