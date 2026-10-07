import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";

interface CanonicalChatClientScope {
  api: ApiClient | null;
  client: CanonicalChatClient | null;
  runtimeSlot: string;
  authGeneration: number;
}

const CanonicalChatClientContext = createContext<CanonicalChatClientScope | null>(null);

/** Rail actions and their Chat route must retain the same authenticated client. */
export function CanonicalChatClientProvider({ api, client, runtimeSlot, authGeneration, children }:
  CanonicalChatClientScope & { children: ReactNode }) {
  const scope = useMemo(() => ({ api, client, runtimeSlot, authGeneration }),
    [api, client, runtimeSlot, authGeneration]);
  return <CanonicalChatClientContext.Provider value={scope}>{children}</CanonicalChatClientContext.Provider>;
}

export function useScopedCanonicalChatClient(api: ApiClient | null, runtimeSlot: string, authGeneration: number) {
  const scope = useContext(CanonicalChatClientContext);
  // A matching URL alone cannot establish the current transport's owner/auth scope.
  return api && scope?.api === api && scope.runtimeSlot === runtimeSlot
    && scope.authGeneration === authGeneration ? scope.client : null;
}
