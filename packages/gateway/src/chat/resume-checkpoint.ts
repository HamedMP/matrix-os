import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";

/** Shared policy for immediate follow-ups, durable queued turns, and Retry. */
export async function loadChatResumeState(input: {
  repository: Pick<ChatRepository, "getLatestAdapterStateForChat">;
  owner: ChatOwner;
  chatId: string;
  instanceId: string;
  adapter: CanonicalChatProviderAdapter;
  executionRootFingerprint: string | null;
  mode: "follow_up" | "retry";
}): Promise<unknown> {
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
