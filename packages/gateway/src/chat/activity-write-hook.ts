import type { ChatOwner } from './records.js';
import type { AssistantDeltaExecutor, AssistantDeltaTransact } from './assistant-delta-repository.js';
export interface ChatActivityWriteKey { owner: ChatOwner; chatId: string; runId: string; activityIds: readonly string[] }
/** Trusted server write composition, never an owner-provided approval. */
export interface ChatActivityWriteHook {
  write<T>(key: ChatActivityWriteKey, transact: AssistantDeltaTransact,
    content: (tx: AssistantDeltaExecutor) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
