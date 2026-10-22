import type { ChatOwner } from './records.js';
import type { CanonicalChatProviderAdapter, CanonicalChatProviderRegistry } from './provider-adapter.js';
import type { GoogleModelHistoryReader } from '../google-data/runtime/model-history-reader.js';
import { GoogleModelHistoryError } from '../google-data/runtime/model-history-admission.js';
import { withAsyncChatInput } from './async-input-adapter.js';

export interface ChatContinuationControl {
  owner: ChatOwner; chatId: string; adapter: CanonicalChatProviderAdapter; controller: AbortController;
}

/** Private continuation admission; provider/profile authorization remains at its broker.
 * A recovered control may fill an empty slot, never replace a currently active run. */
export async function assertChatContinuation(options: {
  reader?: GoogleModelHistoryReader;
  adapters: Pick<CanonicalChatProviderRegistry, 'get'>;
  owner: ChatOwner; chatId: string; active: ChatContinuationControl;
  current(): ChatContinuationControl | undefined;
  recovered?: boolean;
}): Promise<void> {
  if (!options.reader) return;
  const owner = structuredClone(options.owner);
  const chatId = options.chatId;
  const active = options.active;
  const adapter = active.adapter;
  const signal = active.controller.signal;
  const check = () => {
    const current = options.current();
    if (signal.aborted || active.controller.signal !== signal || active.adapter !== adapter
      || active.chatId !== chatId || active.owner.type !== owner.type || active.owner.ownerId !== owner.ownerId
      || options.adapters.get(adapter.driverKind) !== adapter
      || (current !== active && !(options.recovered && !current && adapter.detachOnShutdown))) throw new GoogleModelHistoryError();
  };
  check();
  await options.reader.assertRun({ owner, chatId, adapter, signal });
  check();
}

/** Controlled host composition only. No reader is installed by default. The guard
 * receives the final wrapper object registered in the canonical adapter registry. */
export function withCanonicalChatHistory(native: CanonicalChatProviderAdapter, reader?: GoogleModelHistoryReader): CanonicalChatProviderAdapter {
  return withAsyncChatInput(native, reader ? { beforeNativeDispatch: async (input, adapter) => {
    if (input.signal.aborted) throw new GoogleModelHistoryError();
    await reader.assertRun({ owner: structuredClone(input.owner), chatId: input.chatId, adapter, signal: input.signal });
    if (input.signal.aborted) throw new GoogleModelHistoryError();
  } } : {});
}
