import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { useQuery } from "@tanstack/react-query";

import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { mobileQueryKeys, searchChats, type ChatSearchOptions } from "@/lib/requests";

const NO_RESULTS: CanonicalChatRecord[] = [];
// What the search route accepts; a longer query is cut to this before it is sent.
const QUERY_MAX_LENGTH = 200;

/**
 * Chats with a message matching `query`. Searches every chat unless narrowed
 * to one project (`projectId`) or to chats in no project (`scope: "global"`).
 * An empty query searches nothing. The hook does not wait for typing to stop:
 * pass it a query that the screen has already debounced.
 */
export function useChatSearch(query: string, options: Pick<ChatSearchOptions, "projectId" | "scope"> = {}) {
  const gateway = useActiveGateway();
  const text = query.trim().slice(0, QUERY_MAX_LENGTH).trim();
  const { projectId, scope } = options;
  const enabled = gateway.ready && text.length > 0;
  const search = useQuery({
    queryKey: mobileQueryKeys.chatSearch(gateway.userId, gateway.computerKey, projectId ?? scope ?? "all", text),
    enabled,
    queryFn: async () => {
      const session = await gateway.session();
      if (!session) throw new Error("Search unavailable.");
      return searchChats(session.token, session.gatewayUrl, text, {
        ...(projectId ? { projectId } : {}),
        ...(scope ? { scope } : {}),
      });
    },
  });
  const wanted = gateway.authEnabled && text.length > 0;

  return {
    /** Results for the current query only; empty while it is still being searched. */
    results: enabled ? search.data ?? NO_RESULTS : NO_RESULTS,
    isSearching: wanted && (gateway.isComputerPending || (enabled && search.isPending)),
    isError: wanted && (gateway.isComputerError || search.isError),
  };
}
