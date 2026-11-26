import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";

export async function migrateBotResourceGrantsV20(tx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`
    CREATE TABLE bot_resource_grants (
      grant_id TEXT NOT NULL UNIQUE CHECK (grant_id ~ '^rgr_[a-f0-9]{32}$'),
      candidate_id TEXT NOT NULL CHECK (candidate_id ~ '^source_[a-f0-9]{48}$'),
      owner_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      binding_created_at TIMESTAMPTZ NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('github_repository', 'slack_channel')),
      label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 256 AND octet_length(label) <= 1024),
      connection_id TEXT NOT NULL CHECK (connection_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
      scope JSONB NOT NULL CHECK (
        jsonb_typeof(scope) = 'object' AND scope ? 'kind' AND scope->>'kind' = kind
        AND octet_length(scope::text) <= 2048
      ),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, bot_id, kind),
      FOREIGN KEY (owner_id, bot_id, chat_id) REFERENCES bot_chat_bindings(owner_id, bot_id, chat_id) ON DELETE CASCADE
    )
  `.execute(tx);
}
