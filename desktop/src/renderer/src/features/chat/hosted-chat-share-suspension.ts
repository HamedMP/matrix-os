import { createContext, useCallback, useMemo, useRef } from "react";

interface ShareSuspensionBinding {
  client: object;
  chatId: string;
  start(): void;
  failed(): void;
}

/** The mounted private Chat registers one disclosure boundary with its toolbar. */
export const HostedChatShareSuspensionContext = createContext<((binding: ShareSuspensionBinding) => () => void) | null>(null);

export function useHostedChatShareSuspension(client: object | null, chatId: string | undefined, identity: string) {
  const scope = useMemo(() => ({ client, chatId, identity }), [client, chatId, identity]);
  const current = useRef<{ scope: typeof scope; binding: ShareSuspensionBinding } | null>(null);
  const report = useCallback((binding: ShareSuspensionBinding) => {
    if (binding.client !== scope.client || binding.chatId !== scope.chatId) return () => undefined;
    const registered = { scope, binding };
    current.current = registered;
    return () => { if (current.current === registered) current.current = null; };
  }, [scope]);
  return useMemo(() => ({ report,
    start: () => { if (current.current?.scope === scope) current.current.binding.start(); },
    failed: () => { if (current.current?.scope === scope) current.current.binding.failed(); },
  }), [scope, report]);
}
