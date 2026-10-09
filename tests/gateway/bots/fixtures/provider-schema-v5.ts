// Frozen SQL from deployed #2198 dfb4528ade345206d688710ca8432ce500443036.
// Keep independent of the current migration registry for downgrade regression replay.
import { sql, type Transaction } from 'kysely';
import type { OwnerBotDatabase } from "../../../../packages/gateway/src/bots/database.js";
export async function migrateDeployedProviderConnectionsV5(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`CREATE TABLE bot_provider_authorizations (
    owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256), computer_id TEXT NOT NULL CHECK (length(computer_id) BETWEEN 1 AND 256),
    connection_id TEXT NOT NULL CHECK (connection_id = 'claude_code_tasks'),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) <= 128), enabled BOOLEAN NOT NULL, background BOOLEAN NOT NULL,
    CHECK (NOT background OR enabled), CHECK (NOT enabled OR length(fingerprint) > 0),
    revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991), PRIMARY KEY (owner_id, computer_id, connection_id)
  )`.execute(trx);
  await sql`CREATE TABLE bot_execution_bindings (
    owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256), computer_id TEXT NOT NULL CHECK (length(computer_id) BETWEEN 1 AND 256), bot_id TEXT NOT NULL CHECK (length(bot_id) BETWEEN 1 AND 128),
    connection_id TEXT CHECK (connection_id = 'claude_code_tasks'), model TEXT CHECK (length(model) BETWEEN 1 AND 128), grant_revision BIGINT CHECK (grant_revision BETWEEN 1 AND 9007199254740991),
    native_session_id TEXT CHECK (length(native_session_id) BETWEEN 1 AND 128), revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (owner_id, computer_id, bot_id),
    CHECK ((connection_id IS NULL AND model IS NULL AND grant_revision IS NULL AND native_session_id IS NULL) OR
      (connection_id IS NOT NULL AND model IS NOT NULL AND grant_revision > 0))
  )`.execute(trx);
}
