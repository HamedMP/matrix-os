import { sql, type Kysely, type Transaction } from 'kysely';
import type { ChatDatabase } from '../../chat/database.js';
import type { ChatOwner } from '../../chat/records.js';
import { lockGoogleContexts } from '../runtime/contexts-schema.js';
import { createGoogleModelHistoryStore } from '../runtime/model-history.js';
import { boundedProvenanceSavepoint } from './transaction.js';

/** True when any Google context marker exists for this chat id, in any state and under any owner id.
 * Markers precede Google content entering a chat, are only erased by full owner deletion, and every
 * registered Google copy or classification requires one, so their absence proves no Google taint. */
export async function chatHasGoogleTaint<DB>(tx: Kysely<DB>, chatId: string): Promise<boolean> {
  const row = (await sql<{ tainted: boolean }>`SELECT EXISTS(SELECT 1 FROM google_context_markers
    WHERE chat_id=${chatId}) AS tainted`.execute(tx)).rows[0];
  return row?.tainted !== false;
}

/** Strict pilot copy hooks refuse unknown history, organization owners, collaboration and published scopes.
 * Such a chat without Google taint keeps its pre-pilot write behavior: returns true and the caller writes
 * content directly. Runs in a savepoint (caller timeouts restored) and keeps the context fence until the
 * caller transaction settles, so a concurrent first Google collection serializes after this write.
 * Any doubt (non-transaction executor, taint, or a qualifying personal ordinary chat) returns false. */
export async function untaintedOutsideGoogleProvenance(executor: Kysely<ChatDatabase>, owner: ChatOwner, chatId: string,
  now?: () => Date): Promise<boolean> {
  if (!executor.isTransaction) return false;
  return boundedProvenanceSavepoint(executor as Transaction<ChatDatabase>, async tx => {
    await lockGoogleContexts(tx);
    if (await chatHasGoogleTaint(tx, chatId)) return false;
    if (owner.type !== 'personal') return true;
    const history = await createGoogleModelHistoryStore<ChatDatabase>(tx, now ? { now } : {}).inspect(owner, chatId);
    if (history.classification === 'unknown') return true;
    const chat = await tx.selectFrom('chats').select('collaboration').where('id', '=', chatId)
      .where('owner_type', '=', 'personal').where('owner_id', '=', owner.ownerId).executeTakeFirst();
    if (!chat) return false;
    if (chat.collaboration !== null) return true;
    const shared = await sql`SELECT id FROM collaboration_scopes WHERE owner_type='personal' AND owner_id=${owner.ownerId}
      AND kind='chat' AND resource_id=${chatId} AND lifecycle NOT IN ('private','preparing') LIMIT 1`.execute(tx);
    return shared.rows.length > 0;
  });
}
