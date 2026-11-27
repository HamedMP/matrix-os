import { sql, type Transaction } from 'kysely';
import { isDeepStrictEqual } from 'node:util';
import type { ChatRepository } from '../chat/repository.js';
import type { ChatContextWriteHook } from '../chat/context-write-hook.js';
import { isManagedPiBinding, type BotRuntimeRegistry, type PiRuntimeBinding } from '../bots/runtime-registry.js';
import { GoogleCollectionClientError } from '../google-data/runtime/collection-client.js';

/** Adopt or verify the exact saved run snapshot through its owning repository. No content
 * is emitted or rewritten. Presence alone never establishes ordinary/Google provenance. */
export function createGoogleContextAdmission(options: {
  registry: Pick<BotRuntimeRegistry, 'lookupRun' | 'inferenceSignal'>;
  repository: Pick<ChatRepository, 'withContextTransaction'>;
  adapter: Pick<ChatContextWriteHook, 'write'>;
}) {
  return async (input: PiRuntimeBinding, signal: AbortSignal): Promise<void> => {
    const binding = structuredClone(input); const runSignal = options.registry.inferenceSignal(binding);
    const live = () => {
      if (signal.aborted || !isManagedPiBinding(binding) || !runSignal || runSignal.aborted
        || options.registry.inferenceSignal(binding) !== runSignal
        || !isDeepStrictEqual(options.registry.lookupRun(binding), binding)) throw new GoogleCollectionClientError();
    };
    live();
    await options.adapter.write({ owner: { type: 'personal', ownerId: binding.ownerId }, chatId: binding.chatId,
      runIds: [binding.runId] }, options.repository.withContextTransaction, async () => undefined,
      AbortSignal.any([signal, runSignal!]));
    live();
  };
}

/** Invoked only inside the marker transaction, after acquiring the context fence. */
export async function assertGoogleCollectionChat<DB>(tx: Transaction<DB>, ownerId: string, chatId: string): Promise<void> {
  const eligible = await sql`SELECT c.id FROM chats c
    JOIN google_model_history_births b ON b.chat_id=c.id AND b.owner_type=c.owner_type AND b.owner_id=c.owner_id
    WHERE c.id=${chatId} AND c.owner_id=${ownerId} AND c.owner_type='personal' AND c.lifecycle='active'
      AND c.collaboration IS NULL AND NOT EXISTS (
        SELECT 1 FROM collaboration_scopes s WHERE s.owner_type='personal' AND s.owner_id=c.owner_id
          AND s.kind='chat' AND s.resource_id=c.id AND s.lifecycle NOT IN ('private','preparing')
      ) FOR UPDATE OF c`.execute(tx);
  if (!eligible.rows.length) throw new GoogleCollectionClientError();
}
