import type { CapturedAssistantText } from "./safe-activity-projection.js";
import {
  assistantCredentialOccurrenceId,
  assistantMessageId,
  sealAssistantCredential,
  type SealedAssistantCredential,
} from "./assistant-credential-crypto.js";
import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "./provider-adapter.js";

const MAX_MESSAGE_STATES = 64;
const MAX_PER_MESSAGE = 16;

/** Turns safe text into canonical deltas and seals only bounded captures. This
 * state is run-local, never persisted or exposed as a provider state update. */
export function createAssistantCredentialEmitter(context: {
  ownerType: "personal" | "organization";
  ownerId: string;
  chatId: string;
  runId: string;
  key?: Buffer;
  sharedScopeId?: string;
}) {
  const messageStates = new Map<string, { offset: number; count: number }>();
  const enabled = context.ownerType === "personal" && !!context.key && context.key.length === 32 && !context.sharedScopeId;
  return {
    emit(projected: CapturedAssistantText, providerMessageId?: string): CanonicalProviderRunEvent[] {
      const messageId = assistantMessageId(context.runId, providerMessageId);
      let state = messageStates.get(messageId);
      if (!state) {
        // Beyond the cap, publish safe text but never create an occurrence
        // whose offset could be reset by eviction and collide on a retry.
        state = { offset: 0, count: messageStates.size >= MAX_MESSAGE_STATES ? MAX_PER_MESSAGE : 0 };
        if (messageStates.size < MAX_MESSAGE_STATES) messageStates.set(messageId, state);
      }
      const result: CanonicalProviderRunEvent[] = [];
      let start = 0;
      while (start < projected.text.length) {
        let end = Math.min(start + 4_000, projected.text.length);
        const crossing = projected.captures.find((capture) => capture.offset < end && capture.offset + capture.length > end);
        if (crossing) end = crossing.offset;
        if (end === start) end = Math.min(start + 4_000, projected.text.length);
        if (end < projected.text.length && /[\uD800-\uDBFF]/u.test(projected.text[end - 1]!)) end -= 1;
        const delta = projected.text.slice(start, end);
        const credentials: SealedAssistantCredential[] = [];
        if (enabled) {
          for (const capture of projected.captures) {
            if (capture.offset < start || capture.offset + capture.length > end || state.count >= MAX_PER_MESSAGE) continue;
            const absoluteOffset = state.offset + capture.offset - start;
            const occurrenceId = assistantCredentialOccurrenceId(messageId, absoluteOffset);
            try {
              credentials.push({
                occurrenceId,
                offset: capture.offset - start,
                length: capture.length,
                envelope: sealAssistantCredential(context.key!, {
                  ownerId: context.ownerId, chatId: context.chatId, runId: context.runId,
                  messageId, occurrenceId,
                }, capture.value),
              });
              state.count += 1;
            } catch {
              // Key/capture failure is masked-only; never emit the raw value.
            }
          }
        }
        result.push(CanonicalProviderRunEventSchema.parse({
          type: "assistant.delta", ...(providerMessageId ? { messageId: providerMessageId } : {}),
          delta, ...(credentials.length ? { credentials } : {}),
        }));
        state.offset += delta.length;
        start = end;
      }
      return result;
    },
  };
}
