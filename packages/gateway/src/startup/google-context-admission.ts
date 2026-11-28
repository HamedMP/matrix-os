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
