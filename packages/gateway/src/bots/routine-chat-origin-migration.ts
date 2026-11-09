import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";
/** No inferred/backfilled origins. Ledger identity survives edits and source deletion. */
export async function migrateRoutineChatOriginV16(tx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`ALTER TABLE bot_routines
    ADD COLUMN origin_computer_id TEXT,
    ADD COLUMN origin_request_id UUID,
    ADD CONSTRAINT bot_routines_origin_pair CHECK ((origin_computer_id IS NULL) = (origin_request_id IS NULL)),
    ADD CONSTRAINT bot_routines_origin_receipt FOREIGN KEY (owner_id,origin_computer_id,origin_request_id)
      REFERENCES routine_cli_requests(owner_id,computer_id,client_request_id)`.execute(tx);
  await sql`CREATE UNIQUE INDEX routine_cli_proposals_one_interaction ON routine_cli_proposals(owner_id,interaction_id) WHERE interaction_id IS NOT NULL`.execute(tx);
  await sql`CREATE TABLE routine_chat_deliveries (
    owner_id TEXT NOT NULL, source_chat_id TEXT NOT NULL,
    routine_id TEXT NOT NULL, fire_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 1000),
    kind TEXT NOT NULL CHECK(kind IN ('status','output')),
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(owner_id,source_chat_id,routine_id,fire_id,attempt,kind)
  )`.execute(tx);
  await sql`CREATE INDEX routine_chat_deliveries_source ON routine_chat_deliveries(owner_id,source_chat_id,created_at DESC)`.execute(tx);
  await sql`CREATE INDEX bot_routines_origin ON bot_routines(owner_id,origin_computer_id,origin_request_id) WHERE origin_request_id IS NOT NULL`.execute(tx);
}
