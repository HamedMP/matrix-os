import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { cancelChatRun, canonicalChatRequestId, mobileQueryKeys } from "@/lib/requests";

interface CancelRunInput {
  chatId: string;
  runId: string;
  /** Minted here when left out. */
  clientRequestId?: string;
}

/**
 * Stops a run. The chat and the chat list are read again whether or not the
 * server accepted, because a refusal usually means the run had already ended.
 */
export function useCancelRun() {
  const queryClient = useQueryClient();
  const gateway = useActiveGateway();
  const { userId, computerKey } = gateway;

  return useMutation({
    mutationFn: async ({ chatId, runId, clientRequestId }: CancelRunInput) => {
      const session = await gateway.session();
      if (!session) throw new Error("Could not stop the run. Try again.");
      return cancelChatRun(session.token, session.gatewayUrl, chatId, runId, clientRequestId ?? canonicalChatRequestId());
    },
    // Not awaited, so the button is released as soon as the request is.
    onSettled: (_answer, _error, { chatId }) => {
      void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChatDetail(userId, computerKey, chatId) });
      void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChats(userId, computerKey) });
    },
  });
}
