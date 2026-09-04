import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useAuth } from "@clerk/clerk-expo";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import {
  admitChatTurn,
  canonicalChatRequestId,
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
}

export function useSendChatMessage() {
  const queryClient = useQueryClient();
  const { getToken, userId } = useAuth();
  const { bindDraftChatId } = useCanonicalChatSession();

  return useMutation({
    mutationFn: async ({ chatId, baseRevision, text, selection }: SendChatMessageInput) => {
      const token = await getToken();
      if (!token) throw new Error("Not signed in.");
      const computer = await fetchActiveComputer(token);
      if (!computer) throw new Error("Computer unavailable.");
      const gatewayUrl = `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`;

      let targetChatId = chatId;
      let revision = baseRevision;
      if (!targetChatId) {
        const record = await createChat(token, gatewayUrl, {
          clientRequestId: canonicalChatRequestId(),
          title: canonicalChatTitle(text),
          currentSelection: selection,
        });
        targetChatId = record.chat.id;
        revision = record.chat.revision;
        bindDraftChatId(targetChatId);
      }

      const admission = await admitChatTurn(token, gatewayUrl, targetChatId, {
        clientRequestId: canonicalChatRequestId(),
        baseRevision: revision,
        parts: [{ type: "text", text }],
        selection,
        interactionMode: "default",
        permissionMode: "supervised",
      });

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
