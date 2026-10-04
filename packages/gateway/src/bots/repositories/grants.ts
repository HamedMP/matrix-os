/**
 * Account grants (`bot_grants`): which connected accounts a bot may use, for
 * which effects, and in which conversation audience. One live grant exists
 * per bot, account, and audience (partial unique index). The broker checks
 * grants before dispatch; a revocation takes effect at the next checkpoint.
 */
import { sql, type Selectable } from "kysely";
import type { BotGrantsTable } from "../database.js";
import { BotStateError, isoTimestamp, newBotStateId, optionalIsoTimestamp, toSafeInteger, withTransaction, type BotExecutor } from "./shared.js";

export type BotEffect = "read" | "write" | "send";
const EFFECTS: readonly BotEffect[] = ["read", "write", "send"];
const MAX_GRANTS_LISTED = 100;

export interface BotGrantRecord {
  grantId: string;
  ownerId: string;
  botId: string;
  service: string;
  connectionId: string;
  accountLabel: string;
  effects: BotEffect[];
  audience: string;
  grantedByActorId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revision: number;
  createdAt: string;
}

function fromRow(row: Selectable<BotGrantsTable>): BotGrantRecord {
  return {
    grantId: row.grant_id,
    ownerId: row.owner_id,
    botId: row.bot_id,
    service: row.service,
    connectionId: row.connection_id,
    accountLabel: row.account_label,
    effects: EFFECTS.filter((effect) => row.effects.includes(effect)),
    audience: row.audience,
    grantedByActorId: row.granted_by_actor_id,
    expiresAt: optionalIsoTimestamp(row.expires_at),
    revokedAt: optionalIsoTimestamp(row.revoked_at),
    revision: toSafeInteger(row.revision),
    createdAt: isoTimestamp(row.created_at),
  };
}

function normalizedEffects(effects: readonly BotEffect[]): BotEffect[] {
  // At most one of each known effect; checked by counting, so no collection is built from the input.
  if (effects.length === 0 || effects.length > EFFECTS.length || effects.some((effect) => !EFFECTS.includes(effect))) {
    throw new BotStateError("invalid_input");
  }
  const unique = EFFECTS.filter((effect) => effects.includes(effect));
  if (unique.length !== effects.length) throw new BotStateError("invalid_input");
  return unique;
}

export function createBotGrantsRepository(db: BotExecutor) {
  return {
    /**
     * Grants an account to a bot. Granting the same effects again returns the
     * live grant; different effects for a live grant is a conflict (update it instead).
     */
    async grant(input: {
      ownerId: string;
      botId: string;
      service: string;
      connectionId: string;
      accountLabel: string;
      effects: readonly BotEffect[];
      audience: string;
      grantedByActorId: string;
      expiresAt?: string;
      now: string;
    }, executor: BotExecutor = db): Promise<{ grant: BotGrantRecord; created: boolean }> {
      const effects = normalizedEffects(input.effects);
      if (input.expiresAt !== undefined && !(Date.parse(input.expiresAt) > Date.parse(input.now))) throw new BotStateError("invalid_input");
      return withTransaction(executor, async (trx) => {
        // An expired grant still holds the live key; retire it so the account can be granted again.
        await trx.updateTable("bot_grants")
          .set({ revoked_at: input.now, revision: sql<number>`revision + 1`, updated_at: input.now })
          .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId)
          .where("service", "=", input.service).where("connection_id", "=", input.connectionId)
          .where("audience", "=", input.audience).where("revoked_at", "is", null)
          .where("expires_at", "<=", input.now)
          .execute();
        // ON CONFLICT against the partial index keeps a caller's transaction usable on a duplicate.
        const inserted = await trx.insertInto("bot_grants").values({
          grant_id: newBotStateId("gr"),
          owner_id: input.ownerId,
          bot_id: input.botId,
          service: input.service,
          connection_id: input.connectionId,
          account_label: input.accountLabel,
          effects,
          audience: input.audience,
          granted_by_actor_id: input.grantedByActorId,
          expires_at: input.expiresAt ?? null,
          revoked_at: null,
          created_at: input.now,
          updated_at: input.now,
        }).onConflict((conflict) => conflict
          .columns(["owner_id", "bot_id", "service", "connection_id", "audience"])
          .where("revoked_at", "is", null)
          .doNothing())
          .returningAll()
          .executeTakeFirst();
        if (inserted) return { grant: fromRow(inserted), created: true };
        const live = await trx.selectFrom("bot_grants").selectAll()
          .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId)
          .where("service", "=", input.service).where("connection_id", "=", input.connectionId)
          .where("audience", "=", input.audience).where("revoked_at", "is", null)
          .executeTakeFirst();
        if (!live) throw new BotStateError("conflict");
        const existing = fromRow(live);
        if (existing.effects.join(",") !== effects.join(",")) throw new BotStateError("conflict");
        return { grant: existing, created: false };
      });
    },
    /** Replaces the effects of a live grant at its revision. */
    async updateEffects(input: { ownerId: string; grantId: string; baseRevision: number; effects: readonly BotEffect[]; now: string }, executor: BotExecutor = db): Promise<BotGrantRecord> {
      const row = await executor.updateTable("bot_grants")
        .set({ effects: normalizedEffects(input.effects), revision: sql<number>`revision + 1`, updated_at: input.now })
        .where("owner_id", "=", input.ownerId).where("grant_id", "=", input.grantId)
        .where("revoked_at", "is", null).where("revision", "=", input.baseRevision)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new BotStateError("revision_conflict");
      return fromRow(row);
    },
    /** Revokes once; returns false when the grant was already revoked or does not exist. */
    async revoke(input: { ownerId: string; grantId: string; now: string }, executor: BotExecutor = db): Promise<boolean> {
      const row = await executor.updateTable("bot_grants")
        .set({ revoked_at: input.now, revision: sql<number>`revision + 1`, updated_at: input.now })
        .where("owner_id", "=", input.ownerId).where("grant_id", "=", input.grantId).where("revoked_at", "is", null)
        .returning("grant_id")
        .executeTakeFirst();
      return row !== undefined;
    },
    /**
     * Live grants usable in one audience: unrevoked, unexpired, and bound to
     * exactly that audience. A group run never sees direct grants.
     */
    async listLive(input: { ownerId: string; botId: string; audience: string; service?: string; now: string }, executor: BotExecutor = db): Promise<BotGrantRecord[]> {
      let query = executor.selectFrom("bot_grants").selectAll()
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId)
        .where("audience", "=", input.audience).where("revoked_at", "is", null)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", input.now)]));
      if (input.service !== undefined) query = query.where("service", "=", input.service);
      const rows = await query.orderBy("created_at", "asc").limit(MAX_GRANTS_LISTED).execute();
      return rows.map(fromRow);
    },
    /** The live grant for one account in one audience that allows `effect`, if any. */
    async findUsable(input: { ownerId: string; botId: string; service: string; connectionId: string; audience: string; effect: BotEffect; now: string }, executor: BotExecutor = db): Promise<BotGrantRecord | undefined> {
      const row = await executor.selectFrom("bot_grants").selectAll()
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId)
        .where("service", "=", input.service).where("connection_id", "=", input.connectionId)
        .where("audience", "=", input.audience).where("revoked_at", "is", null)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", input.now)]))
        .where(sql<boolean>`${input.effect} = ANY(effects)`)
        .executeTakeFirst();
      return row ? fromRow(row) : undefined;
    },
  };
}

export type BotGrantsRepository = ReturnType<typeof createBotGrantsRepository>;
