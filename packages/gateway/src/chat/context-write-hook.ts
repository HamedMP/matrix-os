import type { ChatOwner } from './records.js';
import type { AssistantDeltaExecutor, AssistantDeltaTransact } from './assistant-delta-repository.js';
export interface ChatContextWriteKey {
  owner: ChatOwner; chatId: string; runIds?: readonly string[]; queueIds?: readonly string[];
  discoverQueued?: boolean; requestId?: string;
}
export interface ChatContextWriteHook {
  write<T>(key: ChatContextWriteKey, transact: AssistantDeltaTransact,
    content: (tx: AssistantDeltaExecutor) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
/** Existing route inputs are bounded; snapshot private server inputs before any policy/DB wait. */
export function snapshotContextWriteInput<T>(input: T): T {
  if (Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024) throw new RangeError('Chat mutation payload limit exceeded');
  return structuredClone(input);
}
