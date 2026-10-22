import { isDeepStrictEqual } from 'node:util';
import { CanonicalChatMessageIdSchema } from '@matrix-os/contracts';
import { sql, type Kysely } from 'kysely';
import type { ChatDatabase } from '../../chat/database.js';
import { jsonb, toMessage, toOutbox, type ChatOutboxEvent, type ChatOwner } from '../../chat/records.js';
import { GoogleProvenanceUnavailable, validateOpaque, type PurgeHandlers } from './contracts.js';
import { canonicalMessagePayloadHash } from './canonical-message-writes.js';
import { boundedProvenanceTransaction } from './transaction.js';

const notice = [{ type: 'text' as const, text: 'Content deleted.' }];
class Cancelled extends Error { constructor() { super('Deletion cancelled'); this.name = 'Cancelled'; } }
function check(signal: AbortSignal) { if (signal.aborted) throw new Cancelled(); }

/** Exact canonical-message adapter only. The worker already holds its registry-copy
 * lock; acquire chat -> run -> message -> sidecars without context/registry locks.
 * Preserves owner rows/sequence and creates a content-free durable invalidation.
 * Durable replay projections, attachments/files and other derived copies require
 * their own adapters; this handler alone cannot attest all-copy deletion. */
export function createGoogleCanonicalMessageDeletionHandler(database: Kysely<ChatDatabase>, options: {
  onInvalidation?(input: { owner: ChatOwner; event: ChatOutboxEvent }): void;
} = {}): NonNullable<PurgeHandlers['derived']> {
  // This adapter must observe the actual COMMIT, never an inner transaction return.
  if (database.isTransaction) throw new GoogleProvenanceUnavailable();
  return async ({ ownerId, entityRef, expectedHash, signal }) => {
    const messageId = CanonicalChatMessageIdSchema.safeParse(entityRef.startsWith('cm_') ? entityRef.slice(3) : '');
    if (!messageId.success || !/^[a-f0-9]{64}$/.test(expectedHash)) return { status: 'unavailable' };
    validateOpaque(ownerId);
    try {
      check(signal);
      let invalidation: ChatOutboxEvent | undefined;
      const result = await boundedProvenanceTransaction(database, async tx => {
        // Discovery is metadata only, not deletion authority. Recheck all identity
        // fields after the owned chat/run locks before reading or changing content.
        const discovered = await tx.selectFrom('chat_messages as message').innerJoin('chats as chat', 'chat.id', 'message.chat_id')
          .select(['message.chat_id', 'message.run_id']).where('message.id', '=', messageId.data)
          .where('chat.owner_type', '=', 'personal').where('chat.owner_id', '=', ownerId).executeTakeFirst();
        check(signal);
        if (!discovered) return { status: 'missing' as const };
        const chat = await tx.selectFrom('chats').select(['id', 'revision', 'collaboration'])
          .where('id', '=', discovered.chat_id).where('owner_type', '=', 'personal').where('owner_id', '=', ownerId).forUpdate().executeTakeFirst();
        check(signal);
        if (!chat) return { status: 'missing' as const };
        if (chat.collaboration !== null || !discovered.run_id) return { status: 'modified' as const };
        const run = await tx.selectFrom('chat_runs').select('id').where('id', '=', discovered.run_id)
          .where('chat_id', '=', chat.id).forUpdate().executeTakeFirst();
        if (!run) return { status: 'modified' as const };
        const key = { owner: { type: 'personal' as const, ownerId }, chatId: chat.id, runId: run.id, messageId: messageId.data };
        const hash = await canonicalMessagePayloadHash(tx, key);
        check(signal);
        if (hash === null) return { status: 'missing' as const };
        const row = await tx.selectFrom('chat_messages').selectAll().where('id', '=', key.messageId)
          .where('chat_id', '=', key.chatId).where('run_id', '=', key.runId).where('role', '=', 'assistant').executeTakeFirstOrThrow();
        const redacted = { ...toMessage(row), parts: notice };
        const bytes = Buffer.byteLength(JSON.stringify(redacted));
        if (hash !== expectedHash) {
          const sidecar = await tx.selectFrom('chat_credentials').select('id').where('message_id', '=', key.messageId).limit(1).executeTakeFirst();
          // A prior committed redaction can outlive its worker lease. Recognize only
          // the complete content-free form; changed payload/sidecars never qualify.
          return { status: isDeepStrictEqual(row.parts, notice) && row.search_text === '' && Number(row.byte_count) === bytes && !sidecar
            ? 'missing' as const : 'modified' as const };
        }
        check(signal);
        await tx.deleteFrom('chat_credentials').where('message_id', '=', key.messageId).where('owner_id', '=', ownerId)
          .where('chat_id', '=', key.chatId).where('run_id', '=', key.runId).execute();
        await sql`UPDATE chat_messages SET parts=${JSON.stringify(notice)}::jsonb,search_text='',byte_count=${bytes}
          WHERE id=${key.messageId} AND chat_id=${key.chatId} AND run_id=${key.runId} AND role='assistant'
          RETURNING id AS redacted_message_id`.execute(tx);
        check(signal);
        const latest = await tx.selectFrom('chat_messages').select('parts').where('chat_id', '=', chat.id).orderBy('seq', 'desc').limit(1).executeTakeFirst();
        const parts = latest?.parts;
        const firstText = Array.isArray(parts) ? parts.find(part => part !== null && typeof part === 'object' && !Array.isArray(part) && part.type === 'text') : undefined;
        const preview = firstText && typeof firstText === 'object' && !Array.isArray(firstText) && typeof firstText.text === 'string' ? firstText.text.slice(0, 280) : null;
        const revision = Number(chat.revision) + 1;
        if (!Number.isSafeInteger(revision)) throw new GoogleProvenanceUnavailable();
        await tx.updateTable('chats').set({ revision, last_message_preview: preview, updated_at: new Date().toISOString() })
          .where('id', '=', chat.id).where('owner_type', '=', 'personal').where('owner_id', '=', ownerId).execute();
        const event = await tx.insertInto('chat_outbox').values({ owner_type: 'personal', owner_id: ownerId, chat_id: chat.id,
          revision, event_type: 'chat.updated', payload: jsonb({}) }).returningAll().executeTakeFirstOrThrow();
        invalidation = toOutbox(event);
        check(signal);
        return { status: 'deleted' as const };
      });
      check(signal);
      if (invalidation && options.onInvalidation) {
        try { options.onInvalidation({ owner: { type: 'personal', ownerId }, event: invalidation }); }
        catch (error: unknown) {
          // Content is already erased and durable metadata remains replayable.
          console.warn('[google-deletion] Invalidation delivery failed:', error instanceof Error ? error.name : 'UnknownError');
        }
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof Cancelled) return { status: 'unavailable' };
      if (error instanceof GoogleProvenanceUnavailable) return { status: 'modified' };
      throw error;
    }
  };
}
