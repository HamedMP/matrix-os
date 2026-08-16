import type { KernelConversationId } from "@matrix-os/contracts";
import type { ConversationMutationLock } from "./conversation-mutation-lock.js";
import type { ConversationRunRegistry } from "./conversation-run-registry.js";
import type { ConversationStore } from "./conversations.js";

export type ConversationAdmissionResult = "admitted" | "not_found" | "busy";
export type ConversationDeleteResult = "deleted" | "not_found" | "busy";

export interface ConversationLifecycle {
  admitExisting(id: KernelConversationId): Promise<ConversationAdmissionResult>;
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

    deleteIfIdle(id) {
      return deps.conversations.delete(id, () => deps.conversationRuns.isActive(id));
    },

    finalize(id) {
      return deps.conversations.finalize(id, () => deps.conversationRuns.complete(id));
    },
  };
}
