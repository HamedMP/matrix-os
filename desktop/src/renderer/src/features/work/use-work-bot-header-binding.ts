import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BotHeaderBindingReport } from "../desktop-shell/SurfaceChrome";
import type { WorkRoute } from "../../stores/tabs";

interface BotHeaderScope {
  client: object | null;
  chatId?: string;
  sharedScopeId?: string;
  runtimeSlot: string;
  authGeneration: number;
  route: WorkRoute;
  projectSlug?: string;
  initialChatView?: "index" | "draft" | "conversation";
}

/** Single content binding, bounded to one Chat and current renderer authority. */
export function useWorkBotHeaderBinding({ client, chatId, sharedScopeId, runtimeSlot, authGeneration, route, projectSlug, initialChatView }: BotHeaderScope) {
  const scope = useMemo(() => ({ client, chatId, sharedScopeId, runtimeSlot, authGeneration, route, projectSlug, initialChatView }),
    [client, chatId, sharedScopeId, runtimeSlot, authGeneration, route, projectSlug, initialChatView]);
  const latestScope = useRef<BotHeaderScope | null>(scope);
  useLayoutEffect(() => {
    latestScope.current = scope;
    return () => { if (latestScope.current === scope) latestScope.current = null; };
  }, [scope]);
  const [content, setContent] = useState<{ scope: BotHeaderScope; binding: BotHeaderBindingReport } | null>(null);
  const report = useCallback((binding: BotHeaderBindingReport) => {
    if (latestScope.current !== scope || !scope.client || scope.sharedScopeId || binding.chatId !== scope.chatId) return () => undefined;
    // Every report owns its release, even when its values equal the last report.
    setContent({ scope, binding });
    return () => setContent(previous => previous?.scope === scope && previous.binding === binding ? null : previous);
  }, [scope]);
  const agentId = content?.scope === scope && content.binding.status === "bot" ? content.binding.agentId : null;
  return { agentId, report };
}
