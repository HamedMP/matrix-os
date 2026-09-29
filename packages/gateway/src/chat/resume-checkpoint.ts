import type { CanonicalChatRunPolicy } from "@matrix-os/contracts";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";

/**
 * Shared policy for immediate follow-ups, durable queued turns, and Retry.
 * Delivery-aware: checkpoints produced by unheard/unknown deliveries are
 * ineligible, and disposable/session-only policies never reuse native state.
 * When a provider harness cannot rebuild safely, it gets no checkpoint at
 * all — Matrix-owned state remains the recovery authority.
 */
export async function loadChatResumeState(input: {
  repository: Pick<ChatRepository, "getLatestAdapterStateForChat">;
  owner: ChatOwner;
  chatId: string;
  instanceId: string;
  adapter: CanonicalChatProviderAdapter;
  executionRootFingerprint: string | null;
  mode: "follow_up" | "retry";
  /** Immutable execution policy of the run being admitted. */
  runPolicy?: CanonicalChatRunPolicy;
  /** Caller-supplied delivery awareness: ids whose output was never heard. */
  deliveryContext?: { unheardResponses?: readonly string[] };
}): Promise<unknown> {
  // A disposable checkpoint policy never resumes native provider state. The
  // session-only schema guarantees disposable, so both gates are checked.
  if (input.runPolicy?.nativeCheckpointPolicy === "disposable") return undefined;
  const previous = await input.repository.getLatestAdapterStateForChat(input.owner, {
    chatId: input.chatId,
    driverKind: input.adapter.driverKind,
    instanceId: input.instanceId,
    schemaVersion: input.adapter.stateSchemaVersion,
    executionRootFingerprint: input.executionRootFingerprint,
    includeInterrupted: input.mode === "follow_up",
    sessionOnly: input.runPolicy?.memoryMode === "session_only",
    ...(input.deliveryContext?.unheardResponses
      ? { unheardResponses: input.deliveryContext.unheardResponses }
      : {}),
  });
  // Compatibility is filtered in SQL before choosing the newest checkpoint.
  // An incompatible interruption must not hide an older compatible session.
  return previous ? input.adapter.parseState(previous.state) : undefined;
}
