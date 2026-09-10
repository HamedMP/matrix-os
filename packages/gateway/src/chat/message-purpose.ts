import type { CanonicalChatMessage } from "@matrix-os/contracts";
import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";

export type ChatMessagePurpose = "discussion" | "ai_request" | "assistant" | "system";

/** Storage compatibility with collaboration-enabled bundles; no wire-shape change. */
export function messagePurpose(message: Pick<CanonicalChatMessage, "role">): ChatMessagePurpose {
  return message.role === "user" ? "ai_request" : message.role === "assistant" ? "assistant" : "system";
}

export async function bootstrapMessagePurpose(db: Kysely<ChatDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS purpose TEXT
      CHECK (purpose IN ('discussion', 'ai_request', 'assistant', 'system'))
    `.execute(trx);
    // Only legacy NULL values are backfilled. Never relabel existing discussions
    // or touch the actor attribution left by a newer runtime.
    await sql`
      UPDATE chat_messages SET purpose = CASE role
        WHEN 'user' THEN 'ai_request'
        WHEN 'assistant' THEN 'assistant'
        ELSE 'system'
      END WHERE purpose IS NULL
    `.execute(trx);
    await sql`ALTER TABLE chat_messages ALTER COLUMN purpose SET NOT NULL`.execute(trx);
  });
}
