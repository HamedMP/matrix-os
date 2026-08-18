import type { KernelConversationId } from "@matrix-os/contracts";
import type { ConversationMutationLock } from "./conversation-mutation-lock.js";
import type { ConversationRunRegistry } from "./conversation-run-registry.js";
import type { ConversationFile, ConversationStore } from "./conversations.js";

export type ConversationAdmissionResult = "admitted" | "not_found" | "busy";
export type ConversationDeleteResult = "deleted" | "not_found" | "busy";
export type ConversationPreparedAdmissionResult<T> =
  | { status: "admitted"; prepared: T }
  | { status: "not_found" | "busy" | "unavailable" };

export interface ConversationLifecycle {
  admitExisting(id: KernelConversationId): Promise<ConversationAdmissionResult>;
  admitExistingPrepared<T>(
    id: KernelConversationId,
    prepare: (conversation: ConversationFile) => Promise<T | null>,
  ): Promise<ConversationPreparedAdmissionResult<T>>;
  deleteIfIdle(id: KernelConversationId): Promise<ConversationDeleteResult>;
  finalize(id: string): Promise<void>;
}

export function createConversationLifecycle(deps: {
  mutationLock: ConversationMutationLock;
  conversations: ConversationStore;
  conversationRuns: Pick<ConversationRunRegistry, "begin" | "complete" | "isActive">;
}): ConversationLifecycle {
  return {
    admitExisting(id) {
      return deps.mutationLock.run(id, async () => {
        if (!deps.conversations.get(id)) {
          return "not_found";
        }
        if (deps.conversationRuns.isActive(id)) {
          return "busy";
        }

        deps.conversations.begin(id);
        deps.conversationRuns.begin(id);
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

    deleteIfIdle(id) {
      return deps.conversations.delete(id, () => deps.conversationRuns.isActive(id));
    },

    finalize(id) {
      return deps.conversations.finalize(id, () => deps.conversationRuns.complete(id));
    },
  };
}
