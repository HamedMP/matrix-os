import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";

const ATTRIBUTION_MIGRATION_VERSION = 2;

async function migrated(db: Kysely<ChatDatabase>): Promise<boolean> {
  const marker = await sql`
    SELECT version FROM chat_schema_migrations
    WHERE version = ${ATTRIBUTION_MIGRATION_VERSION}
  `.execute(db);
  return marker.rows.length > 0;
}

/**
 * Repair only messages whose owner authorship is proven by canonical gateway
 * relations. Imported and collaborator-authored messages remain unattributed.
 */
export async function bootstrapChatAttribution<Database extends ChatDatabase>(
  db: Kysely<Database>,
): Promise<void> {
  const executor = db as unknown as Kysely<ChatDatabase>;
  if (await migrated(executor)) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await executor.transaction().execute(async (trx) => {
        await sql`LOCK TABLE chats IN ACCESS EXCLUSIVE MODE`.execute(trx);
        if (await migrated(trx)) return;
        await sql`
          UPDATE chat_messages AS message
          SET actor_id = chat.owner_id,
              purpose = 'ai_request'
          FROM chats AS chat
          WHERE message.chat_id = chat.id
            AND chat.owner_type = 'personal'
            AND message.actor_id IS NULL
            AND message.role = 'user'
            AND message.state = 'committed'
            AND message.purpose = 'ai_request'
            AND EXISTS (
              SELECT 1
              FROM chat_members AS owner_member
              WHERE owner_member.chat_id = chat.id
                AND owner_member.principal_type = 'user'
                AND owner_member.principal_id = chat.owner_id
                AND owner_member.role = 'owner'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM chat_legacy_imports AS legacy_import
              WHERE legacy_import.chat_id = chat.id
            )
            AND (
              EXISTS (
                SELECT 1
                FROM chat_turns AS turn_record
                WHERE turn_record.chat_id = message.chat_id
                  AND turn_record.id = message.turn_id
                  AND turn_record.input_message_id = message.id
                  AND EXISTS (
                    SELECT 1
                    FROM chat_runs AS run_record
                    WHERE run_record.chat_id = turn_record.chat_id
                      AND run_record.turn_id = turn_record.id
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM chat_queued_turns AS queued
                    WHERE queued.chat_id = turn_record.chat_id
                      AND queued.claimed_turn_id = turn_record.id
                      AND queued.client_request_id = turn_record.client_request_id
                      AND NOT (
                        (
                          queued.requesting_actor_id IS NOT NULL
                          AND queued.requesting_actor_id = chat.owner_id
                        )
                        OR (
                          queued.requesting_actor_id IS NULL
                          AND queued.collaboration_scope_id IS NULL
                          AND queued.actor_request_id IS NULL
                          AND queued.accepted_seq IS NULL
                          AND queued.payload_hash IS NULL
                          AND queued.accepted_auth_epoch IS NULL
                          AND queued.retry_of_queued_turn_id IS NULL
                        )
                      )
                  )
              )
              OR EXISTS (
                SELECT 1
                FROM chat_run_steers AS steer
                WHERE steer.chat_id = message.chat_id
                  AND steer.message_id = message.id
                  AND steer.turn_id = message.turn_id
                  AND steer.run_id = message.run_id
                  AND steer.status = 'accepted'
                  AND (
                    steer.queued_turn_id IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM chat_queued_turns AS queued_steer
                      WHERE queued_steer.id = steer.queued_turn_id
                        AND queued_steer.chat_id = steer.chat_id
                        AND (
                          (
                            queued_steer.requesting_actor_id IS NOT NULL
                            AND queued_steer.requesting_actor_id = chat.owner_id
                          )
                          OR (
                            queued_steer.requesting_actor_id IS NULL
                            AND queued_steer.collaboration_scope_id IS NULL
                            AND queued_steer.actor_request_id IS NULL
                            AND queued_steer.accepted_seq IS NULL
                            AND queued_steer.payload_hash IS NULL
                            AND queued_steer.accepted_auth_epoch IS NULL
                            AND queued_steer.retry_of_queued_turn_id IS NULL
                          )
                        )
                    )
                  )
              )
            )
        `.execute(trx);
        await sql`
          INSERT INTO chat_schema_migrations (version)
          VALUES (${ATTRIBUTION_MIGRATION_VERSION})
        `.execute(trx);
      });
      return;
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
      if (attempt >= 2 || (code !== "40P01" && code !== "40001")) throw error;
      console.warn("[chat/attribution] Retrying attribution repair after lock conflict");
      await delay(25 * (attempt + 1));
    }
  }
}
