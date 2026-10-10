/** Provenance is read only from successful owner-scoped publications, never execution selection. */
import type { CanonicalChatImportSource } from "@matrix-os/contracts";
import { sql, type Kysely, type RawBuilder, type Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner } from "./records.js";

/** Embed in a list statement so source projection adds no per-Chat round trips. */
export function chatImportHarnessSql(owner: ChatOwner, chatId: RawBuilder<string>): RawBuilder<"claude" | "codex" | null> {
  if (owner.type !== "personal") return sql<null>`NULL`;
  return sql<"claude" | "codex" | null>`COALESCE(
    (SELECT j.harness FROM local_chat_import_jobs j
      WHERE j.owner_id=${owner.ownerId} AND j.chat_id=${chatId} AND j.status='published'
      ORDER BY j.created_at,j.id LIMIT 1),
    (SELECT 'codex' FROM chat_legacy_imports l
      WHERE l.owner_type=${owner.type} AND l.owner_id=${owner.ownerId} AND l.chat_id=${chatId}
        AND l.source_kind='codex_jsonl' AND l.verification_status='verified' LIMIT 1)
  )`;
}
export function chatImportSource(harness: "claude" | "codex" | null): CanonicalChatImportSource | undefined {
  return harness ? { harness } : undefined;
}
export async function readChatImportSource(db: Kysely<ChatDatabase> | Transaction<ChatDatabase>, owner: ChatOwner,
  chatId: string): Promise<CanonicalChatImportSource | undefined> {
  if (owner.type !== "personal") return undefined;
  const result = await db.selectNoFrom(chatImportHarnessSql(owner, sql<string>`${chatId}`).as("harness")).executeTakeFirstOrThrow();
  return chatImportSource(result.harness);
}
