import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";
import { privateBotSourceChat } from "./private-routine-authority.js";
import type { ChatOwner } from "./records.js";

/** Only the authenticated owner's message to this exact private Bot can produce a settings suggestion. */
export async function canProposeBotSettings(db: Kysely<ChatDatabase>, owner: ChatOwner, chatId: string, runId: string, botId: string) {
  if (!await privateBotSourceChat(db, owner, chatId)) return false;
  const matched = await sql<{ live: boolean }>`SELECT EXISTS (
    SELECT 1 FROM chat_runs r JOIN chat_turns t ON t.id=r.turn_id AND t.chat_id=r.chat_id
    JOIN chat_messages m ON m.id=t.input_message_id AND m.chat_id=t.chat_id
    JOIN bot_chat_bindings b ON b.chat_id=r.chat_id AND b.owner_id=${owner.ownerId} AND b.bot_id=${botId}
    WHERE r.id=${runId} AND r.chat_id=${chatId} AND r.driver_kind='matrix_bot' AND r.instance_id='matrix_bot_default'
      AND r.status IN ('accepted', 'running') AND b.kind='direct' AND b.removed_at IS NULL
      AND t.owner_http_input AND m.role='user' AND m.state='committed' AND m.actor_id=${owner.ownerId}
      AND NOT EXISTS (SELECT 1 FROM bot_chat_bindings other WHERE other.chat_id=b.chat_id AND other.removed_at IS NULL
        AND (other.owner_id,other.bot_id,other.kind)<>(b.owner_id,b.bot_id,b.kind))
  ) AS live`.execute(db);
  return matched.rows[0]?.live === true;
}
