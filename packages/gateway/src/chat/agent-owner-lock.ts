import { createHash } from "node:crypto";
import { CanonicalOwnerScopeSchema } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner } from "./records.js";

/** File edits and dedicated identity creation serialize on this same owner row. */
export async function lockChatAgentOwner(db: Kysely<ChatDatabase> | Transaction<ChatDatabase>, owner: ChatOwner): Promise<void> {
  const parsed = CanonicalOwnerScopeSchema.parse(owner);
  if (parsed.type !== "personal") throw new Error("Personal Bot owner required");
  const key = createHash("sha256").update(`${parsed.type}:${parsed.ownerId}`).digest("hex");
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`INSERT INTO chat_agent_owner_locks (owner_key) VALUES (${key}) ON CONFLICT DO NOTHING`.execute(db);
  await sql`SELECT owner_key FROM chat_agent_owner_locks WHERE owner_key = ${key} FOR UPDATE`.execute(db);
}
