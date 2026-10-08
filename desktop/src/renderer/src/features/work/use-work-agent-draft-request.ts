import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatAgentDraftRequest, StartAgentChat } from "@matrix-os/ui";
import { desktopDriveDraftIdentity } from "../../stores/company-drive-chat-draft";
import { useConnection } from "../../stores/connection";

/** One pending intent, owned by the current authenticated runtime binding. */
export function useWorkAgentDraftRequest() {
  const identity = useConnection(desktopDriveDraftIdentity);
  const scope = useMemo(() => ({ identity }), [identity]);
  const liveScope = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => {
    liveScope.current = scope;
    return () => { if (liveScope.current === scope) liveScope.current = null; };
  }, [scope]);
  const sequence = useRef(0);
  const [pending, setPending] = useState<{ scope: typeof scope; request: ChatAgentDraftRequest } | null>(null);
  const requestAgentDraft = useCallback<(...args: Parameters<StartAgentChat>) => boolean>((text, resources) => {
    if (liveScope.current !== scope || desktopDriveDraftIdentity(useConnection.getState()) !== scope.identity) return false;
    sequence.current += 1;
    setPending({ scope, request: { id: sequence.current, text, resources } });
    return true;
  }, [scope]);
  const consumeAgentDraft = useCallback((id: number) => {
    if (liveScope.current !== scope || desktopDriveDraftIdentity(useConnection.getState()) !== scope.identity) return;
    setPending(current => current?.scope === scope && current.request.id === id ? null : current);
  }, [scope]);
  return { agentDraftRequest: pending?.scope === scope ? pending.request : null, requestAgentDraft, consumeAgentDraft };
}
