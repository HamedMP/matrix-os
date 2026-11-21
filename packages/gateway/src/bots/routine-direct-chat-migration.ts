import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";

/** Reservations precede Chat creation. Retain the identity if the source is removed, so a
 * later retry or an old receipt cannot adopt a different binding. */
export async function migrateRoutineDirectChatV17(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`CREATE TABLE routine_direct_chat_contexts (
    owner_id TEXT NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    computer_id TEXT NOT NULL CHECK (computer_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    source_chat_id TEXT NOT NULL CHECK (source_chat_id ~ '^chat_[A-Za-z0-9_-]{1,128}$'),
    bot_id TEXT NOT NULL UNIQUE CHECK (bot_id ~ '^bot_routine[a-f0-9]{32}$'),
    chat_id TEXT NOT NULL UNIQUE CHECK (chat_id ~ '^chat_routine_[a-f0-9]{32}$'),
    activated_at TIMESTAMPTZ,
    PRIMARY KEY (owner_id, computer_id, source_chat_id),
    CHECK (source_chat_id <> chat_id AND source_chat_id !~ '^chat_routine_[a-f0-9]{32}$')
  )`.execute(trx);
}
