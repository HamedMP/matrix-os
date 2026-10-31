import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";

/** Navigation references only. No FK cascade: a missing target must not erase the revision fence. */
export async function migrateRoutineCliPreferencesV12(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`CREATE TABLE routine_cli_preferences (
    owner_id TEXT NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    computer_id TEXT NOT NULL CHECK (computer_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    bot_id TEXT CHECK (bot_id IS NULL OR bot_id ~ '^bot_[a-z0-9]{8,64}$'),
    chat_id TEXT CHECK (chat_id IS NULL OR chat_id ~ '^chat_[A-Za-z0-9_-]{1,128}$'),
    binding_created_at TIMESTAMPTZ,
    revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (owner_id, computer_id),
    CHECK ((bot_id IS NULL AND chat_id IS NULL AND binding_created_at IS NULL)
      OR (bot_id IS NOT NULL AND chat_id IS NOT NULL AND binding_created_at IS NOT NULL))
  )`.execute(trx);
}
