import { useMutation, useQueryClient } from "@tanstack/react-query";

import { warningHaptic } from "@/lib/haptics";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { mobileQueryKeys, retryChatTurn } from "@/lib/requests";

const RETRY_ERROR = "Could not retry. Try again.";

interface RetryChatTurnInput {
  chatId: string;
  turnId: string;
  /** The chat's revision as shown. A chat that has moved on since is refused. */
  baseRevision: number;
  /** Kept for one failed run, so a retry whose answer was lost is not run twice. */
  clientRequestId: string;
}

/**
 * Runs a failed turn again. The chat and the chat list are read again whether
 * or not the computer accepted: the new run shows up, or a refusal usually
 * means the chat has moved on.
 */
export function useRetryChatTurn() {
  const queryClient = useQueryClient();
  const gateway = useActiveGateway();
  const { userId, computerKey } = gateway;

  return useMutation({
    mutationFn: async ({ chatId, turnId, baseRevision, clientRequestId }: RetryChatTurnInput) => {
      const session = await gateway.session();
      if (!session) throw new Error(RETRY_ERROR);
      return retryChatTurn(session.token, session.gatewayUrl, chatId, turnId, { clientRequestId, baseRevision });
    },
    onError: () => warningHaptic(),
    // Not awaited, so the button is released as soon as the request is.
    onSettled: (_answer, _error, { chatId }) => {
      void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChatDetail(userId, computerKey, chatId) });
      void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChats(userId, computerKey) });
    },
  });
}
