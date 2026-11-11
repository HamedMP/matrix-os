import type { CanonicalChatProviderAdapter, ChatResumeSettings } from "./provider-adapter.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";

/** Shared policy for immediate follow-ups, durable queued turns, and Retry. */
export async function loadChatResumeState(input: ChatResumeSettings & {
  repository: Pick<ChatRepository, "getLatestAdapterStateForChat">;
  owner: ChatOwner;
  chatId: string;
  instanceId: string;
  adapter: CanonicalChatProviderAdapter;
  executionRootFingerprint: string | null;
  mode: "follow_up" | "retry";
}): Promise<unknown> {
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
  if (!previous) return undefined;
  const state = input.adapter.parseState(previous.state);
  return input.adapter.selectResumeCheckpoint
    ? input.adapter.selectResumeCheckpoint({ owner: input.owner, chatId: input.chatId, state,
      settings: input, previousSettings: previous.settings })
    : state;
}
