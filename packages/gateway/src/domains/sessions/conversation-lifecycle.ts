import type { KernelConversationId } from "@matrix-os/contracts";
import type { ConversationMutationLock } from "./conversation-mutation-lock.js";
import type { ConversationRunRegistry } from "./conversation-run-registry.js";
import type { ConversationFile, ConversationStore } from "./conversations.js";

export type ConversationAdmissionResult = "admitted" | "not_found" | "busy";
export type ConversationDeleteResult = "deleted" | "not_found" | "busy";
export type ConversationPreparedAdmissionResult<T> =
  | { status: "admitted"; prepared: T }
  | { status: "not_found" | "busy" | "unavailable" };

export function providerResumeSessionId(
  conversation: Pick<ConversationFile, "id" | "messages">,
): string | undefined {
  return conversation.messages.length > 0 ? conversation.id : undefined;
}

export interface ConversationLifecycle {
  admitExisting(id: KernelConversationId): Promise<ConversationAdmissionResult>;
  admitExistingPrepared<T>(
    id: KernelConversationId,
    prepare: (conversation: ConversationFile) => Promise<T | null>,
  ): Promise<ConversationPreparedAdmissionResult<T>>;
  adoptProviderSession(
    id: KernelConversationId,
    providerSessionId: KernelConversationId,
  ): Promise<"adopted" | "not_found" | "conflict">;
  deleteIfIdle(id: KernelConversationId): Promise<ConversationDeleteResult>;
  finalize(id: string): Promise<void>;
  getActiveHistoryStart(id: KernelConversationId): number | null;
}

export function createConversationLifecycle(deps: {
  mutationLock: ConversationMutationLock;
  conversations: ConversationStore;
  conversationRuns: Pick<
    ConversationRunRegistry,
    "begin" | "complete" | "has" | "isActive" | "rekey" | "getActiveHistoryStart"
  >;
}): ConversationLifecycle {
  return {
    admitExisting(id) {
      return deps.mutationLock.run(id, async () => {
        const existing = deps.conversations.get(id);
        if (!existing) {
          return "not_found";
        }
        if (deps.conversationRuns.isActive(id)) {
          return "busy";
        }

        deps.conversations.begin(id);
        deps.conversationRuns.begin(id, existing.messages.length);
        return "admitted";
      });
    },

    admitExistingPrepared(id, prepare) {
      return deps.mutationLock.run(id, async () => {
        const conversation = deps.conversations.get(id);
        if (!conversation) {
          return { status: "not_found" };
        }
        if (deps.conversationRuns.isActive(id)) {
          return { status: "busy" };
        }

        const prepared = await prepare(conversation);
        if (prepared === null) {
          return { status: "unavailable" };
        }

        deps.conversations.begin(id);
        deps.conversationRuns.begin(id);
        return { status: "admitted", prepared };
      });
    },

    async adoptProviderSession(id, providerSessionId) {
      if (!deps.conversationRuns.isActive(id)) return "conflict";
      if (id !== providerSessionId && deps.conversationRuns.has(providerSessionId)) {
        return "conflict";
      }
      const moved = await deps.conversations.rekey(id, providerSessionId);
      if (moved !== "moved") return moved;
      if (!deps.conversationRuns.rekey(id, providerSessionId)) {
        throw new Error("Conversation run could not adopt provider session");
      }
      return "adopted";
    },

    deleteIfIdle(id) {
      return deps.conversations.delete(id, () => deps.conversationRuns.isActive(id));
    },

    finalize(id) {
      return deps.conversations.finalize(id, () => deps.conversationRuns.complete(id));
    },

    getActiveHistoryStart(id) {
      return deps.conversationRuns.getActiveHistoryStart(id);
    },
  };
}
