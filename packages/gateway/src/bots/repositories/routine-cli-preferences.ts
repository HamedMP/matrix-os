import { sql } from "kysely";
import { z } from "zod/v4";
import { RoutineCliRememberTargetSchema } from "@matrix-os/contracts";
import { RoutineCliError, routineCliBoundary } from "../routine-cli-errors.js";
import { isoTimestamp, toSafeInteger, withTransaction, type BotExecutor } from "./shared.js";

export const RoutineCliScopeSchema = z.object({
  ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  computerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
}).strict();
export type RoutineCliScope = z.infer<typeof RoutineCliScopeSchema>;
const timestamp = z.iso.datetime({ offset: true });
const TargetSchema = RoutineCliRememberTargetSchema.omit({ baseRevision: true }).extend({ bindingCreatedAt: timestamp }).strict();
const WriteSchema = RoutineCliScopeSchema.extend({ baseRevision: RoutineCliRememberTargetSchema.shape.baseRevision, now: z.iso.datetime({ offset: true }) }).strict();
const SaveSchema = WriteSchema.extend({ target: TargetSchema }).strict();
export interface RoutineCliStoredPreference {
  revision: number;
  target: { botId: string; chatId: string; bindingCreatedAt: string } | null;
  updatedAt: string;
}

/** Also fences an absent row. Callers keep this lock through target checks and mutation. */
export async function lockRoutineCliPreference(executor: BotExecutor, scope: RoutineCliScope): Promise<void> {
  if (!executor.isTransaction) throw new RoutineCliError("unavailable");
  RoutineCliScopeSchema.parse(scope);
  await sql`SET LOCAL lock_timeout = '5s'`.execute(executor);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["routine-cli-target", scope.ownerId, scope.computerId])}, 0))`.execute(executor);
}

/** Preserve fractional precision beyond JS Date milliseconds, normalized to UTC ISO. */
export function routineCliBindingTimestamp(value: string): string {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value)?.[1] ?? "";
  const extra = fraction.slice(3).replace(/0+$/, "");
  return isoTimestamp(value).replace(/Z$/, `${extra}Z`);
}

export function createRoutineCliPreferencesRepository(db: BotExecutor) {
  const get = async (scope: RoutineCliScope, executor: BotExecutor = db): Promise<RoutineCliStoredPreference | null> => routineCliBoundary(async () => {
    const parsed = RoutineCliScopeSchema.parse(scope);
    const row = await executor.selectFrom("routine_cli_preferences").selectAll()
      // Preserve microseconds across pg's Date decoding for exact binding-incarnation checks.
      .select(sql<string | null>`binding_created_at::text`.as("binding_timestamp"))
      .where("owner_id", "=", parsed.ownerId).where("computer_id", "=", parsed.computerId).executeTakeFirst();
    if (!row) return null;
    return { revision: toSafeInteger(row.revision), updatedAt: isoTimestamp(row.updated_at),
      target: row.bot_id && row.chat_id && row.binding_timestamp
        ? { botId: row.bot_id, chatId: row.chat_id, bindingCreatedAt: routineCliBindingTimestamp(row.binding_timestamp) } : null };
  });
  const write = async (input: z.infer<typeof WriteSchema>, target: z.infer<typeof TargetSchema> | null, executor: BotExecutor) => {
    const scope = { ownerId: input.ownerId, computerId: input.computerId };
    return withTransaction(executor, async trx => {
      await lockRoutineCliPreference(trx, scope);
      const values = { bot_id: target?.botId ?? null, chat_id: target?.chatId ?? null,
        binding_created_at: target?.bindingCreatedAt ?? null, updated_at: input.now, revision: input.baseRevision + 1 };
      const row = input.baseRevision === 0
        ? await trx.insertInto("routine_cli_preferences").values({ owner_id: input.ownerId, computer_id: input.computerId, ...values })
          .onConflict(conflict => conflict.columns(["owner_id", "computer_id"]).doNothing()).returning("revision").executeTakeFirst()
        : await trx.updateTable("routine_cli_preferences").set(values)
          .where("owner_id", "=", input.ownerId).where("computer_id", "=", input.computerId)
          .where("revision", "=", input.baseRevision).returning("revision").executeTakeFirst();
      if (!row) throw new RoutineCliError("revision_conflict");
      return (await get(scope, trx))!;
    });
  };
  return {
    get,
    save: (value: z.infer<typeof SaveSchema>, executor: BotExecutor = db) => routineCliBoundary(async () => {
      const { target, ...input } = SaveSchema.parse(value);
      return write(input, target, executor);
    }),
    reset: (value: z.infer<typeof WriteSchema>, executor: BotExecutor = db) => routineCliBoundary(async () => write(WriteSchema.parse(value), null, executor)),
  };
}
