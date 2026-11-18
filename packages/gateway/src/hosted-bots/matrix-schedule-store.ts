import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  MATRIX_BOTS_SCHEDULE_LIMIT_MS, MATRIX_BOTS_SCHEDULE_WINDOW_MS, type HostedBotsScheduleGrantStore,
} from "./matrix-schedule.js";

const MAX_OUTSTANDING = 128;
type ScheduleDb = {
  hosted_bots_schedule_grants: {
    owner_id: string; machine_id: string; routine_id: string; token_hash: string;
    bot_id: string; thread_id: string; model_id: string; prompt: string;
    scheduled_at: Date; expires_at: Date;
  };
};

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function initializeHostedBotsScheduleStore(
  db: Kysely<ScheduleDb>, scope: { ownerId: string; machineId: string },
): Promise<HostedBotsScheduleGrantStore> {
  const bounded = <T>(work: (trx: Transaction<ScheduleDb>) => Promise<T>) => db.transaction().execute(async trx => {
    await sql`SET LOCAL statement_timeout = '3500ms'`.execute(trx);
    return work(trx);
  });
  // This table is a spend authorization ledger, not another routine scheduler.
  // Keep it additive so a previous host bundle can still open native Bot state.
  await bounded(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('matrix-hosted-bots-schedule-schema', 0))`.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS hosted_bots_schedule_grants (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
        machine_id TEXT NOT NULL CHECK (char_length(machine_id) BETWEEN 1 AND 128),
        routine_id UUID NOT NULL,
        token_hash TEXT NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
        bot_id TEXT NOT NULL CHECK (char_length(bot_id) BETWEEN 1 AND 128),
        thread_id TEXT NOT NULL CHECK (char_length(thread_id) BETWEEN 1 AND 128),
        model_id TEXT NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
        prompt TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 4000),
        scheduled_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > scheduled_at),
        PRIMARY KEY (owner_id, machine_id, routine_id)
      )
    `.execute(trx);
  });
  return {
    issue: (intent, now) => {
      if (intent.scheduledFor <= now || intent.scheduledFor > now + MATRIX_BOTS_SCHEDULE_LIMIT_MS) return Promise.resolve(null);
      return bounded(async trx => {
        const owner = scope.ownerId, machine = scope.machineId;
        // Serialize the per-installation quota and expiry sweep with creation.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([owner, machine])}, 17))`.execute(trx);
        await trx.deleteFrom("hosted_bots_schedule_grants").where("owner_id", "=", owner)
          .where("machine_id", "=", machine).where("expires_at", "<=", new Date(now)).execute();
        const count = await trx.selectFrom("hosted_bots_schedule_grants")
          .where("owner_id", "=", owner).where("machine_id", "=", machine)
          .select(eb => eb.fn.countAll<number>().as("total")).executeTakeFirstOrThrow();
        if (count.total >= MAX_OUTSTANDING) return null;
        const routineId = randomUUID(), token = randomBytes(32).toString("hex");
        await trx.insertInto("hosted_bots_schedule_grants").values({
          owner_id: owner, machine_id: machine, routine_id: routineId, token_hash: tokenHash(token),
          bot_id: intent.botId, thread_id: intent.threadId, model_id: intent.modelId, prompt: intent.prompt,
          scheduled_at: new Date(intent.scheduledFor), expires_at: new Date(intent.scheduledFor + MATRIX_BOTS_SCHEDULE_WINDOW_MS),
        }).execute();
        return { routineId, token };
      });
    },
    consume: (token, claim, now) => bounded(async trx => {
      const record = await trx.deleteFrom("hosted_bots_schedule_grants")
        .where("owner_id", "=", scope.ownerId).where("machine_id", "=", scope.machineId)
        .where("routine_id", "=", claim.routineId).where("token_hash", "=", tokenHash(token))
        .where("bot_id", "=", claim.botId).where("thread_id", "=", claim.threadId).where("model_id", "=", claim.modelId)
        .where("scheduled_at", "=", new Date(claim.scheduledFor)).where("scheduled_at", "<=", new Date(now))
        .where("expires_at", ">", new Date(now)).returning("prompt").executeTakeFirst();
      return record?.prompt ?? null;
    }),
    revoke: routineId => bounded(async trx => {
      await trx.deleteFrom("hosted_bots_schedule_grants")
        .where("owner_id", "=", scope.ownerId).where("machine_id", "=", scope.machineId)
        .where("routine_id", "=", routineId).execute();
    }),
  };
}
