import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { GoogleModelHistoryReader } from "../google-data/runtime/model-history-reader.js";

/** Shared policy for immediate follow-ups, durable queued turns, and Retry. */
export async function loadChatResumeState(input: {
  repository: Pick<ChatRepository, "getLatestAdapterStateForChat">;
  owner: ChatOwner;
  chatId: string;
  instanceId: string;
  adapter: CanonicalChatProviderAdapter;
  executionRootFingerprint: string | null;
  mode: "follow_up" | "retry";
  modelHistory?: GoogleModelHistoryReader;
  signal?: AbortSignal;
}): Promise<unknown> {
  if (input.modelHistory) {
    const { modelHistory, ...rest } = input;
    const admitted = { ...rest, owner: structuredClone(input.owner) };
    return modelHistory.read({ owner: admitted.owner, chatId: admitted.chatId, adapter: admitted.adapter, signal: admitted.signal,
      read: repository => loadChatResumeState({ ...admitted, repository }) });
  }
  if (!input.adapter.resume) return undefined;
  const previous = await input.repository.getLatestAdapterStateForChat(input.owner, {
    chatId: input.chatId,
    driverKind: input.adapter.driverKind,
    instanceId: input.instanceId,
    schemaVersion: input.adapter.stateSchemaVersion,
    executionRootFingerprint: input.executionRootFingerprint,
    includeInterrupted: input.mode === "follow_up",
  });
  // Compatibility is filtered in SQL before choosing the newest checkpoint.
  // An incompatible interruption must not hide an older compatible session.
  return previous ? input.adapter.parseState(previous.state) : undefined;
}
