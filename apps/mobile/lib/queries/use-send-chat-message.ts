import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useAuth } from "@clerk/clerk-expo";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import {
  admitChatTurn,
  canonicalChatTitle,
  createChat,
  fetchActiveComputer,
  mobileQueryKeys,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

interface SendChatMessageInput {
  chatId: string | null;
  /** The active chat's current revision; ignored when chatId is null (a fresh chat starts at revision 0). */
  baseRevision: number;
  text: string;
  selection: CanonicalChatModelSelection;
  /** Must be modes the selected instance's `supports` actually declares -- see defaultTurnModes. */
  interactionMode: string;
  permissionMode: string;
  /** Only applied when creating a new chat (chatId is null) -- see ProjectPicker. */
  projectId: string | null;
  /**
   * Idempotency keys for this exact send attempt. The caller must generate
   * these once per logical compose action and reuse the same values across
   * retries of that same attempt -- minting fresh IDs here on every call
   * would defeat server-side idempotent create/admit and let a lost response
   * duplicate the chat and its billed AI run.
   */
  chatRequestId: string;
  turnRequestId: string;
}

export function useSendChatMessage() {
  const queryClient = useQueryClient();
  const { getToken, userId } = useAuth();
  const { bindDraftChatId } = useCanonicalChatSession();

  return useMutation({
    mutationFn: async ({
      chatId,
      baseRevision,
      text,
      selection,
      interactionMode,
      permissionMode,
      projectId,
      chatRequestId,
      turnRequestId,
    }: SendChatMessageInput) => {
      const token = await getToken();
      if (!token) throw new Error("Not signed in.");
      const computer = await fetchActiveComputer(token);
      if (!computer) throw new Error("Computer unavailable.");
      const gatewayUrl = `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`;

      let targetChatId = chatId;
      let revision = baseRevision;
      if (!targetChatId) {
        const record = await createChat(token, gatewayUrl, {
          clientRequestId: chatRequestId,
          title: canonicalChatTitle(text),
          currentSelection: selection,
          ...(projectId ? { projectId } : {}),
        });
        targetChatId = record.chat.id;
        revision = record.chat.revision;
        // Deliberately not bound yet: binding here would enable
        // useCanonicalChatDetail for a chat that has zero messages, firing an
        // immediate fetch that can race the post-admission refetch below and
        // (given the 30s staleTime) permanently overwrite it with an empty
        // result. Bind only once the turn is actually admitted, below.
      }

      const admission = await admitChatTurn(token, gatewayUrl, targetChatId, {
        clientRequestId: turnRequestId,
        baseRevision: revision,
        parts: [{ type: "text", text }],
        selection,
        interactionMode,
        permissionMode,
      });

      if (!chatId) {
        bindDraftChatId(targetChatId);
      }

      const computerKey = `${computer.handle}:${computer.runtimeSlot}`;
      const uid = userId ?? "signed-out";
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChats(uid, computerKey) }),
        queryClient.invalidateQueries({
          queryKey: mobileQueryKeys.canonicalChatDetail(uid, computerKey, targetChatId),
        }),
      ]);

      return admission;
    },
  });
}
