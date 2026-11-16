import { sql, type Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../../packages/gateway/src/bots/database.js";

export async function retainRoutinePreviewSchema(db: Kysely<OwnerBotDatabase>) {
  // The deployed #3209 preview committed this DDL and its ledger rows together.
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE bot_routines
      ADD COLUMN origin_computer_id TEXT,
      ADD COLUMN origin_request_id UUID,
      ADD CONSTRAINT bot_routines_origin_pair CHECK ((origin_computer_id IS NULL) = (origin_request_id IS NULL)),
      ADD CONSTRAINT bot_routines_origin_receipt FOREIGN KEY (owner_id,origin_computer_id,origin_request_id)
        REFERENCES routine_cli_requests(owner_id,computer_id,client_request_id)`.execute(trx);
    await sql`CREATE UNIQUE INDEX routine_cli_proposals_one_interaction ON routine_cli_proposals(owner_id,interaction_id) WHERE interaction_id IS NOT NULL`.execute(trx);
    await sql`CREATE TABLE routine_chat_deliveries (
      owner_id TEXT NOT NULL, source_chat_id TEXT NOT NULL,
      routine_id TEXT NOT NULL, fire_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 1000),
      kind TEXT NOT NULL CHECK(kind IN ('status','output')),
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, receipt JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(owner_id,source_chat_id,routine_id,fire_id,attempt,kind)
    )`.execute(trx);
    await sql`CREATE INDEX routine_chat_deliveries_source ON routine_chat_deliveries(owner_id,source_chat_id,created_at DESC)`.execute(trx);
    await sql`CREATE INDEX bot_routines_origin ON bot_routines(owner_id,origin_computer_id,origin_request_id) WHERE origin_request_id IS NOT NULL`.execute(trx);
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
    await sql`CREATE INDEX idx_bot_chat_bindings_chat_history ON bot_chat_bindings USING btree (chat_id, owner_id, bot_id)`.execute(trx);
    await trx.insertInto("bot_schema_migrations").values([
      { version: 16, name: "routine_chat_origin" },
      { version: 17, name: "routine_direct_chat" },
      { version: 18, name: "bot_chat_binding_history_index" },
    ]).execute();
  });
}
